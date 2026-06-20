//! Directory walk (files only). For duplicate detection we take ONLY the
//! current folder (no recursion) and cap the number of files — so the scan cost
//! is predictable and does not blow up on giant subtrees.

use std::time::UNIX_EPOCH;

use walkdir::WalkDir;

pub struct ScanFile {
    pub path: String,
    pub size: u64,
    pub mtime: i64,
}

/// Files directly in `dir` (non-recursive), at most `cap` of them.
pub fn walk(dir: &str, cap: usize) -> Vec<ScanFile> {
    WalkDir::new(dir)
        .min_depth(1)
        // .max_depth(1) // current folder only
        .into_iter()
        .filter_map(|e| e.ok())
        .filter(|e| e.file_type().is_file())
        .filter_map(|e| {
            let md = e.metadata().ok()?;
            let mtime = md
                .modified()
                .ok()?
                .duration_since(UNIX_EPOCH)
                .ok()?
                .as_secs() as i64;
            Some(ScanFile {
                path: e.path().to_string_lossy().into_owned(),
                size: md.len(),
                mtime,
            })
        })
        .take(cap)
        .collect()
}
