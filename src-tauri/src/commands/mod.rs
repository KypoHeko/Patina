//! Thin IPC command layer.
//!
//! Threading policy (uniform for all commands):
//! any command that may block the thread — touching the disk (reading/writing
//! data) or the DB (locking the connection) — is declared `async` and does its
//! work via `tauri::async_runtime::spawn_blocking`, fetching state INSIDE the
//! closure through `app.state::<AppState>()`.
//! The `State<'_, AppState>` parameter is unsuitable for this: it is not
//! `'static` and cannot be moved into a `spawn_blocking` closure.
//!
//! The exception is cheap commands without data I/O: path resolution
//! (`home_dir`) and launching external processes (`open_path`,
//! `reveal_in_explorer`) stay synchronous. A special case is
//! `indexing::start_index`: an orchestrator that, on the async thread, performs
//! only quick state operations and watcher setup, offloading the heavy index
//! build to `spawn_blocking`.

pub mod content;
pub mod dir_size;
pub mod duplicates;
pub mod file_index;
pub mod fs;
pub mod indexing;
pub mod relationships;
pub mod system;
pub mod tags;
pub mod versions;
pub mod watch;
