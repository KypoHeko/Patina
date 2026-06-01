//! Слежение за папками (нативно: ReadDirectoryChangesW на Windows через notify).

use std::collections::HashSet;
use std::path::Path;

use notify::{Event, RecursiveMode, Watcher, recommended_watcher};
use tauri::{AppHandle, Emitter, State};

use crate::error::{Error, Result};
use crate::state::AppState;

/// Следить за указанными папками (нерекурсивно). При изменениях извне
/// эмитит событие `fs:external-change` со списком затронутых каталогов.
#[tauri::command]
pub fn set_watch(app: AppHandle, state: State<AppState>, paths: Vec<String>) -> Result<()> {
    let app2 = app.clone();
    let mut watcher = recommended_watcher(move |res: notify::Result<Event>| {
        if let Ok(ev) = res {
            let mut dirs: HashSet<String> = HashSet::new();
            for p in ev.paths {
                if let Some(parent) = p.parent() {
                    dirs.insert(parent.to_string_lossy().into_owned());
                }
            }
            if !dirs.is_empty() {
                let _ = app2.emit("fs:external-change", dirs.into_iter().collect::<Vec<_>>());
            }
        }
    })
    .map_err(|e| Error::Operation(e.to_string()))?;

    for path in &paths {
        let _ = watcher.watch(Path::new(path), RecursiveMode::NonRecursive);
    }
    // Сохраняем вотчер в состоянии — иначе он будет сброшен и слежение остановится.
    // Замена Option останавливает прежние наблюдения.
    *state.watcher()? = Some(watcher);
    Ok(())
}
