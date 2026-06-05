use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

use crate::error::{Error, Result};
use crate::indexer::dups::{self, DupGroup};
use crate::state::AppState;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct DupProgress {
    done: usize,
    total: usize,
}

// Обход и хеширование — блокирующий I/O, поэтому spawn_blocking (выделенный
// пул, не воркеры async-рантайма). Блокировку БД dups::find держит сам —
// короткими сериями. По ходу хеширования шлём 'dups:progress' для индикатора.
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
    .map_err(|e| Error::Operation(format!("поиск дубликатов прерван: {e}")))?
}
