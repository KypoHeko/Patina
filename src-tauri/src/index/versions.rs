//! The versions + version_chunks + zstd_dicts tables.

use rusqlite::{Connection, OptionalExtension};
use serde::Serialize;

use crate::error::Result;
use crate::index::path_bounds::{remap, subtree_bounds};
use crate::index::path_key::normalize;
use crate::index::chunker::Chunk;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Version {
    pub id: i64,
    pub path: String,
    pub ts: i64,
    pub size: i64,
    pub hash: String,
    pub label: String,
    pub strategy: String,
    pub dict_id: Option<i64>,
}

/// Hash of the most recent version for a given path.
///
/// Not used in production code right now: `do_snapshot` checks for the hash
/// among ALL versions via `has_hash_for_path`, which is stricter and correct
/// for the case where the file already matches some older version.
/// Kept as a utility for future needs (e.g. for UI that wants to show the
/// "last saved hash").
#[allow(dead_code)]
pub fn latest_hash(conn: &Connection, path: &str) -> Result<Option<String>> {
    let path = normalize(path);
    let path = path.as_str();
    let h = conn
        .query_row(
            "SELECT hash FROM versions WHERE path = ?1 ORDER BY ts DESC, id DESC LIMIT 1",
            [path],
            |r| r.get::<_, String>(0),
        )
        .optional()?;
    Ok(h)
}

/// Number of versions for a given path.
pub fn count_for(conn: &Connection, path: &str) -> Result<i64> {
    let path = normalize(path);
    let path = path.as_str();
    let count = conn.query_row(
        "SELECT COUNT(*) FROM versions WHERE path = ?1",
        [path],
        |r| r.get::<_, i64>(0),
    )?;
    Ok(count)
}

/// Number of versions with strategy='zstd' (used to decide on dictionary training).
pub fn zstd_count(conn: &Connection) -> Result<i64> {
    let count = conn.query_row(
        "SELECT COUNT(*) FROM versions WHERE strategy = 'zstd'",
        [],
        |r| r.get::<_, i64>(0),
    )?;
    Ok(count)
}

/// Id of the current (most recently trained) dictionary.
pub fn current_dict_id(conn: &Connection) -> Result<Option<i64>> {
    let id = conn
        .query_row(
            "SELECT id FROM zstd_dicts ORDER BY id DESC LIMIT 1",
            [],
            |r| r.get::<_, i64>(0),
        )
        .optional()?;
    Ok(id)
}

/// The next label: v1, v2, v3… Finds the maximum numeric suffix among existing
/// labels of the form vN and adds 1.
pub fn next_label(conn: &Connection, path: &str) -> Result<String> {
    let path = normalize(path);
    let path = path.as_str();

    let mut max_existing: i64 = 0;
    let mut stmt = conn.prepare("SELECT label FROM versions WHERE path = ?1")?;
    let rows = stmt.query_map([path], |r| r.get::<_, String>(0))?;
    for row in rows {
        let label = row?;
        if let Some(suffix) = label.strip_prefix('v')
            && let Ok(n) = suffix.parse::<i64>()
                && n > max_existing {
                    max_existing = n;
                }
    }

    Ok(format!("v{}", max_existing + 1))
}

#[allow(clippy::too_many_arguments)]
pub fn insert(
    conn: &Connection,
    path: &str,
    ts: i64,
    size: i64,
    hash: &str,
    label: &str,
    strategy: &str,
    dict_id: Option<i64>,
) -> Result<i64> {
    let path = normalize(path);
    let path = path.as_str();
    conn.execute(
        "INSERT INTO versions (path, ts, size, hash, label, strategy, dict_id) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
        (path, ts, size, hash, label, strategy, dict_id),
    )?;
    Ok(conn.last_insert_rowid())
}

pub fn list_for(conn: &Connection, path: &str) -> Result<Vec<Version>> {
    let path = normalize(path);
    let path = path.as_str();
    let mut stmt = conn
        .prepare("SELECT id, path, ts, size, hash, label, strategy, dict_id FROM versions WHERE path = ?1 ORDER BY ts DESC, id DESC")?;
    let rows = stmt
        .query_map([path], |r| {
            Ok(Version {
                id: r.get(0)?,
                path: r.get(1)?,
                ts: r.get(2)?,
                size: r.get(3)?,
                hash: r.get(4)?,
                label: r.get(5)?,
                strategy: r.get(6)?,
                dict_id: r.get(7)?,
            })
        })?
        .collect::<rusqlite::Result<_>>()?;
    Ok(rows)
}

pub fn get(conn: &Connection, id: i64) -> Result<Option<Version>> {
    let v = conn
        .query_row(
            "SELECT id, path, ts, size, hash, label, strategy, dict_id FROM versions WHERE id = ?1",
            [id],
            |r| {
                Ok(Version {
                    id: r.get(0)?,
                    path: r.get(1)?,
                    ts: r.get(2)?,
                    size: r.get(3)?,
                    hash: r.get(4)?,
                    label: r.get(5)?,
                    strategy: r.get(6)?,
                    dict_id: r.get(7)?,
                })
            },
        )
        .optional()?;
    Ok(v)
}

/// Delete a version by id. Returns (path, hash, strategy) of the removed row —
/// so the caller can decide whether to delete the blob/chunks.
pub fn delete(conn: &Connection, id: i64) -> Result<Option<(String, String, String)>> {
    let removed = conn
        .query_row(
            "SELECT path, hash, strategy FROM versions WHERE id = ?1",
            [id],
            |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, String>(2)?)),
        )
        .optional()?;
    if let Some((..)) = &removed {
        // Also delete the version's chunks (if strategy='chunked')
        conn.execute("DELETE FROM version_chunks WHERE version_id = ?1", [id])?;
        conn.execute("DELETE FROM versions WHERE id = ?1", [id])?;
    }
    Ok(removed)
}

/// Check whether anyone still references this blob hash.
/// Used for safe deletion of a blob/compressed blob.
pub fn hash_refcount(conn: &Connection, hash: &str) -> Result<i64> {
    let count = conn.query_row(
        "SELECT COUNT(*) FROM versions WHERE hash = ?1",
        [hash],
        |r| r.get::<_, i64>(0),
    )?;
    Ok(count)
}

/// Whether a version of the given path with the given hash already exists.
///
/// Unlike `latest_hash` (which compares only against the most recent version),
/// this checks ALL versions of the path. Used by `do_snapshot` to skip a
/// snapshot if the file's current state is already stored in some version — for
/// example, after a restore the file matches the restored version and a
/// separate snapshot would be a duplicate. Likewise `do_restore` (via
/// `do_snapshot`) does not pile up extra rows on repeated version switching.
pub fn has_hash_for_path(conn: &Connection, path: &str, hash: &str) -> Result<bool> {
    let path = normalize(path);
    let path = path.as_str();
    let count: i64 = conn.query_row(
        "SELECT COUNT(*) FROM versions WHERE path = ?1 AND hash = ?2",
        (path, hash),
        |r| r.get(0),
    )?;
    Ok(count > 0)
}

/// Check whether anyone still references this chunk.
pub fn chunk_refcount(conn: &Connection, chunk_hash: &str) -> Result<i64> {
    let count = conn.query_row(
        "SELECT COUNT(*) FROM version_chunks WHERE chunk_hash = ?1",
        [chunk_hash],
        |r| r.get::<_, i64>(0),
    )?;
    Ok(count)
}

/// Store the list of chunks for a version (strategy='chunked').
pub fn insert_chunks(conn: &Connection, version_id: i64, chunks: &[Chunk]) -> Result<()> {
    for (i, c) in chunks.iter().enumerate() {
        conn.execute(
            "INSERT INTO version_chunks (version_id, chunk_order, chunk_hash, chunk_size) VALUES (?1, ?2, ?3, ?4)",
            (version_id, i as i64, &c.hash, c.size),
        )?;
    }
    Ok(())
}

/// Get the version's chunks in order.
pub fn get_chunks(conn: &Connection, version_id: i64) -> Result<Vec<(String, i64)>> {
    let mut stmt = conn.prepare(
        "SELECT chunk_hash, chunk_size FROM version_chunks WHERE version_id = ?1 ORDER BY chunk_order",
    )?;
    let rows = stmt
        .query_map([version_id], |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?)))?
        .collect::<rusqlite::Result<_>>()?;
    Ok(rows)
}

/// Write a new zstd dictionary into the DB. Returns its id.
/// `zstd_count_at_train` — how many zstd versions existed at training time
/// (used by should_retrain to decide on retraining).
pub fn insert_dict(conn: &Connection, ts: i64, size: i64, zstd_count_at_train: i64) -> Result<i64> {
    conn.execute(
        "INSERT INTO zstd_dicts (ts, size, zstd_count_at_train) VALUES (?1, ?2, ?3)",
        (ts, size, zstd_count_at_train),
    )?;
    Ok(conn.last_insert_rowid())
}

/// How many zstd versions existed when the current dictionary was trained.
/// None if there is no dictionary yet. Used by should_retrain.
pub fn current_dict_zstd_count_at_train(conn: &Connection) -> Result<Option<i64>> {
    let v = conn
        .query_row(
            "SELECT zstd_count_at_train FROM zstd_dicts ORDER BY id DESC LIMIT 1",
            [],
            |r| r.get::<_, i64>(0),
        )
        .optional()?;
    Ok(v)
}

/// Check whether a dictionary is still in use (at least one version references it).
///
/// Not called in production code: zstd dictionaries are not GC'd separately
/// (they grow monotonically, see `zstd_count_at_train` for the retraining
/// logic). Kept as a utility for a future dictionary-GC implementation and used
/// in the tests below. `#[cfg(test)]` suppresses the dead_code warning in a
/// regular build.
#[cfg(test)]
pub fn dict_refcount(conn: &Connection, dict_id: i64) -> Result<i64> {
    let count = conn.query_row(
        "SELECT COUNT(*) FROM versions WHERE dict_id = ?1",
        [dict_id],
        |r| r.get::<_, i64>(0),
    )?;
    Ok(count)
}

/// Remap version history on rename/move: old -> new, including nested paths
/// (for folders). Content-addressed blobs and chunks need not be touched —
/// only the `path` column changes.
pub fn relink(conn: &Connection, old: &str, new: &str) -> Result<()> {
    let old = normalize(old);
    let new = normalize(new);
    let (old, new) = (old.as_str(), new.as_str());

    let (_, prefix, upper) = subtree_bounds(old);
    let affected: Vec<(i64, String)> = {
        let mut stmt = conn
            .prepare("SELECT id, path FROM versions WHERE path = ?1 OR (path >= ?2 AND path < ?3)")?;
        stmt.query_map((old, &prefix, &upper), |r| Ok((r.get(0)?, r.get(1)?)))?
            .collect::<rusqlite::Result<_>>()?
    };
    if affected.is_empty() {
        return Ok(());
    }

    conn.execute_batch("BEGIN")?;
    let res: Result<()> = (|| {
        let mut stmt = conn.prepare("UPDATE versions SET path = ?1 WHERE id = ?2")?;
        for (id, path) in &affected {
            if let Some(np) = remap(path, old, new) {
                stmt.execute((&np, id))?;
            }
        }
        Ok(())
    })();
    match res {
        Ok(()) => {
            conn.execute_batch("COMMIT")?;
            Ok(())
        }
        Err(e) => {
            let _ = conn.execute_batch("ROLLBACK");
            Err(e)
        }
    }
}

/// Delete version history of a path and all nested ones (on move to Trash).
/// Blobs and chunks are not deleted: they are content-addressed and may be
/// referenced by other paths; garbage collection is a separate task.
pub fn purge(conn: &Connection, path: &str) -> Result<()> {
    let path = normalize(path);
    let path = path.as_str();
    let (_, prefix, upper) = subtree_bounds(path);

    // Delete chunks for chunked versions
    let version_ids: Vec<i64> = {
        let mut stmt = conn.prepare(
            "SELECT id FROM versions WHERE path = ?1 OR (path >= ?2 AND path < ?3)",
        )?;
        stmt.query_map((path, &prefix, &upper), |r| r.get::<_, i64>(0))?
            .collect::<rusqlite::Result<_>>()?
    };
    if !version_ids.is_empty() {
        // Delete chunks in batches
        for chunk_id in &version_ids {
            conn.execute("DELETE FROM version_chunks WHERE version_id = ?1", [chunk_id])?;
        }
    }

    conn.execute(
        "DELETE FROM versions WHERE path = ?1 OR (path >= ?2 AND path < ?3)",
        (path, &prefix, &upper),
    )?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn mem() -> Connection {
        let c = Connection::open_in_memory().unwrap();
        c.execute_batch(
            "CREATE TABLE versions (id INTEGER PRIMARY KEY AUTOINCREMENT, path TEXT NOT NULL, ts INTEGER NOT NULL, size INTEGER NOT NULL, hash TEXT NOT NULL, label TEXT NOT NULL DEFAULT '', strategy TEXT NOT NULL DEFAULT 'full', dict_id INTEGER);
             CREATE TABLE version_chunks (version_id INTEGER NOT NULL, chunk_order INTEGER NOT NULL, chunk_hash TEXT NOT NULL, chunk_size INTEGER NOT NULL, PRIMARY KEY (version_id, chunk_order));
             CREATE TABLE zstd_dicts (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, size INTEGER NOT NULL, zstd_count_at_train INTEGER NOT NULL DEFAULT 0);",
        )
        .unwrap();
        c
    }

    fn paths(conn: &Connection) -> Vec<String> {
        let mut stmt = conn.prepare("SELECT path FROM versions ORDER BY path, id").unwrap();
        stmt.query_map([], |r| r.get::<_, String>(0))
            .unwrap()
            .map(|r| r.unwrap())
            .collect()
    }

    #[test]
    fn relink_moves_exact_and_nested_keeps_sibling() {
        let c = mem();
        insert(&c, "C:\\proj\\b", 1, 10, "h1", "v1", "full", None).unwrap();
        insert(&c, "C:\\proj\\b\\x.txt", 1, 20, "h2", "v1", "full", None).unwrap();
        insert(&c, "C:\\proj\\bb\\y.txt", 1, 30, "h3", "v1", "full", None).unwrap();
        relink(&c, "C:\\proj\\b", "C:\\proj\\renamed").unwrap();
        // Paths in the DB are stored in canonical form (path_key::normalize), so
        // we run expectations through the same normalization — keeps the test
        // portable across OSes.
        assert_eq!(
            paths(&c),
            vec![
                normalize("C:\\proj\\bb\\y.txt"),
                normalize("C:\\proj\\renamed"),
                normalize("C:\\proj\\renamed\\x.txt"),
            ]
        );
    }

    #[test]
    fn purge_removes_exact_and_nested_keeps_sibling() {
        let c = mem();
        insert(&c, "C:\\proj\\b", 1, 10, "h1", "v1", "full", None).unwrap();
        insert(&c, "C:\\proj\\b\\x.txt", 1, 20, "h2", "v1", "full", None).unwrap();
        insert(&c, "C:\\proj\\bb\\y.txt", 1, 30, "h3", "v1", "full", None).unwrap();
        purge(&c, "C:\\proj\\b").unwrap();
        assert_eq!(paths(&c), vec![normalize("C:\\proj\\bb\\y.txt")]);
    }

    #[test]
    fn next_label_increments() {
        let c = mem();
        assert_eq!(next_label(&c, "C:\\file.txt").unwrap(), "v1");
        insert(&c, "C:\\file.txt", 1, 10, "h1", "v1", "full", None).unwrap();
        assert_eq!(next_label(&c, "C:\\file.txt").unwrap(), "v2");
        insert(&c, "C:\\file.txt", 2, 10, "h2", "v2", "full", None).unwrap();
        assert_eq!(next_label(&c, "C:\\file.txt").unwrap(), "v3");
    }

    #[test]
    fn next_label_skips_gap_after_delete() {
        let c = mem();
        insert(&c, "C:\\file.txt", 1, 10, "h1", "v1", "full", None).unwrap();
        insert(&c, "C:\\file.txt", 2, 10, "h2", "v2", "full", None).unwrap();
        insert(&c, "C:\\file.txt", 3, 10, "h3", "v3", "full", None).unwrap();
        delete(&c, 2).unwrap();
        assert_eq!(next_label(&c, "C:\\file.txt").unwrap(), "v4");
    }

    #[test]
    fn delete_removes_row_and_returns_info() {
        let c = mem();
        insert(&c, "C:\\file.txt", 1, 10, "h1", "v1", "zstd", None).unwrap();
        let removed = delete(&c, 1).unwrap();
        assert_eq!(removed, Some((normalize("C:\\file.txt"), "h1".to_string(), "zstd".to_string())));
        assert_eq!(count_for(&c, "C:\\file.txt").unwrap(), 0);
    }

    #[test]
    fn chunk_crud() {
        let c = mem();
        let vid = insert(&c, "C:\\big.dat", 1, 50_000_000, "h1", "v1", "chunked", None).unwrap();
        let chunks = vec![
            Chunk { hash: "ca".to_string(), size: 20_000_000 },
            Chunk { hash: "cb".to_string(), size: 20_000_000 },
            Chunk { hash: "cc".to_string(), size: 10_000_000 },
        ];
        insert_chunks(&c, vid, &chunks).unwrap();

        let stored = get_chunks(&c, vid).unwrap();
        assert_eq!(stored.len(), 3);
        assert_eq!(stored[0].0, "ca");
        assert_eq!(stored[2].0, "cc");

        assert_eq!(chunk_refcount(&c, "ca").unwrap(), 1);
        assert_eq!(chunk_refcount(&c, "cx").unwrap(), 0);

        // Deleting a version deletes its chunks
        delete(&c, vid).unwrap();
        assert_eq!(chunk_refcount(&c, "ca").unwrap(), 0);
        assert!(get_chunks(&c, vid).unwrap().is_empty());
    }

    #[test]
    fn dict_crud() {
        let c = mem();
        // Trained the dictionary at 4 zstd versions
        let did = insert_dict(&c, 1000, 4096, 4).unwrap();
        assert_eq!(current_dict_id(&c).unwrap(), Some(did));
        assert_eq!(dict_refcount(&c, did).unwrap(), 0);
        assert_eq!(current_dict_zstd_count_at_train(&c).unwrap(), Some(4));

        insert(&c, "C:\\doc.txt", 1, 5000, "h1", "v1", "zstd", Some(did)).unwrap();
        assert_eq!(dict_refcount(&c, did).unwrap(), 1);
    }

    #[test]
    fn hash_refcount_counts_correctly() {
        let c = mem();
        insert(&c, "C:\\a.txt", 1, 10, "h1", "v1", "full", None).unwrap();
        insert(&c, "C:\\b.txt", 1, 10, "h1", "v1", "zstd", None).unwrap();
        assert_eq!(hash_refcount(&c, "h1").unwrap(), 2);
        delete(&c, 1).unwrap();
        assert_eq!(hash_refcount(&c, "h1").unwrap(), 1);
    }

    #[test]
    fn zstd_count_filters_strategy() {
        let c = mem();
        insert(&c, "C:\\a.txt", 1, 10, "h1", "v1", "full", None).unwrap();
        insert(&c, "C:\\b.txt", 2, 10, "h2", "v1", "zstd", None).unwrap();
        insert(&c, "C:\\c.txt", 3, 10, "h3", "v1", "zstd", None).unwrap();
        assert_eq!(zstd_count(&c).unwrap(), 2);
    }
}
