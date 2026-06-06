//! Таблица versions.

use rusqlite::{Connection, OptionalExtension};
use serde::Serialize;

use crate::error::Result;
use crate::index::path_bounds::{remap, subtree_bounds};
use crate::index::path_key::normalize;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Version {
    pub id: i64,
    pub path: String,
    pub ts: i64,
    pub size: i64,
    pub hash: String,
}

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

pub fn insert(conn: &Connection, path: &str, ts: i64, size: i64, hash: &str) -> Result<i64> {
    let path = normalize(path);
    let path = path.as_str();
    conn.execute(
        "INSERT INTO versions (path, ts, size, hash) VALUES (?1, ?2, ?3, ?4)",
        (path, ts, size, hash),
    )?;
    Ok(conn.last_insert_rowid())
}

pub fn list_for(conn: &Connection, path: &str) -> Result<Vec<Version>> {
    let path = normalize(path);
    let path = path.as_str();
    let mut stmt = conn
        .prepare("SELECT id, path, ts, size, hash FROM versions WHERE path = ?1 ORDER BY ts DESC, id DESC")?;
    let rows = stmt
        .query_map([path], |r| {
            Ok(Version {
                id: r.get(0)?,
                path: r.get(1)?,
                ts: r.get(2)?,
                size: r.get(3)?,
                hash: r.get(4)?,
            })
        })?
        .collect::<rusqlite::Result<_>>()?;
    Ok(rows)
}

pub fn get(conn: &Connection, id: i64) -> Result<Option<Version>> {
    let v = conn
        .query_row(
            "SELECT id, path, ts, size, hash FROM versions WHERE id = ?1",
            [id],
            |r| {
                Ok(Version {
                    id: r.get(0)?,
                    path: r.get(1)?,
                    ts: r.get(2)?,
                    size: r.get(3)?,
                    hash: r.get(4)?,
                })
            },
        )
        .optional()?;
    Ok(v)
}

/// Перенести историю версий при переименовании/перемещении: old -> new, включая
/// вложенные пути (для папок). Контент-адресные блобы (versions/<hash>) трогать
/// не нужно — меняется только колонка `path`.
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

/// Удалить историю версий пути и всех вложенных (при удалении в Корзину).
/// Блобы не удаляем: они контент-адресны и могут шириться другими путями;
/// сбор мусора по блобам — отдельная задача.
pub fn purge(conn: &Connection, path: &str) -> Result<()> {
    let path = normalize(path);
    let path = path.as_str();
    let (_, prefix, upper) = subtree_bounds(path);
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
            "CREATE TABLE versions (id INTEGER PRIMARY KEY AUTOINCREMENT, path TEXT NOT NULL, ts INTEGER NOT NULL, size INTEGER NOT NULL, hash TEXT NOT NULL);",
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
        insert(&c, "C:\\proj\\b", 1, 10, "h1").unwrap(); // сам файл/папка
        insert(&c, "C:\\proj\\b\\x.txt", 1, 20, "h2").unwrap(); // вложенный
        insert(&c, "C:\\proj\\bb\\y.txt", 1, 30, "h3").unwrap(); // СОСЕД — не трогать
        relink(&c, "C:\\proj\\b", "C:\\proj\\renamed").unwrap();
        assert_eq!(
            paths(&c),
            vec![
                "C:\\proj\\bb\\y.txt".to_string(),
                "C:\\proj\\renamed".to_string(),
                "C:\\proj\\renamed\\x.txt".to_string(),
            ]
        );
    }

    #[test]
    fn purge_removes_exact_and_nested_keeps_sibling() {
        let c = mem();
        insert(&c, "C:\\proj\\b", 1, 10, "h1").unwrap();
        insert(&c, "C:\\proj\\b\\x.txt", 1, 20, "h2").unwrap();
        insert(&c, "C:\\proj\\bb\\y.txt", 1, 30, "h3").unwrap();
        purge(&c, "C:\\proj\\b").unwrap();
        assert_eq!(paths(&c), vec!["C:\\proj\\bb\\y.txt".to_string()]);
    }
}
