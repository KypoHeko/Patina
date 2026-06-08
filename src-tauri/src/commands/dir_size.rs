//! Команды размеров папок (Фаза 1).
//!
//! `compute_dir_sizes` — авторитетный обход поддерева по кнопке: считает
//! рекурсивный размер КАЖДОГО каталога и сохраняет в `dir_agg`. Обход
//! post-order (`contents_first`): когда мы выходим из каталога, суммы всех его
//! потомков уже накоплены, поэтому всё считается за один проход со стеком
//! аккумуляторов (память O(глубины), не O(числа файлов)). Берём только
//! метаданные — без чтения содержимого, поэтому это на порядок дешевле
//! контент-индексации. Поддержание свежести (вотчер/дельты) — отдельная фаза.
//!
//! `dir_sizes` — точечное чтение готовых значений для показа в панели.

use std::collections::HashMap;
use std::path::PathBuf;
use std::time::UNIX_EPOCH;

use tauri::{AppHandle, Emitter, Manager};
use walkdir::WalkDir;

use crate::error::{Error, Result};
use crate::index::dir_agg_repo::{self, DirAgg};
use crate::index::path_key;
use crate::state::AppState;

/// Через сколько записанных каталогов коммитим батч и шлём прогресс.
const COMMIT_BATCH: usize = 2000;

fn max_opt(a: Option<i64>, b: Option<i64>) -> Option<i64> {
    match (a, b) {
        (Some(x), Some(y)) => Some(x.max(y)),
        (Some(x), None) | (None, Some(x)) => Some(x),
        (None, None) => None,
    }
}

#[tauri::command]
pub async fn compute_dir_sizes(app: AppHandle, root: String) -> Result<usize> {
    tauri::async_runtime::spawn_blocking(move || -> Result<usize> {
        let state = app.state::<AppState>();

        // Свежий пересчёт: убираем прежние агрегаты поддерева, чтобы не оставались
        // строки для каталогов, которых уже нет.
        {
            let conn = state.db()?;
            dir_agg_repo::clear_subtree(&conn, &path_key::normalize(&root))?;
        }

        // path -> (накопленный размер, число файлов, максимальный mtime).
        let mut acc: HashMap<PathBuf, (i64, i64, Option<i64>)> = HashMap::new();
        let mut batch: Vec<DirAgg> = Vec::with_capacity(COMMIT_BATCH);
        let mut done_dirs = 0usize;

        // follow_links(false) + отсечение симлинков: не разворачиваем ссылки,
        // иначе циклы и двойной счёт. (Junction'ы Windows — известное ограничение
        // Фазы 1.) contents_first(true) — каталог выдаётся ПОСЛЕ его содержимого.
        let walker = WalkDir::new(&root)
            .follow_links(false)
            .contents_first(true)
            .into_iter()
            .filter_entry(|e| !e.file_type().is_symlink());

        for entry in walker.filter_map(|e| e.ok()) {
            let meta = match entry.metadata() {
                Ok(m) => m,
                Err(_) => continue,
            };
            let mtime = meta
                .modified()
                .ok()
                .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                .map(|d| d.as_secs() as i64);
            let path = entry.path();

            if meta.is_dir() {
                // Все потомки уже обработаны (contents_first) — берём накопленное.
                let (size, count, mmax) = acc.remove(path).unwrap_or((0, 0, None));
                let mmax = max_opt(mmax, mtime);
                batch.push(DirAgg {
                    path: path_key::normalize(&path.to_string_lossy()),
                    total_size: size,
                    file_count: count,
                    mtime_max: mmax,
                });
                done_dirs += 1;

                // Вклад каталога в его родителя.
                if let Some(parent) = path.parent() {
                    let e = acc.entry(parent.to_path_buf()).or_insert((0, 0, None));
                    e.0 += size;
                    e.1 += count;
                    e.2 = max_opt(e.2, mmax);
                }

                if batch.len() >= COMMIT_BATCH {
                    {
                        let conn = state.db()?;
                        dir_agg_repo::upsert_many(&conn, &batch)?;
                    }
                    batch.clear();
                    let _ = app.emit(
                        "dirsize:progress",
                        serde_json::json!({ "root": root, "count": done_dirs }),
                    );
                }
            } else {
                // Файл: его размер идёт в накопитель родителя.
                let size = meta.len() as i64;
                if let Some(parent) = path.parent() {
                    let e = acc.entry(parent.to_path_buf()).or_insert((0, 0, None));
                    e.0 += size;
                    e.1 += 1;
                    e.2 = max_opt(e.2, mtime);
                }
            }
        }

        if !batch.is_empty() {
            let conn = state.db()?;
            dir_agg_repo::upsert_many(&conn, &batch)?;
        }

        let _ = app.emit(
            "dirsize:done",
            serde_json::json!({ "root": root, "count": done_dirs }),
        );
        Ok(done_dirs)
    })
    .await
    .map_err(|e| Error::Operation(format!("compute_dir_sizes прервана: {e}")))?
}

#[tauri::command]
pub async fn dir_sizes(app: AppHandle, paths: Vec<String>) -> Result<HashMap<String, i64>> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        let conn = state.db_read()?;
        dir_agg_repo::sizes_for(&conn, &paths)
    })
    .await
    .map_err(|e| Error::Operation(format!("dir_sizes прервана: {e}")))?
}
