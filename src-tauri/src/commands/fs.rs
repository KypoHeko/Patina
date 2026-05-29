//! Команды файловой системы, вызываемые с фронта через invoke().

use tauri::Manager;

use crate::error::{Error, Result};
use crate::fs::lister;
use crate::models::file::FileEntry;

/// Содержимое директории по абсолютному пути.
#[tauri::command]
pub fn list_dir(path: String) -> Result<Vec<FileEntry>> {
    lister::list_dir(&path)
}

/// Домашняя папка пользователя — стартовая точка навигации.
#[tauri::command]
pub fn home_dir(app: tauri::AppHandle) -> Result<String> {
    let path = app
        .path()
        .home_dir()
        .map_err(|e| Error::InvalidPath(e.to_string()))?;
    Ok(path.to_string_lossy().into_owned())
}
