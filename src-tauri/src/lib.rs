//! Точка сборки приложения Patina.
//! Здесь объявляются модули и регистрируются IPC-команды.

mod commands;
mod error;
mod fs;
mod models;

pub use error::{Error, Result};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            commands::fs::list_dir,
            commands::fs::home_dir,
        ])
        .run(tauri::generate_context!())
        .expect("ошибка запуска Patina");
}
