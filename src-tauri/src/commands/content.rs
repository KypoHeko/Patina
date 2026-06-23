//! Full-text content search commands.

use tauri::{AppHandle, Manager};
use walkdir::WalkDir;

use crate::error::{Error, Result};
use crate::index::content_index::{self, ContentHit, ContentRow};
use crate::state::AppState;

const TEXT_EXTS: &[&str] = &[
    "txt", "md", "markdown", "rs", "js", "mjs", "ts", "jsx", "tsx", "json", "toml", "yaml", "yml",
    "ini", "cfg", "conf", "log", "csv", "tsv", "html", "htm", "css", "xml", "sh", "bat", "py", "go",
    "java", "c", "h", "cpp", "hpp", "sql", "kt", "swift", "rb", "php", "lua", "vue", "svelte",
];
const MAX_FILE: u64 = 1_048_576;
const MAX_FILES: usize = 5_000;

/// Best-effort read of up to `cap` bytes from the head of a file.
fn read_head(path: &std::path::Path, cap: usize) -> Vec<u8> {
    use std::io::Read;
    let mut buf = Vec::new();
    if let Ok(f) = std::fs::File::open(path) {
        let _ = f.take(cap as u64).read_to_end(&mut buf);
    }
    buf
}

/// Heuristic: a head sample with no NUL byte and few stray control characters
/// is treated as text — lets unlisted *text* files (e.g. a `.dat` full of
/// digits) be indexed while keeping binaries out.
fn sample_looks_textual(sample: &[u8]) -> bool {
    if sample.is_empty() || sample.contains(&0) {
        return false;
    }
    let control = sample
        .iter()
        .filter(|&&b| b < 0x20 && !matches!(b, b'\t' | b'\n' | b'\r' | 0x0c))
        .count();
    control * 10 < sample.len() * 3
}

#[tauri::command]
pub async fn reindex_content(app: AppHandle, root: String) -> Result<usize> {
    tauri::async_runtime::spawn_blocking(move || -> Result<usize> {
        let mut rows: Vec<ContentRow> = Vec::new();
        for entry in WalkDir::new(&root)
            .min_depth(1)
            .into_iter()
            .filter_map(|e| e.ok())
        {
            if rows.len() >= MAX_FILES {
                break;
            }
            let path = entry.path();
            let meta = match entry.metadata() {
                Ok(m) => m,
                Err(_) => continue,
            };
            if !meta.is_file() || meta.len() == 0 || meta.len() > MAX_FILE {
                continue;
            }
            let ext = path
                .extension()
                .map(|e| e.to_string_lossy().to_ascii_lowercase())
                .unwrap_or_default();
            if !TEXT_EXTS.contains(&ext.as_str()) && !sample_looks_textual(&read_head(path, 8192)) {
                continue;
            }
            let bytes = match std::fs::read(path) {
                Ok(b) => b,
                Err(_) => continue,
            };
            rows.push(ContentRow {
                path: path.to_string_lossy().into_owned(),
                body: String::from_utf8_lossy(&bytes).into_owned(),
            });
        }
        let n = rows.len();
        {
            let state = app.state::<AppState>();
            let mut conn = state.db()?;
            content_index::ensure_table(&conn)?;
            content_index::replace_subtree(&mut conn, &root, &rows)?;
        }
        Ok(n)
    })
    .await
    .map_err(|e| Error::Operation(format!("reindex_content interrupted: {e}")))?
}

#[tauri::command]
pub async fn search_content(
    app: AppHandle,
    root: String,
    query: String,
    limit: usize,
) -> Result<Vec<ContentHit>> {
    tauri::async_runtime::spawn_blocking(move || -> Result<Vec<ContentHit>> {
        let cap = if limit == 0 { 200 } else { limit };
        let state = app.state::<AppState>();
        let result = {
            let conn = state.db_read()?;
            content_index::search(&conn, &root, &query, cap)
        };
        match result {
            Ok(hits) => Ok(hits),
            Err(_) => {
                let conn = state.db()?;
                content_index::ensure_table(&conn)?;
                content_index::search(&conn, &root, &query, cap)
            }
        }
    })
    .await
    .map_err(|e| Error::Operation(format!("search_content interrupted: {e}")))?
}
