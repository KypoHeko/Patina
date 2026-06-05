//! Команды файловой системы.

use std::fs::File;
use std::io::{Cursor, Read};
use std::path::Path;
use std::time::UNIX_EPOCH;

use serde::Serialize;
use tauri::{AppHandle, Manager, State};

use crate::error::{Error, Result};

use crate::fs::{lister, operations};
use crate::index::{edges_repo, tags_repo, versions_repo};
use crate::models::file::FileEntry;
use crate::state::AppState;

#[tauri::command]
pub async fn list_dir(path: String) -> Result<Vec<FileEntry>> {
    // Листинг каталога — блокирующий I/O. Уводим в spawn_blocking, чтобы не
    // занимать главный поток вебвью (иначе панели «подвисают» при навигации).
    tauri::async_runtime::spawn_blocking(move || lister::list_dir(&path))
        .await
        .map_err(|e| Error::Operation(format!("листинг прерван: {e}")))?
}

#[tauri::command]
pub fn home_dir(app: AppHandle) -> Result<String> {
    let path = app
        .path()
        .home_dir()
        .map_err(|e| Error::InvalidPath(e.to_string()))?;
    Ok(path.to_string_lossy().into_owned())
}

#[tauri::command]
pub fn copy_entries(sources: Vec<String>, dest_dir: String, overwrite: bool) -> Result<()> {
    operations::copy_entries(&sources, &dest_dir, overwrite)
}

#[tauri::command]
pub fn move_entries(
    state: State<AppState>,
    sources: Vec<String>,
    dest_dir: String,
    overwrite: bool,
) -> Result<()> {
    operations::move_entries(&sources, &dest_dir, overwrite)?;
    let conn = state.db()?;
    for src in &sources {
        if let Some(name) = Path::new(src).file_name() {
            let new_path = Path::new(&dest_dir).join(name);
            let new_path = new_path.to_string_lossy();
            // Сопровождаем все привязки по пути, чтобы они не "повисли" на старом
            // месте: теги, история версий и связи переезжают вместе с файлом/папкой.
            let _ = tags_repo::relink(&conn, src, &new_path);
            let _ = versions_repo::relink(&conn, src, &new_path);
            let _ = edges_repo::relink(&conn, src, &new_path);
        }
    }
    Ok(())
}

#[tauri::command]
pub fn delete_entries(state: State<AppState>, paths: Vec<String>) -> Result<()> {
    operations::delete_entries(&paths)?;
    let conn = state.db()?;
    for p in &paths {
        // Чистим все привязки удалённого пути (и вложенных), иначе строки копятся
        // в БД навсегда, ссылаясь на несуществующие файлы.
        let _ = tags_repo::purge(&conn, p);
        let _ = versions_repo::purge(&conn, p);
        let _ = edges_repo::purge(&conn, p);
    }
    Ok(())
}

#[tauri::command]
pub fn rename_entry(state: State<AppState>, path: String, new_name: String) -> Result<String> {
    let new_path = operations::rename_entry(&path, &new_name)?;
    let conn = state.db()?;
    let _ = tags_repo::relink(&conn, &path, &new_path);
    let _ = versions_repo::relink(&conn, &path, &new_path);
    let _ = edges_repo::relink(&conn, &path, &new_path);
    Ok(new_path)
}

/// Имена записей, уже существующие в каталоге назначения.
#[tauri::command]
pub fn check_conflicts(sources: Vec<String>, dest_dir: String) -> Result<Vec<String>> {
    let mut out = Vec::new();
    for src in &sources {
        if let Some(name) = Path::new(src).file_name() {
            if Path::new(&dest_dir).join(name).exists() {
                out.push(name.to_string_lossy().into_owned());
            }
        }
    }
    Ok(out)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Preview {
    kind: String, // "text" | "image" | "none"
    name: String,
    text: Option<String>,
    data_url: Option<String>,
}

fn b64(data: &[u8]) -> String {
    const T: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(data.len().div_ceil(3) * 4);
    for chunk in data.chunks(3) {
        let b0 = chunk[0] as u32;
        let b1 = *chunk.get(1).unwrap_or(&0) as u32;
        let b2 = *chunk.get(2).unwrap_or(&0) as u32;
        let n = (b0 << 16) | (b1 << 8) | b2;
        out.push(T[((n >> 18) & 63) as usize] as char);
        out.push(T[((n >> 12) & 63) as usize] as char);
        out.push(if chunk.len() > 1 { T[((n >> 6) & 63) as usize] as char } else { '=' });
        out.push(if chunk.len() > 2 { T[(n & 63) as usize] as char } else { '=' });
    }
    out
}

const RASTER: &[&str] = &["png", "jpg", "jpeg", "gif", "webp", "bmp", "ico", "tiff", "tif"];
const TXT: &[&str] = &[
    "txt", "md", "markdown", "json", "js", "mjs", "ts", "jsx", "tsx", "rs", "toml", "yaml", "yml",
    "ini", "cfg", "conf", "log", "csv", "tsv", "html", "htm", "css", "xml", "sh", "bat", "py", "go",
    "java", "c", "h", "cpp", "sql",
];

fn none_preview(name: String) -> Preview {
    Preview { kind: "none".into(), name, text: None, data_url: None }
}

fn image_jpeg(name: String, bytes: &[u8]) -> Preview {
    Preview {
        kind: "image".into(),
        name,
        text: None,
        data_url: Some(format!("data:image/jpeg;base64,{}", b64(bytes))),
    }
}

/// Синхронная реализация превью. Вызывается из `read_preview` внутри
/// `spawn_blocking`, чтобы тяжёлое декодирование изображений не занимало
/// воркер async-рантайма.
fn build_preview(thumbs_dir: &Path, path: &str) -> Result<Preview> {
    let p = Path::new(path);
    let name = p
        .file_name()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_default();
    let ext = p
        .extension()
        .map(|e| e.to_string_lossy().to_ascii_lowercase())
        .unwrap_or_default();
    let meta = std::fs::metadata(path)?;
    if meta.is_dir() {
        return Ok(none_preview(name));
    }

    // SVG — вектор, инлайним как есть (без растеризации).
    if ext == "svg" {
        let bytes = std::fs::read(path)?;
        return Ok(Preview {
            kind: "image".into(),
            name,
            text: None,
            data_url: Some(format!("data:image/svg+xml;base64,{}", b64(&bytes))),
        });
    }

    // Растровые — миниатюра с дисковым кэшом.
    if RASTER.contains(&ext.as_str()) {
        let mtime = meta
            .modified()
            .ok()
            .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
            .map(|d| d.as_millis())
            .unwrap_or(0);
        let key = blake3::hash(format!("{path}|{mtime}|{}", meta.len()).as_bytes())
            .to_hex()
            .to_string();
        let cache = thumbs_dir.join(format!("{key}.jpg"));

        if let Ok(bytes) = std::fs::read(&cache) {
            return Ok(image_jpeg(name, &bytes));
        }
        if let Ok(img) = image::open(path) {
            let thumb = img.thumbnail(1024, 1024);
            let rgb = image::DynamicImage::ImageRgb8(thumb.to_rgb8());
            let mut bytes = Vec::new();
            if rgb
                .write_to(&mut Cursor::new(&mut bytes), image::ImageFormat::Jpeg)
                .is_ok()
            {
                let _ = std::fs::write(&cache, &bytes);
                return Ok(image_jpeg(name, &bytes));
            }
        }
        return Ok(none_preview(name));
    }

    if TXT.contains(&ext.as_str()) {
        let mut f = File::open(path)?;
        let mut buf = vec![0u8; 16 * 1024];
        let n = f.read(&mut buf)?;
        buf.truncate(n);
        return Ok(Preview {
            kind: "text".into(),
            name,
            text: Some(String::from_utf8_lossy(&buf).into_owned()),
            data_url: None,
        });
    }
    Ok(none_preview(name))
}

/// Превью: текстовая «голова», SVG как есть, либо миниатюра растрового
/// изображения. Растровые декодируются и ужимаются до 1024px на стороне Rust,
/// результат кэшируется на диск (ключ — путь+mtime+размер), повторные открытия
/// мгновенны и работают для изображений любого размера. Тяжёлая работа уходит
/// в блокирующий пул, не занимая воркеры async-рантайма.
#[tauri::command]
pub async fn read_preview(app: AppHandle, path: String) -> Result<Preview> {
    tauri::async_runtime::spawn_blocking(move || -> Result<Preview> {
        let state = app.state::<AppState>();
        build_preview(&state.thumbs_dir, &path)
    })
    .await
    .map_err(|e| Error::Operation(format!("превью прервано: {e}")))?
}

/// Создать новую папку в `parent`. При занятом имени добавляет " (N)".
/// Возвращает путь созданной папки.
#[tauri::command]
pub fn create_folder(parent: String, name: String) -> Result<String> {
    let base = Path::new(&parent);
    if !base.is_dir() {
        return Err(Error::NotADirectory(parent));
    }
    let mut candidate = base.join(&name);
    let mut n = 2;
    while candidate.exists() {
        candidate = base.join(format!("{name} ({n})"));
        n += 1;
    }
    std::fs::create_dir(&candidate)?;
    Ok(candidate.to_string_lossy().into_owned())
}
