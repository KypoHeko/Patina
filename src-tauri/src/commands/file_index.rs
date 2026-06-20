//! Persistent file index commands.

use tauri::{AppHandle, Manager};
use walkdir::WalkDir;

use crate::error::{Error, Result};
use crate::index::file_index::{self, IndexRow};
use crate::models::file::FileEntry;
use crate::state::AppState;

const SCAN_LIMIT: usize = 50_000;

#[tauri::command]
pub async fn reindex_tree(app: AppHandle, root: String) -> Result<usize> {
    tauri::async_runtime::spawn_blocking(move || -> Result<usize> {
        let mut rows: Vec<IndexRow> = Vec::new();
        for entry in WalkDir::new(&root)
            .min_depth(1)
            .into_iter()
            .filter_map(|e| e.ok())
        {
            if rows.len() >= SCAN_LIMIT {
                break;
            }
            let meta = match entry.metadata() {
                Ok(m) => m,
                Err(_) => continue,
            };
            let is_dir = meta.is_dir();
            let path = entry.path().to_string_lossy().into_owned();
            let name = entry.file_name().to_string_lossy().into_owned();
            let mtime = meta
                .modified()
                .ok()
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_millis() as u64);
            let ext = if is_dir {
                None
            } else {
                entry.path().extension().map(|e| e.to_string_lossy().into_owned())
            };
            rows.push(IndexRow { path, name, is_dir, size: if is_dir { 0 } else { meta.len() }, mtime, ext });
        }
        let n = rows.len();
        {
            let state = app.state::<AppState>();
            let mut conn = state.db()?;
            file_index::replace_subtree(&mut conn, &root, &rows)?;
        }
        Ok(n)
    })
    .await
    .map_err(|e| Error::Operation(format!("reindex_tree interrupted: {e}")))?
}

#[tauri::command]
pub async fn search_files(
    app: AppHandle,
    root: String,
    query: String,
    limit: usize,
) -> Result<Vec<FileEntry>> {
    tauri::async_runtime::spawn_blocking(move || {
        let cap = if limit == 0 { 20_000 } else { limit };
        let state = app.state::<AppState>();
        let conn = state.db_read()?;
        file_index::search(&conn, &root, &query, cap)
    })
    .await
    .map_err(|e| Error::Operation(format!("search_files interrupted: {e}")))?
}
