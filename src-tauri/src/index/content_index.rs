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
}

/// Create the FTS5 table if it does not exist yet. Called before indexing/search.
pub fn ensure_table(conn: &Connection) -> Result<()> {
    conn.execute_batch(
        "CREATE VIRTUAL TABLE IF NOT EXISTS content_fts
         USING fts5(path UNINDEXED, body, tokenize = 'unicode61');",
    )?;
    Ok(())
}

/// Fully replace a subtree's contents in the index (in a single transaction).
pub fn replace_subtree(conn: &mut Connection, root: &str, rows: &[ContentRow]) -> Result<()> {
    let root = normalize(root);
    let root = root.as_str();
    let (_, prefix, upper) = subtree_bounds(root);
    let tx = conn.transaction()?;
    tx.execute(
        "DELETE FROM content_fts WHERE path = ?1 OR (path >= ?2 AND path < ?3)",
        (root, &prefix, &upper),
    )?;
    {
        let mut stmt = tx.prepare("INSERT INTO content_fts (path, body) VALUES (?1, ?2)")?;
        for r in rows {
            stmt.execute((&normalize(&r.path), &r.body))?;
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
    let mut out = Vec::new();
    for row in rows {
        let (path, snippet) = row?;
        let name = path
            .rsplit(['\\', '/'])
            .next()
            .unwrap_or(&path)
            .to_string();
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

/// Count content rows for a subtree. Used by `reindex_content` to return
/// the number of indexed files after delegating to `build_all`.
pub fn count_subtree(conn: &Connection, root: &str) -> Result<usize> {
    let root = normalize(root);
    let root = root.as_str();
    let (_, prefix, upper) = subtree_bounds(root);
    let count: i64 = conn.query_row(
        "SELECT COUNT(*) FROM content_fts WHERE path = ?1 OR (path >= ?2 AND path < ?3)",
        (root, &prefix, &upper),
        |r| r.get(0),
    )?;
    Ok(count as usize)
}

/// Update a single file's contents in place (delete+insert: FTS5 has no upsert).
pub fn upsert_one(conn: &Connection, path: &str, body: &str) -> Result<()> {
    let path = normalize(path);
    let path = path.as_str();
    conn.execute("DELETE FROM content_fts WHERE path = ?1", (path,))?;
    conn.execute(
        "INSERT INTO content_fts (path, body) VALUES (?1, ?2)",
        (path, body),
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
}
