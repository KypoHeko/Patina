//! Reading directory contents.

use std::fs;
use std::path::Path;
use std::time::UNIX_EPOCH;

use crate::error::{Error, Result};
use crate::models::file::{EntryKind, FileEntry};

/// Build an entry from an arbitrary path (for virtual lists, e.g. by tag).
pub fn entry_from_path(path: &str) -> Option<FileEntry> {
    let p = Path::new(path);
    let meta = fs::metadata(p).ok()?;
    let name = p
        .file_name()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_else(|| path.to_string());
    let kind = if meta.is_dir() {
        EntryKind::Folder
    } else {
        EntryKind::File
    };
    let size = if matches!(kind, EntryKind::File) { meta.len() } else { 0 };
    let modified = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64);
    let extension = match kind {
        EntryKind::File => p.extension().map(|e| e.to_string_lossy().into_owned()),
        EntryKind::Folder => None,
    };
    Some(FileEntry { name, path: path.to_string(), kind, size, modified, extension })
}

pub fn list_dir(path: &str) -> Result<Vec<FileEntry>> {
    let dir = Path::new(path);
    if !dir.is_dir() {
        return Err(Error::NotADirectory(path.to_string()));
    }

    let mut entries: Vec<FileEntry> = Vec::new();

    for dirent in fs::read_dir(dir)? {
        let dirent = match dirent {
            Ok(d) => d,
            Err(_) => continue,
        };
        let meta = match dirent.metadata() {
            Ok(m) => m,
            Err(_) => continue,
        };

        let full = dirent.path();
        let name = dirent.file_name().to_string_lossy().into_owned();
        let kind = if meta.is_dir() {
            EntryKind::Folder
        } else {
            EntryKind::File
        };
        let size = if matches!(kind, EntryKind::File) { meta.len() } else { 0 };
        let modified = meta
            .modified()
            .ok()
            .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
            .map(|d| d.as_millis() as u64);
        let extension = match kind {
            EntryKind::File => full.extension().map(|e| e.to_string_lossy().into_owned()),
            EntryKind::Folder => None,
        };

        entries.push(FileEntry {
            name,
            path: full.to_string_lossy().into_owned(),
            kind,
            size,
            modified,
            extension,
        });
    }

    // Sorting is not done here: the single source of truth is the front end
    // (sortedEntries: folders above files + the active column). Double sorting
    // was wasted work on every directory listing.
    Ok(entries)
}
