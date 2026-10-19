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
use crate::fs::atomic;
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

    // The file exists, so its history (if it was marked as deleted when the
    // file went to the Recycle Bin) is live again.
    {
        let conn = db.lock().map_err(|_| Error::Operation("DB lock poisoned".into()))?;
        versions::clear_deleted(&conn, path)?;
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
        //
        // The blob is shared by hash across paths. When it already exists, the
        // new row must carry the dictionary that blob was compressed with
        // (which may be older than the current one); only when we write the
        // blob ourselves does the row get our dictionary.
        let (new_id, must_write) = {
            let conn = db.lock().map_err(|_| Error::Operation("DB lock poisoned".into()))?;
            if versions::has_hash_for_path(&conn, path, &hash)? {
                return Ok(());
            }
            let shared = versions::zstd_dict_for_hash(&conn, &hash)?;
            let (row_dict, must_write) = match shared {
                Some(existing) if blob.exists() => (existing, false),
                _ => (used_dict, true),
            };
            let label = versions::next_label(&conn, path)?;
            let id = versions::insert(&conn, path, now_millis(), file_size as i64, &hash, &label, "zstd", row_dict)?;
            (id, must_write)
        };

        // Materialize the blob: the slow write goes to a temp file outside the
        // lock; the rename into place and the re-pointing of every row with this
        // hash at our dictionary happen together under the lock, so concurrent
        // writers of the same content always leave rows and blob consistent.
        if must_write {
            let res = atomic::write_temp(&blob, &compressed)
                .map_err(Error::Io)
                .and_then(|tmp| {
                    let conn = db.lock().map_err(|_| Error::Operation("DB lock poisoned".into()))?;
                    atomic::commit_temp(&tmp, &blob).map_err(Error::Io)?;
                    versions::set_zstd_dict_for_hash(&conn, &hash, used_dict)
                });
            if let Err(e) = res {
                let conn = db.lock().map_err(|_| Error::Operation("DB lock poisoned".into()))?;
                let _ = versions::delete(&conn, new_id);
                return Err(e);
            }
        }

        // NOTE: dictionary training/retraining happens in one place —
        // in `snapshot_version` after `do_snapshot`.
    } else {
        // ── chunked strategy ──
        // ONE pass over the file: whole-file hash, chunk boundaries and the
        // content of new chunks (staged in temp files) all come from the same
        // bytes, so a chunk is never stored under a hash that does not match
        // its content, and a file modified during the snapshot is rejected.
        let staged = chunker::stage_file(path, &chunks_dir)?;
        let hash = staged.file_hash.clone();

        // C4: the version and its chunk rows are inserted BEFORE the staged
        // chunks are renamed into place, so the GC never sees an unreferenced
        // chunk. If the state is already saved, the staged temps are dropped.
        let new_id = {
            let conn = db.lock().map_err(|_| Error::Operation("DB lock poisoned".into()))?;
            if versions::has_hash_for_path(&conn, path, &hash)? {
                return Ok(());
            }
            let label = versions::next_label(&conn, path)?;
            let vid = versions::insert(&conn, path, now_millis(), file_size as i64, &hash, &label, "chunked", None)?;
            versions::insert_chunks(&conn, vid, &staged.chunks)?;
            vid
        };

        if let Err(e) = staged.commit(&chunks_dir) {
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
            // Legacy uncompressed blob: copied file-to-file into a temp next to
            // the target (no full read into memory), then swapped in.
            let blob = versions_dir.join(&v.hash);
            let dest = Path::new(&v.path);
            let tmp = atomic::temp_sibling(dest).map_err(Error::Io)?;
            if let Err(e) = std::fs::copy(&blob, &tmp) {
                let _ = std::fs::remove_file(&tmp);
                return Err(Error::Io(e));
            }
            atomic::replace_with_temp(&tmp, dest).map_err(Error::Io)?;
        }
        "zstd" => {
            let blob = versions_dir.join(format!("{}.zst", v.hash));
            let compressed = std::fs::read(&blob).map_err(Error::Io)?;
            let dicts_dir = version_compress::dicts_dir(versions_dir);
            let data = version_compress::decompress(&compressed, &dicts_dir, v.dict_id)?;
            atomic::replace_contents(Path::new(&v.path), &data).map_err(Error::Io)?;
        }
        "chunked" => {
            let chunks_dir = versions_dir.join("chunks");
            let chunk_list = {
                let conn = db.lock().map_err(|_| Error::Operation("DB lock poisoned".into()))?;
                versions::get_chunks(&conn, id)?
            };
            // Stream the verified chunks into a temp file next to the target
            // (memory stays at one chunk even for multi-gigabyte files), then
            // rename it over the live file.
            let dest = Path::new(&v.path);
            let tmp = atomic::temp_sibling(dest).map_err(Error::Io)?;
            let res = (|| -> Result<()> {
                let mut f = std::fs::File::create(&tmp).map_err(Error::Io)?;
                chunker::reassemble_into(&chunks_dir, &chunk_list, &mut f)?;
                f.sync_all().map_err(Error::Io)
            })();
            if let Err(e) = res {
                let _ = std::fs::remove_file(&tmp);
                return Err(e);
            }
            atomic::replace_with_temp(&tmp, dest).map_err(Error::Io)?;
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

/// Files larger than this are not hashed just to mark the "current" version.
const CURRENT_HASH_LIMIT: u64 = 256 * 1024 * 1024;

/// The version whose content equals the file on disk right now, if any.
/// `None` means the file has unsaved changes (or is too large to check).
/// The preview used to assume the NEWEST version was current, even after the
/// file had been edited since.
#[tauri::command]
pub async fn current_version(path: String, app: AppHandle) -> Result<Option<i64>> {
    tauri::async_runtime::spawn_blocking(move || -> Result<Option<i64>> {
        match std::fs::metadata(&path) {
            Ok(m) if m.is_file() && m.len() <= CURRENT_HASH_LIMIT => {}
            _ => return Ok(None),
        }
        let hash = hasher::hash_file(&path).map_err(Error::Io)?;
        let state = app.state::<AppState>();
        let conn = state.db_read()?;
        versions::id_for_hash(&conn, &path, &hash)
    })
    .await
    .map_err(|e| Error::Operation(format!("current_version interrupted: {e}")))?
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

/// Delete one version row (and its chunk rows) and unlink every blob/chunk
/// that no other version references any more. Must be called with the DB lock
/// held (C4: refcount check and unlink in one critical section).
fn remove_version_locked(conn: &rusqlite::Connection, versions_dir: &Path, v: &Version) -> Result<()> {
    // Collect chunk hashes BEFORE delete (it removes version_chunks).
    let chunk_hashes: Vec<String> = if v.strategy == "chunked" {
        versions::get_chunks(conn, v.id)?.into_iter().map(|(h, _)| h).collect()
    } else {
        Vec::new()
    };
    versions::delete(conn, v.id)?;

    // Blob (full/zstd) — only if the hash has no more references.
    if versions::hash_refcount(conn, &v.hash)? == 0 {
        match v.strategy.as_str() {
            "full" => {
                let _ = std::fs::remove_file(versions_dir.join(&v.hash));
            }
            "zstd" => {
                let _ = std::fs::remove_file(versions_dir.join(format!("{}.zst", v.hash)));
            }
            _ => {}
        }
    }
    // Orphaned chunks.
    let chunks_dir = versions_dir.join("chunks");
    for ch in &chunk_hashes {
        if versions::chunk_refcount(conn, ch)? == 0 {
            let _ = std::fs::remove_file(chunks_dir.join(ch));
        }
    }
    Ok(())
}

/// How long the history of a file that was moved to the Recycle Bin is kept.
pub const DELETED_RETENTION_MS: i64 = 30 * 24 * 60 * 60 * 1000;

/// Temp files older than this are leftovers of an interrupted write.
const STALE_TMP_MS: u128 = 60 * 60 * 1000;

/// Garbage collection of the version store (run in the background at startup):
/// 1. versions of files deleted more than `retention_ms` ago are removed;
/// 2. blobs and chunks no version references any more are unlinked (they
///    used to accumulate forever, e.g. after a crash between writes);
/// 3. stale temp files of interrupted atomic writes are removed.
///
/// Every refcount check and unlink runs under the DB lock, so a concurrent
/// snapshot (which inserts its row BEFORE writing content — C4) is never
/// mistaken for garbage. Returns the number of removed versions.
pub fn collect_garbage(
    db: &std::sync::Mutex<rusqlite::Connection>,
    versions_dir: &Path,
    retention_ms: i64,
) -> Result<usize> {
    let lock = || db.lock().map_err(|_| Error::Operation("DB lock poisoned".into()));
    let cutoff = now_millis() - retention_ms;

    let removed = {
        let conn = lock()?;
        let ids = versions::expired_ids(&conn, cutoff)?;
        for id in &ids {
            if let Some(v) = versions::get(&conn, *id)? {
                remove_version_locked(&conn, versions_dir, &v)?;
            }
        }
        ids.len()
    };

    let is_stale_tmp = |p: &Path| {
        p.file_name().is_some_and(|n| n.to_string_lossy().contains(".patina-tmp-"))
            && std::fs::metadata(p)
                .and_then(|m| m.modified())
                .ok()
                .and_then(|t| t.elapsed().ok())
                .is_some_and(|age| age.as_millis() > STALE_TMP_MS)
    };

    // Blobs in versions_dir: `<hash>.zst` (zstd) or `<hash>` (legacy full).
    if let Ok(rd) = std::fs::read_dir(versions_dir) {
        for entry in rd.flatten() {
            let path = entry.path();
            if !path.is_file() {
                continue;
            }
            if is_stale_tmp(&path) {
                let _ = std::fs::remove_file(&path);
                continue;
            }
            let name = entry.file_name().to_string_lossy().into_owned();
            if name.starts_with('.') {
                continue;
            }
            let hash = name.strip_suffix(".zst").unwrap_or(&name);
            let conn = lock()?;
            if versions::hash_refcount(&conn, hash)? == 0 {
                let _ = std::fs::remove_file(&path);
            }
        }
    }
    // Chunks.
    if let Ok(rd) = std::fs::read_dir(versions_dir.join("chunks")) {
        for entry in rd.flatten() {
            let path = entry.path();
            if is_stale_tmp(&path) {
                let _ = std::fs::remove_file(&path);
                continue;
            }
            let name = entry.file_name().to_string_lossy().into_owned();
            if name.starts_with('.') {
                continue;
            }
            let conn = lock()?;
            if versions::chunk_refcount(&conn, &name)? == 0 {
                let _ = std::fs::remove_file(&path);
            }
        }
    }
    Ok(removed)
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

            remove_version_locked(&conn, &state.versions_dir, &v)?;

            // The updated list — while we still hold the same conn.
            versions::list_for(&conn, &v.path)?
        };

        Ok(versions)
    })
    .await
    .map_err(|e| Error::Operation(format!("delete_version interrupted: {e}")))?
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    struct Env {
        _dir: tempfile::TempDir,
        root: std::path::PathBuf,
        versions_dir: std::path::PathBuf,
        db: Mutex<rusqlite::Connection>,
    }

    fn env() -> Env {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("files");
        let versions_dir = dir.path().join("versions");
        std::fs::create_dir_all(&root).unwrap();
        std::fs::create_dir_all(&versions_dir).unwrap();
        Env { root, versions_dir, db: Mutex::new(crate::index::db::open_in_memory()), _dir: dir }
    }

    fn train(env: &Env, id: i64, seed: &str) {
        let samples: Vec<Vec<u8>> = (0..30)
            .map(|i| format!("{seed}-{i} {}", "lorem ipsum dolor ".repeat(30)).into_bytes())
            .collect();
        let dicts = version_compress::dicts_dir(&env.versions_dir);
        version_compress::train_dict(&dicts, &samples, id).unwrap();
        let conn = env.db.lock().unwrap();
        versions::insert_dict(&conn, 0, 1, 0).unwrap();
    }

    fn file(env: &Env, name: &str, body: &str) -> String {
        let p = env.root.join(name);
        std::fs::write(&p, body).unwrap();
        p.to_string_lossy().into_owned()
    }

    fn versions_of(env: &Env, path: &str) -> Vec<Version> {
        versions::list_for(&env.db.lock().unwrap(), path).unwrap()
    }

    #[test]
    fn shared_blob_keeps_its_dictionary_after_retrain() {
        let env = env();
        let body = "shared content ".repeat(200);
        train(&env, 1, "alpha");
        let a = file(&env, "a.txt", &body);
        do_snapshot(&env.db, &env.versions_dir, &a).unwrap();
        train(&env, 2, "beta"); // the current dictionary changes
        let b = file(&env, "b.txt", &body); // same content, another path
        do_snapshot(&env.db, &env.versions_dir, &b).unwrap();

        let vb = &versions_of(&env, &b)[0];
        assert_eq!(vb.dict_id, Some(1), "row must record the blob's dictionary");
        std::fs::write(&b, "changed").unwrap();
        do_restore(&env.db, &env.versions_dir, vb.id).unwrap();
        assert_eq!(std::fs::read_to_string(&b).unwrap(), body);
    }

    #[test]
    fn snapshot_restore_roundtrip_leaves_no_temp_files() {
        let env = env();
        let p = file(&env, "doc.md", "v1");
        do_snapshot(&env.db, &env.versions_dir, &p).unwrap();
        std::fs::write(&p, "v2").unwrap();
        do_snapshot(&env.db, &env.versions_dir, &p).unwrap();
        let vs = versions_of(&env, &p);
        assert_eq!(vs.len(), 2);
        let v1 = vs.iter().find(|v| v.label == "v1").unwrap();
        do_restore(&env.db, &env.versions_dir, v1.id).unwrap();
        assert_eq!(std::fs::read_to_string(&p).unwrap(), "v1");
        let leftovers: Vec<_> = std::fs::read_dir(&env.root)
            .unwrap()
            .filter_map(|e| e.ok())
            .filter(|e| e.file_name().to_string_lossy().contains("patina-tmp"))
            .collect();
        assert!(leftovers.is_empty());
    }

    #[test]
    fn gc_removes_expired_history_and_orphan_blobs_only() {
        let env = env();
        let keep = file(&env, "keep.txt", "keep me");
        let gone = file(&env, "gone.txt", "gone soon");
        do_snapshot(&env.db, &env.versions_dir, &keep).unwrap();
        do_snapshot(&env.db, &env.versions_dir, &gone).unwrap();
        std::fs::write(env.versions_dir.join("deadbeef.zst"), b"orphan").unwrap();
        {
            let conn = env.db.lock().unwrap();
            versions::mark_deleted(&conn, &gone, 0).unwrap();
        }
        let removed = collect_garbage(&env.db, &env.versions_dir, 1).unwrap();
        assert_eq!(removed, 1);
        assert!(!env.versions_dir.join("deadbeef.zst").exists(), "orphan blob unlinked");
        assert_eq!(versions_of(&env, &keep).len(), 1);
        assert!(versions_of(&env, &gone).is_empty());
        let kv = &versions_of(&env, &keep)[0];
        assert!(env.versions_dir.join(format!("{}.zst", kv.hash)).exists(), "live blob kept");
    }

    #[test]
    fn snapshot_after_restore_from_bin_revives_history() {
        let env = env();
        let p = file(&env, "x.txt", "one");
        do_snapshot(&env.db, &env.versions_dir, &p).unwrap();
        {
            let conn = env.db.lock().unwrap();
            versions::mark_deleted(&conn, &p, 0).unwrap();
        }
        std::fs::write(&p, "two").unwrap(); // the file is back
        do_snapshot(&env.db, &env.versions_dir, &p).unwrap();
        assert_eq!(collect_garbage(&env.db, &env.versions_dir, 1).unwrap(), 0);
        assert_eq!(versions_of(&env, &p).len(), 2);
    }

    #[test]
    fn chunked_snapshot_restore_roundtrip() {
        let env = env();
        let p = env.root.join("big.bin");
        let mut data = Vec::with_capacity(CHUNK_THRESHOLD as usize + 4096);
        let mut x: u64 = 0x9E37_79B9_7F4A_7C15;
        while data.len() < CHUNK_THRESHOLD as usize + 4096 {
            x ^= x << 13;
            x ^= x >> 7;
            x ^= x << 17;
            data.extend_from_slice(&x.to_le_bytes());
        }
        std::fs::write(&p, &data).unwrap();
        let ps = p.to_string_lossy().into_owned();
        do_snapshot(&env.db, &env.versions_dir, &ps).unwrap();
        let v = versions_of(&env, &ps).remove(0);
        assert_eq!(v.strategy, "chunked");
        std::fs::write(&p, b"overwritten").unwrap();
        do_restore(&env.db, &env.versions_dir, v.id).unwrap();
        assert_eq!(std::fs::read(&p).unwrap(), data);
    }
}
