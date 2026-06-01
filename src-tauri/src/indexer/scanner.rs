//! Обход дерева каталогов (только файлы).

use std::time::UNIX_EPOCH;

use walkdir::WalkDir;

pub struct ScanFile {
    pub path: String,
    pub size: u64,
    pub mtime: i64,
}

pub fn walk(dir: &str) -> Vec<ScanFile> {
    WalkDir::new(dir)
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
        .collect()
}
