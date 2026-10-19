//! Duplicate detection: group by size -> hash candidates -> groups.

use std::collections::HashMap;
use std::sync::Mutex;

use rusqlite::Connection;
use serde::Serialize;

use crate::error::{Error, Result};
use crate::index::files;
use crate::indexer::{hasher, scanner};

pub const SCAN_CAP: usize = 20_000;

/// Size of the head hashed to pre-filter large same-size files.
const HEAD_BYTES: u64 = 64 * 1024;

/// Map `f` over `items` on a few worker threads, keeping the input order.
/// `on_each` runs on the calling thread after every finished item, and
/// `cancelled` is polled there as well; a cancel stops the workers at their
/// next item and returns an error.
fn par_map<T, R, F, E, C>(items: &[T], f: F, mut on_each: E, cancelled: &C) -> Result<Vec<R>>
where
    T: Sync,
    R: Send,
    F: Fn(&T) -> R + Sync,
    E: FnMut(usize),
    C: Fn() -> bool,
{
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
    let workers = std::thread::available_parallelism().map_or(2, |n| n.get()).clamp(1, 4).min(items.len().max(1));
    let next = AtomicUsize::new(0);
    let stop = AtomicBool::new(false);
    let mut out: Vec<Option<R>> = (0..items.len()).map(|_| None).collect();
    let mut was_cancelled = false;
    std::thread::scope(|s| {
        let (tx, rx) = std::sync::mpsc::channel::<(usize, R)>();
        for _ in 0..workers {
            let tx = tx.clone();
            let (next, stop, f) = (&next, &stop, &f);
            s.spawn(move || {
                while !stop.load(Ordering::Relaxed) {
                    let i = next.fetch_add(1, Ordering::Relaxed);
                    let Some(item) = items.get(i) else { break };
                    if tx.send((i, f(item))).is_err() {
                        break;
                    }
                }
            });
        }
        drop(tx);
        for (i, r) in rx {
            out[i] = Some(r);
            on_each(i);
            if cancelled() {
                was_cancelled = true;
                stop.store(true, Ordering::Relaxed);
                break;
            }
        }
        stop.store(true, Ordering::Relaxed);
    });
    if was_cancelled || (!items.is_empty() && cancelled()) {
        return Err(Error::Operation("duplicate search cancelled".into()));
    }
    Ok(out.into_iter().map(|r| r.expect("every item was processed")).collect())
}

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

    let groups: Vec<Vec<scanner::ScanFile>> = by_size.into_values().filter(|g| g.len() >= 2).collect();
    if groups.is_empty() {
        on_progress(0, 0);
        return Ok(Vec::new());
    }

    // Pre-filter large files by the hash of their first HEAD_BYTES: same-size
    // files that differ almost always differ early, so most of them never get
    // read in full (before, every same-size candidate was hashed end to end).
    let (small, large): (Vec<_>, Vec<_>) = groups.into_iter().partition(|g| g[0].size <= HEAD_BYTES);
    let mut candidates: Vec<scanner::ScanFile> = small.into_iter().flatten().collect();
    let large: Vec<scanner::ScanFile> = large.into_iter().flatten().collect();
    if !large.is_empty() {
        let heads = par_map(&large, |f| hasher::hash_head(&f.path, HEAD_BYTES).ok(), |_| {}, &cancelled)?;
        let mut by_head: HashMap<(u64, String), Vec<scanner::ScanFile>> = HashMap::new();
        for (f, h) in large.into_iter().zip(heads) {
            if let Some(h) = h {
                by_head.entry((f.size, h)).or_default().push(f);
            }
        }
        candidates.extend(by_head.into_values().filter(|g| g.len() >= 2).flatten());
    }
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

    // Full hashes on several threads: hashing is disk/CPU bound and the files
    // are independent. Progress and cancellation stay on this thread.
    let mut done = 0usize;
    let full = par_map(
        &to_hash,
        |f| hasher::hash_file(&f.path).ok(),
        |_| {
            done += 1;
            if done.is_multiple_of(8) || done == total {
                on_progress(done, total);
            }
        },
        &cancelled,
    )?;
    let mut fresh: Vec<(String, u64, i64, String)> = Vec::new();
    for (f, h) in to_hash.into_iter().zip(full) {
        if let Some(h) = h {
            fresh.push((f.path.clone(), f.size, f.mtime, h.clone()));
            hashes.insert(f.path.clone(), h);
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
    groups.sort_by_key(|g| std::cmp::Reverse(g.size));
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

    #[test]
    fn large_files_are_compared_by_head_then_in_full() {
        let dir = tempfile::tempdir().unwrap();
        let big = vec![7u8; (HEAD_BYTES as usize) * 2];
        let mut tail_differs = big.clone();
        *tail_differs.last_mut().unwrap() = 8;
        let mut head_differs = big.clone();
        head_differs[0] = 9;
        std::fs::write(dir.path().join("a.bin"), &big).unwrap();
        std::fs::write(dir.path().join("b.bin"), &big).unwrap();
        std::fs::write(dir.path().join("c.bin"), &tail_differs).unwrap();
        std::fs::write(dir.path().join("d.bin"), &head_differs).unwrap();

        let db = Mutex::new(crate::index::db::open_in_memory());
        let root = dir.path().to_string_lossy().into_owned();
        let totals = Mutex::new(Vec::new());
        let groups = find(&db, &root, |_, t| totals.lock().unwrap().push(t), || false).unwrap();
        assert_eq!(groups.len(), 1);
        let mut names: Vec<_> = groups[0].paths.iter().map(|p| p.rsplit(['/', '\\']).next().unwrap().to_string()).collect();
        names.sort();
        assert_eq!(names, ["a.bin", "b.bin"]);
        // d.bin was dropped by the head pre-filter: only a, b, c were hashed in full.
        assert_eq!(*totals.lock().unwrap().last().unwrap(), 3);
    }

    #[test]
    fn par_map_keeps_order() {
        let items: Vec<u32> = (0..100).collect();
        let out = par_map(&items, |x| x * 2, |_| {}, &|| false).unwrap();
        assert_eq!(out, items.iter().map(|x| x * 2).collect::<Vec<_>>());
    }
}
