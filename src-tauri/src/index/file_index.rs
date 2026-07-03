//! Persistent file index: fast search without walking the disk on every query.

use rusqlite::Connection;

use crate::error::Result;
use crate::index::path_bounds::subtree_bounds;
use crate::models::file::{EntryKind, FileEntry};
use crate::index::path_key::normalize;

/// An index row (prepared during the walk, OUTSIDE the DB lock).
pub struct IndexRow {
    pub path: String,
    pub name: String,
    pub is_dir: bool,
    pub size: u64,
    pub mtime: Option<u64>,
    pub ext: Option<String>,
}


/// Fully replace the `root` subtree in the index (in a single transaction).
pub fn replace_subtree(conn: &mut Connection, root: &str, rows: &[IndexRow]) -> Result<()> {
    let root = normalize(root);
    let root = root.as_str();
    let (_, prefix, upper) = subtree_bounds(root);
    let tx = conn.transaction()?;
    tx.execute(
        "DELETE FROM file_index WHERE path = ?1 OR (path >= ?2 AND path < ?3)",
        (root, &prefix, &upper),
    )?;
    {
        let mut stmt = tx.prepare(
            "INSERT OR REPLACE INTO file_index
             (path, name, name_lower, is_dir, size, mtime, ext)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
        )?;
        for r in rows {
            stmt.execute((
                &normalize(&r.path),
                &r.name,
                r.name.to_lowercase(),
                r.is_dir as i64,
                r.size as i64,
                r.mtime.map(|m| m as i64),
                &r.ext,
            ))?;
        }
    }
    tx.commit()?;
    Ok(())
}

fn row_to_entry(r: &rusqlite::Row) -> rusqlite::Result<FileEntry> {
    let is_dir: i64 = r.get(2)?;
    Ok(FileEntry {
        path: r.get(0)?,
        name: r.get(1)?,
        kind: if is_dir != 0 {
            EntryKind::Folder
        } else {
            EntryKind::File
        },
        size: r.get::<_, i64>(3)? as u64,
        modified: r.get::<_, Option<i64>>(4)?.map(|m| m as u64),
        extension: r.get::<_, Option<String>>(5)?,
    })
}

/// Escape LIKE special characters (% _ and the escape character itself) for ESCAPE '\\'.
fn escape_like(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 4);
    for c in s.chars() {
        if c == '%' || c == '_' || c == '\\' {
            out.push('\\');
        }
        out.push(c);
    }
    out
}

/// Up to `limit` rows of the subtree. Substring name filtering is done on the
/// SQL side (we do not stream the whole tree over IPC). An empty `query` => the
/// base set (for the front-end regex mode, where filtering happens there).
/// Regex/tags are handled on the front end.
pub fn search(conn: &Connection, root: &str, query: &str, limit: usize) -> Result<Vec<FileEntry>> {
    let root = normalize(root);
    let root = root.as_str();
    let (_, prefix, upper) = subtree_bounds(root);
    let q = query.trim();
    let mut out = Vec::new();
    if q.is_empty() {
        let mut stmt = conn.prepare(
            "SELECT path, name, is_dir, size, mtime, ext FROM file_index
             WHERE path >= ?1 AND path < ?2 LIMIT ?3",
        )?;
        let rows = stmt.query_map((&prefix, &upper, limit as i64), row_to_entry)?;
        for r in rows {
            out.push(r?);
        }
    } else {
        let like = format!("%{}%", escape_like(&q.to_lowercase()));
        let mut stmt = conn.prepare(
            "SELECT path, name, is_dir, size, mtime, ext FROM file_index
             WHERE path >= ?1 AND path < ?2 AND name_lower LIKE ?3 ESCAPE '\\' LIMIT ?4",
        )?;
        let rows = stmt.query_map((&prefix, &upper, &like, limit as i64), row_to_entry)?;
        for r in rows {
            out.push(r?);
        }
    }
    Ok(out)
}

/// Update a single index row in place (incremental maintenance).
pub fn upsert_one(conn: &Connection, row: &IndexRow) -> Result<()> {
    conn.execute(
        "INSERT OR REPLACE INTO file_index (path, name, name_lower, is_dir, size, mtime, ext)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
        (
            &normalize(&row.path),
            &row.name,
            row.name.to_lowercase(),
            row.is_dir as i64,
            row.size as i64,
            row.mtime.map(|m| m as i64),
            &row.ext,
        ),
    )?;
    Ok(())
}

/// Delete a path and its subtree (if it was a folder) from the index.
pub fn delete_path(conn: &Connection, path: &str) -> Result<()> {
    let path = normalize(path);
    let path = path.as_str();
    let (_, prefix, upper) = subtree_bounds(path);
    conn.execute(
        "DELETE FROM file_index WHERE path = ?1 OR (path >= ?2 AND path < ?3)",
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
            "CREATE TABLE file_index (path TEXT PRIMARY KEY, name TEXT NOT NULL, name_lower TEXT NOT NULL, is_dir INTEGER NOT NULL, size INTEGER NOT NULL, mtime INTEGER, ext TEXT);",
        )
        .unwrap();
        c
    }

    // Write the path canonicalized — exactly like production (replace_subtree/
    // upsert_one). Otherwise search() normalizes the root and a "raw" path in
    // the table falls outside the subtree range (BINARY collation) and is not found.
    fn ins(c: &Connection, path: &str, name: &str) {
        c.execute(
            "INSERT INTO file_index (path, name, name_lower, is_dir, size, mtime, ext)
             VALUES (?1, ?2, ?3, 0, 0, NULL, NULL)",
            (normalize(path), name, name.to_lowercase()),
        )
        .unwrap();
    }

    #[test]
    fn escape_like_escapes_specials() {
        assert_eq!(escape_like("a%b_c\\d"), "a\\%b\\_c\\\\d");
        assert_eq!(escape_like("plain"), "plain");
    }

    #[test]
    fn search_substring_scoped_to_subtree() {
        let c = mem();
        ins(&c, "C:\\p\\report.txt", "report.txt");
        ins(&c, "C:\\p\\sub\\budget.xlsx", "budget.xlsx");
        ins(&c, "C:\\other\\report.txt", "report.txt"); // outside the subtree
        let hits = search(&c, "C:\\p", "report", 10).unwrap();
        let paths: Vec<String> = hits.iter().map(|e| e.path.clone()).collect();
        assert_eq!(paths, vec![normalize("C:\\p\\report.txt")]);
    }

    #[test]
    fn percent_is_literal_not_wildcard() {
        let c = mem();
        ins(&c, "C:\\p\\50%off.txt", "50%off.txt");
        ins(&c, "C:\\p\\50abcoff.txt", "50abcoff.txt");
        // "50%" searches for a literal '%', not a LIKE wildcard
        let hits = search(&c, "C:\\p", "50%", 10).unwrap();
        let names: Vec<String> = hits.iter().map(|e| e.name.clone()).collect();
        assert_eq!(names, vec!["50%off.txt".to_string()]);
    }

    #[test]
    fn empty_query_returns_whole_subtree() {
        let c = mem();
        ins(&c, "C:\\p\\a.txt", "a.txt");
        ins(&c, "C:\\p\\b.txt", "b.txt");
        ins(&c, "C:\\q\\c.txt", "c.txt");
        assert_eq!(search(&c, "C:\\p", "", 10).unwrap().len(), 2);
    }
}
