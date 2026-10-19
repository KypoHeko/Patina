//! File relationship commands: manual links + graph construction.

use std::collections::HashMap;
use std::time::UNIX_EPOCH;

use rusqlite::Connection;
use serde::Serialize;
use tauri::{AppHandle, Manager};

use crate::error::{Error, Result};
use crate::index::edges::{self, Edge};
use crate::index::files;
use crate::index::file_index;
use crate::index::path_key::{self, normalize};
use crate::indexer::hasher;
use crate::state::AppState;

#[tauri::command]
pub async fn add_relationship(app: AppHandle, a: String, b: String) -> Result<()> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        let conn = state.db()?;
        edges::add_manual(&conn, &a, &b)
    })
    .await
    .map_err(|e| Error::Operation(format!("add_relationship interrupted: {e}")))?
}

#[tauri::command]
pub async fn remove_relationship(app: AppHandle, a: String, b: String) -> Result<()> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        let conn = state.db()?;
        edges::remove_manual(&conn, &a, &b)
    })
    .await
    .map_err(|e| Error::Operation(format!("remove_relationship interrupted: {e}")))?
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GraphNode {
    path: String,
    name: String,
    is_dir: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GraphData {
    nodes: Vec<GraphNode>,
    edges: Vec<Edge>,
}

/// Original-case path, name and kind of a graph node by its canonical key.
fn node_meta(conn: &Connection, key: &str) -> (String, String, bool) {
    if let Ok(Some((path, name, is_dir))) = file_index::display_of(conn, key) {
        return (path, name, is_dir);
    }
    let path = path_key::on_disk_case(key);
    let name = path.rsplit(['\\', '/']).next().unwrap_or(&path).to_string();
    (path, name, false)
}

#[tauri::command]
pub async fn file_graph(app: AppHandle, seeds: Vec<String>, hops: usize) -> Result<GraphData> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        let conn = state.db_read()?;
        let edges = edges::neighborhood(&conn, &seeds, hops)?;

        // Edges come back in CANONICAL keys (path_key::normalize: on Windows —
        // lowercase, '\'), while seed paths arrive from the front end in their
        // ORIGINAL case. Without reducing to one key, the same file ended up in
        // the graph TWICE: as a seed (original case, no edges) and as an edge
        // endpoint (canonical, with links) — that is the "same files with and
        // without links". We reduce by the canonical key but DISPLAY under the
        // seed's original path (so reveal/selection and name case match the
        // file panel).
        let mut display: HashMap<String, String> = HashMap::new();
        for s in &seeds {
            display.entry(normalize(s)).or_insert_with(|| s.clone());
        }
        let mut meta: HashMap<String, (String, bool)> = HashMap::new();
        for key in edges.iter().flat_map(|e| [&e.src, &e.dst]) {
            if !meta.contains_key(key) {
                // Non-seed endpoints: original case from the file index, so the
                // node matches the file panel and reveal opens the real path.
                let (path, name, is_dir) = node_meta(&conn, key);
                display.entry(key.clone()).or_insert(path);
                meta.insert(key.clone(), (name, is_dir));
            }
        }

        let nodes: Vec<GraphNode> = display
            .iter()
            .map(|(canon, disp)| {
                let (name, is_dir) = meta
                    .get(canon)
                    .cloned()
                    .unwrap_or_else(|| {
                        let (_, n, d) = node_meta(&conn, canon);
                        (n, d)
                    });
                GraphNode { path: disp.clone(), name, is_dir }
            })
            .collect();

        // Translate edges from canonical keys to displayed paths, otherwise on
        // the front end they will not "attach" to nodes (nodes are now under seed paths).
        let edges: Vec<Edge> = edges
            .into_iter()
            .map(|e| Edge {
                src: display.get(&e.src).cloned().unwrap_or(e.src),
                dst: display.get(&e.dst).cloned().unwrap_or(e.dst),
                kind: e.kind,
            })
            .collect();

        Ok(GraphData { nodes, edges })
    })
    .await
    .map_err(|e| Error::Operation(format!("file_graph interrupted: {e}")))?
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileHash {
    pub path: String,
    pub hash: String,
    pub cached: bool,
}

#[tauri::command]
pub async fn hash_graph_files(app: AppHandle, paths: Vec<String>) -> Result<Vec<FileHash>> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        let mut cached: Vec<(String, i64, u64, Option<String>)> = Vec::with_capacity(paths.len());
        {
            let conn = state.db_read()?;
            for path in &paths {
                let meta = std::fs::metadata(path);
                let mtime = meta
                    .as_ref()
                    .ok()
                    .and_then(|m| m.modified().ok())
                    .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                    .map(|d| d.as_secs() as i64);
                let size = meta.as_ref().map(|m| m.len()).unwrap_or(0);
                let hash = if let Some(mt) = mtime {
                    files::cached_hash(&conn, path, mt).ok().flatten()
                } else {
                    None
                };
                cached.push((path.clone(), mtime.unwrap_or(0), size, hash));
            }
        }

        let mut fresh: Vec<(String, i64, u64, String)> = Vec::new();
        let mut results: Vec<FileHash> = Vec::with_capacity(cached.len());
        for (path, mtime, size, hash) in &cached {
            if let Some(h) = hash {
                results.push(FileHash { path: path.clone(), hash: h.clone(), cached: true });
            } else {
                match hasher::hash_file(path) {
                    Ok(h) => {
                        fresh.push((path.clone(), *mtime, *size, h.clone()));
                        results.push(FileHash { path: path.clone(), hash: h, cached: false });
                    }
                    Err(_) => {
                        results.push(FileHash { path: path.clone(), hash: String::new(), cached: false });
                    }
                }
            }
        }

        if !fresh.is_empty() {
            let conn = state.db()?;
            for (path, mtime, size, hash) in &fresh {
                let _ = files::store_hash(&conn, path, *size, *mtime, hash);
            }
        }

        Ok(results)
    })
    .await
    .map_err(|e| Error::Operation(format!("hash_graph_files interrupted: {e}")))?
}
