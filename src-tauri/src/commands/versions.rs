//! Команды истории версий.

use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

use tauri::{AppHandle, Manager};

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

/// Снимок, если содержимое изменилось. Хеширование и копирование файла идут
/// ВНЕ блокировки БД; Mutex берётся лишь короткими сериями.
/// Автоматически назначает метку v1, v2, v3…
fn do_snapshot(db: &std::sync::Mutex<rusqlite::Connection>, versions_dir: &Path, path: &str) -> Result<()> {
    let meta = std::fs::metadata(path)?;
    if !meta.is_file() {
        return Ok(());
    }
    let hash = hasher::hash_file(path).map_err(Error::Io)?;

    {
        let conn = db.lock().map_err(|_| Error::Operation("БД заблокирована (poisoned)".into()))?;
        if versions_repo::latest_hash(&conn, path)?.as_deref() == Some(hash.as_str()) {
            return Ok(());
        }
    }

    let blob = versions_dir.join(&hash);
    if !blob.exists() {
        std::fs::copy(path, &blob)?;
    }

    {
        let conn = db.lock().map_err(|_| Error::Operation("БД заблокирована (poisoned)".into()))?;
        let label = versions_repo::next_label(&conn, path)?;
        versions_repo::insert(&conn, path, now_secs(), meta.len() as i64, &hash, &label)?;
    }
    Ok(())
}

#[tauri::command]
pub async fn snapshot_version(app: AppHandle, path: String) -> Result<Vec<Version>> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        do_snapshot(&state.db, &state.versions_dir, &path)?;
        let conn = state.db_read()?;
        versions_repo::list_for(&conn, &path)
    })
    .await
    .map_err(|e| Error::Operation(format!("snapshot_version прерван: {e}")))?
}

#[tauri::command]
pub async fn list_versions(app: AppHandle, path: String) -> Result<Vec<Version>> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        let conn = state.db_read()?;
        versions_repo::list_for(&conn, &path)
    })
    .await
    .map_err(|e| Error::Operation(format!("list_versions прерван: {e}")))?
}

#[tauri::command]
pub async fn restore_version(app: AppHandle, id: i64) -> Result<()> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        let v = {
            let conn = state.db_read()?;
            versions_repo::get(&conn, id)?
                .ok_or_else(|| Error::Operation("версия не найдена".into()))?
        };
        let _ = do_snapshot(&state.db, &state.versions_dir, &v.path);
        let blob = state.versions_dir.join(&v.hash);
        std::fs::copy(&blob, &v.path)?;
        Ok(())
    })
    .await
    .map_err(|e| Error::Operation(format!("restore_version прерван: {e}")))?
}

/// Удалить версию файла по id. Если на блоб (хеш) больше нет ссылок —
/// блоб тоже удаляется с диска. Нельзя удалить единственную версию
/// (это разрушает целостность — файл остаётся без истории).
#[tauri::command]
pub async fn delete_version(app: AppHandle, id: i64) -> Result<Vec<Version>> {
    tauri::async_runtime::spawn_blocking(move || -> Result<Vec<Version>> {
        let state = app.state::<AppState>();
        let path = {
            let conn = state.db_read()?;
            let v = versions_repo::get(&conn, id)?
                .ok_or_else(|| Error::Operation("версия не найдена".into()))?;
            let count = versions_repo::count_for(&conn, &v.path)?;
            if count <= 1 {
                return Err(Error::Operation("нельзя удалить единственную версию".into()));
            }
            v.path
        };

        let (hash, versions_dir) = {
            let conn = state.db()?;
            let removed = versions_repo::delete(&conn, id)?
                .ok_or_else(|| Error::Operation("версия не найдена".into()))?;
            // Проверяем, ссылается ли ещё кто-то на этот хеш
            let refcount = versions_repo::hash_refcount(&conn, &removed.1)?;
            (removed.1, state.versions_dir.clone())
        };

        // Блоб больше никому не нужен — удаляем
        if refcount == 0 {
            let _ = std::fs::remove_file(versions_dir.join(&hash));
        }

        // Возвращаем обновлённый список версий
        let conn = state.db_read()?;
        versions_repo::list_for(&conn, &path)
    })
    .await
    .map_err(|e| Error::Operation(format!("delete_version прерван: {e}")))?
}
