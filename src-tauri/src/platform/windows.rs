//! Windows-нативный слой: WinAPI через crate `windows`.
//!
//! Реализует:
//! - `delete_to_recycle_bin` — IFileOperation с FO_DELETE + FOF_ALLOWUNDO
//! - `list_drives_native` — GetVolumeInformation + GetDriveType для меток и типов томов
//! - `get_native_icon` — SHGetFileInfo для извлечения иконок файлов
//! - `read_usn_journal` — FSCTL_READ_USN_JOURNAL для инкрементальной синхронизации

use crate::error::{Error, Result};

use super::{DriveInfo, NativeIcon, UsnChanges};

/// UTF-16 c завершающим нулём — формат строк для WinAPI-функций (`*W`).
fn to_wide(s: &str) -> Vec<u16> {
    use std::ffi::OsStr;
    use std::os::windows::ffi::OsStrExt;
    OsStr::new(s).encode_wide().chain(std::iter::once(0)).collect()
}

// ─── Удаление в Корзину через IFileOperation ──────────────────────

// Удаление файлов/папок в Корзину через IFileOperation.
//
// Преимущества перед crate `trash`:
// Нативный COM-вызов, корректно работает с UAC и длинными путями
// Единый прогресс-диалог проводника (если нужен)
// Поддержка UNC-путей и символических ссылок
pub fn delete_to_recycle_bin(paths: &[String]) -> Result<()> {
    use windows::Win32::System::Com::{
        CoInitializeEx, CoUninitialize, CLSCTX_ALL,
    };
    use windows::Win32::UI::Shell::{
        FileOperation, IFileOperation, FOF_ALLOWUNDO, FOF_NOCONFIRMATION,
        FOF_NOERRORUI, FOF_SILENT, FOF_WANTNUKEWARNING,
    };

    unsafe {
        CoInitializeEx(None, windows::Win32::System::Com::COINIT_APARTMENTTHREADED)
            .ok()
            .map_err(|e| Error::Operation(format!("CoInitializeEx: {e}")))?;

        let result = (|| -> Result<()> {
            let op: IFileOperation =
                CoCreateInstance(&FileOperation, None, CLSCTX_ALL)
                    .map_err(|e| Error::Operation(format!("CoCreateInstance IFileOperation: {e}")))?;

            op.SetOperationFlags(
                FOF_ALLOWUNDO       // В Корзину, а не безвозвратно
                | FOF_NOCONFIRMATION // Не спрашивать подтверждение
                | FOF_NOERRORUI      // Не показывать диалоги ошибок
                | FOF_SILENT         // Без прогресс-бара
                | FOF_WANTNUKEWARNING, // Предупредить, если файл слишком велик для Корзины
            )
            .map_err(|e| Error::Operation(format!("SetOperationFlags: {e}")))?;

            for path_str in paths {
                let wide = to_wide(path_str);
                let item: windows::Win32::UI::Shell::IShellItem = SHCreateItemFromParsingName(
                    windows::core::PCWSTR(wide.as_ptr()),
                    None,
                )
                .map_err(|e| Error::Operation(format!("SHCreateItemFromParsingName({path_str}): {e}")))?;

                op.DeleteItem(&item, None)
                    .map_err(|e| Error::Operation(format!("DeleteItem({path_str}): {e}")))?;
            }

            op.PerformOperations()
                .map_err(|e| Error::Operation(format!("PerformOperations: {e}")))?;

            Ok(())
        })();

        CoUninitialize();
        result
    }
}

// Импорт для CoCreateInstance, SHCreateItemFromParsingName
use windows::Win32::System::Com::CoCreateInstance;
use windows::Win32::UI::Shell::SHCreateItemFromParsingName;

// ─── Список дисков с метками и типами ────────────────────────────

/// Определяет тип носителя по букве диска через GetDriveType и
/// оценке rotational speed через DeviceIoControl (IOCTL_STORAGE_QUERY).
///
/// Возвращает список дисков с метками томов, типами (SSD/HDD/Removable/Network)
/// и информацией о месте.
pub fn list_drives_native() -> Vec<DriveInfo> {
    let mut out = Vec::new();

    for letter in b'A'..=b'Z' {
        let c = letter as char;
        let root = format!("{}:\\", c);
        let root_path = std::path::Path::new(&root);

        if !root_path.exists() {
            continue;
        }

        let label = get_volume_label(&root);
        let kind = get_drive_kind(&root);
        let (total, available) = get_disk_space(&root);

        out.push(DriveInfo {
            path: root,
            label,
            kind,
            total,
            available,
        });
    }

    out
}

/// Получить метку тома через GetVolumeInformationW.
fn get_volume_label(root: &str) -> String {
    use windows::Win32::Storage::FileSystem::GetVolumeInformationW;

    let wide = to_wide(root);
    let mut label_buf = [0u16; 256];

    unsafe {
        let _ = GetVolumeInformationW(
            windows::core::PCWSTR(wide.as_ptr()),
            Some(&mut label_buf),
            None,
            None,
            None,
            None,
        );
    }

    // Преобразуем wide-строку в Rust String
    let len = label_buf.iter().position(|&c| c == 0).unwrap_or(0);
    if len == 0 {
        return String::new();
    }
    String::from_utf16_lossy(&label_buf[..len])
}

/// Определяет тип диска: SSD, HDD, Removable, Network, Cloud, Unknown.
///
/// Стратегия:
/// 1. GetDriveTypeW → Removable / Network / RAM
/// 2. IOCTL_STORAGE_QUERY_PROPERTY → проверка DeviceSeekPenalty
///    (SSD не имеет seek penalty → это SSD)
/// 3. Fallback → "HDD"
fn get_drive_kind(root: &str) -> String {
    use windows::Win32::Storage::FileSystem::GetDriveTypeW;

    let wide = to_wide(root);
    let drive_type = unsafe { GetDriveTypeW(windows::core::PCWSTR(wide.as_ptr())) };

    // Числовые значения GetDriveType (winbase.h) стабильны и не зависят от
    // версии крейта — именованные константы в windows 0.58 здесь не достаются.
    match drive_type {
        2 => return "Removable".into(), // DRIVE_REMOVABLE
        4 => return "Network".into(),   // DRIVE_REMOTE
        5 => return "Removable".into(), // DRIVE_CDROM
        6 => return "RAM".into(),       // DRIVE_RAMDISK
        _ => {}                         // 3 = DRIVE_FIXED → проверяем SSD ниже
    }

    // FIXED или UNKNOWN → проверяем SSD через IOCTL
    if is_ssd(root) {
        "SSD".into()
    } else {
        "HDD".into()
    }
}

/// Проверяет, является ли диск SSD через DeviceIoControl
/// с IOCTL_STORAGE_QUERY_PROPERTY → StorageDeviceSeekPenaltyProperty.
///
/// SSD не имеет seek penalty (DeviceSeekPenalty = FALSE).
fn is_ssd(root: &str) -> bool {

    // Открываем устройство \\.\C: для корня C:\
    let drive_letter = root.chars().next().unwrap_or('C');
    let device_path = format!("\\\\.\\{}:", drive_letter);
    let wide = to_wide(&device_path);

    unsafe {
        use windows::Win32::Foundation::HANDLE;
        use windows::Win32::Storage::FileSystem::{
            CreateFileW, FILE_SHARE_READ, FILE_SHARE_WRITE, OPEN_EXISTING,
        };
        use windows::Win32::System::IO::DeviceIoControl;

        let handle = CreateFileW(
            windows::core::PCWSTR(wide.as_ptr()),
            windows::Win32::Storage::FileSystem::FILE_READ_ATTRIBUTES.0,
            FILE_SHARE_READ | FILE_SHARE_WRITE,
            None,
            OPEN_EXISTING,
            windows::Win32::Storage::FileSystem::FILE_ATTRIBUTE_NORMAL,
            HANDLE::default(),
        );

        let handle = match handle {
            Ok(h) if !h.is_invalid() => h,
            _ => return false,
        };

        // IOCTL_STORAGE_QUERY_PROPERTY = 0x2D1400
        // StorageDeviceSeekPenaltyProperty = PropertyStandardQuery (0) + StorageDeviceSeekPenaltyProperty (7)
        // Упрощённая проверка через прямой IOCTL
        #[repr(C)]
        #[derive(Default)]
        struct StorageQuery {
            property: u32, // PropertyId = 7 (SeekPenalty)
            query_type: u32, // PropertyStandardQuery = 0
        }

        // DEVICE_SEEK_PENALTY_DESCRIPTOR: сначала Version (u32) и Size (u32),
        // и только потом IncursSeekPenalty (BOOLEAN = 1 байт). Без первых двух
        // полей мы читали бы Version (он ненулевой) и всегда получали «HDD».
        #[repr(C)]
        #[derive(Default)]
        struct DeviceSeekPenaltyDescriptor {
            version: u32,
            size: u32,
            incurs_seek_penalty: u8, // BOOLEAN: 0 (FALSE) = нет seek penalty = SSD
            _reserved: [u8; 3],
        }

        let query = StorageQuery {
            property: 7, // StorageDeviceSeekPenaltyProperty
            query_type: 0, // PropertyStandardQuery
        };

        let mut result = DeviceSeekPenaltyDescriptor::default();
        let mut bytes_returned = 0u32;

        let ok = DeviceIoControl(
            handle,
            0x0002D1400, // IOCTL_STORAGE_QUERY_PROPERTY
            Some(&query as *const _ as *const _),
            std::mem::size_of::<StorageQuery>() as u32,
            Some(&mut result as *mut _ as *mut _),
            std::mem::size_of::<DeviceSeekPenaltyDescriptor>() as u32,
            Some(&mut bytes_returned),
            None,
        );

        let _ = windows::Win32::Foundation::CloseHandle(handle);

        match ok {
            // Достоверно, только если устройство реально вернуло поле penalty
            // (дескриптор с заголовком занимает ≥ 9 байт). Иначе — не SSD.
            Ok(_) if bytes_returned >= 9 => result.incurs_seek_penalty == 0,
            _ => false,
        }
    }
}

/// Свободное и полное пространство диска через GetDiskFreeSpaceExW.
fn get_disk_space(root: &str) -> (u64, u64) {
    use windows::Win32::Storage::FileSystem::GetDiskFreeSpaceExW;

    let wide = to_wide(root);

    unsafe {
        let mut free_available: u64 = 0;
        let mut total: u64 = 0;
        let mut total_free: u64 = 0;

        let ok = GetDiskFreeSpaceExW(
            windows::core::PCWSTR(wide.as_ptr()),
            Some(&mut free_available),
            Some(&mut total),
            Some(&mut total_free),
        );

        if ok.is_ok() {
            (total, free_available)
        } else {
            (0, 0)
        }
    }
}

// ─── Нативные иконки файлов через SHGetFileInfo ──────────────────

/// Извлечь иконку файла/папки через SHGetFileInfo и конвертировать в PNG.
///
/// `size` — желаемый размер (16 или 32). Возвращается PNG-байты иконки.
///
/// Использует SHGetFileInfoW с SHGFI_ICON | SHGFI_SMALLICON/LARGEICON,
/// затем конвертирует HICON → PNG через вспомогательную функцию.
#[allow(dead_code)] // TODO: подключить нативные иконки к list_dir/превью
pub fn get_native_icon(path: &str, size: u32) -> Option<NativeIcon> {
    use windows::Win32::Storage::FileSystem::FILE_FLAGS_AND_ATTRIBUTES;
    use windows::Win32::UI::Shell::{
        SHGetFileInfoW, SHFILEINFOW, SHGFI_ICON, SHGFI_SMALLICON, SHGFI_LARGEICON,
    };
    use windows::Win32::UI::WindowsAndMessaging::DestroyIcon;

    let wide = to_wide(path);

    let flags = if size <= 16 {
        SHGFI_ICON | SHGFI_SMALLICON
    } else {
        SHGFI_ICON | SHGFI_LARGEICON
    };

    let mut shfi = SHFILEINFOW::default();

    let result = unsafe {
        SHGetFileInfoW(
            windows::core::PCWSTR(wide.as_ptr()),
            FILE_FLAGS_AND_ATTRIBUTES(0),
            Some(&mut shfi),
            std::mem::size_of::<SHFILEINFOW>() as u32,
            flags,
        )
    };

    if result == 0 || shfi.hIcon.is_invalid() {
        return None;
    }

    let png_bytes = unsafe { icon_to_png(shfi.hIcon, size) };

    unsafe {
        let _ = DestroyIcon(shfi.hIcon);
    }

    png_bytes.map(|png| NativeIcon {
        png,
        width: size,
        height: size,
    })
}

/// Конвертирует HICON в PNG-байты заданного размера.
///
/// Стратегия: получаем BITMAP из иконки, читаем пиксели, кодируем в PNG
/// через crate `image`.
#[allow(dead_code)] // TODO: используется get_native_icon (отложено)
unsafe fn icon_to_png(
    icon: windows::Win32::UI::WindowsAndMessaging::HICON,
    size: u32,
) -> Option<Vec<u8>> {
    use windows::Win32::Graphics::Gdi::{
        CreateCompatibleDC, DeleteDC, GetDIBits, SelectObject, BITMAPINFO, BITMAPINFOHEADER,
        BI_RGB, DIB_RGB_COLORS,
    };
    use windows::Win32::UI::WindowsAndMessaging::{GetIconInfo, ICONINFO};

    unsafe {
    let mut icon_info = ICONINFO::default();
    if GetIconInfo(icon, &mut icon_info).is_err() {
        return None;
    }

    let hdc = CreateCompatibleDC(None);
    if hdc.is_invalid() {
        return None;
    }

    let old_bmp = SelectObject(hdc, icon_info.hbmColor);

    let mut bmi = BITMAPINFO {
        bmiHeader: BITMAPINFOHEADER {
            biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
            biWidth: size as i32,
            biHeight: -(size as i32), // Top-down DIB
            biPlanes: 1,
            biBitCount: 32, // BGRA
            biCompression: BI_RGB.0,
            ..Default::default()
        },
        ..Default::default()
    };

    let mut pixels: Vec<u8> = vec![0u8; (size * size * 4) as usize];

    let scan_lines = GetDIBits(
        hdc,
        icon_info.hbmColor,
        0,
        size,
        Some(pixels.as_mut_ptr() as *mut _),
        &mut bmi,
        DIB_RGB_COLORS,
    );

    let _ = SelectObject(hdc, old_bmp);
    let _ = DeleteDC(hdc);

    if scan_lines == 0 {
        return None;
    }

    // Конвертируем BGRA → RGBA для crate image
    for chunk in pixels.chunks_exact_mut(4) {
        chunk.swap(0, 2); // B <-> R
    }

    // Кодируем в PNG
    let img = image::RgbaImage::from_raw(size, size, pixels);
    img.and_then(|img| {
        let mut buf = Vec::new();
        img.write_to(&mut std::io::Cursor::new(&mut buf), image::ImageFormat::Png)
            .ok()?;
        Some(buf)
    })
    }
}

// ─── USN Journal: инкрементальная синхронизация индекса ──────────

/// Прочитать изменения из USN Journal NTFS-тома с момента `last_usn`.
///
/// USN Journal — это лог изменений файловой системы NTFS, который ведёт
/// сама ОС. Позволяет обнаружить создания/удаления/переименования файлов
/// без полного перескана каталога — за O(изменения), а не O(все файлы).
///
/// Возвращает:
/// - `Some(UsnChanges)` — если журнал прочитан успешно
/// - `None` — если том не NTFS или USN Journal недоступен
///
/// `last_usn` — позиция в журнале с прошлого чтения (0 = сначала).
/// После обработки нужно сохранить новый USN для следующего вызова.
#[allow(dead_code)] // TODO: подключить USN-поллер вместо notify для корневого тома
pub fn read_usn_journal(root: &str, last_usn: i64) -> Result<Option<UsnChanges>> {
    use windows::Win32::Foundation::HANDLE;
    use windows::Win32::Storage::FileSystem::{
        CreateFileW, FILE_SHARE_READ, FILE_SHARE_WRITE, OPEN_EXISTING,
        FILE_ATTRIBUTE_NORMAL, FILE_READ_ATTRIBUTES,
    };

    // Определяем букву диска из корня
    let drive_letter = match root.chars().next() {
        Some(c) if c.is_ascii_alphabetic() => c,
        _ => return Ok(None), // Не NTFS-путь
    };

    let device_path = format!("\\\\.\\{}:", drive_letter);
    let wide = to_wide(&device_path);

    unsafe {
        let handle = CreateFileW(
            windows::core::PCWSTR(wide.as_ptr()),
            FILE_READ_ATTRIBUTES.0,
            FILE_SHARE_READ | FILE_SHARE_WRITE,
            None,
            OPEN_EXISTING,
            FILE_ATTRIBUTE_NORMAL,
            HANDLE::default(),
        );

        let handle = match handle {
            Ok(h) if !h.is_invalid() => h,
            _ => return Ok(None), // Не удалось открыть устройство
        };

        let result = read_usn_with_handle(handle, root, last_usn);

        let _ = windows::Win32::Foundation::CloseHandle(handle);

        result
    }
}

/// Внутренняя реализация чтения USN Journal через DeviceIoControl.
#[allow(dead_code)] // TODO: используется read_usn_journal (отложено)
unsafe fn read_usn_with_handle(
    handle: windows::Win32::Foundation::HANDLE,
    root: &str,
    last_usn: i64,
) -> Result<Option<UsnChanges>> {
    use windows::Win32::System::IO::DeviceIoControl;

    // FSCTL_READ_USN_JOURNAL = 0x000900EB
    const FSCTL_READ_USN_JOURNAL: u32 = 0x000900EB;

    // USN_REASON коды, которые нас интересуют
    const USN_REASON_FILE_CREATE: u32 = 0x00000100;
    const USN_REASON_FILE_DELETE: u32 = 0x00000200;
    const USN_REASON_DATA_OVERWRITE: u32 = 0x00000001;
    const USN_REASON_DATA_TRUNCATION: u32 = 0x00000002;
    const USN_REASON_DATA_EXTEND: u32 = 0x00000004;
    const USN_REASON_RENAME_NEW_NAME: u32 = 0x00002000;
    const USN_REASON_CLOSE: u32 = 0x80000000;

    #[repr(C)]
    struct ReadUsnJournalData {
        start_usn: i64,        // USN, с которого начинаем чтение
        reason_mask: u32,      // Маска причин (0 = все)
        return_only_on_close: u32, // 0 = все записи
        timeout: u64,          // 0 = без ожидания
        bytes_to_wait_for: u64, // 0
        usn_journal_id: i64,   // ID журнала (0 = автоопределение)
        min_major_version: u16, // 2
        max_major_version: u16, // 3
    }

    let query = ReadUsnJournalData {
        start_usn: last_usn,
        reason_mask: USN_REASON_FILE_CREATE
            | USN_REASON_FILE_DELETE
            | USN_REASON_DATA_OVERWRITE
            | USN_REASON_DATA_EXTEND
            | USN_REASON_DATA_TRUNCATION
            | USN_REASON_RENAME_NEW_NAME
            | USN_REASON_CLOSE,
        return_only_on_close: 0,
        timeout: 0,
        bytes_to_wait_for: 0,
        usn_journal_id: 0, // Автоопределение
        min_major_version: 2,
        max_major_version: 3,
    };

    let mut out_buf: Vec<u8> = vec![0u8; 65536];
    let mut bytes_returned = 0u32;

    let ok = unsafe {
        DeviceIoControl(
            handle,
            FSCTL_READ_USN_JOURNAL,
            Some(&query as *const _ as *const _),
            std::mem::size_of::<ReadUsnJournalData>() as u32,
            Some(out_buf.as_mut_ptr() as *mut _),
            out_buf.len() as u32,
            Some(&mut bytes_returned),
            None,
        )
    };

    if ok.is_err() || bytes_returned < 8 {
        // USN Journal недоступна (не NTFS, нет прав и т.п.)
        return Ok(None);
    }

    // Первые 8 байт — следующий USN для чтения
    let _next_usn = i64::from_ne_bytes(out_buf[0..8].try_into().unwrap_or([0; 8]));

    let drive_prefix = format!("{}:\\", root.chars().next().unwrap_or('C'));
    let mut modified = Vec::new();
    let mut deleted = Vec::new();

    // Парсим USN-записи
    let mut offset = 8usize;
    while offset + 8 < bytes_returned as usize {
        // USN_RECORD_V2 заголовок:
        // offset 0: RecordLength (u32)
        // offset 4: MajorVersion (u16)
        // offset 6: MinorVersion (u16)
        // offset 8: FileReferenceNumber (u64)
        // offset 16: ParentFileReferenceNumber (u64)
        // offset 24: Usn (i64)
        // offset 32: Timestamp (i64)
        // offset 40: Reason (u32)
        // offset 44: SourceInfo (u32)
        // offset 48: SecurityId (u32)
        // offset 52: FileAttributes (u32)
        // offset 56: FileNameLength (u16)
        // offset 58: FileNameOffset (u16)
        // offset 60: FileName (variable)

        if offset + 60 > bytes_returned as usize {
            break;
        }

        let record_len = u32::from_ne_bytes(out_buf[offset..offset + 4].try_into().unwrap_or([0; 4])) as usize;
        if record_len < 60 || offset + record_len > bytes_returned as usize {
            break;
        }

        let reason = u32::from_ne_bytes(out_buf[offset + 24 + 16..offset + 24 + 20].try_into().unwrap_or([0; 4]));
        let file_name_len = u16::from_ne_bytes(out_buf[offset + 56..offset + 58].try_into().unwrap_or([0; 2])) as usize;
        let file_name_offset = u16::from_ne_bytes(out_buf[offset + 58..offset + 60].try_into().unwrap_or([0; 2])) as usize;

        if file_name_len > 0 && offset + file_name_offset + file_name_len <= bytes_returned as usize {
            let name_bytes = &out_buf[offset + file_name_offset..offset + file_name_offset + file_name_len];
            let name = String::from_utf16_lossy(unsafe {
                std::slice::from_raw_parts(
                    name_bytes.as_ptr() as *const u16,
                    file_name_len / 2,
                )
            });

            // Формируем полный путь
            let full_path = if name.starts_with(&drive_prefix) || name.starts_with('\\') {
                name
            } else {
                format!("{}{}", drive_prefix, name)
            };

            if reason & USN_REASON_FILE_DELETE != 0 {
                deleted.push(full_path);
            } else if reason & (USN_REASON_FILE_CREATE | USN_REASON_DATA_OVERWRITE | USN_REASON_DATA_EXTEND | USN_REASON_DATA_TRUNCATION | USN_REASON_RENAME_NEW_NAME | USN_REASON_CLOSE) != 0 {
                modified.push(full_path);
            }
        }

        offset += record_len;
        if record_len == 0 {
            break; // Защита от бесконечного цикла
        }
    }

    Ok(Some(UsnChanges { modified, deleted }))
}

// ─── Known Folders через FOLDERID ─────────────────────────────────

/// Получить путь к известной папке Windows через SHGetKnownFolderPath.
///
/// Заменяет tauri::path() для Windows, предоставляя нативные пути
/// к системным папкам (Desktop, Documents, Downloads и т.д.)
#[allow(dead_code)]
pub fn get_known_folder(folder_id: windows::core::GUID) -> Option<String> {
    use windows::Win32::UI::Shell::{SHGetKnownFolderPath, KF_FLAG_DEFAULT};

    unsafe {
        // Возвращает PWSTR, выделенный COM; освобождаем через CoTaskMemFree.
        let ptr = SHGetKnownFolderPath(&folder_id, KF_FLAG_DEFAULT, None).ok()?;
        let s = ptr.to_string().ok();
        windows::Win32::System::Com::CoTaskMemFree(Some(ptr.0 as *const _));
        s
    }
}
