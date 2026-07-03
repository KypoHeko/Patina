//! Open the connection and apply migrations (version tracked via PRAGMA user_version).

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
        // Atomicity: the migration's DDL and the PRAGMA user_version update must
        // land in the SAME transaction. Otherwise a crash between COMMIT and the
        // separate pragma_update would leave the schema applied but user_version
        // stale — on the next launch the same migration would re-run and fail
        // (e.g. ALTER TABLE ADD COLUMN: "duplicate column name"). By concatenating
        // the migration SQL with the PRAGMA into a single execute_batch under one
        // BEGIN/COMMIT, both commit (or roll back) together.
        let next_version = version + 1;
        let batch = format!(
            "BEGIN;\n{}\nPRAGMA user_version = {};\nCOMMIT;",
            MIGRATIONS[version], next_version
        );
        if let Err(e) = conn.execute_batch(&batch).map_err(Error::from) {
            // BEGIN may have opened a transaction that survived the failure
            // (the error could come from the migration SQL itself, before COMMIT).
            // Best-effort rollback — ignore the result, the connection is unusable
            // for the next iteration anyway since we return the error.
            let _ = conn.execute_batch("ROLLBACK");
            return Err(e);
        }
        version = next_version;
    }
    Ok(())
}