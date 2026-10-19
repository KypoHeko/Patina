//! Full-text content search commands.

use tauri::{AppHandle, Manager};

use crate::error::{Error, Result};
use crate::index::content_index::{self, ContentHit};
use crate::state::AppState;
use crate::commands::indexing::build_all;

/// Rebuild the content index from disk, filtering out ignored directories.
/// Delegates to `build_all(content=true)` which walks the filesystem, builds
/// the file index, content index, and derived edges in a single pass — instead
/// of duplicating the walk logic here.
#[tauri::command]
pub async fn reindex_content(app: AppHandle, root: String) -> Result<usize> {
    tauri::async_runtime::spawn_blocking(move || -> Result<usize> {
        build_all(&app, &root, true)?;
        // Return the number of content rows as a convenience metric.
        let state = app.state::<AppState>();
        let n = if let Ok(conn) = state.db_read() {
            content_index::count_subtree(&conn, &root)?
        } else {
            0
        };
        Ok(n)
    })
    .await
    .map_err(|e| Error::Operation(format!("reindex_content interrupted: {e}")))?
}

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
            Err(_) => {
                // Table may not exist yet — create it and retry.
                let conn = state.db()?;
                content_index::ensure_table(&conn)?;
                content_index::search(&conn, &root, &query, cap)?
            }
        };
        Ok(hits)
    })
    .await
    .map_err(|e| Error::Operation(format!("search_content interrupted: {e}")))?
}
