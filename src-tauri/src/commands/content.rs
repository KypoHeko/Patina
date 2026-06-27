//! Full-text content search commands.

use tauri::{AppHandle, Manager};
// use walkdir::WalkDir;

use crate::error::{Error, Result};
// use crate::index::content_index::{self, ContentHit, ContentRow};
use crate::index::content_index::{self, ContentHit};
// use crate::index::edges;
// use crate::index::file_index::IndexRow;
// use crate::index::text_detect;
use crate::state::AppState;
// use crate::commands::indexing::build_edges;
use crate::commands::indexing::build_all;

// const MAX_FILES: usize = 5_000;

/// Rebuild the content index from disk, filtering out ignored directories.
// #[tauri::command]
// pub async fn reindex_content(app: AppHandle, root: String) -> Result<usize> {
//     tauri::async_runtime::spawn_blocking(move || -> Result<usize> {
//         let mut content_rows: Vec<ContentRow> = Vec::new();
//         let mut index_rows: Vec<IndexRow> = Vec::new();
//         for entry in WalkDir::new(&root)
//             .min_depth(1)
//             .into_iter()
//             .filter_entry(|e| !text_detect::is_ignored_dir(e))
//             .filter_map(|e| e.ok())
//         {
//             if content_rows.len() >= MAX_FILES {
//                 break;
//             }
//             let path = entry.path();
//             let meta = match entry.metadata() {
//                 Ok(m) => m,
//                 Err(_) => continue,
//             };
//             let is_dir = meta.is_dir();
//             let pstr = path.to_string_lossy().into_owned();
//             let name = entry.file_name().to_string_lossy().into_owned();
//             let mtime = meta
//                 .modified()
//                 .ok()
//                 .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
//                 .map(|d| d.as_millis() as u64);
//             let ext = if is_dir {
//                 None
//             } else {
//                 path.extension().map(|e| e.to_string_lossy().into_owned())
//             };
//             index_rows.push(IndexRow {
//                 path: pstr.clone(),
//                 name,
//                 is_dir,
//                 size: if is_dir { 0 } else { meta.len() },
//                 mtime,
//                 ext,
//             });
//             if is_dir || !text_detect::is_text(path, meta.len()) {
//                 continue;
//             }
//             let bytes = match std::fs::read(path) {
//                 Ok(b) => b,
//                 Err(_) => continue,
//             };
//             content_rows.push(ContentRow {
//                 path: pstr,
//                 body: String::from_utf8_lossy(&bytes).into_owned(),
//             });
//         }
//         let n = content_rows.len();
//         {
//             let state = app.state::<AppState>();
//             let mut conn = state.db()?;
//             content_index::ensure_table(&conn)?;
//             content_index::replace_subtree(&mut conn, &root, &content_rows)?;
//             // Also rebuild derived edges (links/imports/mentions) from the
//             // freshly read content — previously reindex_content only updated
//             // the full-text index, leaving file_edges stale.
//             let edges = build_edges(&app, &root, &content_rows, &index_rows);
//             edges::replace_derived_subtree(&mut conn, &root, &edges)?;
//         }
//         Ok(n)
//     })
//     .await
//     .map_err(|e| Error::Operation(format!("reindex_content interrupted: {e}")))?
// }

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
