//! Тонкий слой IPC-команд.
//!
//! Политика потоков (единая для всех команд):
//! любая команда, которая может заблокировать поток — лезет на диск
//! (чтение/запись данных) или в БД (lock соединения) — объявляется `async`
//! и выполняет работу через `tauri::async_runtime::spawn_blocking`, доставая
//! состояние ВНУТРИ замыкания через `app.state::<AppState>()`.
//! Параметр `State<'_, AppState>` для этого не годится: он не `'static`
//! и не может быть занесён в `spawn_blocking`-замыкание.
//!
//! Исключение — дешёвые команды без data-I/O: разрешение путей (`home_dir`)
//! и запуск внешних процессов (`open_path`, `reveal_in_explorer`) остаются
//! синхронными. Особый случай — `indexing::start_index`: оркестратор, который
//! на async-потоке делает только быстрые операции со state и установку
//! вотчера, а тяжёлую сборку индекса уже уводит в `spawn_blocking`.

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
