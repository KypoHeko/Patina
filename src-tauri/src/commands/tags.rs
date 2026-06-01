//! Команды тегов.

use std::collections::HashMap;

use tauri::State;

use crate::error::Result;
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
pub fn tags_for_paths(
    state: State<AppState>,
    paths: Vec<String>,
) -> Result<HashMap<String, Vec<String>>> {
    let conn = state.db()?;
    tags_repo::for_paths(&conn, &paths)
}

#[tauri::command]
pub fn paths_for_tag(state: State<AppState>, tag_id: String) -> Result<Vec<String>> {
    let conn = state.db()?;
    tags_repo::paths_for(&conn, &tag_id)
}

/// Виртуальный список: все существующие файлы с данным тегом.
#[tauri::command]
pub fn list_tag(state: State<AppState>, tag_id: String) -> Result<Vec<FileEntry>> {
    let paths = {
        let conn = state.db()?;
        tags_repo::paths_for(&conn, &tag_id)?
    };
    Ok(paths.iter().filter_map(|p| lister::entry_from_path(p)).collect())
}

#[tauri::command]
pub fn tag_counts(state: State<AppState>) -> Result<HashMap<String, i64>> {
    let conn = state.db()?;
    tags_repo::counts(&conn)
}
