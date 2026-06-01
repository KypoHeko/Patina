//! Таблица relationships (неориентированные пары).

use std::collections::HashSet;

use rusqlite::Connection;

use crate::error::Result;

fn norm<'a>(a: &'a str, b: &'a str) -> (&'a str, &'a str) {
    if a <= b { (a, b) } else { (b, a) }
}

pub fn add(conn: &Connection, a: &str, b: &str) -> Result<()> {
    if a == b {
        return Ok(());
    }
    let (x, y) = norm(a, b);
    conn.execute(
        "INSERT OR IGNORE INTO relationships (a, b) VALUES (?1, ?2)",
        (x, y),
    )?;
    Ok(())
}

pub fn remove(conn: &Connection, a: &str, b: &str) -> Result<()> {
    let (x, y) = norm(a, b);
    conn.execute("DELETE FROM relationships WHERE a = ?1 AND b = ?2", (x, y))?;
    Ok(())
}

/// Связи, оба конца которых входят в заданное множество путей.
pub fn for_paths(conn: &Connection, paths: &[String]) -> Result<Vec<(String, String)>> {
    let set: HashSet<&str> = paths.iter().map(String::as_str).collect();
    let mut stmt = conn.prepare("SELECT a, b FROM relationships")?;
    let all = stmt
        .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(all
        .into_iter()
        .filter(|(a, b)| set.contains(a.as_str()) && set.contains(b.as_str()))
        .collect())
}
