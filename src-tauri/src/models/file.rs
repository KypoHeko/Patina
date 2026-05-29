use serde::Serialize;

/// Тип записи в директории.
#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum EntryKind {
    File,
    Folder,
}

/// Одна запись в списке файлов. Поля сериализуются в camelCase для фронта.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileEntry {
    pub name: String,
    pub path: String,
    pub kind: EntryKind,
    /// Размер в байтах (для папок — 0).
    pub size: u64,
    /// Время изменения, миллисекунды от epoch (None, если недоступно).
    pub modified: Option<u64>,
    /// Расширение без точки (только для файлов).
    pub extension: Option<String>,
}
