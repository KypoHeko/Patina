//! Глобальное состояние приложения (Tauri .manage()).
//!
//! БД оборачивается в Mutex<Connection>, а не RwLock<Connection>:
//! - rusqlite::Connection содержит RefCell внутри и не реализует Sync
//! - RwLock<T>: Sync требует T: Send + Sync, а Connection: !Sync
//! - Mutex<T>: Sync требует только T: Send, а Connection: Send
//! - Практической разницы нет: на одном соединении SQLite всё равно
//!   сериализует запросы, поэтому «множество читателей» RwLock
//!   не даёт реального параллелизма

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
    /// Mutex<Connection> — единственный способ сделать AppState: Sync,
    /// т.к. rusqlite::Connection: !Sync (внутренний RefCell).
    /// На практике это не хуже RwLock: одно соединение SQLite сериализует
    /// все запросы, поэтому «параллельные читатели» RwLock были иллюзией.
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

    /// Захват соединения БД (эксклюзивная блокировка).
    /// Отравленный лок превращается в ошибку (её увидит фронт),
    /// а не в крах всего процесса.
    pub fn db(&self) -> Result<MutexGuard<'_, Connection>> {
        self.db
            .lock()
            .map_err(|_| Error::Operation("БД заблокирована (poisoned)".into()))
    }

    /// Захват соединения БД для чтения. Сейчас — то же единственное соединение,
    /// что и `db()`; метод существует как явный маркер read-намерения на стороне
    /// вызова и как seam для будущего пула: когда появится отдельное read-only
    /// соединение (WAL), читатели перестанут конкурировать с писателем за мьютекс.
    /// Тогда поменяется только тело здесь — вызовы трогать не придётся.
    pub fn db_read(&self) -> Result<MutexGuard<'_, Connection>> {
        self.db()
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
