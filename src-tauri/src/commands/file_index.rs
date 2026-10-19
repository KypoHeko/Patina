//! Persistent file index commands.

use tauri::{AppHandle, Manager};

use crate::error::{Error, Result};
use crate::index::file_index;
use crate::models::file::FileEntry;
use crate::state::AppState;

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
