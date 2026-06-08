//! Хранение позиции USN Journal по каждому NTFS-тому.
#![allow(dead_code)] // TODO: подключить USN-поллер (get/set/remove) — пока не вызывается

use rusqlite::Connection;

use crate::error::Result;
use crate::index::path_key::normalize;

/// Прочитать сохранённую USN-позицию для тома.
pub fn get(conn: &Connection, volume_root: &str) -> Result<Option<i64>> {
    let root = normalize(volume_root);
    let mut stmt = conn.prepare("SELECT last_usn FROM usn_position WHERE volume_root = ?1")?;
    let result = stmt.query_row([&root], |r| r.get::<_, i64>(0));
    match result {
        Ok(usn) => Ok(Some(usn)),
        Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
        Err(e) => Err(e.into()),
    }
}

/// Сохранить/обновить USN-позицию для тома.
pub fn set(conn: &Connection, volume_root: &str, last_usn: i64) -> Result<()> {
    let root = normalize(volume_root);
    conn.execute(
        "INSERT OR REPLACE INTO usn_position (volume_root, last_usn) VALUES (?1, ?2)",
        (&root, last_usn),
    )?;
    Ok(())
}

/// Удалить позицию для тома.
pub fn remove(conn: &Connection, volume_root: &str) -> Result<()> {
    let root = normalize(volume_root);
    conn.execute("DELETE FROM usn_position WHERE volume_root = ?1", [&root])?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn mem() -> Connection {
        let c = Connection::open_in_memory().unwrap();
        c.execute_batch(
            "CREATE TABLE usn_position (volume_root TEXT PRIMARY KEY, last_usn INTEGER NOT NULL);",
        ).unwrap();
        c
    }

    #[test]
    fn get_returns_none_when_missing() {
        let c = mem();
        assert!(get(&c, r"C:\").unwrap().is_none());
    }

    #[test]
    fn set_and_get_roundtrip() {
        let c = mem();
        set(&c, r"C:\", 12345).unwrap();
        assert_eq!(get(&c, r"C:\").unwrap(), Some(12345));
    }

    #[test]
    fn set_updates_existing() {
        let c = mem();
        set(&c, r"D:\", 100).unwrap();
        set(&c, r"D:\", 200).unwrap();
        assert_eq!(get(&c, r"D:\").unwrap(), Some(200));
    }

    #[test]
    fn remove_clears_position() {
        let c = mem();
        set(&c, r"E:\", 500).unwrap();
        remove(&c, r"E:\").unwrap();
        assert!(get(&c, r"E:\").unwrap().is_none());
    }
}
