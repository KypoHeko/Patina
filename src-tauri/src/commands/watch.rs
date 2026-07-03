//! Folder watching (natively: ReadDirectoryChangesW on Windows via notify).

use std::collections::HashSet;
use std::path::Path;

use notify::{Event, RecursiveMode, Watcher, recommended_watcher};
use tauri::{AppHandle, Emitter, Manager};

use crate::error::{Error, Result};
use crate::state::AppState;

/// Watch the given folders (non-recursively). On external changes it emits an
/// `fs:external-change` event with the list of affected directories.
#[tauri::command]
pub async fn set_watch(app: AppHandle, paths: Vec<String>) -> Result<()> {
    // Creating the native watcher involves system calls; move it off the main
    // thread, since set_watch is called on every folder change.
    tauri::async_runtime::spawn_blocking(move || -> Result<()> {
    let state = app.state::<AppState>();
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
    // Keep the watcher in state — otherwise it is dropped and watching stops.
    // Replacing the Option stops the previous observations.
    *state.watcher()? = Some(watcher);
    Ok(())
    })
    .await
    .map_err(|e| Error::Operation(format!("watcher interrupted: {e}")))?
}
