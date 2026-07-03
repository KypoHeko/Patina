//! Windows native layer: WinAPI via the `windows` crate.
//!
//! Implements:
//! - `delete_to_recycle_bin` — IFileOperation with FO_DELETE + FOF_ALLOWUNDO
//! - `list_drives_native` — GetVolumeInformation + GetDriveType for volume labels and types
//! - `get_native_icon` — SHGetFileInfo for extracting file icons
//! - `read_usn_journal` — FSCTL_READ_USN_JOURNAL for incremental sync

use crate::error::{Error, Result};

use super::{DriveInfo, NativeIcon, UsnChanges};

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
pub fn delete_to_recycle_bin(paths: &[String]) -> Result<()> {
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
                FOF_ALLOWUNDO       // To the Trash, not permanently
                | FOF_NOCONFIRMATION // Do not ask for confirmation
                | FOF_NOERRORUI      // Do not show error dialogs
                | FOF_SILENT         // No progress bar
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

/// Read changes from an NTFS volume's USN Journal since `last_usn`.
///
/// The USN Journal is a log of NTFS filesystem changes maintained by the OS
/// itself. It lets you detect file creations/deletions/renames without a full
/// directory rescan — in O(changes), not O(all files).
///
/// Returns:
/// - `Some(UsnChanges)` — if the journal was read successfully
/// - `None` — if the volume is not NTFS or the USN Journal is unavailable
///
/// `last_usn` — the journal position from the previous read (0 = from the start).
/// After processing, save the new USN for the next call.
pub fn read_usn_journal(root: &str, last_usn: i64) -> Result<Option<UsnChanges>> {
    use windows::Win32::Foundation::HANDLE;
    use windows::Win32::Storage::FileSystem::{
        CreateFileW, FILE_SHARE_READ, FILE_SHARE_WRITE, OPEN_EXISTING,
        FILE_ATTRIBUTE_NORMAL, FILE_READ_ATTRIBUTES,
    };

    // Determine the drive letter from the root
    let drive_letter = match root.chars().next() {
        Some(c) if c.is_ascii_alphabetic() => c,
        _ => return Ok(None), // Not an NTFS path
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
            _ => return Ok(None), // Could not open the device
        };
        // The handle is closed on every exit path from here on (RAII).
        let _handle = HandleGuard(handle);

        read_usn_with_handle(handle, root, last_usn)
    }
}

/// Internal implementation of reading the USN Journal via DeviceIoControl.
unsafe fn read_usn_with_handle(
    handle: windows::Win32::Foundation::HANDLE,
    root: &str,
    last_usn: i64,
) -> Result<Option<UsnChanges>> {
    use windows::Win32::System::IO::DeviceIoControl;

    // FSCTL_READ_USN_JOURNAL = 0x000900EB
    const FSCTL_READ_USN_JOURNAL: u32 = 0x000900EB;

    // The USN_REASON codes we care about
    const USN_REASON_FILE_CREATE: u32 = 0x00000100;
    const USN_REASON_FILE_DELETE: u32 = 0x00000200;
    const USN_REASON_DATA_OVERWRITE: u32 = 0x00000001;
    const USN_REASON_DATA_TRUNCATION: u32 = 0x00000002;
    const USN_REASON_DATA_EXTEND: u32 = 0x00000004;
    const USN_REASON_RENAME_NEW_NAME: u32 = 0x00002000;
    const USN_REASON_CLOSE: u32 = 0x80000000;

    #[repr(C)]
    struct ReadUsnJournalData {
        start_usn: i64,        // USN to start reading from
        reason_mask: u32,      // Reason mask (0 = all)
        return_only_on_close: u32, // 0 = all records
        timeout: u64,          // 0 = no waiting
        bytes_to_wait_for: u64, // 0
        usn_journal_id: i64,   // Journal ID (0 = autodetect)
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
        usn_journal_id: 0, // Autodetect
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
        // The USN Journal is unavailable (not NTFS, no permissions, etc.)
        return Ok(None);
    }

    // The first 8 bytes are the next USN to read from
    let _next_usn = i64::from_ne_bytes(out_buf[0..8].try_into().unwrap_or([0; 8]));

    let drive_prefix = format!("{}:\\", root.chars().next().unwrap_or('C'));
    let mut modified = Vec::new();
    let mut deleted = Vec::new();

    // Parse the USN records
    let mut offset = 8usize;
    while offset + 8 < bytes_returned as usize {
        // USN_RECORD_V2 header:
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

            // Build the full path
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
            break; // Guard against an infinite loop
        }
    }

    Ok(Some(UsnChanges { modified, deleted }))
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
