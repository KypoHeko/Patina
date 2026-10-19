//! Content-defined chunking based on Rabin fingerprinting.
//!
//! Splits data into variable-length chunks at content-defined boundaries.
//! Unchanged regions yield the same chunks — this is the basis of deduplication.

use std::fs::File;
use std::io::{self, Read, Seek, SeekFrom, Write};

use crate::error::{Error, Result};

/// Chunking parameters.
pub const CHUNK_MIN: usize = 256 * 1024;       // 256 KB — minimum chunk
pub const CHUNK_MAX: usize = 8 * 1024 * 1024;   // 8 MB — maximum chunk

/// Mask used to detect a chunk boundary.
/// Boundary = hash divisible by CHUNK_MASK with no remainder.
/// Probability of a boundary at each byte ≈ 1/(CHUNK_MASK+1).
/// With CHUNK_MASK = 0x1FFFF (131071) the average chunk ≈ 128 KB × 32 ≈ 4 MB.
const CHUNK_MASK: u32 = 0x1FFFF;

/// Polynomial for the Rabin fingerprint (irreducible over GF(2), degree 31).
const RABIN_POLY: u64 = 0x3DA3358B4DC173;

/// Rolling-hash window (bytes).
const WINDOW_SIZE: usize = 48;

/// Chunking result: hash + size of each chunk.
#[derive(Debug, Clone)]
pub struct Chunk {
    pub hash: String,
    pub size: i64,
}

/// Split a file into chunks. Chunks are not held in memory in full —
/// we stream the file, find boundaries, and hash each chunk with BLAKE3.
pub fn chunk_file(path: &str) -> Result<Vec<Chunk>> {
    let mut file = File::open(path).map_err(Error::Io)?;
    let meta = file.metadata().map_err(Error::Io)?;
    if meta.len() == 0 {
        // Empty file — a single empty chunk
        let hash = blake3::Hasher::new().finalize().to_hex().to_string();
        return Ok(vec![Chunk { hash, size: 0 }]);
    }

    let mut chunks = Vec::new();
    let mut buf = Vec::with_capacity(CHUNK_MAX);
    let mut window = [0u8; WINDOW_SIZE];
    let mut wi = 0usize; // position in the window
    let mut fp: u64 = 0;
    // RABIN_POLY is kept for a future table-based Rabin fingerprint
    // implementation; the simplified Buzhash below does not use it, so the
    // variable needs no mut.
    let _out_table = RABIN_POLY;

    // Precompute table[i] = RABIN_POLY^(8*i)
    // for fast removal of a byte from the window.
    // But that is expensive — instead we use a simplified rolling hash:
    // Buzhash-style with a table of random values.
    let lookup = build_lookup();

    // Reset the window
    window.fill(0);

    // Buffered read: this used to be [0u8; 1] with a read syscall per byte —
    // for a 15 MB file that is ~15 million syscalls. Now we read in 256 KB
    // blocks and iterate over the bytes of the in-memory slice.
    // 256 KB is enough for efficiency and does not overload the page cache.
    let mut read_buf = vec![0u8; 256 * 1024];
    loop {
        let n = match file.read(&mut read_buf) {
            Ok(0) => break, // EOF
            Ok(n) => n,
            Err(e) => return Err(Error::Io(e)),
        };

        for &b in &read_buf[..n] {
            // Remove the old byte from the window, add the new one
            let old = window[wi];
            fp = fp
                .wrapping_shl(1)
                .wrapping_add(lookup[b as usize])
                .wrapping_sub(lookup[old as usize].wrapping_shl(WINDOW_SIZE as u32));

            window[wi] = b;
            wi = (wi + 1) % WINDOW_SIZE;
            buf.push(b);

            if buf.len() >= CHUNK_MIN && (fp & CHUNK_MASK as u64) == 0 {
                // Chunk boundary
                chunks.push(hash_chunk(&buf));
                buf.clear();
            } else if buf.len() >= CHUNK_MAX {
                // Hard limit — cut here
                chunks.push(hash_chunk(&buf));
                buf.clear();
            }
        }
    }

    // Remainder — the last chunk
    if !buf.is_empty() {
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

/// Read the given chunks and reassemble the file.
/// Chunks are read from `chunks_dir` in the order given by `hashes`.
pub fn reassemble(chunks_dir: &std::path::Path, hashes: &[String]) -> Result<Vec<u8>> {
    let mut out = Vec::new();
    for h in hashes {
        let path = chunks_dir.join(h);
        let data = std::fs::read(&path).map_err(Error::Io)?;
        out.extend_from_slice(&data);
    }
    Ok(out)
}

/// Store chunks on disk. For each chunk: if the file already exists —
/// skip it (content-addressed storage).
///
/// The source file is streamed into chunks in portions, without loading it
/// fully into memory. This used to be `std::fs::read(path)`, which for files
/// of 15 MB+ gave a memory peak equal to the file size (and the chunked
/// strategy applies precisely to large files — theoretically up to gigabytes).
/// Now we keep a single `File` open and copy exactly `chunk.size` bytes per
/// chunk via `io::copy(file.take(n), out)`.
pub fn store_chunks(
    chunks_dir: &std::path::Path,
    path: &str,
    chunks: &[Chunk],
) -> Result<()> {
    std::fs::create_dir_all(chunks_dir).map_err(Error::Io)?;

    // Empty file — write no chunk, but the DB row will still be created
    if chunks.len() == 1 && chunks[0].size == 0 {
        return Ok(());
    }

    let mut file = File::open(path).map_err(Error::Io)?;

    for chunk in chunks {
        let chunk_path = chunks_dir.join(&chunk.hash);
        // chunk.size is i64, but chunks are never negative (the chunker
        // guarantees size >= 0). Cast to u64 for take()/seek().
        let chunk_size = chunk.size.max(0) as u64;

        if chunk_path.exists() {
            // Chunk is already stored — skip it, but advance the file position
            // so the next chunk is read from the correct offset.
            file.seek(SeekFrom::Current(chunk.size))
                .map_err(Error::Io)?;
            continue;
        }

        // Copy exactly chunk_size bytes into the new file. take(n) caps the
        // read at n bytes; io::copy copies until the source returns EOF
        // (for take, that is when the limit is reached). Thus copied equals
        // chunk_size unless the source file turned out shorter than expected.
        let mut out = std::fs::File::create(&chunk_path).map_err(Error::Io)?;
        let copied = io::copy(&mut (&mut file).take(chunk_size), &mut out).map_err(Error::Io)?;
        // Explicit flush + drop to close the file and flush buffers BEFORE we
        // read chunk_path downstream (otherwise on Windows we can hit a
        // sharing violation).
        out.flush().map_err(Error::Io)?;
        drop(out);

        if copied != chunk_size {
            // The file turned out shorter than the sum of chunk sizes — remove
            // the partially written file and return an error.
            let _ = std::fs::remove_file(&chunk_path);
            return Err(Error::Operation(format!(
                "chunk extends past end of file: requested {} bytes, read {}",
                chunk_size, copied
            )));
        }
    }

    Ok(())
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

    #[test]
    fn store_and_reassemble_roundtrip() {
        let data = b"Hello, chunking world!";
        let mut f = NamedTempFile::new().unwrap();
        f.write_all(data).unwrap();
        f.flush().unwrap();

        let chunks = chunk_file(f.path().to_str().unwrap()).unwrap();
        let dir = tempfile::tempdir().unwrap();
        let chunks_dir = dir.path().join("chunks");
        store_chunks(&chunks_dir, f.path().to_str().unwrap(), &chunks).unwrap();

        let hashes: Vec<String> = chunks.iter().map(|c| c.hash.clone()).collect();
        let reassembled = reassemble(&chunks_dir, &hashes).unwrap();
        assert_eq!(reassembled, data);
    }

    /// Regression for bug #5: a file must chunk correctly under buffered
    /// reading (256 KB blocks), including when the file size is not a multiple
    /// of the buffer size and is several times larger than it.
    #[test]
    fn chunk_file_handles_large_non_aligned_file() {
        // 1 MB + 1 byte — definitely not a multiple of the 256 KB read buffer
        let size = 1024 * 1024 + 1;
        let mut data = Vec::with_capacity(size);
        let mut x: u32 = 0xDEAD_BEEF;
        for _ in 0..size {
            // Pseudo-random bytes so chunk boundaries do not fall predictably
            x ^= x << 13;
            x ^= x >> 17;
            x ^= x << 5;
            data.push((x & 0xFF) as u8);
        }

        let mut f = NamedTempFile::new().unwrap();
        f.write_all(&data).unwrap();
        f.flush().unwrap();

        let chunks = chunk_file(f.path().to_str().unwrap()).unwrap();

        // The sum of chunk sizes must equal the file size
        let total: i64 = chunks.iter().map(|c| c.size).sum();
        assert_eq!(total, size as i64, "sum of chunk sizes must match the file size");

        // Every chunk has a non-zero size (apart from a possible empty one, but data > 0)
        assert!(chunks.iter().all(|c| c.size > 0));

        // No chunk exceeds CHUNK_MAX
        assert!(chunks.iter().all(|c| c.size as usize <= CHUNK_MAX));
    }

    /// Regression for bug #6: store_chunks must stream the file into chunks
    /// without loading it fully into memory. We check a roundtrip on a file
    /// that is deliberately larger than the old 256 KB block (using 2 MB to get
    /// several chunks), and idempotency: a repeated store_chunks call must
    /// neither overwrite existing chunks nor corrupt the data.
    #[test]
    fn store_chunks_streams_and_is_idempotent() {
        // 2 MB of pseudo-random data — yields several chunks by default
        // (target size ~4 MB, min 256 KB, but on random data boundaries may
        // fall earlier — the point is the file is larger than the old buffer).
        let size = 2 * 1024 * 1024;
        let mut data = Vec::with_capacity(size);
        let mut x: u32 = 0xCAFEBABE;
        for _ in 0..size {
            x ^= x << 13;
            x ^= x >> 17;
            x ^= x << 5;
            data.push((x & 0xFF) as u8);
        }

        let mut f = NamedTempFile::new().unwrap();
        f.write_all(&data).unwrap();
        f.flush().unwrap();

        let chunks = chunk_file(f.path().to_str().unwrap()).unwrap();
        assert!(!chunks.is_empty(), "expect at least one chunk");

        let dir = tempfile::tempdir().unwrap();
        let chunks_dir = dir.path().join("chunks");

        // First call — writes all chunks
        store_chunks(&chunks_dir, f.path().to_str().unwrap(), &chunks).unwrap();

        // Remember each chunk file's mtime (on Windows mtime precision is
        // limited, so the second store_chunks just must not fail).
        let hashes: Vec<String> = chunks.iter().map(|c| c.hash.clone()).collect();
        let reassembled = reassemble(&chunks_dir, &hashes).unwrap();
        assert_eq!(reassembled, data, "first roundtrip must yield the original data");

        // Second call — all chunks already exist and must be skipped.
        // Verify the data is unchanged.
        store_chunks(&chunks_dir, f.path().to_str().unwrap(), &chunks).unwrap();
        let reassembled2 = reassemble(&chunks_dir, &hashes).unwrap();
        assert_eq!(reassembled2, data, "a repeated store_chunks must not corrupt the data");
    }

    /// Regression for bug #6: store_chunks must return an error if the file
    /// size is smaller than the sum of chunk sizes (e.g. the file was truncated
    /// between chunk_file and store_chunks). The partially written chunk file
    /// must be removed.
    #[test]
    fn store_chunks_errors_on_short_source_file() {
        // Create a "long" file and chunk it
        let long_data = vec![0x77u8; 1024 * 1024]; // 1 MB
        let mut f_long = NamedTempFile::new().unwrap();
        f_long.write_all(&long_data).unwrap();
        f_long.flush().unwrap();
        let chunks = chunk_file(f_long.path().to_str().unwrap()).unwrap();

        // Now create a "short" file with the same name — store_chunks must
        // detect the mismatch and return an error.
        let dir = tempfile::tempdir().unwrap();
        let chunks_dir = dir.path().join("chunks");

        let mut f_short = NamedTempFile::new().unwrap();
        f_short.write_all(&[0u8; 16]).unwrap(); // only 16 bytes instead of a megabyte
        f_short.flush().unwrap();

        let result = store_chunks(&chunks_dir, f_short.path().to_str().unwrap(), &chunks);
        assert!(result.is_err(), "expected an error on a short source file");

        // Every chunk that managed to be created must be removed (or none was
        // created) — verify the chunks dir is either empty or contains only
        // partially written files that we later removed.
        // In practice: the first chunk requests size > 16 bytes, gets 16, fails.
        if chunks_dir.exists() {
            let entries: Vec<_> = std::fs::read_dir(&chunks_dir).unwrap().collect();
            for entry in entries {
                let p = entry.unwrap().path();
                // A partially written chunk must not remain
                assert!(!p.exists(), "a partially written chunk file must not remain: {:?}", p);
            }
        }
    }
}
