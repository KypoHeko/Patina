//! Access to the file_tags table.

use std::collections::HashMap;

use rusqlite::Connection;

use crate::error::Result;
use crate::index::path_bounds::subtree_bounds;
use crate::index::path_key::normalize;

pub fn assign(conn: &Connection, path: &str, tag_id: &str) -> Result<()> {
    let path = normalize(path);
    let path = path.as_str();
    conn.execute(
        "INSERT OR IGNORE INTO file_tags (path, tag_id) VALUES (?1, ?2)",
        (path, tag_id),
    )?;
    Ok(())
}

pub fn remove(conn: &Connection, path: &str, tag_id: &str) -> Result<()> {
    let path = normalize(path);
    let path = path.as_str();
    conn.execute(
        "DELETE FROM file_tags WHERE path = ?1 AND tag_id = ?2",
        (path, tag_id),
    )?;
    Ok(())
}

/// Tags for a set of paths in a single `IN` query (in batches, since SQLite by
/// default limits the number of bound parameters to 999). Only tagged paths are
/// returned.
pub fn for_paths(conn: &Connection, paths: &[String]) -> Result<HashMap<String, Vec<String>>> {
    // normalized_key -> the caller's original string
    let mut origin: HashMap<String, String> = HashMap::new();
    for p in paths {
        origin.entry(normalize(p)).or_insert_with(|| p.clone());
    }
    let keys: Vec<String> = origin.keys().cloned().collect();

    let mut map: HashMap<String, Vec<String>> = HashMap::new();
    for chunk in keys.chunks(900) {
        if chunk.is_empty() {
            continue;
        }
        let placeholders = (1..=chunk.len())
            .map(|i| format!("?{i}"))
            .collect::<Vec<_>>()
            .join(", ");
        let sql = format!("SELECT path, tag_id FROM file_tags WHERE path IN ({placeholders})");
        let mut stmt = conn.prepare(&sql)?;
        let rows = stmt.query_map(rusqlite::params_from_iter(chunk.iter()), |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
        })?;
        for row in rows {
            let (norm_path, tag_id) = row?;
            if let Some(orig) = origin.get(&norm_path) {
                map.entry(orig.clone()).or_default().push(tag_id);
            }
        }
    }
    Ok(map)
}

pub fn paths_for(conn: &Connection, tag_id: &str) -> Result<Vec<String>> {
    let mut stmt = conn.prepare("SELECT path FROM file_tags WHERE tag_id = ?1")?;
    let paths = stmt
        .query_map([tag_id], |r| r.get::<_, String>(0))?
        .collect::<rusqlite::Result<_>>()?;
    Ok(paths)
}


/// Remap tags on rename/move: old -> new, including nested paths (for folders).
/// Only the relevant rows are affected.
pub fn relink(conn: &Connection, old: &str, new: &str) -> Result<()> {
    let old = normalize(old);
    let new = normalize(new);
    let (old, new) = (old.as_str(), new.as_str());

    let (sep, prefix, upper) = subtree_bounds(old);

    let rows: Vec<(String, String)> = {
        let mut stmt = conn.prepare(
            "SELECT path, tag_id FROM file_tags WHERE path = ?1 OR (path >= ?2 AND path < ?3)",
        )?;
        stmt.query_map((old, &prefix, &upper), |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
        })?
        .collect::<rusqlite::Result<_>>()?
    };

    if rows.is_empty() {
        return Ok(());
    }

    // A single burst instead of N autocommit writes to the WAL. Roll back on error.
    conn.execute_batch("BEGIN")?;
    let res: Result<()> = (|| {
        let mut stmt = conn
            .prepare("UPDATE OR IGNORE file_tags SET path = ?1 WHERE path = ?2 AND tag_id = ?3")?;
        for (path, tag_id) in &rows {
            let new_path = if path == old {
                new.to_string()
            } else {
                format!("{new}{sep}{}", &path[prefix.len()..])
            };
            stmt.execute((&new_path, path, tag_id))?;
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

/// Delete tags of a path and all nested ones (on move to Trash) — in one query.
pub fn purge(conn: &Connection, path: &str) -> Result<()> {
    let path = normalize(path);
    let path = path.as_str();
    let (_sep, prefix, upper) = subtree_bounds(path);
    conn.execute(
        "DELETE FROM file_tags WHERE path = ?1 OR (path >= ?2 AND path < ?3)",
        (path, &prefix, &upper),
    )?;
    Ok(())
}

/// Number of files per tag.
pub fn counts(conn: &Connection) -> Result<HashMap<String, i64>> {
    let mut stmt = conn.prepare("SELECT tag_id, COUNT(*) FROM file_tags GROUP BY tag_id")?;
    let mut map: HashMap<String, i64> = HashMap::new();
    let rows = stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?)))?;
    for row in rows {
        let (id, c) = row?;
        map.insert(id, c);
    }
    Ok(map)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn mem() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE file_tags (path TEXT NOT NULL, tag_id TEXT NOT NULL, PRIMARY KEY(path, tag_id));",
        )
        .unwrap();
        conn
    }

    fn rows(conn: &Connection) -> Vec<(String, String)> {
        let mut stmt = conn
            .prepare("SELECT path, tag_id FROM file_tags ORDER BY path, tag_id")
            .unwrap();
        stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))
            .unwrap()
            .map(|r| r.unwrap())
            .collect()
    }

    #[test]
    fn for_paths_one_query_returns_tags() {
        let conn = mem();
        assign(&conn, "C:\\a\\1.txt", "urgent").unwrap();
        assign(&conn, "C:\\a\\1.txt", "done").unwrap();
        assign(&conn, "C:\\a\\2.txt", "reference").unwrap();
        let map = for_paths(
            &conn,
            &[
                "C:\\a\\1.txt".into(),
                "C:\\a\\2.txt".into(),
                "C:\\a\\nope.txt".into(),
            ],
        )
        .unwrap();
        let mut t1 = map.get("C:\\a\\1.txt").cloned().unwrap();
        t1.sort();
        assert_eq!(t1, vec!["done".to_string(), "urgent".to_string()]);
        assert_eq!(map.get("C:\\a\\2.txt").unwrap(), &vec!["reference".to_string()]);
        assert!(!map.contains_key("C:\\a\\nope.txt"));
    }

    #[test]
    fn for_paths_empty_input() {
        let conn = mem();
        assert!(for_paths(&conn, &[]).unwrap().is_empty());
    }

    #[test]
    fn relink_moves_exact_and_nested_keeps_sibling() {
        let conn = mem();
        assign(&conn, "C:\\proj\\b", "urgent").unwrap(); // the folder itself
        assign(&conn, "C:\\proj\\b\\x.txt", "done").unwrap(); // nested
        assign(&conn, "C:\\proj\\bb\\y.txt", "reference").unwrap(); // SIBLING — leave alone
        relink(&conn, "C:\\proj\\b", "C:\\proj\\renamed").unwrap();
        // Paths are stored canonicalized (path_key::normalize) — we run the
        // expectations through the same normalization so the test is OS-independent.
        assert_eq!(
            rows(&conn),
            vec![
                (normalize("C:\\proj\\bb\\y.txt"), "reference".to_string()),
                (normalize("C:\\proj\\renamed"), "urgent".to_string()),
                (normalize("C:\\proj\\renamed\\x.txt"), "done".to_string()),
            ]
        );
    }

    #[test]
    fn purge_removes_exact_and_nested_keeps_sibling() {
        let conn = mem();
        assign(&conn, "C:\\proj\\b", "urgent").unwrap();
        assign(&conn, "C:\\proj\\b\\x.txt", "done").unwrap();
        assign(&conn, "C:\\proj\\bb\\y.txt", "reference").unwrap();
        purge(&conn, "C:\\proj\\b").unwrap();
        assert_eq!(
            rows(&conn),
            vec![(normalize("C:\\proj\\bb\\y.txt"), "reference".to_string())]
        );
    }

    #[test]
    fn relink_forward_slash_paths() {
        let conn = mem();
        assign(&conn, "/home/u/b/x", "done").unwrap();
        assign(&conn, "/home/u/bb/y", "urgent").unwrap();
        relink(&conn, "/home/u/b", "/home/u/c").unwrap();
        // Forward slashes on input are canonicalized too (on Windows → '\'),
        // so we build the expectations through normalize.
        assert_eq!(
            rows(&conn),
            vec![
                (normalize("/home/u/bb/y"), "urgent".to_string()),
                (normalize("/home/u/c/x"), "done".to_string()),
            ]
        );
    }
}
