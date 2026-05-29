//! Чтение содержимого директории.

use std::fs;
use std::path::Path;
use std::time::UNIX_EPOCH;

use crate::error::{Error, Result};
use crate::models::file::{EntryKind, FileEntry};

/// Возвращает содержимое директории: папки первыми, затем файлы, по алфавиту.
/// Записи, метаданные которых прочитать не удалось (заблокированы и т.п.),
/// тихо пропускаются — один битый файл не должен ронять весь листинг.
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

        let size = if matches!(kind, EntryKind::File) {
            meta.len()
        } else {
            0
        };

        let modified = meta
            .modified()
            .ok()
            .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
            .map(|d| d.as_millis() as u64);

        let extension = match kind {
            EntryKind::File => full
                .extension()
                .map(|e| e.to_string_lossy().into_owned()),
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

    entries.sort_by(|a, b| match (a.kind, b.kind) {
        (EntryKind::Folder, EntryKind::File) => std::cmp::Ordering::Less,
        (EntryKind::File, EntryKind::Folder) => std::cmp::Ordering::Greater,
        _ => a.name.to_lowercase().cmp(&b.name.to_lowercase()),
    });

    Ok(entries)
}
