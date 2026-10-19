//! Patina application assembly point.

mod commands;
mod error;
mod fs;
mod index;
mod indexer;
mod models;
mod state;
mod platform;

use tauri::Manager;

use state::AppState;

pub use error::{Error, Result};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            let conn = index::db::open(app.handle())?;
            let data_dir = app
                .path()
                .app_data_dir()
                .map_err(|e| Error::InvalidPath(e.to_string()))?;
            let versions_dir = data_dir.join("versions");
            let thumbs_dir = data_dir.join("thumbs");
            std::fs::create_dir_all(&versions_dir)?;
            std::fs::create_dir_all(&thumbs_dir)?;
            app.manage(AppState::new(conn, versions_dir, thumbs_dir));
            // Background GC of the version store: expired history of deleted
            // files, unreferenced blobs/chunks, stale temp files.
            let handle = app.handle().clone();
            tauri::async_runtime::spawn_blocking(move || {
                let state = handle.state::<AppState>();
                if let Err(e) = commands::versions::collect_garbage(
                    &state.db,
                    &state.versions_dir,
                    commands::versions::DELETED_RETENTION_MS,
                ) {
                    eprintln!("[patina] version GC failed: {e}");
                }
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::fs::list_dir,
            commands::fs::home_dir,
            commands::fs::copy_entries,
            commands::fs::move_entries,
            commands::fs::delete_entries,
            commands::fs::rename_entry,
            commands::fs::create_folder,
            commands::fs::check_conflicts,
            commands::fs::read_preview,
            commands::system::open_path,
            commands::system::reveal_in_explorer,
            commands::system::quick_access,
            commands::system::quick_access_save,
            commands::system::list_drives,
            commands::system::list_storage,
            commands::system::native_icon,
            commands::tags::assign_tag,
            commands::tags::remove_tag,
            commands::tags::tags_for_paths,
            commands::tags::paths_for_tag,
            commands::tags::list_tag,
            commands::tags::tag_counts,
            commands::duplicates::find_duplicates,
            commands::versions::snapshot_version,
            commands::versions::list_versions,
            commands::versions::restore_version,
            commands::versions::delete_version,
            commands::relationships::add_relationship,
            commands::relationships::remove_relationship,
            commands::relationships::file_graph,
            commands::relationships::hash_graph_files,
            commands::watch::set_watch,
            commands::file_index::reindex_tree,
            commands::file_index::search_files,
            commands::content::reindex_content,
            commands::content::search_content,
            commands::indexing::start_index,
            commands::indexing::rebuild_edges,
            commands::dir_size::compute_dir_sizes,
            commands::dir_size::dir_sizes,
        ])
        .run(tauri::generate_context!())
        .expect("failed to start Patina");
}
