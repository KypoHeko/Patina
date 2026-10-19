//! Duplicate detection: group by size -> hash candidates -> groups.

use std::collections::HashMap;
use std::sync::Mutex;

use rusqlite::Connection;
use serde::Serialize;

use crate::error::{Error, Result};
use crate::index::files;
use crate::indexer::{hasher, scanner};

pub const SCAN_CAP: usize = 20_000;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DupGroup {
    pub hash: String,
    pub size: u64,
    pub paths: Vec<String>,
}

/// Find duplicate groups in `dir`: first a cheap grouping by size, then hashing
/// only the candidates (reusing the hash cache from the DB).
/// `on_progress(done, total)` is called during hashing. Groups are sorted by
/// descending size.
/// `cancelled()` is polled between files: closing the panel or starting a
/// new scan stops the hashing instead of letting it run to the end.
pub fn find<F, C>(db: &Mutex<Connection>, dir: &str, on_progress: F, cancelled: C) -> Result<Vec<DupGroup>>
where
    F: Fn(usize, usize),
    C: Fn() -> bool,
{
    let mut by_size: HashMap<u64, Vec<scanner::ScanFile>> = HashMap::new();
    for f in scanner::walk(dir, SCAN_CAP) {
        if f.size > 0 {
            by_size.entry(f.size).or_default().push(f);
        }
    }

    let candidates: Vec<scanner::ScanFile> = by_size
        .into_iter()
        .filter(|(_, g)| g.len() >= 2)
        .flat_map(|(_, g)| g)
        .collect();
    if candidates.is_empty() {
        on_progress(0, 0);
        return Ok(Vec::new());
    }

    let mut hashes: HashMap<String, String> = HashMap::new();
    {
        let conn = db.lock().map_err(|_| Error::Operation("DB lock poisoned".into()))?;
        for f in &candidates {
            if let Some(h) = files::cached_hash(&conn, &f.path, f.mtime, f.size)? {
                hashes.insert(f.path.clone(), h);
            }
        }
    }

    let to_hash: Vec<&scanner::ScanFile> = candidates
        .iter()
        .filter(|f| !hashes.contains_key(&f.path))
        .collect();
    let total = to_hash.len();
    on_progress(0, total);

    let mut fresh: Vec<(String, u64, i64, String)> = Vec::new();
    let mut done = 0usize;
    for f in to_hash {
        if cancelled() {
            return Err(Error::Operation("duplicate search cancelled".into()));
        }
        if let Ok(h) = hasher::hash_file(&f.path) {
            fresh.push((f.path.clone(), f.size, f.mtime, h.clone()));
            hashes.insert(f.path.clone(), h);
        }
        done += 1;
        if done.is_multiple_of(8) || done == total {
            on_progress(done, total);
        }
    }

    if !fresh.is_empty() {
        let conn = db.lock().map_err(|_| Error::Operation("DB lock poisoned".into()))?;
        for (path, size, mtime, h) in &fresh {
            files::store_hash(&conn, path, *size, *mtime, h)?;
        }
    }

    let mut by_hash: HashMap<String, (u64, Vec<scanner::ScanFile>)> = HashMap::new();
    for f in candidates {
        if let Some(h) = hashes.get(&f.path) {
            by_hash.entry(h.clone()).or_insert((f.size, Vec::new())).1.push(f);
        }
    }
    let mut groups: Vec<DupGroup> = by_hash
        .into_iter()
        .filter(|(_, (_, files))| files.len() > 1)
        .map(|(hash, (size, mut files))| {
            // Deterministic order, the most likely ORIGINAL first: oldest,
            // then the shortest path. The UI's "keep first" keeps it — before,
            // the order came from a HashMap and the kept copy was random.
            files.sort_by(|a, b| {
                a.mtime
                    .cmp(&b.mtime)
                    .then(a.path.len().cmp(&b.path.len()))
                    .then_with(|| a.path.cmp(&b.path))
            });
            DupGroup { hash, size, paths: files.into_iter().map(|f| f.path).collect() }
        })
        .collect();
    groups.sort_by(|a, b| b.size.cmp(&a.size));
    Ok(groups)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keeps_the_oldest_copy_first_and_honours_cancel() {
        let dir = tempfile::tempdir().unwrap();
        let old = dir.path().join("zz_original.txt");
        std::fs::write(&old, "same").unwrap();
        let past = std::time::SystemTime::now() - std::time::Duration::from_secs(3600);
        std::fs::File::options().write(true).open(&old).unwrap().set_modified(past).unwrap();
        std::fs::create_dir(dir.path().join("sub")).unwrap();
        std::fs::write(dir.path().join("sub").join("a_copy.txt"), "same").unwrap();
        std::fs::write(dir.path().join("other.txt"), "diff").unwrap();

        let db = Mutex::new(crate::index::db::open_in_memory());
        let root = dir.path().to_string_lossy().into_owned();
        let groups = find(&db, &root, |_, _| {}, || false).unwrap();
        assert_eq!(groups.len(), 1);
        assert!(groups[0].paths[0].ends_with("zz_original.txt"), "got {:?}", groups[0].paths);
        assert_eq!(groups[0].paths.len(), 2, "the subtree is scanned");

        let db2 = Mutex::new(crate::index::db::open_in_memory());
        assert!(find(&db2, &root, |_, _| {}, || true).is_err());
    }
}
