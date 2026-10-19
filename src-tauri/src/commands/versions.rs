//! Version history commands.
//!
//! Hybrid storage strategy:
//! - < 15 MB: zstd compression with a trainable dictionary
//! - >= 15 MB: chunk splitting (content-defined chunking)
//! - 'full': old format (backward compatibility)
//!
//! Content-addressed storage consistency (bug C4)
//! --------------------------------------------------------------------
//! Blobs (`versions/<hash>.zst`) and chunks (`chunks/<hash>`) are addressed by
//! content and shared between versions, so they can only be deleted when no
//! references to the hash remain (refcount == 0). To keep garbage collection
//! from wiping out live data, one invariant holds:
//!
//!   *The referencing row in the DB always appears BEFORE the content lands on
//!    disk, and the garbage collector checks refcount and deletes the file under
//!    the same `state.db()` acquisition.*
//!
//! Then by the time a blob/chunk materializes on disk, the refcount for its hash
//! is already non-zero, and GC (`delete_version`), running under the same lock,
//! cannot consider it orphaned. The heavy content write meanwhile happens
//! OUTSIDE the lock — holding the DB locked for multi-megabyte IO is not allowed.

use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

use tauri::{AppHandle, Manager};

use crate::error::{Error, Result};
use crate::index::versions::{self, Version};
use crate::index::chunker;
use crate::index::version_compress;
use crate::indexer::hasher;
use crate::state::AppState;

/// Threshold: files >= this size are chunked.
const CHUNK_THRESHOLD: u64 = 15 * 1024 * 1024; // 15 MB

/// Current time in milliseconds since the UNIX epoch.
///
/// Returns ms (not seconds) — this is the single standard for all timestamps in
/// the project: `fs::lister`, `commands::fs::file_times`, `system::native_icon`,
/// `indexer::build_row` all return mtime in ms. The front end, via
/// `formatDate()`, treats numbers as ms (`new Date(ms)`); if versions returned
/// seconds, `new Date(seconds)` would read them as ms → a date around 1970.
/// `ORDER BY ts DESC` sorting is the same for both units, so old rows (if any)
/// keep sorting correctly — only their displayed date is slightly off, which is
/// acceptable for 0.1.
fn now_millis() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// Take a snapshot if the contents changed.
/// Picks a strategy by file size:
/// - < 15 MB: zstd compression (with a dictionary, if trained)
/// - >= 15 MB: chunk splitting
///
/// The order of operations is dictated by the consistency invariant (see the
/// module header): first the version row is inserted under the lock (and for
/// chunked, its chunk rows too), and only then is the content written to disk
/// outside the lock. If the content write fails, the row is rolled back so no
/// version is left without its blob/chunks.
fn do_snapshot(db: &std::sync::Mutex<rusqlite::Connection>, versions_dir: &Path, path: &str) -> Result<()> {
    let meta = std::fs::metadata(path).map_err(Error::Io)?;
    if !meta.is_file() {
        return Ok(());
    }

    let file_size = meta.len();
    let chunks_dir = versions_dir.join("chunks");
    let dicts_dir = version_compress::dicts_dir(versions_dir);

    if file_size < CHUNK_THRESHOLD {
        // ── zstd strategy ──
        // One disk pass: obtain both the hash (for CAS addressing and the
        // "did the file change" check) and the bytes (for compression) in one read.
        let (hash, file_data) = hasher::hash_and_read(path).map_err(Error::Io)?;

        // Short lock: check "is this state already saved" + the current dictionary.
        // has_hash_for_path (not latest_hash) — so we do not create duplicates
        // when the file already matches some old version (e.g. after a restore).
        let dict_id = {
            let conn = db.lock().map_err(|_| Error::Operation("DB lock poisoned".into()))?;
            if versions::has_hash_for_path(&conn, path, &hash)? {
                return Ok(());
            }
            versions::current_dict_id(&conn)?
        };

        // Compression — outside the lock (this is CPU work, no need to hold the DB).
        let (compressed, used_dict) = version_compress::compress(&file_data, &dicts_dir, dict_id)?;

        let blob = versions_dir.join(format!("{hash}.zst"));

        // C4: insert the referencing row BEFORE writing the blob. The repeated
        // has_hash_for_path check under the lock rules out a race with a
        // concurrent snapshot of the same version that may have inserted while we
        // were compressing.
        let new_id = {
            let conn = db.lock().map_err(|_| Error::Operation("DB lock poisoned".into()))?;
            if versions::has_hash_for_path(&conn, path, &hash)? {
                return Ok(());
            }
            let label = versions::next_label(&conn, path)?;
            versions::insert(&conn, path, now_millis(), file_size as i64, &hash, &label, "zstd", used_dict)?
        };

        // Materialize the blob outside the lock. If the file does not exist yet,
        // write it; if the write fails, roll back the just-inserted row so no
        // version is left referencing a non-existent blob.
        if !blob.exists()
            && let Err(e) = std::fs::write(&blob, &compressed).map_err(Error::Io) {
                let conn = db.lock().map_err(|_| Error::Operation("DB lock poisoned".into()))?;
                let _ = versions::delete(&conn, new_id);
                return Err(e);
            }

        // NOTE: dictionary training/retraining happens in one place —
        // in `snapshot_version` after `do_snapshot`.
    } else {
        // ── chunked strategy ──
        // The hash is needed for the "did the file change" check; the chunker
        // streams the content. This is a second pass over the file (see the
        // deferred bugs #5–#7 about the chunker).
        let hash = hasher::hash_file(path).map_err(Error::Io)?;

        // If the state is already saved in some version — skip (short lock).
        // has_hash_for_path, so we do not breed duplicates after a restore.
        {
            let conn = db.lock().map_err(|_| Error::Operation("DB lock poisoned".into()))?;
            if versions::has_hash_for_path(&conn, path, &hash)? {
                return Ok(());
            }
        }

        // Compute chunk boundaries outside the lock (reads the file as a stream).
        let chunks = chunker::chunk_file(path)?;

        // C4: the version and its chunk rows are inserted BEFORE chunks are
        // written to disk. So each chunk's refcount is non-zero by the time the
        // chunk appears on disk, and a concurrent GC will not delete it as
        // orphaned. The chunks themselves (potentially gigabytes) are written
        // below, OUTSIDE the lock.
        let new_id = {
            let conn = db.lock().map_err(|_| Error::Operation("DB lock poisoned".into()))?;
            if versions::has_hash_for_path(&conn, path, &hash)? {
                return Ok(());
            }
            let label = versions::next_label(&conn, path)?;
            let vid = versions::insert(&conn, path, now_millis(), file_size as i64, &hash, &label, "chunked", None)?;
            versions::insert_chunks(&conn, vid, &chunks)?;
            vid
        };

        // Materialize the chunks outside the lock. On error, roll back the
        // version row (delete also removes its version_chunks).
        if let Err(e) = chunker::store_chunks(&chunks_dir, path, &chunks) {
            let conn = db.lock().map_err(|_| Error::Operation("DB lock poisoned".into()))?;
            let _ = versions::delete(&conn, new_id);
            return Err(e);
        }
    }

    Ok(())
}

/// Train or retrain the zstd dictionary (given the versions_dir path).
fn maybe_train_dict_with_dir(
    db: &std::sync::Mutex<rusqlite::Connection>,
    versions_dir: &Path,
) -> Result<()> {
    let dicts_dir = version_compress::dicts_dir(versions_dir);

    // Current state: how many zstd versions accumulated, at what count the last
    // dictionary was trained, and that dictionary's id (to generate the new
    // dictionary's file name: dict-<id>.zstd).
    let (zstd_count, trained_at, current_dict_id) = {
        let conn = db.lock().map_err(|_| Error::Operation("DB lock poisoned".into()))?;
        let count = versions::zstd_count(&conn)? as usize;
        let at = versions::current_dict_zstd_count_at_train(&conn)?
            .map(|v| v as usize);
        let dict_id = versions::current_dict_id(&conn)?;
        (count, at, dict_id)
    };

    if !version_compress::should_retrain(zstd_count, trained_at) {
        return Ok(());
    }

    let max_samples = 20;
    let max_sample_size = 1024 * 1024;

    let rows: Vec<(String, Option<i64>)> = {
        let conn = db.lock().map_err(|_| Error::Operation("DB lock poisoned".into()))?;
        conn
            .prepare("SELECT hash, dict_id FROM versions WHERE strategy = 'zstd' ORDER BY ts DESC LIMIT ?1")?
            .query_map([max_samples as i64], |r| {
                Ok((r.get::<_, String>(0)?, r.get::<_, Option<i64>>(1)?))
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?
    };

    let mut samples = Vec::new();
    for (hash, dict_id) in &rows {
        let blob = versions_dir.join(format!("{hash}.zst"));
        if !blob.exists() {
            // The blob is not materialized yet (incl. an in-flight snapshot) — skip.
            continue;
        }
        let compressed = std::fs::read(&blob).map_err(Error::Io)?;
        match version_compress::decompress(&compressed, &dicts_dir, *dict_id) {
            Ok(data) => {
                // Cap the sample size
                if data.len() <= max_sample_size {
                    samples.push(data);
                } else {
                    samples.push(data[..max_sample_size].to_vec());
                }
            }
            Err(_) => continue, // failed to decompress — skip
        }
        if samples.len() >= max_samples {
            break;
        }
    }

    if samples.len() < 4 {
        return Ok(()); // too few to train
    }

    // New dictionary id = max existing + 1 (or 1 if none).
    // The id is only used for the dict-<id>.zstd file name; it no longer
    // determines the retraining logic — zstd_count_at_train does that.
    let new_id = current_dict_id.unwrap_or(0) + 1;

    let dict_path = version_compress::train_dict(&dicts_dir, &samples, new_id)?;
    let dict_data = std::fs::read(&dict_path).map_err(Error::Io)?;

    {
        let conn = db.lock().map_err(|_| Error::Operation("DB lock poisoned".into()))?;
        // Remember at what zstd-version count the dictionary was trained —
        // a future should_retrain measures the interval from this value.
        versions::insert_dict(&conn, now_millis(), dict_data.len() as i64, zstd_count as i64)?;
    }

    Ok(())
}

/// Atomically replace the contents of `dest` with `data`.
///
/// Writes to a sibling temp file (so the rename stays on the same volume —
/// atomic and never crosses a mount point), then renames over the target.
/// On Windows `std::fs::rename` over an existing file fails, so we fall back
/// to the canonical "remove then rename" sequence. The window between remove
/// and rename is on the order of a syscall — for a version manager this is
/// acceptable, and a crash here leaves the user with the safety snapshot
/// taken at the start of `do_restore` (so the data is recoverable from the
/// version history).
///
/// This is the fix for H7: previously `std::fs::copy` / `std::fs::write` ran
/// straight over the live file. A power loss, disk-full, or panic mid-write
/// would leave the user's file truncated/corrupted with no automatic recovery
/// path — the safety snapshot was already taken, so there was nothing to roll
/// back to.
fn atomic_write(dest: &Path, data: &[u8]) -> std::result::Result<(), Error> {
    let parent = dest
        .parent()
        .ok_or_else(|| Error::Operation(format!("restore target has no parent: {}", dest.display())))?;
    // temp file in the same directory → rename is intra-volume and atomic
    let tmp = parent.join(format!(
        ".patina-restore-tmp-{}",
        std::process::id(),
    ));
    {
        let mut f = std::fs::File::create(&tmp).map_err(Error::Io)?;
        use std::io::Write;
        f.write_all(data).map_err(Error::Io)?;
        f.sync_all().map_err(Error::Io)?;
    }
    // Try the atomic rename first; on Windows this fails if `dest` exists,
    // so we remove `dest` and rename. Either path leaves a fully written file
    // at `dest` (or the original untouched, if anything failed before rename).
    if std::fs::rename(&tmp, dest).is_ok() {
        return Ok(());
    }
    // Windows path (also tolerates a stale `dest` on Unix):
    let _ = std::fs::remove_file(dest);
    std::fs::rename(&tmp, dest).map_err(Error::Io)?;
    Ok(())
}

/// Restore a version: snapshot the current state, then replace the file's
/// contents with the version's data.
fn do_restore(
    db: &std::sync::Mutex<rusqlite::Connection>,
    versions_dir: &Path,
    id: i64,
) -> Result<()> {
    let v = {
        let conn = db.lock().map_err(|_| Error::Operation("DB lock poisoned".into()))?;
        versions::get(&conn, id)?
            .ok_or_else(|| Error::Operation("version not found".into()))?
    };

    // C3: a safety snapshot of the current state — otherwise restore overwrites
    // unsaved changes. The snapshot error must not be swallowed:
    //   Ok            — snapshotted (or not needed, file unchanged) → continue;
    //   file missing  — nothing to lose, restore recreates it → continue;
    //   any other     — the current state is NOT saved → abort the restore.
    match do_snapshot(db, versions_dir, &v.path) {
        Ok(()) => {}
        Err(Error::Io(e)) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => return Err(e),
    }

    match v.strategy.as_str() {
        "full" => {
            let blob = versions_dir.join(&v.hash);
            // Stream the blob through a buffer to keep peak memory bounded for
            // large "full" versions, then write atomically (H7).
            let data = std::fs::read(&blob).map_err(Error::Io)?;
            atomic_write(Path::new(&v.path), &data)?;
        }
        "zstd" => {
            let blob = versions_dir.join(format!("{}.zst", &v.hash));
            let compressed = std::fs::read(&blob).map_err(Error::Io)?;
            let dicts_dir = version_compress::dicts_dir(versions_dir);
            let data = version_compress::decompress(&compressed, &dicts_dir, v.dict_id)?;
            atomic_write(Path::new(&v.path), &data)?;
        }
        "chunked" => {
            let chunks_dir = versions_dir.join("chunks");
            let chunk_list = {
                let conn = db.lock().map_err(|_| Error::Operation("DB lock poisoned".into()))?;
                versions::get_chunks(&conn, id)?
            };
            let hashes: Vec<String> = chunk_list.iter().map(|(h, _)| h.clone()).collect();
            let data = chunker::reassemble(&chunks_dir, &hashes)?;
            atomic_write(Path::new(&v.path), &data)?;
        }
        _ => {
            return Err(Error::Operation(format!("unknown strategy: {}", v.strategy)));
        }
    }
    Ok(())
}

#[tauri::command]
pub async fn snapshot_version(app: AppHandle, path: String) -> Result<Vec<Version>> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        do_snapshot(&state.db, &state.versions_dir, &path)?;
        // Train/retrain the dictionary (for the zstd strategy)
        let _ = maybe_train_dict_with_dir(&state.db, &state.versions_dir);
        let conn = state.db_read()?;
        versions::list_for(&conn, &path)
    })
    .await
    .map_err(|e| Error::Operation(format!("snapshot_version interrupted: {e}")))?
}

#[tauri::command]
pub async fn list_versions(app: AppHandle, path: String) -> Result<Vec<Version>> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        let conn = state.db_read()?;
        versions::list_for(&conn, &path)
    })
    .await
    .map_err(|e| Error::Operation(format!("list_versions interrupted: {e}")))?
}

#[tauri::command]
pub async fn restore_version(app: AppHandle, id: i64) -> Result<()> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        do_restore(&state.db, &state.versions_dir, id)
    })
    .await
    .map_err(|e| Error::Operation(format!("restore_version interrupted: {e}")))?
}

/// Delete a file version by id. If a blob/chunk has no more references, it is
/// also removed from disk. The only remaining version cannot be deleted.
#[tauri::command]
pub async fn delete_version(app: AppHandle, id: i64) -> Result<Vec<Version>> {
    tauri::async_runtime::spawn_blocking(move || -> Result<Vec<Version>> {
        let state = app.state::<AppState>();

        // C4: the entire critical section is under a single state.db()
        // acquisition. Then no concurrent snapshot can squeeze between the
        // refcount check and the physical remove_file and reference the same
        // content-addressed object. Holding the DB mutex across the unlink here
        // is deliberate: version operations are serialized on one connection
        // anyway, and the unlink itself is short and does not re-enter the DB.
        let versions = {
            let conn = state.db()?;

            // Metadata of the version being deleted + protection against deleting the only one.
            let v = versions::get(&conn, id)?
                .ok_or_else(|| Error::Operation("version not found".into()))?;
            if versions::count_for(&conn, &v.path)? <= 1 {
                return Err(Error::Operation("cannot delete the only version".into()));
            }

        // Collect chunk hashes BEFORE delete (it removes version_chunks).
        let chunk_hashes: Vec<String> = if v.strategy == "chunked" {
            versions::get_chunks(&conn, id)?
                .into_iter()
                .map(|(h, _)| h)
                .collect()
        } else {
            Vec::new()
        };

        // Delete the version row (and its version_chunks).
        versions::delete(&conn, id)?
                .ok_or_else(|| Error::Operation("version not found".into()))?;

            let versions_dir = &state.versions_dir;

            // Blob (full/zstd) — only if the hash has no more references.
            if versions::hash_refcount(&conn, &v.hash)? == 0 {
            match v.strategy.as_str() {
                "full" => {
                    let _ = std::fs::remove_file(versions_dir.join(&v.hash));
                }
                "zstd" => {
                    let _ = std::fs::remove_file(versions_dir.join(format!("{}.zst", &v.hash)));
                }
                _ => {}
            }
        }

        // Orphaned chunks.
        if !chunk_hashes.is_empty() {
            let chunks_dir = versions_dir.join("chunks");
            for ch in &chunk_hashes {
                if versions::chunk_refcount(&conn, ch)? == 0 {
                    let _ = std::fs::remove_file(chunks_dir.join(ch));
                }
            }
        }

        // The updated list — while we still hold the same conn.
        versions::list_for(&conn, &v.path)?
        };

        Ok(versions)
    })
    .await
    .map_err(|e| Error::Operation(format!("delete_version interrupted: {e}")))?
}
