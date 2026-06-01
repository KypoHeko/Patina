//! Таблица versions.

use rusqlite::{Connection, OptionalExtension};
use serde::Serialize;

use crate::error::Result;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Version {
    pub id: i64,
    pub path: String,
    pub ts: i64,
    pub size: i64,
    pub hash: String,
}

pub fn latest_hash(conn: &Connection, path: &str) -> Result<Option<String>> {
    let h = conn
        .query_row(
            "SELECT hash FROM versions WHERE path = ?1 ORDER BY ts DESC, id DESC LIMIT 1",
            [path],
            |r| r.get::<_, String>(0),
        )
        .optional()?;
    Ok(h)
}

pub fn insert(conn: &Connection, path: &str, ts: i64, size: i64, hash: &str) -> Result<i64> {
    conn.execute(
        "INSERT INTO versions (path, ts, size, hash) VALUES (?1, ?2, ?3, ?4)",
        (path, ts, size, hash),
    )?;
    Ok(conn.last_insert_rowid())
}

pub fn list_for(conn: &Connection, path: &str) -> Result<Vec<Version>> {
    let mut stmt = conn
        .prepare("SELECT id, path, ts, size, hash FROM versions WHERE path = ?1 ORDER BY ts DESC, id DESC")?;
    let rows = stmt
        .query_map([path], |r| {
            Ok(Version {
                id: r.get(0)?,
                path: r.get(1)?,
                ts: r.get(2)?,
                size: r.get(3)?,
                hash: r.get(4)?,
            })
        })?
        .collect::<rusqlite::Result<_>>()?;
    Ok(rows)
}

pub fn get(conn: &Connection, id: i64) -> Result<Option<Version>> {
    let v = conn
        .query_row(
            "SELECT id, path, ts, size, hash FROM versions WHERE id = ?1",
            [id],
            |r| {
                Ok(Version {
                    id: r.get(0)?,
                    path: r.get(1)?,
                    ts: r.get(2)?,
                    size: r.get(3)?,
                    hash: r.get(4)?,
                })
            },
        )
        .optional()?;
    Ok(v)
}
