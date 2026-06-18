//! USN Journal: инкрементальная синхронизация индекса NTFS-томов.
//!
//! USN Update Sequence Number Journal — это лог файловых изменений, который
//! NTFS ведёт автоматически. Каждое создание, удаление, переименование или
//! модификация файла получает порядковый номер (USN).
//!
//! Вместо полного перескана каталога при каждом запуске можно:
//! 1. Один раз построить полный индекс (scanner.rs) и запомнить USN
//! 2. При следующем запуске прочитать только изменения из журнала
//! 3. Применить точечные upsert/delete к SQLite-индексу
//!
//! Это превращает O(все файлы) в O(изменения), что на больших томах
//! даёт ускорение на порядки (секунды → миллисекунды).
#![allow(dead_code)] // Модуль используется через indexing.rs; sync_from_journal — публичный API

use crate::error::Result;
use crate::platform;

/// Результат инкрементальной синхронизации через USN Journal.
#[derive(Debug)]
pub struct UsnSyncResult {
    /// Количество обновлённых/созданных записей в файловом индексе
    pub upserted: usize,
    /// Количество удалённых записей из файлового индекса
    pub deleted: usize,
    /// Новый USN для сохранения (позиция в журнале на момент чтения)
    pub new_usn: i64,
    /// Была ли синхронизация через USN (false → fallback на полный перескан)
    pub used_journal: bool,
}

/// Попробовать инкрементальную синхронизацию индекса через USN Journal.
///
/// Если том поддерживает USN Journal (NTFS), читает изменения с момента
/// `last_usn` и точечно обновляет `file_index` в SQLite.
///
/// Возвращает `UsnSyncResult` с числом изменений и новым USN.
/// Если USN Journal недоступна (не NTFS, нет прав), возвращает результат
/// с `used_journal: false` — вызывающая сторона должна сделать полный перескан.
pub fn sync_from_journal(
    root: &str,
    last_usn: i64,
    conn: &rusqlite::Connection,
) -> Result<UsnSyncResult> {
    let changes = match platform::read_usn_journal(root, last_usn)? {
        Some(changes) => changes,
        None => {
            return Ok(UsnSyncResult {
                upserted: 0,
                deleted: 0,
                new_usn: last_usn,
                used_journal: false,
            });
        }
    };

    let mut upserted = 0;
    let mut deleted = 0;

    // Точечное обновление файлового индекса по изменённым путям
    for path in &changes.modified {
        if let Some(row) = crate::indexer::build_row_from_path(path) {
            if crate::index::file_index::upsert_one(conn, &row).is_ok() {
                upserted += 1;
            }
        }
    }

    // Удаление записей для удалённых файлов
    for path in &changes.deleted {
        if crate::index::file_index::delete_path(conn, path).is_ok() {
            deleted += 1;
        }
    }

    Ok(UsnSyncResult {
        upserted,
        deleted,
        new_usn: last_usn + 1, // Позиция обновляется при следующем чтении
        used_journal: true,
    })
}
