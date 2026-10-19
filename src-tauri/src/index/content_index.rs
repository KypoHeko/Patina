//! Full-text index of text-file contents (SQLite FTS5).
//! The table is created lazily — if FTS5 is not built into SQLite, that is a
//! regular error, not a crash on application startup.

use rusqlite::Connection;
use serde::Serialize;

use crate::error::Result;
use crate::index::path_bounds::subtree_bounds;
use crate::index::path_key::normalize;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ContentHit {
    pub path: String,
    pub name: String,
    pub snippet: String,
}

pub struct ContentRow {
    pub path: String,
    pub body: String,
    /// (size, mtime ms) of the file the body was read from.
    pub stamp: Stamp,
}

/// (size, mtime in ms) of an indexed file.
pub type Stamp = (i64, Option<i64>);

/// Create the FTS5 table (and its stamp table) if they do not exist yet.
/// `content_stamps` records the size/mtime each body was read at, so a rebuild
/// re-reads only files that changed SINCE THEIR CONTENT WAS INDEXED (the
/// file_index stamps are not enough: the watcher updates them even while the
/// content index is off).
pub fn ensure_table(conn: &Connection) -> Result<()> {
    conn.execute_batch(
        "CREATE VIRTUAL TABLE IF NOT EXISTS content_fts
         USING fts5(path UNINDEXED, body, tokenize = 'unicode61');
         CREATE TABLE IF NOT EXISTS content_stamps (
             path  TEXT PRIMARY KEY,
             size  INTEGER NOT NULL,
             mtime INTEGER
         );",
    )?;
    Ok(())
}

/// Stamps of the indexed bodies of a subtree, by canonical key.
pub fn stamps_in_subtree(conn: &Connection, root: &str) -> Result<std::collections::HashMap<String, Stamp>> {
    let root = normalize(root);
    let (_, prefix, upper) = subtree_bounds(&root);
    let mut stmt = conn.prepare(
        "SELECT path, size, mtime FROM content_stamps WHERE path = ?1 OR (path >= ?2 AND path < ?3)",
    )?;
    let map = stmt
        .query_map((&root, &prefix, &upper), |r| Ok((r.get::<_, String>(0)?, (r.get(1)?, r.get(2)?))))?
        .collect::<rusqlite::Result<_>>()?;
    Ok(map)
}

/// Canonical keys of every file of the subtree that has content indexed.
pub fn keys_in_subtree(conn: &Connection, root: &str) -> Result<std::collections::HashSet<String>> {
    let root = normalize(root);
    let (_, prefix, upper) = subtree_bounds(&root);
    let mut stmt =
        conn.prepare("SELECT path FROM content_fts WHERE path = ?1 OR (path >= ?2 AND path < ?3)")?;
    let keys = stmt
        .query_map((&root, &prefix, &upper), |r| r.get::<_, String>(0))?
        .collect::<rusqlite::Result<_>>()?;
    Ok(keys)
}

/// Insert or replace the bodies of `rows` in one transaction (a batch of an
/// index build: memory stays bounded by the batch, not by the whole tree).
pub fn upsert_many(conn: &mut Connection, rows: &[ContentRow]) -> Result<()> {
    let tx = conn.transaction()?;
    {
        let mut del = tx.prepare("DELETE FROM content_fts WHERE path = ?1")?;
        let mut ins = tx.prepare("INSERT INTO content_fts (path, body) VALUES (?1, ?2)")?;
        let mut stamp = tx.prepare("INSERT OR REPLACE INTO content_stamps (path, size, mtime) VALUES (?1, ?2, ?3)")?;
        for r in rows {
            let key = normalize(&r.path);
            del.execute([&key])?;
            ins.execute((&key, &r.body))?;
            stamp.execute((&key, r.stamp.0, r.stamp.1))?;
        }
    }
    tx.commit()?;
    Ok(())
}

/// Delete the content rows of the given canonical keys, in one transaction.
pub fn delete_keys(conn: &mut Connection, keys: &[String]) -> Result<()> {
    if keys.is_empty() {
        return Ok(());
    }
    let tx = conn.transaction()?;
    {
        let mut del = tx.prepare("DELETE FROM content_fts WHERE path = ?1")?;
        let mut del_stamp = tx.prepare("DELETE FROM content_stamps WHERE path = ?1")?;
        for k in keys {
            del.execute([k])?;
            del_stamp.execute([k])?;
        }
    }
    tx.commit()?;
    Ok(())
}

/// Search file contents within a subtree. Returns path, name and a highlighted snippet.
pub fn search(conn: &Connection, root: &str, query: &str, limit: usize) -> Result<Vec<ContentHit>> {
    let root = normalize(root);
    let root = root.as_str();
    let match_q = build_match(query);
    if match_q.is_empty() {
        return Ok(Vec::new());
    }
    let (_, prefix, upper) = subtree_bounds(root);
    let mut stmt = conn.prepare(
        "SELECT path, snippet(content_fts, 1, '[', ']', '…', 12)
         FROM content_fts
         WHERE content_fts MATCH ?1 AND path >= ?2 AND path < ?3
         ORDER BY rank LIMIT ?4",
    )?;
    let rows = stmt.query_map((&match_q, &prefix, &upper, limit as i64), |r| {
        Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
    })?;
    let hits: Vec<(String, String)> = rows.collect::<rusqlite::Result<_>>()?;
    // FTS rows are keyed by the canonical (case-folded on Windows) path; report
    // the original spelling from the file index so results show and open the
    // real names.
    let mut out = Vec::with_capacity(hits.len());
    for (key, snippet) in hits {
        let (path, name) = match crate::index::file_index::display_of(conn, &key)? {
            Some((path, name, _)) => (path, name),
            None => {
                let path = crate::index::path_key::on_disk_case(&key);
                let name = path.rsplit(['\\', '/']).next().unwrap_or(&path).to_string();
                (path, name)
            }
        };
        out.push(ContentHit { path, name, snippet });
    }
    Ok(out)
}

/// Convert a user query into a safe FTS5 MATCH.
/// A fully quoted query ("exact phrase") -> phrase search as-is.
/// Otherwise each word -> "word"* (prefix), joined by spaces (implicit AND).
/// Quotes inside words are stripped so they do not break FTS5 syntax.
fn build_match(q: &str) -> String {
    let t = q.trim();
    if t.len() >= 2 && t.starts_with('"') && t.ends_with('"') {
        let inner = t[1..t.len() - 1].replace('"', "");
        let inner = inner.trim();
        if inner.is_empty() {
            return String::new();
        }
        return format!("\"{inner}\"");
    }
    t.split_whitespace()
        .map(|w| w.replace('"', ""))
        .filter(|w| !w.is_empty())
        .map(|w| format!("\"{w}\"*"))
        .collect::<Vec<_>>()
        .join(" ")
}

/// Update a single file's contents in place (delete+insert: FTS5 has no upsert).
pub fn upsert_one(conn: &Connection, path: &str, body: &str, stamp: Stamp) -> Result<()> {
    let path = normalize(path);
    let path = path.as_str();
    conn.execute("DELETE FROM content_fts WHERE path = ?1", (path,))?;
    conn.execute(
        "INSERT INTO content_fts (path, body) VALUES (?1, ?2)",
        (path, body),
    )?;
    conn.execute(
        "INSERT OR REPLACE INTO content_stamps (path, size, mtime) VALUES (?1, ?2, ?3)",
        (path, stamp.0, stamp.1),
    )?;
    Ok(())
}

/// Delete a path and its subtree from the content index.
pub fn delete_path(conn: &Connection, path: &str) -> Result<()> {
    let path = normalize(path);
    let path = path.as_str();
    let (_, prefix, upper) = subtree_bounds(path);
    conn.execute(
        "DELETE FROM content_fts WHERE path = ?1 OR (path >= ?2 AND path < ?3)",
        (path, &prefix, &upper),
    )?;
    conn.execute(
        "DELETE FROM content_stamps WHERE path = ?1 OR (path >= ?2 AND path < ?3)",
        (path, &prefix, &upper),
    )?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn words_become_prefix_and() {
        assert_eq!(build_match("hello world"), "\"hello\"* \"world\"*");
        assert_eq!(build_match("  one  "), "\"one\"*");
    }

    #[test]
    fn empty_and_blank() {
        assert_eq!(build_match(""), "");
        assert_eq!(build_match("    "), "");
    }

    #[test]
    fn inner_quotes_stripped() {
        assert_eq!(build_match("foo\"bar"), "\"foobar\"*");
    }

    #[test]
    fn quoted_is_exact_phrase() {
        assert_eq!(build_match("\"exact phrase\""), "\"exact phrase\"");
    }

    #[test]
    fn quoted_empty_is_empty() {
        assert_eq!(build_match("\"\""), "");
        assert_eq!(build_match("\"   \""), "");
    }

    fn mem() -> Connection {
        let c = crate::index::db::open_in_memory(); // search() joins file_index
        ensure_table(&c).unwrap();
        c
    }

    #[test]
    fn upsert_many_replaces_and_delete_keys_removes() {
        let mut c = mem();
        let row = |p: &str, b: &str| ContentRow { path: p.into(), body: b.into(), stamp: (1, Some(1)) };
        upsert_many(&mut c, &[row("/r/a.txt", "alpha"), row("/r/b.txt", "beta")]).unwrap();
        upsert_many(&mut c, &[row("/r/a.txt", "gamma")]).unwrap(); // replaced, not duplicated
        assert_eq!(keys_in_subtree(&c, "/r").unwrap().len(), 2);
        assert!(search(&c, "/r", "alpha", 10).unwrap().is_empty());
        assert_eq!(search(&c, "/r", "gamma", 10).unwrap().len(), 1);
        delete_keys(&mut c, &[normalize("/r/b.txt")]).unwrap();
        assert_eq!(keys_in_subtree(&c, "/r").unwrap().len(), 1);
        assert_eq!(stamps_in_subtree(&c, "/r").unwrap().len(), 1, "stamps follow the rows");
    }
}

