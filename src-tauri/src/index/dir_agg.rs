//! Per-directory aggregate store (`dir_agg`): recursive subtree size and file
//! count. Sizes are filled by an on-demand traversal and read by the panel for
//! specific paths. This repository does not touch the hash/hash_dirty fields —
//! hashes (a future Merkle rollup) live in a separate mechanism.

use std::collections::HashMap;

use rusqlite::{Connection, OptionalExtension};

use crate::error::Result;
use crate::index::path_bounds::subtree_bounds;
use crate::index::path_key;

/// An aggregate row. `path` is already a canonical key (path_key::normalize).
pub struct DirAgg {
    pub path: String,
    pub total_size: i64,
    pub file_count: i64,
    pub mtime_max: Option<i64>,
}

/// Batch upsert of aggregates in a single transaction. hash/hash_dirty untouched.
pub fn upsert_many(conn: &Connection, rows: &[DirAgg]) -> Result<()> {
    let tx = conn.unchecked_transaction()?;
    {
        let mut stmt = tx.prepare(
            "INSERT INTO dir_agg (path, total_size, file_count, mtime_max)
             VALUES (?1, ?2, ?3, ?4)
             ON CONFLICT(path) DO UPDATE SET
               total_size = excluded.total_size,
               file_count = excluded.file_count,
               mtime_max  = excluded.mtime_max",
        )?;
        for r in rows {
            stmt.execute((&r.path, r.total_size, r.file_count, r.mtime_max))?;
        }
    }
    tx.commit()?;
    Ok(())
}

/// Delete aggregates for the whole `root_key` subtree (including the root
/// itself) before a fresh recompute — so no rows remain for vanished
/// directories. The half-open interval [prefix, upper) is the same trick used
/// across the other repositories.
pub fn clear_subtree(conn: &Connection, root_key: &str) -> Result<()> {
    let (_sep, prefix, upper) = subtree_bounds(root_key);
    conn.execute(
        "DELETE FROM dir_agg WHERE path = ?1 OR (path >= ?2 AND path < ?3)",
        (root_key, prefix, upper),
    )?;
    Ok(())
}

/// Sizes for specific paths (for display in the panel). The result key is the
/// ORIGINAL path from the query (as the frontend knows it), the value is
/// total_size. Directories whose aggregate is not computed yet are omitted.
pub fn sizes_for(conn: &Connection, paths: &[String]) -> Result<HashMap<String, i64>> {
    let mut out = HashMap::with_capacity(paths.len());
    let mut stmt = conn.prepare("SELECT total_size FROM dir_agg WHERE path = ?1")?;
    for p in paths {
        let key = path_key::normalize(p);
        let size: Option<i64> = stmt.query_row([&key], |r| r.get(0)).optional()?;
        if let Some(s) = size {
            out.insert(p.clone(), s);
        }
    }
    Ok(out)
}
