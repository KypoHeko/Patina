//! Команды истории версий.

use std::path::Path;
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use rusqlite::Connection;
use tauri::State;

use crate::error::{Error, Result};
use crate::index::versions_repo::{self, Version};
use crate::indexer::hasher;
use crate::state::AppState;

fn now_secs() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

fn lock(db: &Mutex<Connection>) -> Result<std::sync::MutexGuard<'_, Connection>> {
    db.lock()
        .map_err(|_| Error::Operation("БД заблокирована (poisoned)".into()))
}

/// Снимок, если содержимое изменилось. Хеширование и копирование файла идут
/// ВНЕ блокировки БД; мьютекс берётся лишь короткими сериями (чтение последнего
/// хеша и вставка), чтобы тяжёлый файловый I/O не блокировал остальной UI.
fn do_snapshot(db: &Mutex<Connection>, versions_dir: &Path, path: &str) -> Result<()> {
    let meta = std::fs::metadata(path)?;
    if !meta.is_file() {
        return Ok(());
    }
    let hash = hasher::hash_file(path).map_err(Error::Io)?; // без лока

    {
        let conn = lock(db)?;
        if versions_repo::latest_hash(&conn, path)?.as_deref() == Some(hash.as_str()) {
            return Ok(()); // без изменений
        }
    }

    let blob = versions_dir.join(&hash);
    if !blob.exists() {
        std::fs::copy(path, &blob)?; // без лока
    }

    {
        let conn = lock(db)?;
        versions_repo::insert(&conn, path, now_secs(), meta.len() as i64, &hash)?;
    }
    Ok(())
}

#[tauri::command]
pub async fn snapshot_version(state: State<'_, AppState>, path: String) -> Result<Vec<Version>> {
    do_snapshot(&state.db, &state.versions_dir, &path)?;
    let conn = state.db()?;
    versions_repo::list_for(&conn, &path)
}

#[tauri::command]
pub fn list_versions(state: State<AppState>, path: String) -> Result<Vec<Version>> {
    let conn = state.db()?;
    versions_repo::list_for(&conn, &path)
}

#[tauri::command]
pub async fn restore_version(state: State<'_, AppState>, id: i64) -> Result<()> {
    let v = {
        let conn = state.db()?;
        versions_repo::get(&conn, id)?
            .ok_or_else(|| Error::Operation("версия не найдена".into()))?
    };
    // снимок текущего состояния, чтобы восстановление было обратимым
    let _ = do_snapshot(&state.db, &state.versions_dir, &v.path);
    let blob = state.versions_dir.join(&v.hash);
    std::fs::copy(&blob, &v.path)?; // без лока
    Ok(())
}
