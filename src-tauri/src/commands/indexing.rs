//! Живой индекс: фоновое построение + рекурсивное слежение за корнем +
//! инкрементальные точечные апдейты (upsert/delete по конкретным путям из
//! событий вотчера) вместо полного рескана. Здесь же строятся рёбра связей
//! (зависимости/обратные ссылки) из содержимого файлов.

use std::collections::{HashMap, HashSet};
use std::path::Path;

use notify::{recommended_watcher, Event, RecursiveMode, Watcher};
use tauri::{AppHandle, Emitter, Manager, State};

use crate::error::{Error, Result};
use crate::index::file_index::{self, IndexRow};
use crate::index::{content_index, edges_repo};
use crate::indexer::{build_row, links};
use crate::state::AppState;

const TEXT_EXTS: &[&str] = &[
    "txt", "md", "markdown", "rs", "js", "mjs", "ts", "jsx", "tsx", "json", "toml", "yaml", "yml",
    "ini", "cfg", "conf", "log", "csv", "tsv", "html", "htm", "css", "xml", "sh", "bat", "py", "go",
    "java", "c", "h", "cpp", "hpp", "sql", "kt", "swift", "rb", "php", "lua", "vue", "svelte",
];
const MAX_FILE: u64 = 1_048_576; // 1 МБ
const SCAN_LIMIT: usize = 50_000;
const MENTION_SCAN_CAP: usize = 200_000; // верхняя граница тела для скана упоминаний

fn is_text(path: &Path, len: u64) -> bool {
    if len == 0 || len > MAX_FILE {
        return false;
    }
    match path.extension().map(|e| e.to_string_lossy().to_ascii_lowercase()) {
        Some(ext) => TEXT_EXTS.contains(&ext.as_str()),
        None => false,
    }
}

fn ext_lower(path: &str) -> String {
    Path::new(path)
        .extension()
        .map(|e| e.to_string_lossy().to_ascii_lowercase())
        .unwrap_or_default()
}

/// Явные исходящие рёбра одного файла по его телу (ссылки/импорты, резолвятся в
/// существующие пути). Mention-слой здесь НЕ строится — он требует общей карты
/// имён и пересобирается при полной переиндексации.
fn explicit_out_edges(src_path: &str, body: &str) -> Vec<(String, String)> {
    let ext = ext_lower(src_path);
    let kind = links::kind_for(&ext);
    let mut seen: HashSet<String> = HashSet::new();
    let mut out = Vec::new();
    for raw in links::extract_targets(&ext, body) {
        if let Some(dst) = links::resolve(src_path, &raw) {
            if dst != src_path && seen.insert(dst.clone()) {
                out.push((dst, kind.to_string()));
            }
        }
    }
    out
}

/// Полный набор рёбер поддерева: явные ссылки/импорты + слой упоминаний по
/// уникальному имени файла (дискавери). Строится из уже прочитанных тел.
fn build_edges(
    content_rows: &[content_index::ContentRow],
    rows: &[IndexRow],
) -> Vec<(String, String, String)> {
    // basename(lower) -> уникальный путь (None, если имя неуникально).
    let mut by_name: HashMap<String, Option<String>> = HashMap::new();
    for r in rows {
        by_name
            .entry(r.name.to_lowercase())
            .and_modify(|v| *v = None)
            .or_insert_with(|| Some(r.path.clone()));
    }

    let mut out: Vec<(String, String, String)> = Vec::new();
    let mut seen: HashSet<(String, String)> = HashSet::new();

    // 1) Явные ссылки/импорты.
    for cr in content_rows {
        for (dst, kind) in explicit_out_edges(&cr.path, &cr.body) {
            if seen.insert((cr.path.clone(), dst.clone())) {
                out.push((cr.path.clone(), dst, kind));
            }
        }
    }

    // 2) Упоминания по уникальному имени (слой дискавери). Имена < 4 символов
    // пропускаем, чтобы не шуметь (a.h, io и т.п.).
    let unique: Vec<(&String, &String)> = by_name
        .iter()
        .filter_map(|(name, p)| p.as_ref().map(|path| (name, path)))
        .filter(|(name, _)| name.len() >= 4)
        .collect();

    for cr in content_rows {
        let body = &cr.body;
        let slice = if body.len() > MENTION_SCAN_CAP {
            let mut end = MENTION_SCAN_CAP;
            while end > 0 && !body.is_char_boundary(end) {
                end -= 1;
            }
            &body[..end]
        } else {
            &body[..]
        };
        let hay = slice.to_lowercase();
        for (name, dst) in &unique {
            if dst.as_str() == cr.path {
                continue;
            }
            if hay.contains(name.as_str()) && seen.insert((cr.path.clone(), (*dst).clone())) {
                out.push((cr.path.clone(), (*dst).clone(), "mention".to_string()));
            }
        }
    }

    out
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
                        // Инкрементально обновляем только явные исходящие рёбра
                        // (mention-слой пересоберётся при полной переиндексации).
                        let edges = explicit_out_edges(&pstr, &body);
                        let _ = edges_repo::replace_derived_for_src(&conn, &pstr, &edges);
                    }
                }
            }
        }
    } else if let Ok(conn) = state.db() {
        let _ = file_index::delete_path(&conn, &pstr);
        let _ = edges_repo::purge(&conn, &pstr);
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
        // Содержимое + рёбра связей строятся из одних и тех же прочитанных тел.
        let edges = build_edges(&content_rows, &rows);
        let mut conn = state.db()?;
        content_index::ensure_table(&conn)?;
        content_index::replace_subtree(&mut conn, root, &content_rows)?;
        edges_repo::replace_derived_subtree(&mut conn, root, &edges)?;
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
        // build_all — синхронный блокирующий обход + транзакции: spawn_blocking,
        // чтобы не занимать воркер async-рантайма на всё время сборки индекса.
        tauri::async_runtime::spawn_blocking(move || {
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
