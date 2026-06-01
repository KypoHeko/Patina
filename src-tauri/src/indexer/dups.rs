//! Поиск дубликатов: группировка по размеру -> хеш кандидатов -> группы.

use std::collections::HashMap;
use std::sync::Mutex;

use rusqlite::Connection;
use serde::Serialize;

use crate::error::{Error, Result};
use crate::index::files_repo;
use crate::indexer::{hasher, scanner};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DupGroup {
    pub hash: String,
    pub size: u64,
    pub paths: Vec<String>,
}

/// Поиск дубликатов. Тяжёлое хеширование выполняется ВНЕ блокировки БД:
/// мьютекс соединения захватывается лишь короткими сериями (чтение кэша
/// хешей и запись новых). Это не даёт скану блокировать остальной UI
/// (теги/версии/связи), который тоже ходит в `db.lock()`.
pub fn find(db: &Mutex<Connection>, dir: &str) -> Result<Vec<DupGroup>> {
    // 1. Обход и группировка по размеру — без блокировки.
    let mut by_size: HashMap<u64, Vec<scanner::ScanFile>> = HashMap::new();
    for f in scanner::walk(dir) {
        if f.size > 0 {
            by_size.entry(f.size).or_default().push(f);
        }
    }

    // Кандидаты — файлы, у которых есть «сосед» того же размера.
    let candidates: Vec<scanner::ScanFile> = by_size
        .into_iter()
        .filter(|(_, g)| g.len() >= 2)
        .flat_map(|(_, g)| g)
        .collect();
    if candidates.is_empty() {
        return Ok(Vec::new());
    }

    // 2a. Короткая блокировка: читаем кэш хешей кандидатов (быстрые точечные SELECT).
    let mut hashes: HashMap<String, String> = HashMap::new();
    {
        let conn = db.lock().map_err(|_| Error::Operation("БД заблокирована (poisoned)".into()))?;
        for f in &candidates {
            if let Some(h) = files_repo::cached_hash(&conn, &f.path, f.mtime)? {
                hashes.insert(f.path.clone(), h);
            }
        }
    } // лок отпущен — дальше тяжёлая часть идёт без него

    // 2b. БЕЗ блокировки: хешируем промахи (чтение файлов — самая долгая часть).
    let mut fresh: Vec<(String, u64, i64, String)> = Vec::new();
    for f in &candidates {
        if hashes.contains_key(&f.path) {
            continue;
        }
        let h = hasher::hash_file(&f.path).map_err(Error::Io)?;
        fresh.push((f.path.clone(), f.size, f.mtime, h.clone()));
        hashes.insert(f.path.clone(), h);
    }

    // 2c. Короткая блокировка: пишем новые хеши в кэш.
    if !fresh.is_empty() {
        let conn = db.lock().map_err(|_| Error::Operation("БД заблокирована (poisoned)".into()))?;
        for (path, size, mtime, h) in &fresh {
            files_repo::store_hash(&conn, path, *size, *mtime, h)?;
        }
    }

    // 3. Группировка по хешу: оставляем только настоящие дубликаты, сортируем по размеру.
    let mut by_hash: HashMap<String, (u64, Vec<String>)> = HashMap::new();
    for f in candidates {
        if let Some(h) = hashes.get(&f.path) {
            by_hash
                .entry(h.clone())
                .or_insert((f.size, Vec::new()))
                .1
                .push(f.path);
        }
    }
    let mut groups: Vec<DupGroup> = by_hash
        .into_iter()
        .filter(|(_, (_, paths))| paths.len() > 1)
        .map(|(hash, (size, paths))| DupGroup { hash, size, paths })
        .collect();
    groups.sort_by(|a, b| b.size.cmp(&a.size));
    Ok(groups)
}
