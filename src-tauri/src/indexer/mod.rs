//! Сканирование, хеширование, поиск дубликатов и извлечение связей.

use std::path::Path;

use crate::index::file_index::IndexRow;

pub mod dups;
pub mod hasher;
pub mod links;
pub mod scanner;
pub mod usn_journal;

/// Строит строку файлового индекса из пути файловой системы.
/// Читает метаданные (размер, mtime, расширение) и возвращает `IndexRow`.
/// Возвращает `None`, если не удалось прочитать метаданные или имя файла.
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

/// Публичная обёртка над `build_row` для использования из `usn_journal`.
/// Принимает строковый путь, возвращает Option<IndexRow>.
#[allow(dead_code)] // TODO: используется USN-путём (sync_from_journal), пока не подключён
pub fn build_row_from_path(path: &str) -> Option<IndexRow> {
    build_row(Path::new(path))
}
