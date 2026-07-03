//! Global application state (Tauri .manage()).
//!
//! The DB is wrapped in Mutex<Connection>, not RwLock<Connection>:
//! - rusqlite::Connection holds a RefCell internally and does not implement Sync
//! - RwLock<T>: Sync requires T: Send + Sync, but Connection: !Sync
//! - Mutex<T>: Sync requires only T: Send, and Connection: Send
//! - There is no practical difference: a single SQLite connection serializes
//!   queries anyway, so RwLock's "many readers" gives no real parallelism

use std::path::PathBuf;
use std::sync::{Mutex, MutexGuard};

use notify::RecommendedWatcher;
use rusqlite::Connection;

use crate::error::{Error, Result};

/// Live index state: which root is being indexed and whether the content index is active.
#[derive(Default)]
pub struct IndexState {
    pub root: Option<String>,
    pub content_active: bool,
}

pub struct AppState {
    /// Mutex<Connection> is the only way to make AppState: Sync,
    /// since rusqlite::Connection: !Sync (internal RefCell).
    /// In practice this is no worse than RwLock: a single SQLite connection
    /// serializes all queries, so RwLock's "parallel readers" were an illusion.
    pub db: Mutex<Connection>,
    pub versions_dir: PathBuf,
    pub thumbs_dir: PathBuf,
    pub watcher: Mutex<Option<RecommendedWatcher>>,
    /// Recursive watcher of the indexed root (live index).
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

    /// Acquire the DB connection (exclusive lock).
    /// A poisoned lock turns into an error (which the front end sees),
    /// not a crash of the whole process.
    pub fn db(&self) -> Result<MutexGuard<'_, Connection>> {
        self.db
            .lock()
            .map_err(|_| Error::Operation("DB lock poisoned".into()))
    }

    /// Acquire the DB connection for reading. Currently the same single
    /// connection as `db()`; this method exists as an explicit read-intent marker
    /// at the call site and as a seam for a future pool: once a separate
    /// read-only (WAL) connection exists, readers will stop competing with the
    /// writer for the mutex. Only the body here will change then — call sites
    /// will not need to be touched.
    pub fn db_read(&self) -> Result<MutexGuard<'_, Connection>> {
        self.db()
    }

    pub fn watcher(&self) -> Result<MutexGuard<'_, Option<RecommendedWatcher>>> {
        self.watcher
            .lock()
            .map_err(|_| Error::Operation("watcher lock poisoned".into()))
    }

    pub fn index_info(&self) -> Result<MutexGuard<'_, IndexState>> {
        self.index_info
            .lock()
            .map_err(|_| Error::Operation("index_info lock poisoned".into()))
    }

    pub fn index_watcher(&self) -> Result<MutexGuard<'_, Option<RecommendedWatcher>>> {
        self.index_watcher
            .lock()
            .map_err(|_| Error::Operation("index_watcher lock poisoned".into()))
    }
}
