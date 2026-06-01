//! Полнотекстовый индекс содержимого текстовых файлов (SQLite FTS5).
//! Таблица создаётся лениво — если FTS5 не собран в SQLite, это обычная ошибка,
//! а не падение старта приложения.

use rusqlite::Connection;
use serde::Serialize;

use crate::error::Result;
use crate::index::path_bounds::subtree_bounds;

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

/// Создать FTS5-таблицу, если её ещё нет. Вызывается перед индексацией/поиском.
pub fn ensure_table(conn: &Connection) -> Result<()> {
    conn.execute_batch(
        "CREATE VIRTUAL TABLE IF NOT EXISTS content_fts
         USING fts5(path UNINDEXED, body, tokenize = 'unicode61');",
    )?;
    Ok(())
}



/// Полностью заменить содержимое поддерева в индексе (одной транзакцией).
pub fn replace_subtree(conn: &mut Connection, root: &str, rows: &[ContentRow]) -> Result<()> {
    let (_, prefix, upper) = subtree_bounds(root);
    let tx = conn.transaction()?;
    tx.execute(
        "DELETE FROM content_fts WHERE path = ?1 OR (path >= ?2 AND path < ?3)",
        (root, &prefix, &upper),
    )?;
    {
        let mut stmt = tx.prepare("INSERT INTO content_fts (path, body) VALUES (?1, ?2)")?;
        for r in rows {
            stmt.execute((&r.path, &r.body))?;
        }
    }
    tx.commit()?;
    Ok(())
}

/// Поиск по содержимому в поддереве. Возвращает путь, имя и сниппет с подсветкой.
pub fn search(conn: &Connection, root: &str, query: &str, limit: usize) -> Result<Vec<ContentHit>> {
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
            .rsplit(|c| c == '\\' || c == '/')
            .next()
            .unwrap_or(&path)
            .to_string();
        out.push(ContentHit { path, name, snippet });
    }
    Ok(out)
}

/// Пользовательский запрос -> безопасный FTS5 MATCH.
/// Запрос целиком в кавычках ("точная фраза") -> фразовый поиск как есть.
/// Иначе каждое слово -> "слово"* (префикс), склейка пробелом (неявный AND).
/// Кавычки внутри слов вычищаются, чтобы не ломать синтаксис FTS5.
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
