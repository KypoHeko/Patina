//! File duplicate detection command (progress via the `dups:progress` event).

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
        let emit = |done, total| {
            let _ = app2.emit("dups:progress", DupProgress { done, total });
        };
        dups::find(&state.db, &dir, emit)
    })
    .await
    .map_err(|e| Error::Operation(format!("duplicate search interrupted: {e}")))?
}
