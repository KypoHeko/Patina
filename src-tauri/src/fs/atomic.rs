//! Crash-safe file writes: write to a uniquely named sibling temp file,
//! flush it to disk, then rename it over the destination.
//!
//! A plain `fs::write` that is interrupted (crash, power loss, disk full)
//! leaves a truncated file behind. For content-addressed blobs that is fatal:
//! the next writer sees `exists()` and never rewrites it. Writing through a
//! temp file means the destination either keeps its old content or gets the
//! complete new one.

use std::fs::{self, File};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

static SEQ: AtomicU64 = AtomicU64::new(0);

/// A temp path next to `dest` (same directory → same volume → atomic rename),
/// unique per process, per call and per moment, so concurrent writers never
/// collide.
pub fn temp_sibling(dest: &Path) -> io::Result<PathBuf> {
    let parent = dest.parent().ok_or_else(|| {
        io::Error::new(io::ErrorKind::InvalidInput, format!("no parent directory: {}", dest.display()))
    })?;
    let name = dest
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.subsec_nanos())
        .unwrap_or(0);
    let seq = SEQ.fetch_add(1, Ordering::Relaxed);
    Ok(parent.join(format!(".{name}.patina-tmp-{}-{seq}-{nanos}", std::process::id())))
}

/// Write `data` into a fresh temp sibling of `dest` and fsync it. Returns the
/// temp path; the caller renames it into place (see [`commit_temp`]). Used when
/// the rename must happen under a lock while the slow write must not.
pub fn write_temp(dest: &Path, data: &[u8]) -> io::Result<PathBuf> {
    let tmp = temp_sibling(dest)?;
    let res = (|| {
        let mut f = File::create(&tmp)?;
        f.write_all(data)?;
        f.sync_all()
    })();
    if let Err(e) = res {
        let _ = fs::remove_file(&tmp);
        return Err(e);
    }
    Ok(tmp)
}

/// Move a finished temp file over `dest`. `std::fs::rename` replaces an
/// existing file on every platform (on Windows via `MOVEFILE_REPLACE_EXISTING`).
/// On failure the temp file is removed so nothing is left behind.
pub fn commit_temp(tmp: &Path, dest: &Path) -> io::Result<()> {
    fs::rename(tmp, dest).inspect_err(|_| {
        let _ = fs::remove_file(tmp);
    })
}

/// Write `data` to `dest` atomically (temp file + rename).
pub fn write_atomic(dest: &Path, data: &[u8]) -> io::Result<()> {
    let tmp = write_temp(dest, data)?;
    commit_temp(&tmp, dest)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn writes_and_replaces_without_leftovers() {
        let dir = tempfile::tempdir().unwrap();
        let dest = dir.path().join("blob.bin");
        write_atomic(&dest, b"one").unwrap();
        write_atomic(&dest, b"two").unwrap();
        assert_eq!(fs::read(&dest).unwrap(), b"two");
        let entries: Vec<_> = fs::read_dir(dir.path()).unwrap().collect();
        assert_eq!(entries.len(), 1, "temp files must not be left behind");
    }

    #[test]
    fn temp_names_are_unique() {
        let dir = tempfile::tempdir().unwrap();
        let dest = dir.path().join("x");
        assert_ne!(temp_sibling(&dest).unwrap(), temp_sibling(&dest).unwrap());
    }
}
