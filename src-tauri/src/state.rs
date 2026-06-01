//! Глобальное состояние приложения (Tauri .manage()).

use std::path::PathBuf;
use std::sync::{Mutex, MutexGuard};

use notify::RecommendedWatcher;
use rusqlite::Connection;

use crate::error::{Error, Result};

pub struct AppState {
    pub db: Mutex<Connection>,
    pub versions_dir: PathBuf,
    pub thumbs_dir: PathBuf,
    pub watcher: Mutex<Option<RecommendedWatcher>>,
}

impl AppState {
    pub fn new(conn: Connection, versions_dir: PathBuf, thumbs_dir: PathBuf) -> Self {
        Self {
            db: Mutex::new(conn),
            versions_dir,
            thumbs_dir,
            watcher: Mutex::new(None),
        }
    }

    /// Захват соединения БД без паники: отравленный мьютекс превращается в
    /// обычную ошибку (её увидит фронт), а не в крах всего процесса.
    pub fn db(&self) -> Result<MutexGuard<'_, Connection>> {
        self.db
            .lock()
            .map_err(|_| Error::Operation("БД заблокирована (poisoned)".into()))
    }

    /// Захват вотчера без паники (по аналогии с db()).
    pub fn watcher(&self) -> Result<MutexGuard<'_, Option<RecommendedWatcher>>> {
        self.watcher
            .lock()
            .map_err(|_| Error::Operation("watcher заблокирован (poisoned)".into()))
    }
}
