//! The files table. Currently serves as a hash cache for duplicate detection.

use rusqlite::{Connection, OptionalExtension};

use crate::error::Result;

use crate::index::path_key::normalize;

/// The cached hash, if present and the mtime matches.
pub fn cached_hash(conn: &Connection, path: &str, mtime: i64) -> Result<Option<String>> {
    let path = normalize(path);
    let path = path.as_str();
    let r = conn
        .query_row(
            "SELECT hash FROM files WHERE path = ?1 AND mtime = ?2 AND hash IS NOT NULL",
            (path, mtime),
            |row| row.get::<_, String>(0),
        )
        .optional()?;
    Ok(r)
}

pub fn store_hash(conn: &Connection, path: &str, size: u64, mtime: i64, hash: &str) -> Result<()> {
    let path = normalize(path);
    let path = path.as_str();
    conn.execute(
        "INSERT INTO files (path, size, mtime, hash) VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT(path) DO UPDATE SET size = excluded.size, mtime = excluded.mtime, hash = excluded.hash",
        (path, size as i64, mtime, hash),
    )?;
    Ok(())
}
