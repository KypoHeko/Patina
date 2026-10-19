//! Windows native layer: WinAPI via the `windows` crate.
//!
//! Implements:
//! - `delete_to_recycle_bin` — IFileOperation with FO_DELETE + FOF_ALLOWUNDO
//! - `list_drives_native` — GetVolumeInformation + GetDriveType for volume labels and types
//! - `get_native_icon` — SHGetFileInfo for extracting file icons
//! - `query_usn_cursor` / `read_usn_journal` — USN Journal for incremental sync

use crate::error::{Error, Result};

use super::usn::{self, FileRef};
use super::{DriveInfo, NativeIcon, UsnCursor, UsnRead};

/// NUL-terminated UTF-16 — the string format for WinAPI functions (`*W`).
fn to_wide(s: &str) -> Vec<u16> {
    use std::ffi::OsStr;
    use std::os::windows::ffi::OsStrExt;
    OsStr::new(s).encode_wide().chain(std::iter::once(0)).collect()
}

// ─── RAII guards for native handles ───────────────────────────────
//
// A manual `CloseHandle` / `CoUninitialize` is correct only as long as no early
// `return`/`?` slips in between acquiring the resource and releasing it. These
// guards move the release into `Drop`, so it runs on *every* exit path. The code
// is already leak-free today; this keeps it that way as the code grows.

/// Closes a Win32 `HANDLE` on drop.
struct HandleGuard(windows::Win32::Foundation::HANDLE);

impl Drop for HandleGuard {
    fn drop(&mut self) {
        // SAFETY: only constructed from a handle that opened successfully and is
        // not INVALID_HANDLE_VALUE; `CloseHandle` is its documented release.
        unsafe {
            let _ = windows::Win32::Foundation::CloseHandle(self.0);
        }
    }
}

/// Balances a successful `CoInitializeEx` with `CoUninitialize` on drop.
struct ComGuard;

impl Drop for ComGuard {
    fn drop(&mut self) {
        // SAFETY: only constructed after `CoInitializeEx` returned a success
        // code; each successful init must be paired with exactly one uninit.
        unsafe {
            windows::Win32::System::Com::CoUninitialize();
        }
    }
}

// ─── Delete to Trash via IFileOperation ───────────────────────────

// Delete files/folders to the Trash via IFileOperation.
//
// Advantages over the `trash` crate:
// Native COM call, works correctly with UAC and long paths
// A single Explorer progress dialog (if needed)
// Support for UNC paths and symbolic links
//
// Runs on a dedicated thread: the calling thread comes from the async
// runtime's blocking pool and may already have COM initialized in another
// apartment mode (CoInitializeEx would fail with RPC_E_CHANGED_MODE and the
// whole deletion with it). A fresh thread always gets its own STA.
pub fn delete_to_recycle_bin(paths: &[String]) -> Result<()> {
    let paths = paths.to_vec();
    std::thread::spawn(move || delete_on_sta_thread(&paths))
        .join()
        .map_err(|_| Error::Operation("recycle-bin thread panicked".into()))?
}

fn delete_on_sta_thread(paths: &[String]) -> Result<()> {
    use windows::Win32::System::Com::{
        CoInitializeEx, CLSCTX_ALL, COINIT_APARTMENTTHREADED,
    };
    use windows::Win32::UI::Shell::{
        FileOperation, IFileOperation, FOF_ALLOWUNDO, FOF_NOCONFIRMATION,
        FOF_NOERRORUI, FOF_SILENT, FOF_WANTNUKEWARNING,
    };

    unsafe {
        CoInitializeEx(None, COINIT_APARTMENTTHREADED)
            .ok()
            .map_err(|e| Error::Operation(format!("CoInitializeEx: {e}")))?;

        // Balances the CoInitializeEx above: CoUninitialize runs on scope exit,
        // including the early `?` returns below. Declared BEFORE `op` so that the
        // IFileOperation interface is released *before* CoUninitialize (locals
        // drop in reverse declaration order).
        let _com = ComGuard;

        let op: IFileOperation = CoCreateInstance(&FileOperation, None, CLSCTX_ALL)
            .map_err(|e| Error::Operation(format!("CoCreateInstance IFileOperation: {e}")))?;

        op.SetOperationFlags(
            FOF_ALLOWUNDO          // To the Trash, not permanently
            | FOF_NOCONFIRMATION   // Do not ask for confirmation
            | FOF_NOERRORUI        // Do not show error dialogs
            | FOF_SILENT           // No progress bar
            | FOF_WANTNUKEWARNING, // Warn if the file is too big for the Trash
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

        // PerformOperations succeeds even when the user declined the "too big
        // for the Recycle Bin, delete permanently?" prompt or an item failed:
        // that is only reported here. The caller drops metadata only for paths
        // that are really gone.
        if op.GetAnyOperationsAborted().map(|b| b.as_bool()).unwrap_or(false) {
            return Err(Error::Operation(
                "some items were not moved to the Recycle Bin (cancelled or failed)".into(),
            ));
        }

        Ok(())
        // `op` drops here (releases IFileOperation), then `_com` drops
        // (CoUninitialize) — the required order.
    }
}

// Imports for CoCreateInstance, SHCreateItemFromParsingName
use windows::Win32::System::Com::CoCreateInstance;
use windows::Win32::UI::Shell::SHCreateItemFromParsingName;

// ─── Drive list with labels and types ─────────────────────────────

/// Determines the media type by drive letter via GetDriveType and a
/// rotational-speed estimate via DeviceIoControl (IOCTL_STORAGE_QUERY).
///
/// Returns a list of drives with volume labels, types
/// (SSD/HDD/Removable/Network) and space information.
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

/// Get the volume label via GetVolumeInformationW.
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

    // Convert the wide string into a Rust String
    let len = label_buf.iter().position(|&c| c == 0).unwrap_or(0);
    if len == 0 {
        return String::new();
    }
    String::from_utf16_lossy(&label_buf[..len])
}

/// Determines the disk type: SSD, HDD, Removable, Network, Cloud, Unknown.
///
/// Strategy:
/// 1. GetDriveTypeW → Removable / Network / RAM
/// 2. For a fixed disk — detect_fixed_media (TRIM + seek penalty)
/// 3. Indeterminate → "SSD" (see detect_fixed_media)
fn get_drive_kind(root: &str) -> String {
    use windows::Win32::Storage::FileSystem::GetDriveTypeW;

    let wide = to_wide(root);
    let drive_type = unsafe { GetDriveTypeW(windows::core::PCWSTR(wide.as_ptr())) };

    // The numeric GetDriveType values (winbase.h) are stable and do not depend
    // on the crate version — the named constants are not reachable here in windows 0.58.
    match drive_type {
        2 => return "Removable".into(), // DRIVE_REMOVABLE
        4 => return "Network".into(),   // DRIVE_REMOTE
        5 => return "Removable".into(), // DRIVE_CDROM
        6 => return "RAM".into(),       // DRIVE_RAMDISK
        _ => {}                         // 3 = DRIVE_FIXED → check for SSD below
    }

    // FIXED or UNKNOWN → determine the media via IOCTL.
    detect_fixed_media(root).into()
}

/// SSD/HDD for a fixed disk. We combine TWO IOCTL_STORAGE_QUERY_PROPERTY
/// signals, because seek-penalty alone is not enough: on some SSDs (especially
/// NVMe) the query is uninformative or fails, and the previous implementation
/// then always returned "HDD" — hence a false HDD on a real SSD.
///
/// 1. TRIM enabled → SSD (mechanical HDDs do not support it) — most reliable.
/// 2. Otherwise seek penalty: FALSE → SSD, TRUE → HDD.
/// 3. Both queries uninformative → assume SSD: on modern fixed disks this is far
///    more likely, and an HDD reliably reports seek penalty (so in practice this
///    default does not produce a false "SSD instead of HDD").
fn detect_fixed_media(root: &str) -> &'static str {
    // StorageDeviceTrimProperty = 8
    if query_storage_property_bool(root, 8) == Some(true) {
        return "SSD";
    }
    // StorageDeviceSeekPenaltyProperty = 7: true = has a seek penalty (HDD).
    match query_storage_property_bool(root, 7) {
        Some(false) => "SSD",
        Some(true) => "HDD",
        None => "SSD",
    }
}

/// Query a boolean device descriptor via DeviceIoControl
/// (IOCTL_STORAGE_QUERY_PROPERTY). Suitable for properties whose descriptor has
/// the form { Version: u32, Size: u32, Value: BOOLEAN } — i.e. SeekPenalty (7)
/// and Trim (8).
///
/// Returns Some(true)/Some(false) by the field value, or None if the query is
/// uninformative (device did not open / IOCTL unsupported / short reply).
/// The difference between None and Some(false) matters: the caller treats
/// "unknown" differently from a confident "no".
fn query_storage_property_bool(root: &str, property_id: u32) -> Option<bool> {
    // Open the device \\.\C: for the root C:\
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
            _ => return None,
        };
        // From here on the handle is closed on every exit path (RAII).
        let _handle = HandleGuard(handle);

        // STORAGE_PROPERTY_QUERY: PropertyId (u32) + QueryType (u32).
        #[repr(C)]
        #[derive(Default)]
        struct StorageQuery {
            property: u32,
            query_type: u32,
        }

        // Descriptor: Version (u32) + Size (u32) + Value (BOOLEAN = 1 byte).
        // The header (Version/Size) is mandatory — without it we would read
        // Version (which is non-zero) and always get "true".
        #[repr(C)]
        #[derive(Default)]
        struct BoolDescriptor {
            version: u32,
            size: u32,
            value: u8, // BOOLEAN
            _reserved: [u8; 3],
        }

        let query = StorageQuery {
            property: property_id,
            query_type: 0, // PropertyStandardQuery
        };

        let mut result = BoolDescriptor::default();
        let mut bytes_returned = 0u32;

        let ok = DeviceIoControl(
            handle,
            0x0002D140, // IOCTL_STORAGE_QUERY_PROPERTY
            Some(&query as *const _ as *const _),
            std::mem::size_of::<StorageQuery>() as u32,
            Some(&mut result as *mut _ as *mut _),
            std::mem::size_of::<BoolDescriptor>() as u32,
            Some(&mut bytes_returned),
            None,
        );

        match ok {
            // Reliable only if the device actually returned the value field
            // (8-byte header + 1 byte = ≥ 9). Otherwise — "unknown".
            Ok(_) if bytes_returned >= 9 => Some(result.value != 0),
            _ => None,
        }
    }
}

/// Free and total disk space via GetDiskFreeSpaceExW.
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

// ─── Native file icons via SHGetFileInfo ──────────────────────────

/// Extract a file/folder icon via SHGetFileInfo and convert it to PNG.
///
/// `size` — the desired size (16 or 32). Returns the icon's PNG bytes.
///
/// Uses SHGetFileInfoW with SHGFI_ICON | SHGFI_SMALLICON/LARGEICON,
/// then converts HICON → PNG via a helper function.
#[allow(dead_code)]
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

/// Converts an HICON into PNG bytes of the given size.
///
/// Strategy: get the BITMAP from the icon, read the pixels, encode to PNG
/// via the `image` crate.
#[allow(dead_code)]
unsafe fn icon_to_png(
    icon: windows::Win32::UI::WindowsAndMessaging::HICON,
    size: u32,
) -> Option<Vec<u8>> {
    use windows::Win32::Graphics::Gdi::{
        CreateCompatibleDC, DeleteDC, DeleteObject, GetDIBits, SelectObject, BITMAPINFO,
        BITMAPINFOHEADER, BI_RGB, DIB_RGB_COLORS,
    };
    use windows::Win32::UI::WindowsAndMessaging::{GetIconInfo, ICONINFO};

    unsafe {
    let mut icon_info = ICONINFO::default();
    if GetIconInfo(icon, &mut icon_info).is_err() {
        return None;
    }

    // GetIconInfo creates two bitmaps (hbmColor and hbmMask); per the WinAPI
    // contract the caller must delete them, otherwise a GDI object leaks per call.
    // hbmMask is unused — delete it right away; hbmColor is needed for GetDIBits,
    // freed after the DC (or, on an early exit, right here).
    if !icon_info.hbmMask.is_invalid() {
        let _ = DeleteObject(icon_info.hbmMask);
    }

    let hdc = CreateCompatibleDC(None);
    if hdc.is_invalid() {
        if !icon_info.hbmColor.is_invalid() {
            let _ = DeleteObject(icon_info.hbmColor);
        }
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
    if !icon_info.hbmColor.is_invalid() {
        let _ = DeleteObject(icon_info.hbmColor);
    }

    if scan_lines == 0 {
        return None;
    }

    // Convert BGRA → RGBA for the image crate
    for chunk in pixels.chunks_exact_mut(4) {
        chunk.swap(0, 2); // B <-> R
    }

    // Encode to PNG
    let img = image::RgbaImage::from_raw(size, size, pixels);
    img.and_then(|img| {
        let mut buf = Vec::new();
        img.write_to(&mut std::io::Cursor::new(&mut buf), image::ImageFormat::Png)
            .ok()?;
        Some(buf)
    })
    }
}

// ─── USN Journal: incremental index sync ──────────────────────────
//
// A USN record holds the file NAME and the reference number of its PARENT
// directory, not a path. Paths are rebuilt by opening the parent by its id
// (`OpenFileById`) and asking for its final path; parents are cached because
// thousands of records usually share a handful of directories.

/// FSCTL_QUERY_USN_JOURNAL = CTL_CODE(FILE_DEVICE_FILE_SYSTEM, 61, METHOD_BUFFERED, FILE_ANY_ACCESS)
const FSCTL_QUERY_USN_JOURNAL: u32 = 0x0009_00F4;
/// FSCTL_READ_USN_JOURNAL = CTL_CODE(FILE_DEVICE_FILE_SYSTEM, 46, METHOD_NEITHER, FILE_ANY_ACCESS)
const FSCTL_READ_USN_JOURNAL: u32 = 0x0009_00BB;

/// Reasons that change what the index holds for a path.
const USN_REASON_MASK: u32 = 0x0000_0001 // DATA_OVERWRITE
    | 0x0000_0002 // DATA_EXTEND
    | 0x0000_0004 // DATA_TRUNCATION
    | 0x0000_0100 // FILE_CREATE
    | 0x0000_0200 // FILE_DELETE
    | 0x0000_1000 // RENAME_OLD_NAME
    | 0x0000_2000 // RENAME_NEW_NAME
    | 0x8000_0000; // CLOSE

/// USN_JOURNAL_DATA_V1 (V0 plus the supported record versions).
#[repr(C)]
#[allow(dead_code)] // layout mirrors the WinAPI struct; not every field is read
#[derive(Default)]
struct UsnJournalData {
    journal_id: u64,
    first_usn: i64,
    next_usn: i64,
    lowest_valid_usn: i64,
    max_usn: i64,
    maximum_size: u64,
    allocation_delta: u64,
    min_supported_major: u16,
    max_supported_major: u16,
}

/// READ_USN_JOURNAL_DATA_V1.
#[repr(C)]
#[allow(dead_code)] // only passed to the kernel, never read back
struct ReadUsnJournalData {
    start_usn: i64,
    reason_mask: u32,
    return_only_on_close: u32,
    timeout: u64,
    bytes_to_wait_for: u64,
    usn_journal_id: u64,
    min_major_version: u16,
    max_major_version: u16,
}

/// Open `\\.\X:` for the drive of `root`. Reading the journal needs read
/// access to the volume, which normally requires administrator rights; without
/// them this returns None and the caller does a full scan.
fn open_volume(root: &str) -> Option<HandleGuard> {
    use windows::Win32::Foundation::HANDLE;
    use windows::Win32::Storage::FileSystem::{
        CreateFileW, FILE_FLAGS_AND_ATTRIBUTES, FILE_SHARE_READ, FILE_SHARE_WRITE, OPEN_EXISTING,
    };
    let mut chars = root.chars();
    let letter = chars.next().filter(char::is_ascii_alphabetic)?;
    if chars.next() != Some(':') {
        return None; // UNC or relative path — no local volume journal
    }
    let wide = to_wide(&format!("\\\\.\\{letter}:"));
    // GENERIC_READ = 0x80000000
    let handle = unsafe {
        CreateFileW(
            windows::core::PCWSTR(wide.as_ptr()),
            0x8000_0000,
            FILE_SHARE_READ | FILE_SHARE_WRITE,
            None,
            OPEN_EXISTING,
            FILE_FLAGS_AND_ATTRIBUTES(0),
            HANDLE::default(),
        )
    }
    .ok()?;
    if handle.is_invalid() {
        return None;
    }
    Some(HandleGuard(handle))
}

fn query_journal(volume: windows::Win32::Foundation::HANDLE) -> Option<UsnJournalData> {
    use windows::Win32::System::IO::DeviceIoControl;
    let mut data = UsnJournalData::default();
    let mut returned = 0u32;
    unsafe {
        DeviceIoControl(
            volume,
            FSCTL_QUERY_USN_JOURNAL,
            None,
            0,
            Some(&mut data as *mut _ as *mut core::ffi::c_void),
            std::mem::size_of::<UsnJournalData>() as u32,
            Some(&mut returned),
            None,
        )
    }
    .ok()?;
    // journal_id + first_usn + next_usn + lowest_valid_usn are what we use.
    (returned >= 32).then_some(data)
}

/// Current end of the journal for `root`'s volume — saved right before a full
/// scan so the next start can continue from it.
pub fn query_usn_cursor(root: &str) -> Option<UsnCursor> {
    let volume = open_volume(root)?;
    let info = query_journal(volume.0)?;
    Some(UsnCursor { journal_id: info.journal_id, next_usn: info.next_usn })
}

/// Full path of a directory by its file reference number.
fn path_by_id(volume: windows::Win32::Foundation::HANDLE, id: &FileRef) -> Option<String> {
    use windows::Win32::Storage::FileSystem::{
        ExtendedFileIdType, FileIdType, GetFinalPathNameByHandleW, OpenFileById, FILE_FLAG_BACKUP_SEMANTICS,
        FILE_ID_128, FILE_ID_DESCRIPTOR, FILE_ID_DESCRIPTOR_0, FILE_NAME_NORMALIZED, FILE_SHARE_DELETE,
        FILE_SHARE_READ, FILE_SHARE_WRITE,
    };
    let desc = match id {
        FileRef::V2(frn) => FILE_ID_DESCRIPTOR {
            dwSize: std::mem::size_of::<FILE_ID_DESCRIPTOR>() as u32,
            Type: FileIdType,
            Anonymous: FILE_ID_DESCRIPTOR_0 { FileId: *frn as i64 },
        },
        FileRef::V3(bytes) => FILE_ID_DESCRIPTOR {
            dwSize: std::mem::size_of::<FILE_ID_DESCRIPTOR>() as u32,
            Type: ExtendedFileIdType,
            Anonymous: FILE_ID_DESCRIPTOR_0 { ExtendedFileId: FILE_ID_128 { Identifier: *bytes } },
        },
    };
    // Access 0 = metadata only; BACKUP_SEMANTICS is required to open directories.
    let handle = unsafe {
        OpenFileById(
            volume,
            &desc,
            0,
            FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
            None,
            FILE_FLAG_BACKUP_SEMANTICS,
        )
    }
    .ok()?;
    let _guard = HandleGuard(handle);
    let mut buf = vec![0u16; 512];
    for _ in 0..2 {
        // FILE_NAME_NORMALIZED | VOLUME_NAME_DOS — both are 0.
        let n = unsafe { GetFinalPathNameByHandleW(handle, &mut buf, FILE_NAME_NORMALIZED) } as usize;
        if n == 0 {
            return None;
        }
        if n < buf.len() {
            return Some(usn::strip_verbatim(&String::from_utf16_lossy(&buf[..n])));
        }
        buf.resize(n + 1, 0); // n = required size including the terminator
    }
    None
}

/// Every path touched on `root`'s volume since `since`, plus the new cursor.
/// Reads the journal to its current end in 64 KB batches (the old version read
/// one batch and dropped the rest), checks the journal instance and that the
/// saved position is still inside the journal.
pub fn read_usn_journal(root: &str, since: UsnCursor) -> UsnRead {
    use std::collections::{HashMap, HashSet};
    use windows::Win32::Foundation::{ERROR_HANDLE_EOF, ERROR_JOURNAL_ENTRY_DELETED, ERROR_JOURNAL_NOT_ACTIVE};
    use windows::Win32::System::IO::DeviceIoControl;

    let Some(volume) = open_volume(root) else { return UsnRead::Unavailable };
    let Some(info) = query_journal(volume.0) else { return UsnRead::Unavailable };
    if info.journal_id != since.journal_id || since.next_usn < info.lowest_valid_usn.max(info.first_usn) {
        return UsnRead::Reset;
    }

    // u64 storage keeps the buffer 8-byte aligned, as the IOCTL expects.
    let mut storage = vec![0u64; 64 * 1024 / 8];
    let mut entries: HashSet<usn::UsnEntry> = HashSet::new();
    let mut start = since.next_usn;
    while start < info.next_usn {
        let query = ReadUsnJournalData {
            start_usn: start,
            reason_mask: USN_REASON_MASK,
            return_only_on_close: 0,
            timeout: 0,
            bytes_to_wait_for: 0,
            usn_journal_id: info.journal_id,
            min_major_version: 2,
            max_major_version: 3,
        };
        let mut returned = 0u32;
        let res = unsafe {
            DeviceIoControl(
                volume.0,
                FSCTL_READ_USN_JOURNAL,
                Some(&query as *const _ as *const core::ffi::c_void),
                std::mem::size_of::<ReadUsnJournalData>() as u32,
                Some(storage.as_mut_ptr() as *mut core::ffi::c_void),
                (storage.len() * 8) as u32,
                Some(&mut returned),
                None,
            )
        };
        if let Err(e) = res {
            let code = e.code();
            if code == ERROR_HANDLE_EOF.to_hresult() {
                break;
            }
            if code == ERROR_JOURNAL_ENTRY_DELETED.to_hresult() || code == ERROR_JOURNAL_NOT_ACTIVE.to_hresult() {
                return UsnRead::Reset;
            }
            return UsnRead::Unavailable;
        }
        let len = (returned as usize).min(storage.len() * 8);
        // SAFETY: viewing initialized u64 storage as bytes is always valid.
        let bytes = unsafe { std::slice::from_raw_parts(storage.as_ptr() as *const u8, len) };
        if bytes.len() < 8 {
            break;
        }
        let next = i64::from_le_bytes(bytes[0..8].try_into().unwrap_or([0; 8]));
        usn::parse_records(&bytes[8..], &mut entries);
        if next <= start {
            break; // no progress — the end of the journal
        }
        start = next;
    }

    let mut parents: HashMap<FileRef, Option<String>> = HashMap::new();
    let mut paths: HashSet<String> = HashSet::new();
    for e in entries {
        let parent = parents.entry(e.parent).or_insert_with(|| path_by_id(volume.0, &e.parent));
        if let Some(dir) = parent {
            let sep = if dir.ends_with('\\') { "" } else { "\\" };
            paths.insert(format!("{dir}{sep}{}", e.name));
        }
    }
    UsnRead::Changes {
        paths: paths.into_iter().collect(),
        cursor: UsnCursor { journal_id: info.journal_id, next_usn: start },
    }
}

// ─── Known Folders via FOLDERID ───────────────────────────────────

/// Get the path to a Windows known folder via SHGetKnownFolderPath.
///
/// Replaces tauri::path() on Windows, providing native paths to system folders
/// (Desktop, Documents, Downloads, etc.)
#[allow(dead_code)]
pub fn get_known_folder(folder_id: windows::core::GUID) -> Option<String> {
    use windows::Win32::UI::Shell::{SHGetKnownFolderPath, KF_FLAG_DEFAULT};

    unsafe {
        // Returns a COM-allocated PWSTR; we free it via CoTaskMemFree.
        let ptr = SHGetKnownFolderPath(&folder_id, KF_FLAG_DEFAULT, None).ok()?;
        let s = ptr.to_string().ok();
        windows::Win32::System::Com::CoTaskMemFree(Some(ptr.0 as *const _));
        s
    }
}
