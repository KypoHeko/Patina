//! Saved USN Journal position per indexed root.
//!
//! After a full scan of a root the journal cursor taken right BEFORE the scan
//! is stored here; the next start reads only the journal records since that
//! cursor instead of rescanning the whole tree (see `commands::indexing`).

use rusqlite::{Connection, OptionalExtension};

use crate::error::Result;
use crate::index::path_key::normalize;
use crate::platform::UsnCursor;

/// The saved cursor for an indexed root.
pub fn get(conn: &Connection, root: &str) -> Result<Option<UsnCursor>> {
    let root = normalize(root);
    let v = conn
        .query_row(
            "SELECT journal_id, last_usn FROM usn_position WHERE volume_root = ?1",
            [&root],
            |r| Ok(UsnCursor { journal_id: r.get::<_, i64>(0)? as u64, next_usn: r.get(1)? }),
        )
        .optional()?;
    Ok(v)
}

/// Save/update the cursor for an indexed root.
pub fn set(conn: &Connection, root: &str, cursor: UsnCursor) -> Result<()> {
    let root = normalize(root);
    conn.execute(
        "INSERT OR REPLACE INTO usn_position (volume_root, last_usn, journal_id) VALUES (?1, ?2, ?3)",
        (&root, cursor.next_usn, cursor.journal_id as i64),
    )?;
    Ok(())
}

/// Forget the cursor (the index of this root is no longer known to be in sync).
pub fn remove(conn: &Connection, root: &str) -> Result<()> {
    let root = normalize(root);
    conn.execute("DELETE FROM usn_position WHERE volume_root = ?1", [&root])?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cur(j: u64, u: i64) -> UsnCursor {
        UsnCursor { journal_id: j, next_usn: u }
    }

    #[test]
    fn roundtrip_update_and_remove() {
        let c = crate::index::db::open_in_memory();
        assert!(get(&c, r"C:\proj").unwrap().is_none());
        set(&c, r"C:\proj", cur(7, 100)).unwrap();
        assert_eq!(get(&c, r"C:\proj").unwrap(), Some(cur(7, 100)));
        set(&c, r"C:\proj", cur(7, 200)).unwrap();
        assert_eq!(get(&c, r"C:\proj").unwrap(), Some(cur(7, 200)));
        remove(&c, r"C:\proj").unwrap();
        assert!(get(&c, r"C:\proj").unwrap().is_none());
    }
}
