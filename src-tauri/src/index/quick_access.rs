//! Store for the user's "Quick Access" (contents + order).

use rusqlite::Connection;
use serde::{Deserialize, Serialize};

use crate::error::Result;

#[derive(Serialize, Deserialize, Clone)]
pub struct QuickItem {
    pub path: String,
    pub label: String,
    pub kind: String,
}

/// The list in user-defined order.
pub fn list(conn: &Connection) -> Result<Vec<QuickItem>> {
    let mut stmt = conn.prepare("SELECT path, label, kind FROM quick_access ORDER BY position")?;
    let rows = stmt.query_map([], |r| {
        Ok(QuickItem {
            path: r.get(0)?,
            label: r.get(1)?,
            kind: r.get(2)?,
        })
    })?;
    let mut out = Vec::new();
    for row in rows {
        out.push(row?);
    }
    Ok(out)
}

/// Full replacement of the list (position = index in the slice). In a transaction.
pub fn replace_all(conn: &Connection, items: &[QuickItem]) -> Result<()> {
    let tx = conn.unchecked_transaction()?;
    tx.execute("DELETE FROM quick_access", [])?;
    {
        let mut stmt = tx.prepare(
            "INSERT INTO quick_access (position, path, label, kind) VALUES (?1, ?2, ?3, ?4)",
        )?;
        for (i, it) in items.iter().enumerate() {
            stmt.execute((i as i64, &it.path, &it.label, &it.kind))?;
        }
    }
    tx.commit()?;
    Ok(())
}

/// Whether it is empty (for seeding with system folders on first launch).
pub fn is_empty(conn: &Connection) -> Result<bool> {
    let n: i64 = conn.query_row("SELECT COUNT(*) FROM quick_access", [], |r| r.get(0))?;
    Ok(n == 0)
}
