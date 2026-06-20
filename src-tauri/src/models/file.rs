//! A file/folder entry (`FileEntry`) and its kind (`EntryKind`) for the front end.

use serde::Serialize;

/// The kind of a directory entry.
#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum EntryKind {
    File,
    Folder,
}

/// A single entry in a file listing. Fields are serialized as camelCase for the front end.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileEntry {
    pub name: String,
    pub path: String,
    pub kind: EntryKind,
    /// Size in bytes (0 for folders).
    pub size: u64,
    /// Modification time, milliseconds since epoch (None if unavailable).
    pub modified: Option<u64>,
    /// Extension without the dot (files only).
    pub extension: Option<String>,
}
