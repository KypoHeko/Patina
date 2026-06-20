//! Folder size commands (Phase 1).
//!
//! `compute_dir_sizes` is the authoritative on-demand subtree walk: it computes
//! the recursive size of EVERY directory and stores it in `dir_agg`. The walk is
//! post-order (`contents_first`): by the time we leave a directory, the sums of
//! all its descendants are already accumulated, so everything is computed in a
//! single pass with a stack of accumulators (memory O(depth), not O(file count)).
//! We take only metadata — no content reads — so this is an order of magnitude
//! cheaper than content indexing. Keeping it fresh (watcher/deltas) is a
//! separate phase.
//!
//! `dir_sizes` reads the ready values for specific paths for display in the panel.

use std::collections::HashMap;
use std::path::PathBuf;
use std::time::UNIX_EPOCH;

use tauri::{AppHandle, Emitter, Manager};
use walkdir::WalkDir;

use crate::error::{Error, Result};
use crate::index::dir_agg::{self, DirAgg};
use crate::index::path_key;
use crate::state::AppState;

/// After how many written directories we commit a batch and emit progress.
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

        // Fresh recompute: drop the previous subtree aggregates so no rows remain
        // for directories that no longer exist.
        {
            let conn = state.db()?;
            dir_agg::clear_subtree(&conn, &path_key::normalize(&root))?;
        }

        // path -> (accumulated size, file count, maximum mtime).
        let mut acc: HashMap<PathBuf, (i64, i64, Option<i64>)> = HashMap::new();
        let mut batch: Vec<DirAgg> = Vec::with_capacity(COMMIT_BATCH);
        let mut done_dirs = 0usize;

        // follow_links(false) + skipping symlinks: we do not follow links,
        // otherwise cycles and double counting. (Windows junctions are a known
        // Phase 1 limitation.) contents_first(true) — a directory is yielded
        // AFTER its contents.
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
                // All descendants are already processed (contents_first) — take the accumulated value.
                let (size, count, mmax) = acc.remove(path).unwrap_or((0, 0, None));
                let mmax = max_opt(mmax, mtime);
                batch.push(DirAgg {
                    path: path_key::normalize(&path.to_string_lossy()),
                    total_size: size,
                    file_count: count,
                    mtime_max: mmax,
                });
                done_dirs += 1;

                // The directory's contribution to its parent.
                if let Some(parent) = path.parent() {
                    let e = acc.entry(parent.to_path_buf()).or_insert((0, 0, None));
                    e.0 += size;
                    e.1 += count;
                    e.2 = max_opt(e.2, mmax);
                }

                if batch.len() >= COMMIT_BATCH {
                    {
                        let conn = state.db()?;
                        dir_agg::upsert_many(&conn, &batch)?;
                    }
                    batch.clear();
                    let _ = app.emit(
                        "dirsize:progress",
                        serde_json::json!({ "root": root, "count": done_dirs }),
                    );
                }
            } else {
                // File: its size goes into the parent's accumulator.
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
            dir_agg::upsert_many(&conn, &batch)?;
        }

        let _ = app.emit(
            "dirsize:done",
            serde_json::json!({ "root": root, "count": done_dirs }),
        );
        Ok(done_dirs)
    })
    .await
    .map_err(|e| Error::Operation(format!("compute_dir_sizes interrupted: {e}")))?
}

#[tauri::command]
pub async fn dir_sizes(app: AppHandle, paths: Vec<String>) -> Result<HashMap<String, i64>> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        let conn = state.db_read()?;
        dir_agg::sizes_for(&conn, &paths)
    })
    .await
    .map_err(|e| Error::Operation(format!("dir_sizes interrupted: {e}")))?
}
