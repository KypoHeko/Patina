//! Filesystem commands.

use std::fs::File;
use std::io::{Cursor, Read};
use std::path::Path;
use std::time::UNIX_EPOCH;

use rusqlite::Connection;
use serde::Serialize;
use tauri::{AppHandle, Manager};

use crate::error::{Error, Result};

use crate::fs::{lister, operations};
use crate::index::{edges, tags, text_detect, versions};
use crate::models::file::FileEntry;
use crate::state::AppState;

/// Move all path-bound data (tags, versions, links) from the old path to the
/// new one — a single point for move/rename. Errors from individual
/// repositories are intentionally swallowed: the file is already moved on disk,
/// and a failure of the accompanying metadata must not roll back the operation.
fn relink_all(conn: &Connection, old: &str, new: &str) {
    let _ = tags::relink(conn, old, new);
    let _ = versions::relink(conn, old, new);
    let _ = edges::relink(conn, old, new);
}

/// Drop path-bound data for a path moved to the Recycle Bin (and nested ones).
/// Tags and links are removed; version history is only MARKED as deleted, so
/// a file restored from the Bin keeps its history (expired history is removed
/// by `versions::collect_garbage`). Errors are swallowed for the same reasons
/// as in `relink_all`.
fn purge_all(conn: &Connection, path: &str) {
    let now = std::time::SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0);
    let _ = tags::purge(conn, path);
    let _ = versions::mark_deleted(conn, path, now);
    let _ = edges::purge(conn, path);
}

#[tauri::command]
pub async fn list_dir(path: String) -> Result<Vec<FileEntry>> {
    // Directory listing is blocking I/O. Offload to spawn_blocking so we do not
    // occupy the webview's main thread (otherwise panels "hang" during navigation).
    tauri::async_runtime::spawn_blocking(move || lister::list_dir(&path))
        .await
        .map_err(|e| Error::Operation(format!("listing interrupted: {e}")))?
}

#[tauri::command]
pub fn home_dir(app: AppHandle) -> Result<String> {
    let path = app
        .path()
        .home_dir()
        .map_err(|e| Error::InvalidPath(e.to_string()))?;
    Ok(path.to_string_lossy().into_owned())
}

#[tauri::command]
pub async fn copy_entries(sources: Vec<String>, dest_dir: String, overwrite: bool) -> Result<()> {
    tauri::async_runtime::spawn_blocking(move || {
        operations::copy_entries(&sources, &dest_dir, overwrite)
    })
    .await
    .map_err(|e| Error::Operation(format!("copy_entries interrupted: {e}")))?
}

#[tauri::command]
pub async fn move_entries(
    app: AppHandle,
    sources: Vec<String>,
    dest_dir: String,
    overwrite: bool,
) -> Result<()> {
    tauri::async_runtime::spawn_blocking(move || {
        // One entry at a time, relinking each right after it moved: a batch
        // move that failed half-way used to return before ANY relink, leaving
        // the tags and history of the entries that did move under their old
        // paths. Failures are collected and reported together.
        let state = app.state::<AppState>();
        let mut failed: Vec<String> = Vec::new();
        for src in &sources {
            let name = Path::new(src)
                .file_name()
                .map(|n| n.to_string_lossy().into_owned())
                .unwrap_or_else(|| src.clone());
            match operations::move_entries(std::slice::from_ref(src), &dest_dir, overwrite) {
                Ok(()) => {
                    let new_path = Path::new(&dest_dir).join(&name);
                    let conn = state.db()?;
                    relink_all(&conn, src, &new_path.to_string_lossy());
                }
                Err(e) => failed.push(format!("{name}: {e}")),
            }
        }
        if failed.is_empty() {
            Ok(())
        } else {
            Err(Error::Operation(format!("not moved — {}", failed.join("; "))))
        }
    })
    .await
    .map_err(|e| Error::Operation(format!("move_entries interrupted: {e}")))?
}

#[tauri::command]
pub async fn delete_entries(app: AppHandle, paths: Vec<String>) -> Result<()> {
    tauri::async_runtime::spawn_blocking(move || {
        let res = operations::delete_entries(&paths);
        // Drop metadata only for what is really gone: a deletion that was
        // cancelled or failed for some items must not erase the tags and
        // links of files that are still there.
        let state = app.state::<AppState>();
        let conn = state.db()?;
        for p in paths.iter().filter(|p| !Path::new(p.as_str()).exists()) {
            purge_all(&conn, p);
        }
        res
    })
    .await
    .map_err(|e| Error::Operation(format!("delete_entries interrupted: {e}")))?
}

#[tauri::command]
pub async fn rename_entry(app: AppHandle, path: String, new_name: String) -> Result<String> {
    tauri::async_runtime::spawn_blocking(move || {
        let new_path = operations::rename_entry(&path, &new_name)?;
        let state = app.state::<AppState>();
        let conn = state.db()?;
        relink_all(&conn, &path, &new_path);
        Ok(new_path)
    })
    .await
    .map_err(|e| Error::Operation(format!("rename_entry interrupted: {e}")))?
}

/// Names of entries that already exist in the destination directory.
#[tauri::command]
pub async fn check_conflicts(sources: Vec<String>, dest_dir: String) -> Result<Vec<String>> {
    tauri::async_runtime::spawn_blocking(move || -> Result<Vec<String>> {
        let mut out = Vec::new();
        for src in &sources {
            if let Some(name) = Path::new(src).file_name()
                && Path::new(&dest_dir).join(name).exists()
            {
                out.push(name.to_string_lossy().into_owned());
            }
        }
        Ok(out)
    })
    .await
    .map_err(|e| Error::Operation(format!("check_conflicts interrupted: {e}")))?
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Preview {
    kind: String, // "text" | "image" | "none"
    name: String,
    text: Option<String>,
    data_url: Option<String>,
    /// Absolute path to a cached thumbnail, served to the webview via the asset
    /// protocol (avoids base64 + a large IPC payload). None for non-images.
    thumb_path: Option<String>,
    /// File size in bytes
    size: u64,
    /// Modification time (Unix ms)
    modified: i64,
    /// Creation time (Unix ms), 0 if unavailable
    created: i64,
}

pub fn b64(data: &[u8]) -> String {
    const T: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(data.len().div_ceil(3) * 4);
    for chunk in data.chunks(3) {
        let b0 = chunk[0] as u32;
        let b1 = *chunk.get(1).unwrap_or(&0) as u32;
        let b2 = *chunk.get(2).unwrap_or(&0) as u32;
        let n = (b0 << 16) | (b1 << 8) | b2;
        out.push(T[((n >> 18) & 63) as usize] as char);
        out.push(T[((n >> 12) & 63) as usize] as char);
        out.push(if chunk.len() > 1 { T[((n >> 6) & 63) as usize] as char } else { '=' });
        out.push(if chunk.len() > 2 { T[(n & 63) as usize] as char } else { '=' });
    }
    out
}

/// Largest SVG inlined into the preview.
const MAX_SVG_PREVIEW: u64 = 2 * 1024 * 1024;

const RASTER: &[&str] = &["png", "jpg", "jpeg", "gif", "webp", "bmp", "ico", "tiff", "tif"];

fn file_times(meta: &std::fs::Metadata) -> (i64, i64) {
    let modified = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0);
    let created = meta
        .created()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0);
    (modified, created)
}

fn none_preview(name: String, meta: &std::fs::Metadata) -> Preview {
    let (modified, created) = file_times(meta);
    Preview { kind: "none".into(), name, text: None, data_url: None, thumb_path: None, size: meta.len(), modified, created }
}

/// Synchronous preview implementation. Called from `read_preview` inside
/// `spawn_blocking` so that heavy image decoding does not occupy an
/// async-runtime worker.
fn build_preview(thumbs_dir: &Path, path: &str) -> Result<Preview> {
    let p = Path::new(path);
    let name = p
        .file_name()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_default();
    let ext = p
        .extension()
        .map(|e| e.to_string_lossy().to_ascii_lowercase())
        .unwrap_or_default();
    let meta = std::fs::metadata(path)?;
    if meta.is_dir() {
        return Ok(none_preview(name, &meta));
    }

    // SVG is a vector — inline it as-is (no rasterization). Inlined as a data
    // URL over IPC, so a huge (or hostile) SVG is not previewed at all instead
    // of being read into memory whole.
    if ext == "svg" {
        if meta.len() > MAX_SVG_PREVIEW {
            return Ok(none_preview(name, &meta));
        }
        let bytes = std::fs::read(path)?;
        let (modified, created) = file_times(&meta);
        return Ok(Preview {
            kind: "image".into(),
            name,
            text: None,
            data_url: Some(format!("data:image/svg+xml;base64,{}", b64(&bytes))),
            thumb_path: None,
            size: meta.len(),
            modified,
            created,
        });
    }

    // Raster images — a thumbnail with a disk cache.
    if RASTER.contains(&ext.as_str()) {
        let mtime = meta
            .modified()
            .ok()
            .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
            .map(|d| d.as_millis())
            .unwrap_or(0);
        let key = blake3::hash(format!("{path}|{mtime}|{}", meta.len()).as_bytes())
            .to_hex()
            .to_string();
        let cache = thumbs_dir.join(format!("{key}.jpg"));
        let (modified, created) = file_times(&meta);

        // Generate the thumbnail once; later opens reuse the cached file, which
        // the webview loads directly via the asset protocol.
        let ready = cache.exists()
            || image::open(path).is_ok_and(|img| {
                let rgb = image::DynamicImage::ImageRgb8(img.thumbnail(1024, 1024).to_rgb8());
                let mut bytes = Vec::new();
                rgb.write_to(&mut Cursor::new(&mut bytes), image::ImageFormat::Jpeg).is_ok()
                    && crate::fs::atomic::write_atomic(&cache, &bytes).is_ok()
            });

        if ready {
            return Ok(Preview {
                kind: "image".into(),
                name,
                text: None,
                data_url: None,
                thumb_path: Some(cache.to_string_lossy().into_owned()),
                size: meta.len(),
                modified,
                created,
            });
        }
        return Ok(none_preview(name, &meta));
    }

    // One list of text extensions for preview and content indexing.
    if text_detect::TEXT_EXTS.contains(&ext.as_str()) {
        let mut f = File::open(path)?;
        let mut buf = vec![0u8; 16 * 1024];
        let n = f.read(&mut buf)?;
        buf.truncate(n);
        let (modified, created) = file_times(&meta);
        return Ok(Preview {
            kind: "text".into(),
            name,
            text: Some(String::from_utf8_lossy(&buf).into_owned()),
            data_url: None,
            thumb_path: None,
            size: meta.len(),
            modified,
            created,
        });
    }
    Ok(none_preview(name, &meta))
}

/// Preview: a text "head", SVG as-is, or a thumbnail of a raster image. Raster
/// images are decoded and shrunk to 1024px on the Rust side, the result is
/// cached on disk (key = path+mtime+size), so repeat opens are instant and work
/// for images of any size. The heavy work goes to the blocking pool, without
/// occupying async-runtime workers.
///
/// Also returns the file's metadata (size, dates) for display in the FILE INFO
/// section of the preview panel.
#[tauri::command]
pub async fn read_preview(app: AppHandle, path: String) -> Result<Preview> {
    tauri::async_runtime::spawn_blocking(move || -> Result<Preview> {
        let state = app.state::<AppState>();
        build_preview(&state.thumbs_dir, &path)
    })
    .await
    .map_err(|e| Error::Operation(format!("preview interrupted: {e}")))?
}

/// Largest `.gitignore` handed to the graph.
const MAX_GITIGNORE: u64 = 256 * 1024;

/// Contents of `<dir>/.gitignore` for the graph's ignore filter, or `None`
/// when there is none (or it is not a regular file, or is implausibly big).
/// The graph used to fetch it through the asset protocol, which therefore had
/// to be opened for the whole disk (`scope: **`) — any script running in the
/// webview could read any file. Now the protocol only serves thumbnails and
/// this command reads exactly one file name.
#[tauri::command]
pub async fn read_gitignore(dir: String) -> Result<Option<String>> {
    tauri::async_runtime::spawn_blocking(move || -> Result<Option<String>> { Ok(read_gitignore_sync(Path::new(&dir))) })
        .await
        .map_err(|e| Error::Operation(format!("read_gitignore interrupted: {e}")))?
}

fn read_gitignore_sync(dir: &Path) -> Option<String> {
    let path = dir.join(".gitignore");
    let meta = std::fs::symlink_metadata(&path).ok()?;
    if !meta.is_file() || meta.len() > MAX_GITIGNORE {
        return None;
    }
    let bytes = std::fs::read(&path).ok()?;
    Some(String::from_utf8_lossy(&bytes).into_owned())
}

/// Create a new folder in `parent`. If the name is taken, appends " (N)".
/// Returns the path of the created folder.
#[tauri::command]
pub async fn create_folder(parent: String, name: String) -> Result<String> {
    tauri::async_runtime::spawn_blocking(move || -> Result<String> {
        // Security: reject separators / traversal components in the name — same
        // rule as `rename_entry`. Without this, `name = "..\..\evil"` would
        // escape `parent` via `Path::join` and create a folder anywhere the
        // user has permission.
        if name.is_empty() || name.contains('/') || name.contains('\\') {
            return Err(Error::InvalidPath(format!("invalid folder name: {name}")));
        }
        let base = Path::new(&parent);
        if !base.is_dir() {
            return Err(Error::NotADirectory(parent));
        }
        let mut candidate = base.join(&name);
        let mut n = 2;
        while candidate.exists() {
            candidate = base.join(format!("{name} ({n})"));
            n += 1;
        }
        std::fs::create_dir(&candidate)?;
        Ok(candidate.to_string_lossy().into_owned())
    })
    .await
    .map_err(|e| Error::Operation(format!("create_folder interrupted: {e}")))?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn gitignore_is_read_only_when_it_is_a_small_regular_file() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(read_gitignore_sync(dir.path()), None);
        std::fs::write(dir.path().join(".gitignore"), "target/\n").unwrap();
        assert_eq!(read_gitignore_sync(dir.path()).as_deref(), Some("target/\n"));
        std::fs::write(dir.path().join(".gitignore"), vec![b'#'; (MAX_GITIGNORE + 1) as usize]).unwrap();
        assert_eq!(read_gitignore_sync(dir.path()), None);
    }
}
