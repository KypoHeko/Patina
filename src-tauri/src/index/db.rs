//! Открытие соединения и применение миграций (версия — PRAGMA user_version).

use std::fs;

use rusqlite::Connection;
use tauri::{AppHandle, Manager};

use crate::error::{Error, Result};

const MIGRATIONS: &[&str] = &[
    include_str!("schema/0001_tags.sql"),
    include_str!("schema/0002_files.sql"),
    include_str!("schema/0003_versions.sql"),
    include_str!("schema/0004_relationships.sql"),
    include_str!("schema/0005_file_index.sql"),
    include_str!("schema/0006_file_edges.sql"),
    include_str!("schema/0007_quick_access.sql"),
];

pub fn open(app: &AppHandle) -> Result<Connection> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| Error::InvalidPath(e.to_string()))?;
    fs::create_dir_all(&dir)?;

    let conn = Connection::open(dir.join("patina.db"))?;
    conn.execute_batch("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;")?;
    run_migrations(&conn)?;
    Ok(conn)
}

fn run_migrations(conn: &Connection) -> Result<()> {
    let mut version: usize =
        conn.pragma_query_value(None, "user_version", |r| r.get::<_, i64>(0))? as usize;
    // Каждая миграция — в своей транзакции, версия бампается сразу после успеха.
    // Так частичный сбой не оставит БД в промежуточном состоянии (см. ревью).
    while version < MIGRATIONS.len() {
        conn.execute_batch("BEGIN")?;
        let step: Result<()> = conn.execute_batch(MIGRATIONS[version]).map_err(Error::from);
        match step {
            Ok(()) => {
                conn.execute_batch("COMMIT")?;
                version += 1;
                conn.pragma_update(None, "user_version", version as i64)?;
            }
            Err(e) => {
                let _ = conn.execute_batch("ROLLBACK");
                return Err(e);
            }
        }
    }
    Ok(())
}
