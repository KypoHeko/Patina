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

#[cfg(windows)]
pub mod windows;

// ─── Re-export Windows functions at the platform::* level ─────────
// On Windows the functions are implemented in windows.rs, but calling code
// uses platform::read_usn_journal, platform::list_drives_native, etc.
// The re-export makes them available without the windows:: qualification.

#[cfg(windows)]
pub use windows::{delete_to_recycle_bin, list_drives_native};

// Re-export native icons and the USN Journal for use in commands.
#[cfg(windows)]
pub use windows::{get_native_icon, read_usn_journal};

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

/// Incremental changes obtained from the USN Journal.
#[derive(Debug)]
pub struct UsnChanges {
    /// Paths of files that were created or modified
    pub modified: Vec<String>,
    /// Paths of files that were deleted
    pub deleted: Vec<String>,
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

#[cfg(not(windows))]
pub fn read_usn_journal(_root: &str, _last_usn: i64) -> crate::error::Result<Option<UsnChanges>> {
    // The USN Journal is available only on NTFS/Windows
    Ok(None)
}
