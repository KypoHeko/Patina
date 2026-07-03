//! Scanning, hashing, duplicate detection, and link extraction.

use std::path::Path;

use crate::index::file_index::IndexRow;

pub mod dups;
pub mod hasher;
pub mod links;
pub mod scanner;
pub mod usn_journal;

/// Builds a file index row from a filesystem path.
/// Reads metadata (size, mtime, extension) and returns an `IndexRow`.
/// Returns `None` if the metadata or the file name could not be read.
pub fn build_row(path: &Path) -> Option<IndexRow> {
    let meta = std::fs::metadata(path).ok()?;
    let is_dir = meta.is_dir();
    let name = path.file_name()?.to_string_lossy().into_owned();
    let mtime = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64);
    let ext = if is_dir {
        None
    } else {
        path.extension().map(|e| e.to_string_lossy().into_owned())
    };
    Some(IndexRow {
        path: path.to_string_lossy().into_owned(),
        name,
        is_dir,
        size: if is_dir { 0 } else { meta.len() },
        mtime,
        ext,
    })
}

/// Public wrapper over `build_row` for use from `usn_journal`.
/// Takes a string path, returns Option<IndexRow>.
pub fn build_row_from_path(path: &str) -> Option<IndexRow> {
    build_row(Path::new(path))
}
