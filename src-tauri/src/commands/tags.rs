//! Tag commands.

use std::collections::HashMap;

use tauri::{AppHandle, Manager};

use crate::error::{Error, Result};
use crate::fs::lister;
use crate::index::tags;
use crate::models::file::FileEntry;
use crate::state::AppState;

#[tauri::command]
pub async fn assign_tag(app: AppHandle, path: String, tag_id: String) -> Result<()> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        let conn = state.db()?;
        tags::assign(&conn, &path, &tag_id)
    })
    .await
    .map_err(|e| Error::Operation(format!("assign_tag interrupted: {e}")))?
}

/// Tag or untag a whole selection in one call and one transaction.
#[tauri::command]
pub async fn set_tag_many(app: AppHandle, paths: Vec<String>, tag_id: String, on: bool) -> Result<()> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        let conn = state.db()?;
        tags::set_many(&conn, &paths, &tag_id, on)
    })
    .await
    .map_err(|e| Error::Operation(format!("set_tag_many interrupted: {e}")))?
}

#[tauri::command]
pub async fn remove_tag(app: AppHandle, path: String, tag_id: String) -> Result<()> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        let conn = state.db()?;
        tags::remove(&conn, &path, &tag_id)
    })
    .await
    .map_err(|e| Error::Operation(format!("remove_tag interrupted: {e}")))?
}

#[tauri::command]
pub async fn tags_for_paths(
    app: AppHandle,
    paths: Vec<String>,
) -> Result<HashMap<String, Vec<String>>> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        let conn = state.db_read()?;
        tags::for_paths(&conn, &paths)
    })
    .await
    .map_err(|e| Error::Operation(format!("tags interrupted: {e}")))?
}

#[tauri::command]
pub async fn paths_for_tag(app: AppHandle, tag_id: String) -> Result<Vec<String>> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        let conn = state.db_read()?;
        tags::paths_for(&conn, &tag_id)
    })
    .await
    .map_err(|e| Error::Operation(format!("paths_for_tag interrupted: {e}")))?
}

#[tauri::command]
pub async fn list_tag(app: AppHandle, tag_id: String) -> Result<Vec<FileEntry>> {
    tauri::async_runtime::spawn_blocking(move || -> Result<Vec<FileEntry>> {
        let state = app.state::<AppState>();
        let paths = {
            let conn = state.db_read()?;
            tags::paths_for(&conn, &tag_id)?
        };
        Ok(paths.iter().filter_map(|p| lister::entry_from_path(p)).collect())
    })
    .await
    .map_err(|e| Error::Operation(format!("tag listing interrupted: {e}")))?
}

/// Number of EXISTING files per tag. Files deleted or renamed outside Patina
/// keep their tag rows (they may come back, e.g. a removable drive), but they
/// must not inflate the sidebar counters — the tag view already hides them.
#[tauri::command]
pub async fn tag_counts(app: AppHandle) -> Result<HashMap<String, i64>> {
    tauri::async_runtime::spawn_blocking(move || -> Result<HashMap<String, i64>> {
        let state = app.state::<AppState>();
        let rows = {
            let conn = state.db_read()?;
            tags::all(&conn)?
        };
        let mut counts: HashMap<String, i64> = HashMap::new();
        for (path, tag) in rows {
            if std::path::Path::new(&path).exists() {
                *counts.entry(tag).or_default() += 1;
            }
        }
        Ok(counts)
    })
    .await
    .map_err(|e| Error::Operation(format!("tag counts interrupted: {e}")))?
}
