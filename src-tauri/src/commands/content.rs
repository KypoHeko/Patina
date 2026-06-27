//! Full-text content search commands.

use tauri::{AppHandle, Manager};
use walkdir::WalkDir;

use crate::error::{Error, Result};
use crate::index::content_index::{self, ContentHit, ContentRow};
use crate::index::edges;
use crate::index::file_index::{self, IndexRow};
use crate::state::AppState;
use crate::commands::indexing::{build_edges, is_ignored_dir};

const TEXT_EXTS: &[&str] = &[
    "txt", "md", "markdown", "rs", "js", "mjs", "ts", "jsx", "tsx", "json", "toml", "yaml", "yml",
    "ini", "cfg", "conf", "log", "csv", "tsv", "dat", "html", "htm", "css", "xml", "sh", "bat", "py", "go",
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
        let mut content_rows: Vec<ContentRow> = Vec::new();
        let mut index_rows: Vec<IndexRow> = Vec::new();
        // Use the same is_ignored_dir filter as build_all — otherwise target/,
        // node_modules/, etc. fill the index with thousands of junk rows that
        // drown out the project's own files and waste edge-building time.
        for entry in WalkDir::new(&root)
            .min_depth(1)
            .into_iter()
            .filter_entry(|e| !is_ignored_dir(e))
            .filter_map(|e| e.ok())
        {
            if content_rows.len() >= MAX_FILES {
                break;
            }
            let path = entry.path();
            let meta = match entry.metadata() {
                Ok(m) => m,
                Err(_) => continue,
            };
            let is_dir = meta.is_dir();
            let pstr = path.to_string_lossy().into_owned();
            let name = entry.file_name().to_string_lossy().into_owned();
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
            index_rows.push(IndexRow {
                path: pstr.clone(),
                name,
                is_dir,
                size: if is_dir { 0 } else { meta.len() },
                mtime,
                ext,
            });
            if is_dir || meta.len() == 0 || meta.len() > MAX_FILE {
                continue;
            }
            let ext_lower = path
                .extension()
                .map(|e| e.to_string_lossy().to_ascii_lowercase())
                .unwrap_or_default();
            if !TEXT_EXTS.contains(&ext_lower.as_str()) && !sample_looks_textual(&read_head(path, 8192)) {
                continue;
            }
            let bytes = match std::fs::read(path) {
                Ok(b) => b,
                Err(_) => continue,
            };
            content_rows.push(ContentRow {
                path: pstr,
                body: String::from_utf8_lossy(&bytes).into_owned(),
            });
        }
        let n = content_rows.len();
        eprintln!(
            "[patina:content] reindex_content: {} content_rows, {} index_rows for root={root}",
            n,
            index_rows.len()
        );
        {
            let state = app.state::<AppState>();
            let mut conn = state.db()?;
            content_index::ensure_table(&conn)?;
            content_index::replace_subtree(&mut conn, &root, &content_rows)?;
            // Also rebuild derived edges (links/imports/mentions) from the
            // freshly read content — previously reindex_content only updated
            // the full-text index, leaving file_edges stale.
            let edges = build_edges(&app, &root, &content_rows, &index_rows);
            edges::replace_derived_subtree(&mut conn, &root, &edges)?;
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
        let hits = match result {
            Ok(hits) => hits,
            Err(first_err) => {
                eprintln!("[patina:content] search_content first attempt failed: {first_err}, retrying with ensure_table");
                let conn = state.db()?;
                content_index::ensure_table(&conn)?;
                content_index::search(&conn, &root, &query, cap)?
            }
        };
        eprintln!(
            "[patina:content] search_content: query={query} root={root} hits={}",
            hits.len()
        );
        Ok(hits)
    })
    .await
    .map_err(|e| Error::Operation(format!("search_content interrupted: {e}")))?
}
