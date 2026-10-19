//! Pruning of the on-disk thumbnail/icon cache (`<app data>/thumbs`).
//! Entries are keyed by path+mtime+size, so every edited or moved file left
//! an orphan behind and the folder grew forever.

use std::path::Path;
use std::time::{Duration, SystemTime};

/// Remove entries older than `max_age`, then the oldest ones until the cache
/// fits in `max_bytes`. Best-effort: unreadable entries are skipped. Returns the
/// number of removed files.
pub fn prune(dir: &Path, max_age: Duration, max_bytes: u64) -> usize {
    let Ok(rd) = std::fs::read_dir(dir) else { return 0 };
    let now = SystemTime::now();
    let mut removed = 0;
    let mut kept: Vec<(SystemTime, u64, std::path::PathBuf)> = Vec::new();
    for entry in rd.flatten() {
        let path = entry.path();
        let Ok(meta) = entry.metadata() else { continue };
        if !meta.is_file() {
            continue;
        }
        let mtime = meta.modified().unwrap_or(now);
        if now.duration_since(mtime).unwrap_or_default() > max_age {
            if std::fs::remove_file(&path).is_ok() {
                removed += 1;
            }
        } else {
            kept.push((mtime, meta.len(), path));
        }
    }
    let mut total: u64 = kept.iter().map(|k| k.1).sum();
    if total > max_bytes {
        kept.sort_by_key(|k| k.0); // oldest first
        for (_, len, path) in kept {
            if total <= max_bytes {
                break;
            }
            if std::fs::remove_file(&path).is_ok() {
                total = total.saturating_sub(len);
                removed += 1;
            }
        }
    }
    removed
}

#[cfg(test)]
mod tests {
    use super::*;

    fn file(dir: &Path, name: &str, len: usize, age: Duration) {
        let p = dir.join(name);
        std::fs::write(&p, vec![0u8; len]).unwrap();
        let t = SystemTime::now() - age;
        std::fs::File::options().write(true).open(&p).unwrap().set_modified(t).unwrap();
    }

    #[test]
    fn drops_expired_then_oldest_until_under_the_cap() {
        let dir = tempfile::tempdir().unwrap();
        let day = Duration::from_secs(86_400);
        file(dir.path(), "expired.jpg", 10, day * 40);
        file(dir.path(), "old.jpg", 100, day * 3);
        file(dir.path(), "mid.jpg", 100, day * 2);
        file(dir.path(), "new.jpg", 100, day);
        let removed = prune(dir.path(), day * 30, 250);
        assert_eq!(removed, 2);
        assert!(!dir.path().join("expired.jpg").exists());
        assert!(!dir.path().join("old.jpg").exists());
        assert!(dir.path().join("mid.jpg").exists() && dir.path().join("new.jpg").exists());
    }
}
