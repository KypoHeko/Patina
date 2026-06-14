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
    pub label: String,
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

/// Количество версий для данного пути.
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

/// Следующая метка: v1, v2, v3… Считает количество существующих версий
/// и прибавляет 1. Если версии есть, но без меток — подбирает максимальный
/// номер из существующих меток формата vN.
pub fn next_label(conn: &Connection, path: &str) -> Result<String> {
    let path = normalize(path);
    let path = path.as_str();

    // Находим максимальный числовой суффикс среди существующих меток vN
    let max_n: i64 = conn
        .query_row(
            "SELECT label FROM versions WHERE path = ?1",
            [path],
            |r| r.get::<_, String>(0),
        )
        .optional()?
        .and_then(|labels| {
            // Нужно найти макс vN среди всех строк — используем другой подход
            None::<i64>
        })
        .unwrap_or(0);

    // Простой надёжный способ: COUNT + 1
    let count = conn.query_row(
        "SELECT COUNT(*) FROM versions WHERE path = ?1",
        [path],
        |r| r.get::<_, i64>(0),
    )?;

    // Но если какие-то версии были удалены, COUNT+1 может совпасть
    // с существующей меткой. Ищем максимальный N из меток vN.
    let mut max_existing: i64 = 0;
    let mut stmt = conn.prepare("SELECT label FROM versions WHERE path = ?1")?;
    let rows = stmt.query_map([path], |r| r.get::<_, String>(0))?;
    for row in rows {
        let label = row?;
        if let Some(suffix) = label.strip_prefix('v') {
            if let Ok(n) = suffix.parse::<i64>() {
                if n > max_existing {
                    max_existing = n;
                }
            }
        }
    }

    Ok(format!("v{}", max_existing + 1))
}

pub fn insert(conn: &Connection, path: &str, ts: i64, size: i64, hash: &str, label: &str) -> Result<i64> {
    let path = normalize(path);
    let path = path.as_str();
    conn.execute(
        "INSERT INTO versions (path, ts, size, hash, label) VALUES (?1, ?2, ?3, ?4, ?5)",
        (path, ts, size, hash, label),
    )?;
    Ok(conn.last_insert_rowid())
}

pub fn list_for(conn: &Connection, path: &str) -> Result<Vec<Version>> {
    let path = normalize(path);
    let path = path.as_str();
    let mut stmt = conn
        .prepare("SELECT id, path, ts, size, hash, label FROM versions WHERE path = ?1 ORDER BY ts DESC, id DESC")?;
    let rows = stmt
        .query_map([path], |r| {
            Ok(Version {
                id: r.get(0)?,
                path: r.get(1)?,
                ts: r.get(2)?,
                size: r.get(3)?,
                hash: r.get(4)?,
                label: r.get(5)?,
            })
        })?
        .collect::<rusqlite::Result<_>>()?;
    Ok(rows)
}

pub fn get(conn: &Connection, id: i64) -> Result<Option<Version>> {
    let v = conn
        .query_row(
            "SELECT id, path, ts, size, hash, label FROM versions WHERE id = ?1",
            [id],
            |r| {
                Ok(Version {
                    id: r.get(0)?,
                    path: r.get(1)?,
                    ts: r.get(2)?,
                    size: r.get(3)?,
                    hash: r.get(4)?,
                    label: r.get(5)?,
                })
            },
        )
        .optional()?;
    Ok(v)
}

/// Удалить версию по id. Возвращает (path, hash) удалённой записи —
/// чтобы вызывающая сторона могла решить, удалять ли блоб.
pub fn delete(conn: &Connection, id: i64) -> Result<Option<(String, String)>> {
    let removed = conn
        .query_row(
            "SELECT path, hash FROM versions WHERE id = ?1",
            [id],
            |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)),
        )
        .optional()?;
    if let Some((..)) = &removed {
        conn.execute("DELETE FROM versions WHERE id = ?1", [id])?;
    }
    Ok(removed)
}

/// Проверить, ссылается ли ещё кто-нибудь на данный хеш.
/// Используется для безопасного удаления блоба: если хеш больше
/// не встречается ни в одной версии — блоб можно удалить.
pub fn hash_refcount(conn: &Connection, hash: &str) -> Result<i64> {
    let count = conn.query_row(
        "SELECT COUNT(*) FROM versions WHERE hash = ?1",
        [hash],
        |r| r.get::<_, i64>(0),
    )?;
    Ok(count)
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
            "CREATE TABLE versions (id INTEGER PRIMARY KEY AUTOINCREMENT, path TEXT NOT NULL, ts INTEGER NOT NULL, size INTEGER NOT NULL, hash TEXT NOT NULL, label TEXT NOT NULL DEFAULT '');",
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
        insert(&c, "C:\\proj\\b", 1, 10, "h1", "v1").unwrap();
        insert(&c, "C:\\proj\\b\\x.txt", 1, 20, "h2", "v1").unwrap();
        insert(&c, "C:\\proj\\bb\\y.txt", 1, 30, "h3", "v1").unwrap();
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
        insert(&c, "C:\\proj\\b", 1, 10, "h1", "v1").unwrap();
        insert(&c, "C:\\proj\\b\\x.txt", 1, 20, "h2", "v1").unwrap();
        insert(&c, "C:\\proj\\bb\\y.txt", 1, 30, "h3", "v1").unwrap();
        purge(&c, "C:\\proj\\b").unwrap();
        assert_eq!(paths(&c), vec!["C:\\proj\\bb\\y.txt".to_string()]);
    }

    #[test]
    fn next_label_increments() {
        let c = mem();
        assert_eq!(next_label(&c, "C:\\file.txt").unwrap(), "v1");
        insert(&c, "C:\\file.txt", 1, 10, "h1", "v1").unwrap();
        assert_eq!(next_label(&c, "C:\\file.txt").unwrap(), "v2");
        insert(&c, "C:\\file.txt", 2, 10, "h2", "v2").unwrap();
        assert_eq!(next_label(&c, "C:\\file.txt").unwrap(), "v3");
    }

    #[test]
    fn next_label_skips_gap_after_delete() {
        let c = mem();
        insert(&c, "C:\\file.txt", 1, 10, "h1", "v1").unwrap();
        insert(&c, "C:\\file.txt", 2, 10, "h2", "v2").unwrap();
        insert(&c, "C:\\file.txt", 3, 10, "h3", "v3").unwrap();
        // Удаляем v2
        delete(&c, 2).unwrap();
        // Следующая метка — v4 (не v3, т.к. v3 уже существует)
        assert_eq!(next_label(&c, "C:\\file.txt").unwrap(), "v4");
    }

    #[test]
    fn delete_removes_row_and_returns_info() {
        let c = mem();
        insert(&c, "C:\\file.txt", 1, 10, "h1", "v1").unwrap();
        let removed = delete(&c, 1).unwrap();
        assert_eq!(removed, Some(("C:\\file.txt".to_string(), "h1".to_string())));
        assert_eq!(count_for(&c, "C:\\file.txt").unwrap(), 0);
    }

    #[test]
    fn hash_refcount_counts_correctly() {
        let c = mem();
        insert(&c, "C:\\a.txt", 1, 10, "h1", "v1").unwrap();
        insert(&c, "C:\\b.txt", 1, 10, "h1", "v1").unwrap(); // тот же хеш, другой файл
        assert_eq!(hash_refcount(&c, "h1").unwrap(), 2);
        delete(&c, 1).unwrap();
        assert_eq!(hash_refcount(&c, "h1").unwrap(), 1);
    }
}
