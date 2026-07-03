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

#[tauri::command]
pub async fn tag_counts(app: AppHandle) -> Result<HashMap<String, i64>> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        let conn = state.db_read()?;
        tags::counts(&conn)
    })
    .await
    .map_err(|e| Error::Operation(format!("tag counts interrupted: {e}")))?
}
