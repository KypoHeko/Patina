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
    include_str!("schema/0008_usn_position.sql"),
    include_str!("schema/0009_dir_agg.sql"),
    include_str!("schema/0010_version_label.sql"),
    include_str!("schema/0011_version_strategy.sql"),
    include_str!("schema/0012_version_chunks.sql"),
    include_str!("schema/0013_dict_zstd_count.sql"),
];

pub fn open(app: &AppHandle) -> Result<Connection> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| Error::InvalidPath(e.to_string()))?;
    fs::create_dir_all(&dir)?;

    let conn = Connection::open(dir.join("patina.db"))?;
    conn.execute_batch(
        "PRAGMA journal_mode = WAL;
         PRAGMA foreign_keys = ON;
         PRAGMA busy_timeout = 5000;
         PRAGMA synchronous = NORMAL;
         PRAGMA cache_size = -64000;",
    )?;
    run_migrations(&conn)?;
    Ok(conn)
}

fn run_migrations(conn: &Connection) -> Result<()> {
    let mut version: usize =
        conn.pragma_query_value(None, "user_version", |r| r.get::<_, i64>(0))? as usize;
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
