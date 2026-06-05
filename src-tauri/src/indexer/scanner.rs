//! Обход каталога (только файлы). Для поиска дубликатов берём ТОЛЬКО текущую
//! папку (без рекурсии) и ограничиваем число файлов — чтобы стоимость скана
//! была предсказуемой и не упиралась в гигантские поддеревья.

use std::time::UNIX_EPOCH;

use walkdir::WalkDir;

pub struct ScanFile {
    pub path: String,
    pub size: u64,
    pub mtime: i64,
}

/// Файлы непосредственно в `dir` (не рекурсивно), не более `cap` штук.
pub fn walk(dir: &str, cap: usize) -> Vec<ScanFile> {
    WalkDir::new(dir)
        .min_depth(1)
        .max_depth(1) // только текущая папка
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
