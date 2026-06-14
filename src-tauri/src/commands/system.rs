//! Системные команды: запуск файлов, показ в проводнике, места для сайдбара,
//! нативные иконки файлов (SHGetFileInfo на Windows).

use serde::Serialize;
use tauri::{AppHandle, Manager};

use crate::index::quick_access_repo::{self, QuickItem};
use crate::state::AppState;
use crate::error::{Error, Result};

/// Результат запроса нативной иконки: data-URL для использования в <img>.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeIconResult {
    /// data:image/png;base64,... — готовый URL для <img src="...">
    data_url: String,
    width: u32,
    height: u32,
}

/// Запись для сайдбара: подпись, путь, тип (для иконки на фронте).
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Location {
    label: String,
    path: String,
    kind: String,
}

/// Открыть путь в приложении по умолчанию (ярлыки .lnk разворачивает ОС).
#[tauri::command]
pub fn open_path(path: String) -> Result<()> {
    open::that(&path)?;
    Ok(())
}

/// Показать файл в системном проводнике (с выделением на Windows).
#[tauri::command]
pub fn reveal_in_explorer(path: String) -> Result<()> {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        use std::process::Command;
        Command::new("explorer")
            .raw_arg(format!("/select,\"{}\"", path))
            .spawn()?;
        Ok(())
    }
    #[cfg(not(windows))]
    {
        let target = std::path::Path::new(&path)
            .parent()
            .map(std::path::Path::to_path_buf)
            .unwrap_or_else(|| std::path::PathBuf::from(&path));
        open::that(target)?;
        Ok(())
    }
}

/// Быстрый доступ: домашняя, рабочий стол, документы, загрузки
/// (только существующие).
pub fn quick_access_defaults(app: &tauri::AppHandle) -> Vec<Location> {
    let p = app.path();

    let candidates = [
        ("Домашняя", "home", p.home_dir()),
        ("Рабочий стол", "desktop", p.desktop_dir()),
        ("Документы", "documents", p.document_dir()),
        ("Загрузки", "downloads", p.download_dir()),
    ];
    candidates
        .into_iter()
        .filter_map(|(label, kind, res)| {
            let path = res.ok()?;
            if !path.exists() {
                return None;
            }
            Some(Location {
                label: label.into(),
                path: path.to_string_lossy().into_owned(),
                kind: kind.into(),
            })
        })
        .collect()
}

#[tauri::command]
pub async fn quick_access(app: AppHandle) -> Result<Vec<Location>> {
    tauri::async_runtime::spawn_blocking(move || -> Result<Vec<Location>> {
        let state = app.state::<AppState>();
        // Проверяем наличие данных (чтение), при пустоте — сеем (запись).
        let conn = state.db()?;
        if quick_access_repo::is_empty(&conn)? {
            let seed: Vec<QuickItem> = quick_access_defaults(&app)
                .into_iter()
                .map(|l| QuickItem { path: l.path, label: l.label, kind: l.kind })
                .collect();
            quick_access_repo::replace_all(&conn, &seed)?;
        }
        let items = quick_access_repo::list(&conn)?;
        Ok(items
            .into_iter()
            .map(|i| Location { label: i.label, path: i.path, kind: i.kind })
            .collect())
    })
    .await
    .map_err(|e| Error::Operation(format!("quick_access прерван: {e}")))?
}

/// Сохранить пользовательский список (полная замена).
#[tauri::command]
pub async fn quick_access_save(app: AppHandle, items: Vec<QuickItem>) -> Result<()> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        let conn = state.db()?;
        quick_access_repo::replace_all(&conn, &items)
    })
    .await
    .map_err(|e| Error::Operation(format!("quick_access_save прерван: {e}")))?
}

/// Список доступных дисков. Перечисление обходит ФС (проверка существования
/// корней), поэтому уводим его на блокирующий пул — единая политика с остальными
/// командами, трогающими диск.
#[tauri::command]
pub async fn list_drives() -> Vec<Location> {
    tauri::async_runtime::spawn_blocking(list_drives_sync)
        .await
        .unwrap_or_default()
}

fn list_drives_sync() -> Vec<Location> {
    let mut out = Vec::new();
    #[cfg(windows)]
    {
        for letter in b'A'..=b'Z' {
            let c = letter as char;
            let root = format!("{}:\\", c);
            if std::path::Path::new(&root).exists() {
                out.push(Location {
                    label: format!("{}:", c),
                    path: root,
                    kind: "drive".into(),
                });
            }
        }
    }
    #[cfg(not(windows))]
    {
        out.push(Location {
            label: "/".into(),
            path: "/".into(),
            kind: "drive".into(),
        });
    }
    out
}

/// Запись о хранилище для сайдбара.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Storage {
    name: String,
    path: String,
    kind: String,
    total: u64,
    used: u64,
}

/// Список томов: точка монтирования, тип (SSD/HDD), занято/всего.
/// Тип «Cloud» через sysinfo не определяется — будет «Диск».
/// Ограничен таймаутом 5 с — sysinfo может зависать на сетевых томах.
#[tauri::command]
pub async fn list_storage() -> Vec<Storage> {
    // sysinfo обходит все тома — это блокирующая работа, уводим её с главного
    // потока (на старте сайдбар не должен тормозить отрисовку окна).
    tauri::async_runtime::spawn_blocking(list_storage_sync)
        .await
        .unwrap_or_default()
}

/// На Windows — нативное перечисление томов через WinAPI: реальные метки тома
/// и тип носителя (SSD/HDD). sysinfo на Windows часто отдаёт пустые метки.
#[cfg(windows)]
fn list_storage_sync() -> Vec<Storage> {
    crate::platform::list_drives_native()
        .into_iter()
        .map(|d| Storage {
            name: if d.label.is_empty() {
                d.path.trim_end_matches('\\').to_string()
            } else {
                d.label
            },
            path: d.path,
            kind: d.kind,
            total: d.total,
            used: d.total.saturating_sub(d.available),
        })
        .collect()
}

/// На Linux/macOS — через кроссплатформенный sysinfo.
#[cfg(not(windows))]
fn list_storage_sync() -> Vec<Storage> {
    use std::collections::HashSet;
    use sysinfo::{DiskKind, Disks};

    let disks = Disks::new_with_refreshed_list();
    let mut seen: HashSet<String> = HashSet::new();
    let mut out = Vec::new();
    for d in disks.list() {
        let mp = d.mount_point().to_string_lossy().into_owned();
        if !seen.insert(mp.clone()) {
            continue;
        }
        let total = d.total_space();
        let avail = d.available_space();
        let kind = match d.kind() {
            DiskKind::SSD => "SSD",
            DiskKind::HDD => "HDD",
            _ => "Диск",
        }
        .to_string();
        let trimmed = mp.trim_end_matches(|c| c == '\\' || c == '/');
        let name = if trimmed.is_empty() { mp.clone() } else { trimmed.to_string() };
        out.push(Storage {
            name,
            path: mp,
            kind,
            total,
            used: total.saturating_sub(avail),
        });
    }
    out
}

/// Получить нативную иконку файла/папки через WinAPI (SHGetFileInfo).
///
/// На Windows извлекает реальную системную иконку (как в проводнике),
/// конвертирует в PNG и возвращает как data-URL. На других платформах
/// возвращает None — фронтенд использует SVG-фолбэк.
///
/// Иконки кэшируются на диске (ключ — путь+mtime+размер), повторные
/// запросы мгновенны. Тяжёлая работа уходит в блокирующий пул.
#[tauri::command]
pub async fn native_icon(app: AppHandle, path: String, size: u32) -> Result<Option<NativeIconResult>> {
    tauri::async_runtime::spawn_blocking(move || -> Result<Option<NativeIconResult>> {
        // Дисковый кэш: ключ = blake3(путь + mtime + размер)
        let state = app.state::<AppState>();
        let meta = std::fs::metadata(&path);
        let mtime = meta.as_ref().ok().and_then(|m| {
            m.modified().ok().and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_millis())
        }).unwrap_or(0);
        let fsize = meta.as_ref().map(|m| m.len()).unwrap_or(0);
        let cache_key = blake3::hash(format!("{path}|{mtime}|{fsize}|icon{size}").as_bytes())
            .to_hex().to_string();
        let cache_path = state.thumbs_dir.join(format!("icon_{cache_key}.bin"));

        // Проверяем кэш
        if let Ok(cached) = std::fs::read(&cache_path) {
            if let Ok(data_url) = String::from_utf8(cached) {
                return Ok(Some(NativeIconResult {
                    data_url,
                    width: size,
                    height: size,
                }));
            }
        }

        // Получаем нативную иконку
        let icon = crate::platform::get_native_icon(&path, size);
        match icon {
            Some(ni) => {
                let data_url = format!(
                    "data:image/png;base64,{}",
                    crate::commands::fs::b64(&ni.png)
                );
                // Сохраняем в кэш
                let _ = std::fs::write(&cache_path, data_url.as_bytes());
                Ok(Some(NativeIconResult {
                    data_url,
                    width: ni.width,
                    height: ni.height,
                }))
            }
            None => Ok(None),
        }
    })
    .await
    .map_err(|e| Error::Operation(format!("native_icon прерван: {e}")))?
}
