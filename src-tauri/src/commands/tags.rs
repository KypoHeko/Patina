//! Команды тегов.

use std::collections::HashMap;

use tauri::{AppHandle, Manager, State};

use crate::error::{Error, Result};
use crate::fs::lister;
use crate::index::tags_repo;
use crate::models::file::FileEntry;
use crate::state::AppState;

#[tauri::command]
pub fn assign_tag(state: State<AppState>, path: String, tag_id: String) -> Result<()> {
    let conn = state.db()?;
    tags_repo::assign(&conn, &path, &tag_id)
}

#[tauri::command]
pub fn remove_tag(state: State<AppState>, path: String, tag_id: String) -> Result<()> {
    let conn = state.db()?;
    tags_repo::remove(&conn, &path, &tag_id)
}

#[tauri::command]
pub async fn tags_for_paths(
    app: AppHandle,
    paths: Vec<String>,
) -> Result<HashMap<String, Vec<String>>> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        let conn = state.db_read()?;
        tags_repo::for_paths(&conn, &paths)
    })
    .await
    .map_err(|e| Error::Operation(format!("теги прерваны: {e}")))?
}

#[tauri::command]
pub fn paths_for_tag(state: State<AppState>, tag_id: String) -> Result<Vec<String>> {
    let conn = state.db_read()?;
    tags_repo::paths_for(&conn, &tag_id)
}

#[tauri::command]
pub async fn list_tag(app: AppHandle, tag_id: String) -> Result<Vec<FileEntry>> {
    tauri::async_runtime::spawn_blocking(move || -> Result<Vec<FileEntry>> {
        let state = app.state::<AppState>();
        let paths = {
            let conn = state.db_read()?;
            tags_repo::paths_for(&conn, &tag_id)?
        };
        Ok(paths.iter().filter_map(|p| lister::entry_from_path(p)).collect())
    })
    .await
    .map_err(|e| Error::Operation(format!("список тега прерван: {e}")))?
}

#[tauri::command]
pub async fn tag_counts(app: AppHandle) -> Result<HashMap<String, i64>> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        let conn = state.db_read()?;
        tags_repo::counts(&conn)
    })
    .await
    .map_err(|e| Error::Operation(format!("счётчики тегов прерваны: {e}")))?
}
