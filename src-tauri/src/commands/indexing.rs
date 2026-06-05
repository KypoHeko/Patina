//! Живой индекс: фоновое построение + рекурсивное слежение за корнем +
//! инкрементальные точечные апдейты (upsert/delete по конкретным путям из
//! событий вотчера) вместо полного рескана.

use std::path::Path;

use notify::{recommended_watcher, Event, RecursiveMode, Watcher};
use tauri::{AppHandle, Emitter, Manager, State};

use crate::error::{Error, Result};
use crate::index::file_index::{self, IndexRow};
use crate::index::{content_index};
use crate::state::AppState;

const TEXT_EXTS: &[&str] = &[
    "txt", "md", "markdown", "rs", "js", "mjs", "ts", "jsx", "tsx", "json", "toml", "yaml", "yml",
    "ini", "cfg", "conf", "log", "csv", "tsv", "html", "htm", "css", "xml", "sh", "bat", "py", "go",
    "java", "c", "h", "cpp", "hpp", "sql", "kt", "swift", "rb", "php", "lua", "vue", "svelte",
];
const MAX_FILE: u64 = 1_048_576; // 1 МБ
const SCAN_LIMIT: usize = 50_000;

fn is_text(path: &Path, len: u64) -> bool {
    if len == 0 || len > MAX_FILE {
        return false;
    }
    match path.extension().map(|e| e.to_string_lossy().to_ascii_lowercase()) {
        Some(ext) => TEXT_EXTS.contains(&ext.as_str()),
        None => false,
    }
}

fn build_row(path: &Path) -> Option<IndexRow> {
    let meta = std::fs::metadata(path).ok()?;
    let is_dir = meta.is_dir();
    let name = path.file_name()?.to_string_lossy().into_owned();
    let mtime = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64);
    let ext = if is_dir {
        None
    } else {
        path.extension().map(|e| e.to_string_lossy().into_owned())
    };
    Some(IndexRow {
        path: path.to_string_lossy().into_owned(),
        name,
        is_dir,
        size: if is_dir { 0 } else { meta.len() },
        mtime,
        ext,
    })
}

/// Применить изменение ОДНОГО пути к индексам. Best-effort: ошибки глотаются —
/// это фоновое сопровождение, рассинхрон выправит следующая полная пересборка.
fn apply_change(app: &AppHandle, content_active: bool, path: &Path) {
    let state = app.state::<AppState>();
    let pstr = path.to_string_lossy().into_owned();
    if path.exists() {
        if let Some(row) = build_row(path) {
            let text_file = !row.is_dir && is_text(path, row.size);
            if let Ok(conn) = state.db() {
                let _ = file_index::upsert_one(&conn, &row);
            }
            if content_active && text_file {
                if let Ok(bytes) = std::fs::read(path) {
                    let body = String::from_utf8_lossy(&bytes).into_owned();
                    if let Ok(conn) = state.db() {
                        let _ = content_index::ensure_table(&conn);
                        let _ = content_index::upsert_one(&conn, &pstr, &body);
                    }
                }
            }
        }
    } else if let Ok(conn) = state.db() {
        let _ = file_index::delete_path(&conn, &pstr);
        if content_active {
            let _ = content_index::delete_path(&conn, &pstr);
        }
    }
}

/// Полное (пере)построение индекса корня — выполняется в фоне.
fn build_all(app: &AppHandle, root: &str, content: bool) -> Result<()> {
    let state = app.state::<AppState>();
    let mut rows: Vec<IndexRow> = Vec::new();
    let mut content_rows: Vec<content_index::ContentRow> = Vec::new();
    for entry in walkdir::WalkDir::new(root)
        .min_depth(1)
        .into_iter()
        .filter_map(|e| e.ok())
    {
        if rows.len() >= SCAN_LIMIT {
            break;
        }
        let path = entry.path();
        if let Some(row) = build_row(path) {
            if content && !row.is_dir && is_text(path, row.size) {
                if let Ok(bytes) = std::fs::read(path) {
                    content_rows.push(content_index::ContentRow {
                        path: row.path.clone(),
                        body: String::from_utf8_lossy(&bytes).into_owned(),
                    });
                }
            }
            rows.push(row);
        }
    }
    {
        let mut conn = state.db()?;
        file_index::replace_subtree(&mut conn, root, &rows)?;
    }
    if content {
        let mut conn = state.db()?;
        content_index::ensure_table(&conn)?;
        content_index::replace_subtree(&mut conn, root, &content_rows)?;
    }
    Ok(())
}

/// Запустить/обновить живой индекс корня: фоновое построение + рекурсивный
/// вотчер, который точечно поддерживает индексы свежими. Идемпотентно.
#[tauri::command]
pub async fn start_index(
    app: AppHandle,
    state: State<'_, AppState>,
    root: String,
    content: bool,
    force: bool,
) -> Result<()> {
    if root.is_empty() || root.starts_with("tag:") {
        return Ok(());
    }

    // Обновить флаги; узнать, сменился ли корень.
    let root_changed = {
        let mut info = state.index_info()?;
        if content {
            info.content_active = true;
        }
        let changed = info.root.as_deref() != Some(root.as_str());
        info.root = Some(root.clone());
        changed
    };

    // Построить в фоне, если корень новый, форс, или впервые включили контент.
    if root_changed || force || content {
        let app2 = app.clone();
        let root2 = root.clone();
        tauri::async_runtime::spawn(async move {
            let _ = build_all(&app2, &root2, content);
            let _ = app2.emit("index:ready", &root2);
        });
    }

    // (Пере)запустить рекурсивный вотчер на корень.
    if root_changed || force {
        let app3 = app.clone();
        let mut watcher =
            recommended_watcher(move |res: notify::Result<Event>| {
                if let Ok(ev) = res {
                    if ev.paths.is_empty() {
                        return;
                    }
                    let content_active = app3
                        .state::<AppState>()
                        .index_info
                        .lock()
                        .map(|i| i.content_active)
                        .unwrap_or(false);
                    for p in &ev.paths {
                        apply_change(&app3, content_active, p);
                    }
                    let _ = app3.emit("index:changed", ());
                }
            })
            .map_err(|e| Error::Operation(e.to_string()))?;
        watcher
            .watch(Path::new(&root), RecursiveMode::Recursive)
            .map_err(|e| Error::Operation(e.to_string()))?;
        *state.index_watcher()? = Some(watcher);
    }

    Ok(())
}
