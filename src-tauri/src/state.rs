//! Global application state (Tauri .manage()).
//!
//! Two SQLite connections, each behind a Mutex (rusqlite::Connection is Send
//! but !Sync, so a Mutex is what makes AppState: Sync):
//! - `db` — the single WRITER; every write goes through it;
//! - `db_ro` — a READ-ONLY connection for queries. In WAL mode it reads the
//!   last committed state while the writer is busy, so a long index build no
//!   longer blocks tag lookups, folder sizes or search.

use std::path::PathBuf;
use std::sync::atomic::AtomicU64;
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
    /// The writer connection.
    pub db: Mutex<Connection>,
    /// Read-only connection (None in tests: reads then use `db`).
    pub db_ro: Option<Mutex<Connection>>,
    pub versions_dir: PathBuf,
    pub thumbs_dir: PathBuf,
    pub watcher: Mutex<Option<RecommendedWatcher>>,
    /// Recursive watcher of the indexed root (live index).
    pub index_watcher: Mutex<Option<RecommendedWatcher>>,
    pub index_info: Mutex<IndexState>,
    /// Generation of the latest live-index build. A build started for an
    /// older generation stops at its next check instead of running to the end
    /// next to (and racing with) the newer one.
    pub index_gen: AtomicU64,
    /// Generation of the latest duplicate scan; an older scan stops hashing.
    pub dups_gen: AtomicU64,
}

impl AppState {
    pub fn new(conn: Connection, read_conn: Option<Connection>, versions_dir: PathBuf, thumbs_dir: PathBuf) -> Self {
        Self {
            db: Mutex::new(conn),
            db_ro: read_conn.map(Mutex::new),
            versions_dir,
            thumbs_dir,
            watcher: Mutex::new(None),
            index_watcher: Mutex::new(None),
            index_info: Mutex::new(IndexState::default()),
            index_gen: AtomicU64::new(0),
            dups_gen: AtomicU64::new(0),
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

    /// Acquire a connection for READING: the read-only connection when there is
    /// one, so readers do not wait for the writer. Never write through it.
    pub fn db_read(&self) -> Result<MutexGuard<'_, Connection>> {
        match &self.db_ro {
            Some(ro) => ro.lock().map_err(|_| Error::Operation("read DB lock poisoned".into())),
            None => self.db(),
        }
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
