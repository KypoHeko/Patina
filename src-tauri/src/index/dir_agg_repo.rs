//! Хранилище агрегатов по каталогам (`dir_agg`): рекурсивный размер и число
//! файлов поддерева. Размеры заполняются обходом по кнопке и читаются панелью
//! точечно. Поля hash/hash_dirty этот репозиторий не трогает — хеши (будущий
//! меркловский роллап) живут отдельным механизмом.

use std::collections::HashMap;

use rusqlite::{Connection, OptionalExtension};

use crate::error::Result;
use crate::index::path_bounds::subtree_bounds;
use crate::index::path_key;

/// Строка агрегата. `path` — уже канонический ключ (path_key::normalize).
pub struct DirAgg {
    pub path: String,
    pub total_size: i64,
    pub file_count: i64,
    pub mtime_max: Option<i64>,
}

/// Батч-upsert агрегатов в одной транзакции. hash/hash_dirty не затрагиваются.
pub fn upsert_many(conn: &Connection, rows: &[DirAgg]) -> Result<()> {
    let tx = conn.unchecked_transaction()?;
    {
        let mut stmt = tx.prepare(
            "INSERT INTO dir_agg (path, total_size, file_count, mtime_max)
             VALUES (?1, ?2, ?3, ?4)
             ON CONFLICT(path) DO UPDATE SET
               total_size = excluded.total_size,
               file_count = excluded.file_count,
               mtime_max  = excluded.mtime_max",
        )?;
        for r in rows {
            stmt.execute((&r.path, r.total_size, r.file_count, r.mtime_max))?;
        }
    }
    tx.commit()?;
    Ok(())
}

/// Удалить агрегаты всего поддерева `root_key` (включая сам корень) перед
/// свежим пересчётом — чтобы не оставались строки для исчезнувших каталогов.
/// Полуинтервал [prefix, upper) — тот же приём, что и в остальных репозиториях.
pub fn clear_subtree(conn: &Connection, root_key: &str) -> Result<()> {
    let (_sep, prefix, upper) = subtree_bounds(root_key);
    conn.execute(
        "DELETE FROM dir_agg WHERE path = ?1 OR (path >= ?2 AND path < ?3)",
        (root_key, prefix, upper),
    )?;
    Ok(())
}

/// Размеры для конкретных путей (для показа в панели). Ключ результата — это
/// ИСХОДНЫЙ путь из запроса (как его знает фронт), значение — total_size.
/// Каталоги, для которых агрегат ещё не посчитан, в результат не попадают.
pub fn sizes_for(conn: &Connection, paths: &[String]) -> Result<HashMap<String, i64>> {
    let mut out = HashMap::with_capacity(paths.len());
    let mut stmt = conn.prepare("SELECT total_size FROM dir_agg WHERE path = ?1")?;
    for p in paths {
        let key = path_key::normalize(p);
        let size: Option<i64> = stmt.query_row([&key], |r| r.get(0)).optional()?;
        if let Some(s) = size {
            out.insert(p.clone(), s);
        }
    }
    Ok(out)
}
