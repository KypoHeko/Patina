//! Platform layer: OS-specific code, isolated behind feature flags.
//!
//! On Windows it provides native APIs:
//! - IFileOperation for deleting to Trash (instead of the `trash` crate)
//! - SHGetFileInfo for extracting file icons (instead of SVG mapping)
//! - GetVolumeInformation / GetDriveType for volume labels and types
//! - USN Journal for incremental index sync (NTFS)
//!
//! On other platforms — a fallback via cross-platform crates.
//!
//! All public functions are available directly via `crate::platform::*`
//! (re-exported from the windows submodule on Windows, or fallback
//! implementations on other platforms).

pub mod icon;
pub mod usn;
#[cfg(windows)]
pub mod windows;

pub use usn::{UsnCursor, UsnRead};

// ─── Re-export Windows functions at the platform::* level ─────────
// On Windows the functions are implemented in windows.rs, but calling code
// uses platform::read_usn_journal, platform::list_drives_native, etc.
// The re-export makes them available without the windows:: qualification.

#[cfg(windows)]
pub use windows::{confirm_run, delete_to_recycle_bin, list_drives_native, reveal_in_explorer};

// Re-export native icons and the USN Journal for use in commands.
#[cfg(windows)]
pub use windows::{get_native_icon, query_usn_cursor, read_usn_journal};

/// `CTL_CODE` from winioctl.h — IOCTL codes are computed, not typed in as hex:
/// the hand-written constants here were wrong twice (storage query and USN read).
#[cfg_attr(not(windows), allow(dead_code))]
pub const fn ctl_code(device: u32, function: u32, method: u32, access: u32) -> u32 {
    (device << 16) | (access << 14) | (function << 2) | method
}

#[cfg(test)]
mod ioctl_tests {
    use super::ctl_code;

    #[test]
    fn known_ioctl_codes() {
        // FILE_DEVICE_FILE_SYSTEM = 9, IOCTL_STORAGE_BASE = 0x2D
        assert_eq!(ctl_code(9, 61, 0, 0), 0x0009_00F4); // FSCTL_QUERY_USN_JOURNAL
        assert_eq!(ctl_code(9, 46, 3, 0), 0x0009_00BB); // FSCTL_READ_USN_JOURNAL
        assert_eq!(ctl_code(0x2D, 0x500, 0, 0), 0x002D_1400); // IOCTL_STORAGE_QUERY_PROPERTY
    }
}

/// Disk/volume information with native OS data.
#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DriveInfo {
    /// Drive letter or mount point (e.g. "C:\\" or "/mnt/data")
    pub path: String,
    /// Volume label (e.g. "System", "Data") — may be empty
    pub label: String,
    /// Media type: "SSD", "HDD", "Removable", "Network", "Cloud", "Unknown"
    pub kind: String,
    /// Total capacity in bytes
    pub total: u64,
    /// Available (free) in bytes
    pub available: u64,
}

/// Result of extracting an icon via SHGetFileInfo.
#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
#[allow(dead_code)]
pub struct NativeIcon {
    /// Icon PNG bytes (16x16 or 32x32)
    pub png: Vec<u8>,
    /// Width in pixels
    pub width: u32,
    /// Height in pixels
    pub height: u32,
}

/// Drive letters present in a `GetLogicalDrives` bit mask (bit 0 = A:).
/// Kept OS-independent so it is unit-tested everywhere.
#[cfg_attr(not(windows), allow(dead_code))]
pub fn drive_letters(mask: u32) -> Vec<char> {
    (0..26u8).filter(|i| mask & (1 << i) != 0).map(|i| (b'A' + i) as char).collect()
}

/// Drive letters of the system, from one `GetLogicalDrives` call — instead of
/// probing `X:\` 26 times with `Path::exists`, which stalls for seconds on a
/// disconnected network drive or an empty card reader.
#[cfg(windows)]
pub fn logical_drives() -> Vec<char> {
    drive_letters(unsafe { ::windows::Win32::Storage::FileSystem::GetLogicalDrives() })
}

/// Extensions Windows EXECUTES on open rather than showing in an app.
const RUNNABLE_EXTS: &[&str] = &[
    "exe", "com", "scr", "pif", "bat", "cmd", "ps1", "psm1", "vbs", "vbe", "js", "jse", "wsf", "wsh",
    "hta", "msi", "msp", "cpl", "reg", "jar",
];

/// Whether opening `path` would run code (and so needs the user's native
/// confirmation, see `commands::system::open_path`).
#[cfg_attr(not(windows), allow(dead_code))]
pub fn is_runnable(path: &str) -> bool {
    std::path::Path::new(path)
        .extension()
        .map(|e| e.to_string_lossy().to_ascii_lowercase())
        .is_some_and(|e| RUNNABLE_EXTS.contains(&e.as_str()))
}

// ─── Fallback implementations for non-Windows ──────────────────────

#[cfg(not(windows))]
#[allow(dead_code)]
pub fn list_drives_native() -> Vec<DriveInfo> {
    // On Linux/macOS we return the root as the only "drive".
    // Detailed volume detection is via sysinfo (on the caller's side).
    vec![DriveInfo {
        path: "/".into(),
        label: String::new(),
        kind: "Unknown".into(),
        total: 0,
        available: 0,
    }]
}

#[cfg(not(windows))]
pub fn delete_to_recycle_bin(_paths: &[String]) -> crate::error::Result<()> {
    // Fallback — the trash crate on non-Windows
    trash::delete_all(_paths).map_err(|e| crate::error::Error::Operation(e.to_string()))
}

#[cfg(not(windows))]
pub fn get_native_icon(_path: &str, _size: u32) -> Option<NativeIcon> {
    None
}

#[cfg(test)]
mod drive_tests {
    #[test]
    fn recognises_runnable_files() {
        assert!(super::is_runnable(r"C:\Downloads\setup.EXE"));
        assert!(super::is_runnable("/x/run.bat"));
        assert!(super::is_runnable("script.ps1"));
        assert!(!super::is_runnable("notes.txt"));
        assert!(!super::is_runnable("shortcut.lnk"));
        assert!(!super::is_runnable("exe")); // a name, not an extension
    }

    #[test]
    fn decodes_the_logical_drive_mask() {
        assert_eq!(super::drive_letters(0), Vec::<char>::new());
        assert_eq!(super::drive_letters(0b1100), vec!['C', 'D']);
        assert_eq!(super::drive_letters(1 | (1 << 25)), vec!['A', 'Z']);
        assert_eq!(super::drive_letters(u32::MAX).len(), 26);
    }
}

/// The USN Journal exists only on NTFS/ReFS under Windows.
#[cfg(not(windows))]
pub fn query_usn_cursor(_root: &str) -> Option<UsnCursor> {
    None
}

#[cfg(not(windows))]
pub fn read_usn_journal(_root: &str, _since: UsnCursor) -> UsnRead {
    UsnRead::Unavailable
}
