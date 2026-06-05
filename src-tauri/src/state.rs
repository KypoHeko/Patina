//! Глобальное состояние приложения (Tauri .manage()).

use std::path::PathBuf;
use std::sync::{Mutex, MutexGuard};

use notify::RecommendedWatcher;
use rusqlite::Connection;

use crate::error::{Error, Result};

/// Состояние живого индекса: какой корень индексируется и активен ли контент-индекс.
#[derive(Default)]
pub struct IndexState {
    pub root: Option<String>,
    pub content_active: bool,
}

pub struct AppState {
    pub db: Mutex<Connection>,
    pub versions_dir: PathBuf,
    pub thumbs_dir: PathBuf,
    pub watcher: Mutex<Option<RecommendedWatcher>>,
    /// Рекурсивный вотчер индексируемого корня (живой индекс).
    pub index_watcher: Mutex<Option<RecommendedWatcher>>,
    pub index_info: Mutex<IndexState>,
}

impl AppState {
    pub fn new(conn: Connection, versions_dir: PathBuf, thumbs_dir: PathBuf) -> Self {
        Self {
            db: Mutex::new(conn),
            versions_dir,
            thumbs_dir,
            watcher: Mutex::new(None),
            index_watcher: Mutex::new(None),
            index_info: Mutex::new(IndexState::default()),
        }
    }

    /// Захват соединения БД без паники: отравленный мьютекс превращается в
    /// обычную ошибку (её увидит фронт), а не в крах всего процесса.
    pub fn db(&self) -> Result<MutexGuard<'_, Connection>> {
        self.db
            .lock()
            .map_err(|_| Error::Operation("БД заблокирована (poisoned)".into()))
    }

    pub fn watcher(&self) -> Result<MutexGuard<'_, Option<RecommendedWatcher>>> {
        self.watcher
            .lock()
            .map_err(|_| Error::Operation("watcher заблокирован (poisoned)".into()))
    }

    pub fn index_info(&self) -> Result<MutexGuard<'_, IndexState>> {
        self.index_info
            .lock()
            .map_err(|_| Error::Operation("index_info заблокирован (poisoned)".into()))
    }

    pub fn index_watcher(&self) -> Result<MutexGuard<'_, Option<RecommendedWatcher>>> {
        self.index_watcher
            .lock()
            .map_err(|_| Error::Operation("index_watcher заблокирован (poisoned)".into()))
    }
}
