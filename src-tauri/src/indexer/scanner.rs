//! Directory walk (files only) for duplicate detection: the whole SUBTREE of
//! the folder, skipping VCS/build/cache folders and symlinks, capped at `cap`
//! files so the cost stays predictable on giant trees.

use std::time::UNIX_EPOCH;

use walkdir::WalkDir;

use crate::index::text_detect;

pub struct ScanFile {
    pub path: String,
    pub size: u64,
    /// Modification time, Unix ms.
    pub mtime: i64,
}

/// Files in the subtree of `dir`, at most `cap` of them.
pub fn walk(dir: &str, cap: usize) -> Vec<ScanFile> {
    WalkDir::new(dir)
        .min_depth(1)
        .follow_links(false)
        .into_iter()
        .filter_entry(|e| !text_detect::is_ignored_dir(e))
        .filter_map(|e| e.ok())
        .filter(|e| e.file_type().is_file())
        .filter_map(|e| {
            let md = e.metadata().ok()?;
            let mtime = md
                .modified()
                .ok()?
                .duration_since(UNIX_EPOCH)
                .ok()?
                .as_millis() as i64;
            Some(ScanFile {
                path: e.path().to_string_lossy().into_owned(),
                size: md.len(),
                mtime,
            })
        })
        .take(cap)
        .collect()
}
