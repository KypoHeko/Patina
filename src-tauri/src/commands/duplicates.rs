//! File duplicate detection commands (progress via the `dups:progress` event).

use std::sync::atomic::Ordering;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

use crate::error::{Error, Result};
use crate::indexer::dups::{self, DupGroup};
use crate::state::AppState;

/// Search progress for the `dups:progress` event: how many candidates were hashed.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct DupProgress {
    done: usize,
    total: usize,
}

/// Find duplicates in directory `dir`. The heavy scan+hashing is offloaded to
/// the blocking pool (uniform command policy); progress is sent via `dups:progress`.
#[tauri::command]
pub async fn find_duplicates(app: AppHandle, dir: String) -> Result<Vec<DupGroup>> {
    let app2 = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let state = app2.state::<AppState>();
        // A new scan supersedes the previous one (it stops at its next file).
        let generation = state.dups_gen.fetch_add(1, Ordering::SeqCst) + 1;
        let emit = |done, total| {
            let _ = app2.emit("dups:progress", DupProgress { done, total });
        };
        let cancelled = || state.dups_gen.load(Ordering::SeqCst) != generation;
        dups::find(&state.db, &dir, emit, cancelled)
    })
    .await
    .map_err(|e| Error::Operation(format!("duplicate search interrupted: {e}")))?
}

/// Stop a running duplicate scan (the panel was closed).
#[tauri::command]
pub fn cancel_duplicates(app: AppHandle) {
    app.state::<AppState>().dups_gen.fetch_add(1, Ordering::SeqCst);
}
