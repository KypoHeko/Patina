//! Full-text content search commands.

use tauri::{AppHandle, Manager};

use crate::error::{Error, Result};
use crate::index::content_index::{self, ContentHit};
use crate::state::AppState;

/// Full-text content search within a subtree.
#[tauri::command]
pub async fn search_content(
    app: AppHandle,
    root: String,
    query: String,
    limit: usize,
) -> Result<Vec<ContentHit>> {
    tauri::async_runtime::spawn_blocking(move || -> Result<Vec<ContentHit>> {
        let cap = if limit == 0 { 200 } else { limit };
        let state = app.state::<AppState>();
        let result = {
            let conn = state.db_read()?;
            content_index::search(&conn, &root, &query, cap)
        };
        let hits = match result {
            Ok(hits) => hits,
            // Only a missing FTS table (no content index built yet) is worth a
            // retry; any other error is reported instead of being masked by a
            // second attempt under the write lock.
            Err(Error::Db(e)) if e.to_string().contains("no such table") => {
                let conn = state.db()?;
                content_index::ensure_table(&conn)?;
                content_index::search(&conn, &root, &query, cap)?
            }
            Err(e) => return Err(e),
        };
        Ok(hits)
    })
    .await
    .map_err(|e| Error::Operation(format!("search_content interrupted: {e}")))?
}
