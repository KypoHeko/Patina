//! Команды связей между файлами.

use tauri::State;

use crate::error::Result;
use crate::index::relationships_repo;
use crate::state::AppState;

#[tauri::command]
pub fn add_relationship(state: State<AppState>, a: String, b: String) -> Result<()> {
    let conn = state.db()?;
    relationships_repo::add(&conn, &a, &b)
}

#[tauri::command]
pub fn remove_relationship(state: State<AppState>, a: String, b: String) -> Result<()> {
    let conn = state.db()?;
    relationships_repo::remove(&conn, &a, &b)
}

#[tauri::command]
pub fn relationships_for(state: State<AppState>, paths: Vec<String>) -> Result<Vec<(String, String)>> {
    let conn = state.db()?;
    relationships_repo::for_paths(&conn, &paths)
}
