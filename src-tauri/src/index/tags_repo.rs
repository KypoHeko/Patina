//! Доступ к таблице file_tags.

use std::collections::HashMap;

use rusqlite::Connection;

use crate::error::Result;
use crate::index::path_bounds::subtree_bounds;

pub fn assign(conn: &Connection, path: &str, tag_id: &str) -> Result<()> {
    conn.execute(
        "INSERT OR IGNORE INTO file_tags (path, tag_id) VALUES (?1, ?2)",
        (path, tag_id),
    )?;
    Ok(())
}

pub fn remove(conn: &Connection, path: &str, tag_id: &str) -> Result<()> {
    conn.execute(
        "DELETE FROM file_tags WHERE path = ?1 AND tag_id = ?2",
        (path, tag_id),
    )?;
    Ok(())
}

/// Теги для набора путей одним запросом `IN` (батчами, т.к. SQLite по умолчанию
/// ограничивает число bound-параметров 999). Возвращаются только помеченные пути.
pub fn for_paths(conn: &Connection, paths: &[String]) -> Result<HashMap<String, Vec<String>>> {
    let mut map: HashMap<String, Vec<String>> = HashMap::new();
    for chunk in paths.chunks(900) {
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
            let (path, tag_id) = row?;
            map.entry(path).or_default().push(tag_id);
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


/// Перенести теги при переименовании/перемещении: old -> new, включая
/// вложенные пути (для папок). Затрагиваются только релевантные строки.
pub fn relink(conn: &Connection, old: &str, new: &str) -> Result<()> {
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

    // Один burst вместо N autocommit-записей в WAL. На ошибке — откат.
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

/// Удалить теги пути и всех вложенных (при удалении в Корзину) — одним запросом.
pub fn purge(conn: &Connection, path: &str) -> Result<()> {
    let (_sep, prefix, upper) = subtree_bounds(path);
    conn.execute(
        "DELETE FROM file_tags WHERE path = ?1 OR (path >= ?2 AND path < ?3)",
        (path, &prefix, &upper),
    )?;
    Ok(())
}

/// Кол-во файлов на каждый тег.
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
        assert!(map.get("C:\\a\\nope.txt").is_none());
    }

    #[test]
    fn for_paths_empty_input() {
        let conn = mem();
        assert!(for_paths(&conn, &[]).unwrap().is_empty());
    }

    #[test]
    fn relink_moves_exact_and_nested_keeps_sibling() {
        let conn = mem();
        assign(&conn, "C:\\proj\\b", "urgent").unwrap(); // сама папка
        assign(&conn, "C:\\proj\\b\\x.txt", "done").unwrap(); // вложенный
        assign(&conn, "C:\\proj\\bb\\y.txt", "reference").unwrap(); // СОСЕД — не трогать
        relink(&conn, "C:\\proj\\b", "C:\\proj\\renamed").unwrap();
        assert_eq!(
            rows(&conn),
            vec![
                ("C:\\proj\\bb\\y.txt".to_string(), "reference".to_string()),
                ("C:\\proj\\renamed".to_string(), "urgent".to_string()),
                ("C:\\proj\\renamed\\x.txt".to_string(), "done".to_string()),
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
            vec![("C:\\proj\\bb\\y.txt".to_string(), "reference".to_string())]
        );
    }

    #[test]
    fn relink_forward_slash_paths() {
        let conn = mem();
        assign(&conn, "/home/u/b/x", "done").unwrap();
        assign(&conn, "/home/u/bb/y", "urgent").unwrap();
        relink(&conn, "/home/u/b", "/home/u/c").unwrap();
        assert_eq!(
            rows(&conn),
            vec![
                ("/home/u/bb/y".to_string(), "urgent".to_string()),
                ("/home/u/c/x".to_string(), "done".to_string()),
            ]
        );
    }
}
