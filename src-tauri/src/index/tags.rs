//! Access to the file_tags table.

use std::collections::HashMap;

use rusqlite::Connection;

use crate::error::Result;
use crate::index::path_bounds::{remap, subtree_bounds};
use crate::index::path_key::{normalize, on_disk_case, rebase_display};

/// Tag `path`. The key is canonical; the original spelling is kept for display.
pub fn assign(conn: &Connection, path: &str, tag_id: &str) -> Result<()> {
    let key = normalize(path);
    conn.execute(
        "INSERT INTO file_tags (path, tag_id, display_path) VALUES (?1, ?2, ?3)
         ON CONFLICT(path, tag_id) DO UPDATE SET display_path = excluded.display_path",
        (&key, tag_id, path),
    )?;
    Ok(())
}

/// Tag (or untag, `on = false`) many paths in ONE transaction — tagging a
/// selection used to be one IPC call and one autocommit per file.
pub fn set_many(conn: &Connection, paths: &[String], tag_id: &str, on: bool) -> Result<()> {
    let tx = conn.unchecked_transaction()?;
    for p in paths {
        if on {
            assign(&tx, p, tag_id)?;
        } else {
            remove(&tx, p, tag_id)?;
        }
    }
    tx.commit()?;
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

/// Paths carrying `tag_id`, in their ORIGINAL case (legacy rows without a
/// stored spelling are resolved against the disk).
pub fn paths_for(conn: &Connection, tag_id: &str) -> Result<Vec<String>> {
    let mut stmt = conn.prepare("SELECT path, display_path FROM file_tags WHERE tag_id = ?1")?;
    let paths = stmt
        .query_map([tag_id], |r| Ok((r.get::<_, String>(0)?, r.get::<_, Option<String>>(1)?)))?
        .map(|r| r.map(|(key, display)| display.unwrap_or_else(|| on_disk_case(&key))))
        .collect::<rusqlite::Result<_>>()?;
    Ok(paths)
}


/// Remap tags on rename/move: old -> new, including nested paths (for folders).
/// `old`/`new` are the caller's original-case paths: the key is remapped
/// canonically, the stored spelling keeps the case of the untouched tail.
/// A row whose target already carries the tag is merged (deleted) instead of
/// being left behind under the old path.
pub fn relink(conn: &Connection, old: &str, new: &str) -> Result<()> {
    let old_key = normalize(old);
    let new_key = normalize(new);
    let (_sep, prefix, upper) = subtree_bounds(&old_key);

    let rows: Vec<(String, String, Option<String>)> = {
        let mut stmt = conn.prepare(
            "SELECT path, tag_id, display_path FROM file_tags WHERE path = ?1 OR (path >= ?2 AND path < ?3)",
        )?;
        stmt.query_map((&old_key, &prefix, &upper), |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?
            .collect::<rusqlite::Result<_>>()?
    };

    if rows.is_empty() {
        return Ok(());
    }

    // A single burst instead of N autocommit writes to the WAL. Roll back on error.
    conn.execute_batch("BEGIN")?;
    let res: Result<()> = (|| {
        let mut upd = conn.prepare(
            "UPDATE OR IGNORE file_tags SET path = ?1, display_path = ?2 WHERE path = ?3 AND tag_id = ?4",
        )?;
        let mut del = conn.prepare("DELETE FROM file_tags WHERE path = ?1 AND tag_id = ?2")?;
        for (path, tag_id, display) in &rows {
            let new_path = remap(path, &old_key, &new_key).unwrap_or_else(|| path.clone());
            let new_display = display
                .as_deref()
                .and_then(|d| rebase_display(d, old, new))
                .unwrap_or_else(|| rebase_display(path, old, new).unwrap_or_else(|| new_path.clone()));
            upd.execute((&new_path, &new_display, path, tag_id))?;
            // If UPDATE OR IGNORE skipped the row (the target already has this
            // tag), drop the leftover under the old key. A case-only rename keeps
            // the same key — then the row was updated in place and must stay.
            if &new_path != path {
                del.execute((path, tag_id))?;
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

/// Every assignment as (path for the file system, tag id).
pub fn all(conn: &Connection) -> Result<Vec<(String, String)>> {
    let mut stmt = conn.prepare("SELECT COALESCE(display_path, path), tag_id FROM file_tags")?;
    let rows = stmt
        .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?
        .collect::<rusqlite::Result<_>>()?;
    Ok(rows)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn mem() -> Connection {
        crate::index::db::open_in_memory()
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

    #[test]
    fn paths_for_returns_original_case_and_relink_keeps_tail_case() {
        let conn = mem();
        assign(&conn, "/Home/U/Docs/Report.TXT", "urgent").unwrap();
        assert_eq!(paths_for(&conn, "urgent").unwrap(), vec!["/Home/U/Docs/Report.TXT".to_string()]);
        relink(&conn, "/Home/U/Docs", "/Home/U/Archive").unwrap();
        assert_eq!(paths_for(&conn, "urgent").unwrap(), vec!["/Home/U/Archive/Report.TXT".to_string()]);
    }

    #[test]
    fn relink_onto_an_already_tagged_target_leaves_no_orphan() {
        let conn = mem();
        assign(&conn, "/a/x.txt", "done").unwrap();
        assign(&conn, "/b/x.txt", "done").unwrap();
        relink(&conn, "/a/x.txt", "/b/x.txt").unwrap();
        assert_eq!(rows(&conn), vec![(normalize("/b/x.txt"), "done".to_string())]);
    }

    #[test]
    fn all_lists_assignments_with_original_paths() {
        let conn = mem();
        assign(&conn, "/x/A.txt", "done").unwrap();
        assert_eq!(all(&conn).unwrap(), vec![("/x/A.txt".to_string(), "done".to_string())]);
    }

    #[test]
    fn set_many_tags_and_untags_in_bulk() {
        let conn = mem();
        let paths: Vec<String> = (0..50).map(|i| format!("/d/{i}.txt")).collect();
        set_many(&conn, &paths, "urgent", true).unwrap();
        assert_eq!(paths_for(&conn, "urgent").unwrap().len(), 50);
        set_many(&conn, &paths[..10], "urgent", false).unwrap();
        assert_eq!(paths_for(&conn, "urgent").unwrap().len(), 40);
    }
}

