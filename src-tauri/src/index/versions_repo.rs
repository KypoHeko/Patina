//! Таблица versions + version_chunks + zstd_dicts.

use rusqlite::{Connection, OptionalExtension};
use serde::Serialize;

use crate::error::Result;
use crate::index::path_bounds::{remap, subtree_bounds};
use crate::index::path_key::normalize;
use crate::index::chunker::Chunk;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Version {
    pub id: i64,
    pub path: String,
    pub ts: i64,
    pub size: i64,
    pub hash: String,
    pub label: String,
    pub strategy: String,
    pub dict_id: Option<i64>,
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

/// Количество версий со strategy='zstd' (для принятия решения об обучении словаря).
pub fn zstd_count(conn: &Connection) -> Result<i64> {
    let count = conn.query_row(
        "SELECT COUNT(*) FROM versions WHERE strategy = 'zstd'",
        [],
        |r| r.get::<_, i64>(0),
    )?;
    Ok(count)
}

/// Id текущего (последнего обученного) словаря.
pub fn current_dict_id(conn: &Connection) -> Result<Option<i64>> {
    let id = conn
        .query_row(
            "SELECT id FROM zstd_dicts ORDER BY id DESC LIMIT 1",
            [],
            |r| r.get::<_, i64>(0),
        )
        .optional()?;
    Ok(id)
}

/// Следующая метка: v1, v2, v3… Ищет максимальный числовой суффикс
/// среди существующих меток формата vN и прибавляет 1.
pub fn next_label(conn: &Connection, path: &str) -> Result<String> {
    let path = normalize(path);
    let path = path.as_str();

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

pub fn insert(
    conn: &Connection,
    path: &str,
    ts: i64,
    size: i64,
    hash: &str,
    label: &str,
    strategy: &str,
    dict_id: Option<i64>,
) -> Result<i64> {
    let path = normalize(path);
    let path = path.as_str();
    conn.execute(
        "INSERT INTO versions (path, ts, size, hash, label, strategy, dict_id) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
        (path, ts, size, hash, label, strategy, dict_id),
    )?;
    Ok(conn.last_insert_rowid())
}

pub fn list_for(conn: &Connection, path: &str) -> Result<Vec<Version>> {
    let path = normalize(path);
    let path = path.as_str();
    let mut stmt = conn
        .prepare("SELECT id, path, ts, size, hash, label, strategy, dict_id FROM versions WHERE path = ?1 ORDER BY ts DESC, id DESC")?;
    let rows = stmt
        .query_map([path], |r| {
            Ok(Version {
                id: r.get(0)?,
                path: r.get(1)?,
                ts: r.get(2)?,
                size: r.get(3)?,
                hash: r.get(4)?,
                label: r.get(5)?,
                strategy: r.get(6)?,
                dict_id: r.get(7)?,
            })
        })?
        .collect::<rusqlite::Result<_>>()?;
    Ok(rows)
}

pub fn get(conn: &Connection, id: i64) -> Result<Option<Version>> {
    let v = conn
        .query_row(
            "SELECT id, path, ts, size, hash, label, strategy, dict_id FROM versions WHERE id = ?1",
            [id],
            |r| {
                Ok(Version {
                    id: r.get(0)?,
                    path: r.get(1)?,
                    ts: r.get(2)?,
                    size: r.get(3)?,
                    hash: r.get(4)?,
                    label: r.get(5)?,
                    strategy: r.get(6)?,
                    dict_id: r.get(7)?,
                })
            },
        )
        .optional()?;
    Ok(v)
}

/// Удалить версию по id. Возвращает (path, hash, strategy) удалённой записи —
/// чтобы вызывающая сторона могла решить, удалять ли блоб/чанки.
pub fn delete(conn: &Connection, id: i64) -> Result<Option<(String, String, String)>> {
    let removed = conn
        .query_row(
            "SELECT path, hash, strategy FROM versions WHERE id = ?1",
            [id],
            |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, String>(2)?)),
        )
        .optional()?;
    if let Some((..)) = &removed {
        // Удаляем также чанки версии (если strategy='chunked')
        conn.execute("DELETE FROM version_chunks WHERE version_id = ?1", [id])?;
        conn.execute("DELETE FROM versions WHERE id = ?1", [id])?;
    }
    Ok(removed)
}

/// Проверить, ссылается ли ещё кто-нибудь на данный хеш блоба.
/// Используется для безопасного удаления блоба/сжатого блоба.
pub fn hash_refcount(conn: &Connection, hash: &str) -> Result<i64> {
    let count = conn.query_row(
        "SELECT COUNT(*) FROM versions WHERE hash = ?1",
        [hash],
        |r| r.get::<_, i64>(0),
    )?;
    Ok(count)
}

/// Проверить, ссылается ли ещё кто-нибудь на данный чанк.
pub fn chunk_refcount(conn: &Connection, chunk_hash: &str) -> Result<i64> {
    let count = conn.query_row(
        "SELECT COUNT(*) FROM version_chunks WHERE chunk_hash = ?1",
        [chunk_hash],
        |r| r.get::<_, i64>(0),
    )?;
    Ok(count)
}

/// Сохранить список чанков для версии (strategy='chunked').
pub fn insert_chunks(conn: &Connection, version_id: i64, chunks: &[Chunk]) -> Result<()> {
    for (i, c) in chunks.iter().enumerate() {
        conn.execute(
            "INSERT INTO version_chunks (version_id, chunk_order, chunk_hash, chunk_size) VALUES (?1, ?2, ?3, ?4)",
            (version_id, i as i64, &c.hash, c.size),
        )?;
    }
    Ok(())
}

/// Получить список чанков версии в порядке.
pub fn get_chunks(conn: &Connection, version_id: i64) -> Result<Vec<(String, i64)>> {
    let mut stmt = conn.prepare(
        "SELECT chunk_hash, chunk_size FROM version_chunks WHERE version_id = ?1 ORDER BY chunk_order",
    )?;
    let rows = stmt
        .query_map([version_id], |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?)))?
        .collect::<rusqlite::Result<_>>()?;
    Ok(rows)
}

/// Записать новый словарь zstd в БД. Возвращает его id.
/// `zstd_count_at_train` — сколько zstd-версий было на момент обучения
/// (используется should_retrain для принятия решения о переобучении).
pub fn insert_dict(conn: &Connection, ts: i64, size: i64, zstd_count_at_train: i64) -> Result<i64> {
    conn.execute(
        "INSERT INTO zstd_dicts (ts, size, zstd_count_at_train) VALUES (?1, ?2, ?3)",
        (ts, size, zstd_count_at_train),
    )?;
    Ok(conn.last_insert_rowid())
}

/// Сколько zstd-версий было на момент обучения текущего словаря.
/// None, если словаря ещё нет. Используется should_retrain.
pub fn current_dict_zstd_count_at_train(conn: &Connection) -> Result<Option<i64>> {
    let v = conn
        .query_row(
            "SELECT zstd_count_at_train FROM zstd_dicts ORDER BY id DESC LIMIT 1",
            [],
            |r| r.get::<_, i64>(0),
        )
        .optional()?;
    Ok(v)
}

/// Проверить, используется ли ещё словарь (хотя бы одна версия ссылается на него).
pub fn dict_refcount(conn: &Connection, dict_id: i64) -> Result<i64> {
    let count = conn.query_row(
        "SELECT COUNT(*) FROM versions WHERE dict_id = ?1",
        [dict_id],
        |r| r.get::<_, i64>(0),
    )?;
    Ok(count)
}

/// Перенести историю версий при переименовании/перемещении: old -> new, включая
/// вложенные пути (для папок). Контент-адресные блобы и чанки трогать
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
/// Блобы и чанки не удаляем: они контент-адресны и могут ссылаться другие пути;
/// сбор мусора — отдельная задача.
pub fn purge(conn: &Connection, path: &str) -> Result<()> {
    let path = normalize(path);
    let path = path.as_str();
    let (_, prefix, upper) = subtree_bounds(path);

    // Удаляем чанки для chunked-версий
    let version_ids: Vec<i64> = {
        let mut stmt = conn.prepare(
            "SELECT id FROM versions WHERE path = ?1 OR (path >= ?2 AND path < ?3)",
        )?;
        stmt.query_map((path, &prefix, &upper), |r| r.get::<_, i64>(0))?
            .collect::<rusqlite::Result<_>>()?
    };
    if !version_ids.is_empty() {
        // Удаляем чанки партиями
        for chunk_id in &version_ids {
            conn.execute("DELETE FROM version_chunks WHERE version_id = ?1", [chunk_id])?;
        }
    }

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
            "CREATE TABLE versions (id INTEGER PRIMARY KEY AUTOINCREMENT, path TEXT NOT NULL, ts INTEGER NOT NULL, size INTEGER NOT NULL, hash TEXT NOT NULL, label TEXT NOT NULL DEFAULT '', strategy TEXT NOT NULL DEFAULT 'full', dict_id INTEGER);
             CREATE TABLE version_chunks (version_id INTEGER NOT NULL, chunk_order INTEGER NOT NULL, chunk_hash TEXT NOT NULL, chunk_size INTEGER NOT NULL, PRIMARY KEY (version_id, chunk_order));
             CREATE TABLE zstd_dicts (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, size INTEGER NOT NULL, zstd_count_at_train INTEGER NOT NULL DEFAULT 0);",
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
        insert(&c, "C:\\proj\\b", 1, 10, "h1", "v1", "full", None).unwrap();
        insert(&c, "C:\\proj\\b\\x.txt", 1, 20, "h2", "v1", "full", None).unwrap();
        insert(&c, "C:\\proj\\bb\\y.txt", 1, 30, "h3", "v1", "full", None).unwrap();
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
        insert(&c, "C:\\proj\\b", 1, 10, "h1", "v1", "full", None).unwrap();
        insert(&c, "C:\\proj\\b\\x.txt", 1, 20, "h2", "v1", "full", None).unwrap();
        insert(&c, "C:\\proj\\bb\\y.txt", 1, 30, "h3", "v1", "full", None).unwrap();
        purge(&c, "C:\\proj\\b").unwrap();
        assert_eq!(paths(&c), vec!["C:\\proj\\bb\\y.txt".to_string()]);
    }

    #[test]
    fn next_label_increments() {
        let c = mem();
        assert_eq!(next_label(&c, "C:\\file.txt").unwrap(), "v1");
        insert(&c, "C:\\file.txt", 1, 10, "h1", "v1", "full", None).unwrap();
        assert_eq!(next_label(&c, "C:\\file.txt").unwrap(), "v2");
        insert(&c, "C:\\file.txt", 2, 10, "h2", "v2", "full", None).unwrap();
        assert_eq!(next_label(&c, "C:\\file.txt").unwrap(), "v3");
    }

    #[test]
    fn next_label_skips_gap_after_delete() {
        let c = mem();
        insert(&c, "C:\\file.txt", 1, 10, "h1", "v1", "full", None).unwrap();
        insert(&c, "C:\\file.txt", 2, 10, "h2", "v2", "full", None).unwrap();
        insert(&c, "C:\\file.txt", 3, 10, "h3", "v3", "full", None).unwrap();
        delete(&c, 2).unwrap();
        assert_eq!(next_label(&c, "C:\\file.txt").unwrap(), "v4");
    }

    #[test]
    fn delete_removes_row_and_returns_info() {
        let c = mem();
        insert(&c, "C:\\file.txt", 1, 10, "h1", "v1", "zstd", None).unwrap();
        let removed = delete(&c, 1).unwrap();
        assert_eq!(removed, Some(("C:\\file.txt".to_string(), "h1".to_string(), "zstd".to_string())));
        assert_eq!(count_for(&c, "C:\\file.txt").unwrap(), 0);
    }

    #[test]
    fn chunk_crud() {
        let c = mem();
        let vid = insert(&c, "C:\\big.dat", 1, 50_000_000, "h1", "v1", "chunked", None).unwrap();
        let chunks = vec![
            Chunk { hash: "ca".to_string(), size: 20_000_000 },
            Chunk { hash: "cb".to_string(), size: 20_000_000 },
            Chunk { hash: "cc".to_string(), size: 10_000_000 },
        ];
        insert_chunks(&c, vid, &chunks).unwrap();

        let stored = get_chunks(&c, vid).unwrap();
        assert_eq!(stored.len(), 3);
        assert_eq!(stored[0].0, "ca");
        assert_eq!(stored[2].0, "cc");

        assert_eq!(chunk_refcount(&c, "ca").unwrap(), 1);
        assert_eq!(chunk_refcount(&c, "cx").unwrap(), 0);

        // Удаление версии удаляет чанки
        delete(&c, vid).unwrap();
        assert_eq!(chunk_refcount(&c, "ca").unwrap(), 0);
        assert!(get_chunks(&c, vid).unwrap().is_empty());
    }

    #[test]
    fn dict_crud() {
        let c = mem();
        // Обучили словарь при 4 zstd-версиях
        let did = insert_dict(&c, 1000, 4096, 4).unwrap();
        assert_eq!(current_dict_id(&c).unwrap(), Some(did));
        assert_eq!(dict_refcount(&c, did).unwrap(), 0);
        assert_eq!(current_dict_zstd_count_at_train(&c).unwrap(), Some(4));

        insert(&c, "C:\\doc.txt", 1, 5000, "h1", "v1", "zstd", Some(did)).unwrap();
        assert_eq!(dict_refcount(&c, did).unwrap(), 1);
    }

    #[test]
    fn hash_refcount_counts_correctly() {
        let c = mem();
        insert(&c, "C:\\a.txt", 1, 10, "h1", "v1", "full", None).unwrap();
        insert(&c, "C:\\b.txt", 1, 10, "h1", "v1", "zstd", None).unwrap();
        assert_eq!(hash_refcount(&c, "h1").unwrap(), 2);
        delete(&c, 1).unwrap();
        assert_eq!(hash_refcount(&c, "h1").unwrap(), 1);
    }

    #[test]
    fn zstd_count_filters_strategy() {
        let c = mem();
        insert(&c, "C:\\a.txt", 1, 10, "h1", "v1", "full", None).unwrap();
        insert(&c, "C:\\b.txt", 2, 10, "h2", "v1", "zstd", None).unwrap();
        insert(&c, "C:\\c.txt", 3, 10, "h3", "v1", "zstd", None).unwrap();
        assert_eq!(zstd_count(&c).unwrap(), 2);
    }
}
