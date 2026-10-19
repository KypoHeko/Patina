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
    include_str!("schema/0014_version_deleted_at.sql"),
    include_str!("schema/0015_usn_journal_id.sql"),
    include_str!("schema/0016_display_path.sql"),
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

/// A second, READ-ONLY connection to the same database for queries. With WAL
/// it reads the last committed state while the writer is inside a long
/// transaction (an index build of 50 000 rows), so tags, folder sizes and
/// search stay responsive instead of queueing behind the writer's mutex.
/// Open it after `open` (the schema must exist).
pub fn open_read_only(app: &AppHandle) -> Result<Connection> {
    use rusqlite::OpenFlags;
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| Error::InvalidPath(e.to_string()))?;
    let conn = Connection::open_with_flags(
        dir.join("patina.db"),
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_URI | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )?;
    conn.execute_batch("PRAGMA busy_timeout = 5000; PRAGMA cache_size = -16000;")?;
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
/// An in-memory database with the full production schema (all migrations
/// applied) — for tests of code that spans several repositories.
#[cfg(test)]
pub fn open_in_memory() -> Connection {
    let conn = Connection::open_in_memory().expect("in-memory db");
    conn.execute_batch("PRAGMA foreign_keys = ON;").expect("pragma");
    run_migrations(&conn).expect("migrations");
    conn
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn migrations_apply_and_are_idempotent() {
        let conn = open_in_memory();
        let v: i64 = conn.pragma_query_value(None, "user_version", |r| r.get(0)).unwrap();
        assert_eq!(v as usize, MIGRATIONS.len());
        run_migrations(&conn).unwrap(); // second run is a no-op
    }

    #[test]
    fn read_only_connection_is_not_blocked_by_a_writer_transaction() {
        use rusqlite::OpenFlags;
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("t.db");
        let w = Connection::open(&path).unwrap();
        w.execute_batch("PRAGMA journal_mode = WAL; CREATE TABLE t (x INTEGER); INSERT INTO t VALUES (1);")
            .unwrap();
        let r = Connection::open_with_flags(&path, OpenFlags::SQLITE_OPEN_READ_ONLY).unwrap();
        w.execute_batch("BEGIN; INSERT INTO t VALUES (2);").unwrap(); // long write in progress
        let n: i64 = r.query_row("SELECT COUNT(*) FROM t", [], |row| row.get(0)).unwrap();
        assert_eq!(n, 1, "the reader sees the last committed state without waiting");
        w.execute_batch("COMMIT").unwrap();
        let n: i64 = r.query_row("SELECT COUNT(*) FROM t", [], |row| row.get(0)).unwrap();
        assert_eq!(n, 2);
    }
}

