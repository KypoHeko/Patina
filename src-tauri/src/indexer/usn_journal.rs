//! USN Journal: incremental index sync for NTFS volumes.
//!
//! The USN (Update Sequence Number) Journal is a log of file changes that NTFS
//! maintains automatically. Every file creation, deletion, rename or
//! modification gets a sequence number (USN).
//!
//! Instead of a full directory rescan on every launch, you can:
//! 1. Build the full index once (scanner.rs) and remember the USN
//! 2. On the next launch read only the changes from the journal
//! 3. Apply targeted upsert/delete to the SQLite index
//!
//! This turns O(all files) into O(changes), which on large volumes gives an
//! order-of-magnitude speedup (seconds → milliseconds).
#![allow(dead_code)] // Reserved for the USN sync that is disabled in 0.1; sync_from_journal is the public API

use crate::error::Result;
use crate::platform;

/// Result of an incremental sync via the USN Journal.
#[derive(Debug)]
pub struct UsnSyncResult {
    /// Number of updated/created rows in the file index
    pub upserted: usize,
    /// Number of deleted rows from the file index
    pub deleted: usize,
    /// The new USN to save (the journal position at read time)
    pub new_usn: i64,
    /// Whether the sync went through USN (false → fall back to a full rescan)
    pub used_journal: bool,
}

/// Try an incremental index sync via the USN Journal.
///
/// If the volume supports the USN Journal (NTFS), reads changes since
/// `last_usn` and updates `file_index` in SQLite in a targeted way.
///
/// Returns a `UsnSyncResult` with the change counts and the new USN.
/// If the USN Journal is unavailable (not NTFS, no permissions), returns a
/// result with `used_journal: false` — the caller must do a full rescan.
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

    // Targeted update of the file index for the changed paths
    for path in &changes.modified {
        if let Some(row) = crate::indexer::build_row_from_path(path)
            && crate::index::file_index::upsert_one(conn, &row).is_ok() {
                upserted += 1;
            }
    }

    // Delete rows for removed files
    for path in &changes.deleted {
        if crate::index::file_index::delete_path(conn, path).is_ok() {
            deleted += 1;
        }
    }

    Ok(UsnSyncResult {
        upserted,
        deleted,
        new_usn: last_usn + 1, // The position is updated on the next read
        used_journal: true,
    })
}
