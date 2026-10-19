//! Content-defined chunking based on Rabin fingerprinting.
//!
//! Splits data into variable-length chunks at content-defined boundaries.
//! Unchanged regions yield the same chunks — this is the basis of deduplication.

use std::fs::File;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};

use crate::error::{Error, Result};
use crate::fs::atomic;

/// Chunking parameters.
pub const CHUNK_MIN: usize = 256 * 1024;       // 256 KB — minimum chunk
pub const CHUNK_MAX: usize = 8 * 1024 * 1024;   // 8 MB — maximum chunk

/// Mask used to detect a chunk boundary.
/// Boundary = hash divisible by CHUNK_MASK with no remainder.
/// Probability of a boundary at each byte ≈ 1/(CHUNK_MASK+1).
/// With CHUNK_MASK = 0x1FFFF (131071) the average chunk ≈ 128 KB × 32 ≈ 4 MB.
const CHUNK_MASK: u32 = 0x1FFFF;

/// Rolling-hash window (bytes).
const WINDOW_SIZE: usize = 48;

/// Chunking result: hash + size of each chunk.
#[derive(Debug, Clone)]
pub struct Chunk {
    pub hash: String,
    pub size: i64,
}

/// Rolling-hash boundary detector (Buzhash-style, see `build_lookup`).
struct Boundary {
    lookup: [u64; 256],
    window: [u8; WINDOW_SIZE],
    wi: usize,
    fp: u64,
}

impl Boundary {
    fn new() -> Self {
        Self { lookup: build_lookup(), window: [0u8; WINDOW_SIZE], wi: 0, fp: 0 }
    }

    /// Feed one byte; `len` is the size of the current chunk INCLUDING it.
    /// Returns true when the chunk must be cut after this byte.
    #[inline]
    fn push(&mut self, b: u8, len: usize) -> bool {
        let old = self.window[self.wi];
        self.fp = self
            .fp
            .wrapping_shl(1)
            .wrapping_add(self.lookup[b as usize])
            .wrapping_sub(self.lookup[old as usize].wrapping_shl(WINDOW_SIZE as u32));
        self.window[self.wi] = b;
        self.wi = (self.wi + 1) % WINDOW_SIZE;
        (len >= CHUNK_MIN && (self.fp & CHUNK_MASK as u64) == 0) || len >= CHUNK_MAX
    }
}

/// Split a file into chunks (hashes and sizes only, nothing is stored).
#[cfg(test)]
pub fn chunk_file(path: &str) -> Result<Vec<Chunk>> {
    let mut file = File::open(path).map_err(Error::Io)?;
    let mut chunks = Vec::new();
    let mut buf = Vec::with_capacity(CHUNK_MAX);
    let mut boundary = Boundary::new();
    let mut read_buf = vec![0u8; 256 * 1024];
    loop {
        let n = file.read(&mut read_buf).map_err(Error::Io)?;
        if n == 0 {
            break;
        }
        for &b in &read_buf[..n] {
            buf.push(b);
            if boundary.push(b, buf.len()) {
                chunks.push(hash_chunk(&buf));
                buf.clear();
            }
        }
    }
    if !buf.is_empty() || chunks.is_empty() {
        chunks.push(hash_chunk(&buf));
    }
    Ok(chunks)
}

/// Hash a chunk's contents with BLAKE3.
fn hash_chunk(data: &[u8]) -> Chunk {
    let hash = blake3::hash(data).to_hex().to_string();
    Chunk {
        hash,
        size: data.len() as i64,
    }
}

/// A chunked snapshot prepared in ONE pass over the file: the whole-file hash,
/// the chunk list, and the content of every chunk not yet in the store staged
/// in a temp file next to its final place.
///
/// Hash and content come from the same bytes, so a chunk can never end up
/// stored under somebody else's hash — the previous design read the file three
/// times (hash, boundaries, copy) and silently stored wrong data if the file
/// changed in between. Temp files are only renamed into place by [`commit`]
/// once the version rows exist (C4), so the garbage collector never sees a
/// chunk without a reference.
///
/// [`commit`]: Staged::commit
pub struct Staged {
    pub file_hash: String,
    pub chunks: Vec<Chunk>,
    temps: Vec<Option<PathBuf>>,
}

/// Read `path` once and stage its chunks under `chunks_dir`. Fails if the file
/// changed while it was being read (size or mtime differ), so a torn snapshot
/// is never recorded.
pub fn stage_file(path: &str, chunks_dir: &Path) -> Result<Staged> {
    std::fs::create_dir_all(chunks_dir).map_err(Error::Io)?;
    let mut file = File::open(path).map_err(Error::Io)?;
    let before = file.metadata().map_err(Error::Io)?;

    let mut staged = Staged { file_hash: String::new(), chunks: Vec::new(), temps: Vec::new() };
    let mut file_hasher = blake3::Hasher::new();
    let mut buf = Vec::with_capacity(CHUNK_MAX);
    let mut boundary = Boundary::new();
    let mut read_buf = vec![0u8; 256 * 1024];
    let mut total: u64 = 0;

    let res: Result<()> = (|| {
        loop {
            let n = file.read(&mut read_buf).map_err(Error::Io)?;
            if n == 0 {
                break;
            }
            total += n as u64;
            file_hasher.update(&read_buf[..n]);
            for &b in &read_buf[..n] {
                buf.push(b);
                if boundary.push(b, buf.len()) {
                    staged.stage(chunks_dir, &buf)?;
                    buf.clear();
                }
            }
        }
        if !buf.is_empty() || staged.chunks.is_empty() {
            staged.stage(chunks_dir, &buf)?;
        }
        let after = std::fs::metadata(path).map_err(Error::Io)?;
        if total != before.len()
            || after.len() != before.len()
            || after.modified().ok() != before.modified().ok()
        {
            return Err(Error::Operation(
                "the file changed while its snapshot was being taken; try again".into(),
            ));
        }
        Ok(())
    })();
    if let Err(e) = res {
        staged.discard();
        return Err(e);
    }
    staged.file_hash = file_hasher.finalize().to_hex().to_string();
    Ok(staged)
}

impl Staged {
    fn stage(&mut self, chunks_dir: &Path, data: &[u8]) -> Result<()> {
        let chunk = hash_chunk(data);
        let dest = chunks_dir.join(&chunk.hash);
        // Already stored (content-addressed) or seen earlier in this file.
        let known = dest.exists() || self.chunks.iter().any(|c| c.hash == chunk.hash);
        let tmp = if known || data.is_empty() {
            None
        } else {
            Some(atomic::write_temp(&dest, data).map_err(Error::Io)?)
        };
        self.chunks.push(chunk);
        self.temps.push(tmp);
        Ok(())
    }

    /// Move the staged chunks into place. Call after the version and chunk rows
    /// are inserted. A chunk that was skipped because it already existed must
    /// still be there — if the GC removed it meanwhile, the snapshot fails and
    /// the caller rolls the rows back.
    pub fn commit(mut self, chunks_dir: &Path) -> Result<()> {
        for (chunk, tmp) in self.chunks.iter().zip(self.temps.iter_mut()) {
            let dest = chunks_dir.join(&chunk.hash);
            match tmp.take() {
                Some(t) => atomic::commit_temp(&t, &dest).map_err(Error::Io)?,
                None if chunk.size > 0 && !dest.exists() => {
                    return Err(Error::Operation(format!(
                        "chunk {} disappeared during the snapshot; try again",
                        chunk.hash
                    )));
                }
                None => {}
            }
        }
        Ok(())
    }

    /// Remove every staged temp file (on error).
    pub fn discard(&mut self) {
        for t in self.temps.iter_mut().filter_map(Option::take) {
            let _ = std::fs::remove_file(t);
        }
    }
}

impl Drop for Staged {
    fn drop(&mut self) {
        self.discard();
    }
}

/// Stream the given chunks, in order, into `out`, verifying each chunk's size
/// and BLAKE3 hash — a damaged or substituted chunk aborts the restore instead
/// of silently producing a corrupt file. Memory use is one chunk (≤ 8 MB),
/// independent of the file size. Returns the number of bytes written.
pub fn reassemble_into<W: Write>(chunks_dir: &Path, chunks: &[(String, i64)], out: &mut W) -> Result<u64> {
    let mut written = 0u64;
    for (hash, size) in chunks {
        if *size == 0 {
            continue; // the empty chunk of an empty file is never stored
        }
        let data = std::fs::read(chunks_dir.join(hash)).map_err(Error::Io)?;
        if data.len() as i64 != *size || blake3::hash(&data).to_hex().as_str() != hash {
            return Err(Error::Operation(format!("chunk {hash} is damaged; the version cannot be restored")));
        }
        out.write_all(&data).map_err(Error::Io)?;
        written += data.len() as u64;
    }
    Ok(written)
}

/// Table of random 64-bit values for Buzhash.
/// Generated deterministically from a simple PRNG.
fn build_lookup() -> [u64; 256] {
    let mut table = [0u64; 256];
    let mut seed: u64 = 0x12345678_9ABCDEF0;
    for entry in &mut table {
        seed = seed.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
        *entry = seed;
    }
    table
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use tempfile::NamedTempFile;

    #[test]
    fn empty_file_produces_one_chunk() {
        let f = NamedTempFile::new().unwrap();
        let chunks = chunk_file(f.path().to_str().unwrap()).unwrap();
        assert_eq!(chunks.len(), 1);
        assert_eq!(chunks[0].size, 0);
    }

    #[test]
    fn small_file_produces_one_chunk() {
        let mut f = NamedTempFile::new().unwrap();
        f.write_all(&vec![0xAB; 1024]).unwrap();
        f.flush().unwrap();
        let chunks = chunk_file(f.path().to_str().unwrap()).unwrap();
        assert_eq!(chunks.len(), 1);
        assert_eq!(chunks[0].size, 1024);
    }

    #[test]
    fn identical_content_produces_same_chunks() {
        let data = vec![0x42; 6 * 1024 * 1024]; // 6 MB
        let mut f1 = NamedTempFile::new().unwrap();
        f1.write_all(&data).unwrap();
        f1.flush().unwrap();

        let mut f2 = NamedTempFile::new().unwrap();
        f2.write_all(&data).unwrap();
        f2.flush().unwrap();

        let c1 = chunk_file(f1.path().to_str().unwrap()).unwrap();
        let c2 = chunk_file(f2.path().to_str().unwrap()).unwrap();
        assert_eq!(c1.len(), c2.len());
        for (a, b) in c1.iter().zip(c2.iter()) {
            assert_eq!(a.hash, b.hash);
            assert_eq!(a.size, b.size);
        }
    }

    fn random_file(size: usize, seed: u32) -> (NamedTempFile, Vec<u8>) {
        let mut data = Vec::with_capacity(size);
        let mut x = seed;
        for _ in 0..size {
            x ^= x << 13;
            x ^= x >> 17;
            x ^= x << 5;
            data.push((x & 0xFF) as u8);
        }
        let mut f = NamedTempFile::new().unwrap();
        f.write_all(&data).unwrap();
        f.flush().unwrap();
        (f, data)
    }

    fn restore(chunks_dir: &Path, staged_chunks: &[Chunk]) -> Result<Vec<u8>> {
        let list: Vec<(String, i64)> = staged_chunks.iter().map(|c| (c.hash.clone(), c.size)).collect();
        let mut out = Vec::new();
        reassemble_into(chunks_dir, &list, &mut out)?;
        Ok(out)
    }

    #[test]
    fn stage_commit_reassemble_roundtrip() {
        let (f, data) = random_file(2 * 1024 * 1024 + 7, 0xCAFEBABE);
        let dir = tempfile::tempdir().unwrap();
        let chunks_dir = dir.path().join("chunks");
        let staged = stage_file(f.path().to_str().unwrap(), &chunks_dir).unwrap();
        assert_eq!(staged.file_hash, blake3::hash(&data).to_hex().to_string());
        assert_eq!(staged.chunks.iter().map(|c| c.size).sum::<i64>(), data.len() as i64);
        let chunks = staged.chunks.clone();
        staged.commit(&chunks_dir).unwrap();
        assert_eq!(restore(&chunks_dir, &chunks).unwrap(), data);

        // A second snapshot of the same content stages nothing new and still restores.
        let again = stage_file(f.path().to_str().unwrap(), &chunks_dir).unwrap();
        assert!(again.temps.iter().all(Option::is_none));
        again.commit(&chunks_dir).unwrap();
        assert_eq!(restore(&chunks_dir, &chunks).unwrap(), data);
    }

    #[test]
    fn dropped_stage_leaves_no_temp_files() {
        let (f, _) = random_file(1024 * 1024, 0xDEADBEEF);
        let dir = tempfile::tempdir().unwrap();
        let chunks_dir = dir.path().join("chunks");
        drop(stage_file(f.path().to_str().unwrap(), &chunks_dir).unwrap());
        assert_eq!(std::fs::read_dir(&chunks_dir).unwrap().count(), 0);
    }

    #[test]
    fn reassemble_rejects_a_damaged_chunk() {
        let (f, _) = random_file(600 * 1024, 0x1234_5678);
        let dir = tempfile::tempdir().unwrap();
        let chunks_dir = dir.path().join("chunks");
        let staged = stage_file(f.path().to_str().unwrap(), &chunks_dir).unwrap();
        let chunks = staged.chunks.clone();
        staged.commit(&chunks_dir).unwrap();
        let victim = chunks_dir.join(&chunks[0].hash);
        let mut bytes = std::fs::read(&victim).unwrap();
        bytes[0] ^= 0xFF;
        std::fs::write(&victim, bytes).unwrap();
        assert!(restore(&chunks_dir, &chunks).is_err());
    }

    #[test]
    fn stage_matches_chunk_file_boundaries() {
        let (f, _) = random_file(3 * 1024 * 1024, 0xBADC0DE);
        let dir = tempfile::tempdir().unwrap();
        let staged = stage_file(f.path().to_str().unwrap(), &dir.path().join("c")).unwrap();
        let plain = chunk_file(f.path().to_str().unwrap()).unwrap();
        let a: Vec<_> = staged.chunks.iter().map(|c| c.hash.clone()).collect();
        let b: Vec<_> = plain.iter().map(|c| c.hash.clone()).collect();
        assert_eq!(a, b);
    }

    /// Regression for bug #5: a file must chunk correctly under buffered
    /// reading (256 KB blocks), including when the file size is not a multiple
    /// of the buffer size and is several times larger than it.
    #[test]
    fn chunk_file_handles_large_non_aligned_file() {
        let size = 1024 * 1024 + 1;
        let (f, _) = random_file(size, 0xDEAD_BEEF);
        let chunks = chunk_file(f.path().to_str().unwrap()).unwrap();
        let total: i64 = chunks.iter().map(|c| c.size).sum();
        assert_eq!(total, size as i64, "sum of chunk sizes must match the file size");
        assert!(chunks.iter().all(|c| c.size > 0));
        assert!(chunks.iter().all(|c| c.size as usize <= CHUNK_MAX));
    }
}
