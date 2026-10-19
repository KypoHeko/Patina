//! System commands: launching files, revealing in the file manager, sidebar
//! locations, native file icons (SHGetFileInfo on Windows).

use serde::Serialize;
use tauri::{AppHandle, Manager};

use crate::index::quick_access::{self, QuickItem};
use crate::state::AppState;
use crate::error::{Error, Result};

/// Native icon request result: a data URL for use in an <img>.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeIconResult {
    /// data:image/png;base64,... — a ready URL for <img src="...">
    data_url: String,
    width: u32,
    height: u32,
}

/// A sidebar entry: label, path, kind (for the icon on the front end).
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Location {
    label: String,
    path: String,
    kind: String,
}

/// Open a path in the default application (.lnk shortcuts are resolved by the OS).
#[tauri::command]
pub fn open_path(path: String) -> Result<()> {
    open::that(&path)?;
    Ok(())
}

/// Reveal a file in the system file manager (with selection on Windows).
///
/// Security: NTFS allows `"` in file names. Earlier we built the argument
/// manually via `raw_arg("/select,\"{}\"", path)` — a name containing `"`
/// would break out of the quoted region and let `explorer.exe` parse the rest
/// as a separate argument (potentially an executable path to launch).
///
/// Now we (a) reject paths containing `"` outright (defence in depth —
/// `explorer /select,` cannot legitimately address such a path anyway) and
/// (b) rely on Rust's `Command::arg`, which applies `CommandLineToArgvW`
/// quoting rules instead of our own. Together these close the injection.
#[tauri::command]
pub fn reveal_in_explorer(path: String) -> Result<()> {
    if path.contains('"') {
        return Err(Error::InvalidPath(
            "path contains a double quote, refusing to pass to explorer".into(),
        ));
    }
    #[cfg(windows)]
    {
        use std::process::Command;
        // `.arg(...)` lets std apply the standard CommandLineToArgvW quoting.
        // No manual quotes around the path — std adds them when needed.
        Command::new("explorer")
            .arg(format!("/select,{}", path))
            .spawn()?;
        Ok(())
    }
    #[cfg(not(windows))]
    {
        let target = std::path::Path::new(&path)
            .parent()
            .map(std::path::Path::to_path_buf)
            .unwrap_or_else(|| std::path::PathBuf::from(&path));
        open::that(target)?;
        Ok(())
    }
}

/// Quick access: home, desktop, documents, downloads
/// (only the ones that exist).
pub fn quick_access_defaults(app: &tauri::AppHandle) -> Vec<Location> {
    let p = app.path();

    let candidates = [
        ("Домашняя", "home", p.home_dir()),
        ("Рабочий стол", "desktop", p.desktop_dir()),
        ("Документы", "documents", p.document_dir()),
        ("Загрузки", "downloads", p.download_dir()),
    ];
    candidates
        .into_iter()
        .filter_map(|(label, kind, res)| {
            let path = res.ok()?;
            if !path.exists() {
                return None;
            }
            Some(Location {
                label: label.into(),
                path: path.to_string_lossy().into_owned(),
                kind: kind.into(),
            })
        })
        .collect()
}

#[tauri::command]
pub async fn quick_access(app: AppHandle) -> Result<Vec<Location>> {
    tauri::async_runtime::spawn_blocking(move || -> Result<Vec<Location>> {
        let state = app.state::<AppState>();
        // Check whether data exists (read); if empty — seed it (write).
        let conn = state.db()?;
        if quick_access::is_empty(&conn)? {
            let seed: Vec<QuickItem> = quick_access_defaults(&app)
                .into_iter()
                .map(|l| QuickItem { path: l.path, label: l.label, kind: l.kind })
                .collect();
            quick_access::replace_all(&conn, &seed)?;
        }
        let items = quick_access::list(&conn)?;
        Ok(items
            .into_iter()
            .map(|i| Location { label: i.label, path: i.path, kind: i.kind })
            .collect())
    })
    .await
    .map_err(|e| Error::Operation(format!("quick_access interrupted: {e}")))?
}

/// Save the user's list (full replacement).
#[tauri::command]
pub async fn quick_access_save(app: AppHandle, items: Vec<QuickItem>) -> Result<()> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        let conn = state.db()?;
        quick_access::replace_all(&conn, &items)
    })
    .await
    .map_err(|e| Error::Operation(format!("quick_access_save interrupted: {e}")))?
}

/// List the available drives. Enumeration touches the filesystem (checking that
/// roots exist), so we offload it to the blocking pool — uniform policy with the
/// other commands that touch the disk.
#[tauri::command]
pub async fn list_drives() -> Vec<Location> {
    tauri::async_runtime::spawn_blocking(list_drives_sync)
        .await
        .unwrap_or_default()
}

fn list_drives_sync() -> Vec<Location> {
    let mut out = Vec::new();
    #[cfg(windows)]
    {
        for letter in b'A'..=b'Z' {
            let c = letter as char;
            let root = format!("{}:\\", c);
            if std::path::Path::new(&root).exists() {
                out.push(Location {
                    label: format!("{}:", c),
                    path: root,
                    kind: "drive".into(),
                });
            }
        }
    }
    #[cfg(not(windows))]
    {
        out.push(Location {
            label: "/".into(),
            path: "/".into(),
            kind: "drive".into(),
        });
    }
    out
}

/// A storage entry for the sidebar.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Storage {
    name: String,
    path: String,
    kind: String,
    total: u64,
    used: u64,
}

/// List of volumes: mount point, kind (SSD/HDD), used/total.
/// The "Cloud" kind is not detected via sysinfo — it shows as a plain "Disk".
/// Bounded by a 5 s timeout — sysinfo can hang on network volumes.
#[tauri::command]
pub async fn list_storage() -> Vec<Storage> {
    // sysinfo walks all volumes — this is blocking work, move it off the main
    // thread (at startup the sidebar must not slow down window rendering).
    tauri::async_runtime::spawn_blocking(list_storage_sync)
        .await
        .unwrap_or_default()
}

/// On Windows — native volume enumeration via WinAPI: real volume labels and
/// media type (SSD/HDD). sysinfo on Windows often returns empty labels.
#[cfg(windows)]
fn list_storage_sync() -> Vec<Storage> {
    crate::platform::list_drives_native()
        .into_iter()
        .map(|d| Storage {
            name: if d.label.is_empty() {
                d.path.trim_end_matches('\\').to_string()
            } else {
                d.label
            },
            path: d.path,
            kind: d.kind,
            total: d.total,
            used: d.total.saturating_sub(d.available),
        })
        .collect()
}

/// On Linux/macOS — via the cross-platform sysinfo.
#[cfg(not(windows))]
fn list_storage_sync() -> Vec<Storage> {
    use std::collections::HashSet;
    use sysinfo::{DiskKind, Disks};

    let disks = Disks::new_with_refreshed_list();
    let mut seen: HashSet<String> = HashSet::new();
    let mut out = Vec::new();
    for d in disks.list() {
        let mp = d.mount_point().to_string_lossy().into_owned();
        if !seen.insert(mp.clone()) {
            continue;
        }
        let total = d.total_space();
        let avail = d.available_space();
        let kind = match d.kind() {
            DiskKind::SSD => "SSD",
            DiskKind::HDD => "HDD",
            _ => "Диск",
        }
        .to_string();
        let trimmed = mp.trim_end_matches(|c| c == '\\' || c == '/');
        let name = if trimmed.is_empty() { mp.clone() } else { trimmed.to_string() };
        out.push(Storage {
            name,
            path: mp,
            kind,
            total,
            used: total.saturating_sub(avail),
        });
    }
    out
}

/// Get a native file/folder icon via WinAPI (SHGetFileInfo).
///
/// On Windows it extracts the real system icon (as in the file manager),
/// converts it to PNG and returns it as a data URL. On other platforms it
/// returns None — the front end uses an SVG fallback.
///
/// Icons are cached on disk (key = path+mtime+size), so repeat requests are
/// instant. The heavy work goes to the blocking pool.
#[tauri::command]
pub async fn native_icon(app: AppHandle, path: String, size: u32) -> Result<Option<NativeIconResult>> {
    tauri::async_runtime::spawn_blocking(move || -> Result<Option<NativeIconResult>> {
        // Disk cache: key = blake3(path + mtime + size)
        let state = app.state::<AppState>();
        let meta = std::fs::metadata(&path);
        let mtime = meta.as_ref().ok().and_then(|m| {
            m.modified().ok().and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_millis())
        }).unwrap_or(0);
        let fsize = meta.as_ref().map(|m| m.len()).unwrap_or(0);
        let cache_key = blake3::hash(format!("{path}|{mtime}|{fsize}|icon{size}").as_bytes())
            .to_hex().to_string();
        let cache_path = state.thumbs_dir.join(format!("icon_{cache_key}.bin"));

        // Check the cache
        if let Ok(cached) = std::fs::read(&cache_path)
            && let Ok(data_url) = String::from_utf8(cached) {
                return Ok(Some(NativeIconResult {
                    data_url,
                    width: size,
                    height: size,
                }));
            }

        // Get the native icon
        let icon = crate::platform::get_native_icon(&path, size);
        match icon {
            Some(ni) => {
                let data_url = format!(
                    "data:image/png;base64,{}",
                    crate::commands::fs::b64(&ni.png)
                );
                // Save to the cache
                let _ = std::fs::write(&cache_path, data_url.as_bytes());
                Ok(Some(NativeIconResult {
                    data_url,
                    width: ni.width,
                    height: ni.height,
                }))
            }
            None => Ok(None),
        }
    })
    .await
    .map_err(|e| Error::Operation(format!("native_icon interrupted: {e}")))?
}
