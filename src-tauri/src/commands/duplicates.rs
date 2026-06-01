use tauri::State;

use crate::error::Result;
use crate::indexer::dups::{self, DupGroup};
use crate::state::AppState;

// async: обход и хеширование уходят с основного потока. Блокировку БД держит
// сам dups::find — короткими сериями, не на время всего скана.
#[tauri::command]
pub async fn find_duplicates(state: State<'_, AppState>, dir: String) -> Result<Vec<DupGroup>> {
    dups::find(&state.db, &dir)
}
