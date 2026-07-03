//! Streaming file hashing (BLAKE3).

use std::fs::File;
use std::io::{self, Read};

pub fn hash_file(path: &str) -> io::Result<String> {
    let mut hasher = blake3::Hasher::new();
    let mut file = File::open(path)?;
    io::copy(&mut file, &mut hasher)?;
    Ok(hasher.finalize().to_hex().to_string())
}

/// Hashes a file and collects its bytes into memory at the same time — one disk
/// pass instead of two (hash_file + std::fs::read).
///
/// Used in `versions::do_snapshot` for the zstd branch, where we need both the
/// BLAKE3 hash (for CAS addressing of the blob) and the contents (for compression).
///
/// The function does not know the file size in advance, but the caller must
/// limit the call to files < CHUNK_THRESHOLD (15 MB) so as not to pull a large
/// file into memory — for big ones the chunked strategy applies, reading the
/// file as a stream via `chunker::chunk_file`.
pub fn hash_and_read(path: &str) -> io::Result<(String, Vec<u8>)> {
    let mut hasher = blake3::Hasher::new();
    let mut file = File::open(path)?;
    // 64 KB per iteration — enough for efficiency and not too hard on the cache.
    let mut buf = vec![0u8; 64 * 1024];
    let mut data = Vec::new();
    loop {
        let n = file.read(&mut buf)?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
        data.extend_from_slice(&buf[..n]);
    }
    Ok((hasher.finalize().to_hex().to_string(), data))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    #[test]
    fn hash_and_read_matches_hash_file() {
        let mut tmp = std::env::temp_dir();
        tmp.push("patina_hash_and_read_test.bin");
        let payload = b"The quick brown fox jumps over the lazy dog. ".repeat(100);
        {
            let mut f = std::fs::File::create(&tmp).unwrap();
            f.write_all(&payload).unwrap();
        }

        let (h, data) = hash_and_read(tmp.to_str().unwrap()).unwrap();
        let h_only = hash_file(tmp.to_str().unwrap()).unwrap();
        assert_eq!(h, h_only, "hashes must match");
        assert_eq!(data, payload, "bytes must match the original");

        let _ = std::fs::remove_file(&tmp);
    }
}
