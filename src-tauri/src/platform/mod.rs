//! Платформенный слой: ОС-специфичный код, изолированный за feature-флагами.
//!
//! На Windows предоставляет нативные API:
//! - IFileOperation для удаления в Корзину (вместо crate `trash`)
//! - SHGetFileInfo для извлечения иконок файлов (вместо SVG-маппинга)
//! - GetVolumeInformation / GetDriveType для меток и типов томов
//! - USN Journal для инкрементальной синхронизации индекса (NTFS)
//!
//! На других платформах — fallback через кроссплатформенные крейты.
//!
//! Все публичные функции доступны напрямую через `crate::platform::*`
//! (реэкспорт из windows-субмодуля на Windows, или fallback-реализации
//! на других платформах).

#[cfg(windows)]
pub mod windows;

// ─── Реэкспорт Windows-функций на уровень platform::* ─────────────
// На Windows функции реализованы в windows.rs, но вызывающий код
// использует platform::read_usn_journal, platform::list_drives_native и т.д.
// Реэкспорт делает их доступными без квалификации windows::.

#[cfg(windows)]
pub use windows::{delete_to_recycle_bin, list_drives_native};

// Реэкспорт нативных иконок и USN Journal для использования в командах.
#[cfg(windows)]
pub use windows::{get_native_icon, read_usn_journal};

/// Информация о диске/томе с нативными данными ОС.
#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DriveInfo {
    /// Буква диска или точка монтирования (напр. "C:\\" или "/mnt/data")
    pub path: String,
    /// Метка тома (напр. "System", "Данные") — может быть пустой
    pub label: String,
    /// Тип носителя: "SSD", "HDD", "Removable", "Network", "Cloud", "Unknown"
    pub kind: String,
    /// Полный объём в байтах
    pub total: u64,
    /// Доступно (свободно) в байтах
    pub available: u64,
}

/// Результат извлечения иконки через SHGetFileInfo.
#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
#[allow(dead_code)]
pub struct NativeIcon {
    /// PNG-байты иконки (16x16 или 32x32)
    pub png: Vec<u8>,
    /// Ширина в пикселях
    pub width: u32,
    /// Высота в пикселях
    pub height: u32,
}

/// Инкрементальные изменения, полученные из USN Journal.
#[derive(Debug)]
pub struct UsnChanges {
    /// Пути файлов, которые были созданы или изменены
    pub modified: Vec<String>,
    /// Пути файлов, которые были удалены
    pub deleted: Vec<String>,
}

// ─── Fallback-реализации для не-Windows ────────────────────────────

#[cfg(not(windows))]
#[allow(dead_code)]
pub fn list_drives_native() -> Vec<DriveInfo> {
    // На Linux/macOS возвращаем корень как единственный «диск».
    // Детальное определение томов — через sysinfo (вызывающая сторона).
    vec![DriveInfo {
        path: "/".into(),
        label: String::new(),
        kind: "Unknown".into(),
        total: 0,
        available: 0,
    }]
}

#[cfg(not(windows))]
pub fn delete_to_recycle_bin(_paths: &[String]) -> crate::error::Result<()> {
    // Fallback — crate trash на не-Windows
    trash::delete_all(_paths).map_err(|e| crate::error::Error::Operation(e.to_string()))
}

#[cfg(not(windows))]
pub fn get_native_icon(_path: &str, _size: u32) -> Option<NativeIcon> {
    None
}

#[cfg(not(windows))]
pub fn read_usn_journal(_root: &str, _last_usn: i64) -> crate::error::Result<Option<UsnChanges>> {
    // USN Journal доступна только на NTFS/Windows
    Ok(None)
}
