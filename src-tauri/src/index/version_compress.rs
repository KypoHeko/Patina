//! zstd version compression with a trainable dictionary.
//!
//! For files < 15 MB: compress with a shared dictionary (if one is already
//! trained), otherwise plain zstd compression. The dictionary is trained from
//! accumulated blobs after every N new compressed versions.

use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};

use crate::error::{Error, Result};

/// zstd compression level (1–22). 3 is a fast, good compromise.
const ZSTD_LEVEL: i32 = 3;

/// Minimum number of compressed blobs required to train a dictionary.
const DICT_MIN_SAMPLES: usize = 4;

/// Retrain the dictionary after every N new compressed versions.
const DICT_RETRAIN_INTERVAL: usize = 8;

/// Maximum size of a trained dictionary. This is also the output buffer
/// capacity in `zstd::dict::from_samples`: at 0 the buffer is empty and training
/// always fails with "Destination buffer too small". 110 KiB is the zstd default.
const DICT_MAX_SIZE: usize = 112_640;

/// Compress data with a zstd dictionary (if available) or without one.
/// Returns the compressed bytes and the id of the dictionary used (None = no dict).
pub fn compress(
    data: &[u8],
    dicts_dir: &Path,
    current_dict_id: Option<i64>,
) -> Result<(Vec<u8>, Option<i64>)> {
    if let Some(dict_id) = current_dict_id {
        let dict_path = dict_file(dicts_dir, dict_id);
        if dict_path.exists() {
            let dict_data = fs::read(&dict_path).map_err(Error::Io)?;
            let mut compressed = Vec::new();
            {
                let mut encoder =
                    zstd::Encoder::with_dictionary(&mut compressed, ZSTD_LEVEL, &dict_data)
                        .map_err(|e| Error::Operation(format!("zstd encoder: {e}")))?;
                std::io::Write::write_all(&mut encoder, data)
                    .map_err(|e| Error::Operation(format!("zstd write: {e}")))?;
                encoder
                    .finish()
                    .map_err(|e| Error::Operation(format!("zstd finish: {e}")))?;
            }
            return Ok((compressed, Some(dict_id)));
        }
    }

    // No dictionary — plain compression
    let compressed = zstd::encode_all(data, ZSTD_LEVEL)
        .map_err(|e| Error::Operation(format!("zstd encode: {e}")))?;
    Ok((compressed, None))
}

/// Decompress zstd-compressed data. If the version was compressed with a
/// dictionary, load that dictionary and use it.
pub fn decompress(data: &[u8], dicts_dir: &Path, dict_id: Option<i64>) -> Result<Vec<u8>> {
    if let Some(id) = dict_id {
        let dict_path = dict_file(dicts_dir, id);
        if dict_path.exists() {
            let dict_data = fs::read(&dict_path).map_err(Error::Io)?;
            let mut decoder = zstd::Decoder::with_dictionary(data, &dict_data)
                .map_err(|e| Error::Operation(format!("zstd decoder with dict: {e}")))?;
            let mut decompressed = Vec::new();
            Read::read_to_end(&mut decoder, &mut decompressed)
                .map_err(|e| Error::Operation(format!("zstd decompress: {e}")))?;
            return Ok(decompressed);
        }
    }

    // No dictionary
    let decompressed =
        zstd::decode_all(data).map_err(|e| Error::Operation(format!("zstd decode: {e}")))?;
    Ok(decompressed)
}

/// Train a new dictionary from existing compressed blobs.
/// `samples` — sample data (uncompressed originals or already-compressed blobs).
/// zstd dict::from_samples works on uncompressed data — we pass samples from cache.
///
/// Returns the id of the new dictionary (also written to the DB).
pub fn train_dict(dicts_dir: &Path, samples: &[Vec<u8>], new_dict_id: i64) -> Result<PathBuf> {
    if samples.len() < DICT_MIN_SAMPLES {
        return Err(Error::Operation(format!(
            "need at least {} samples to train a dictionary, have {}",
            DICT_MIN_SAMPLES,
            samples.len()
        )));
    }

    fs::create_dir_all(dicts_dir).map_err(Error::Io)?;

    // zstd::dict::from_samples trains a dictionary from a set of samples.
    // Each sample is the uncompressed data of one file.
    let dict_data = zstd::dict::from_samples(samples, DICT_MAX_SIZE)
        .map_err(|e| Error::Operation(format!("zstd dict train: {e}")))?;

    let path = dict_file(dicts_dir, new_dict_id);
    fs::write(&path, &dict_data).map_err(Error::Io)?;
    Ok(path)
}

/// Path to a dictionary file by id.
pub fn dict_file(dicts_dir: &Path, id: i64) -> PathBuf {
    dicts_dir.join(format!("dict-{id}.zstd"))
}

/// The dictionaries directory inside versions_dir.
pub fn dicts_dir(versions_dir: &Path) -> PathBuf {
    versions_dir.join("dicts")
}

/// Should the dictionary be retrained?
///
/// `zstd_count` — how many versions with strategy='zstd' are stored right now.
/// `trained_at` — how many zstd versions existed when the current dictionary was
/// trained (None if there is no dictionary yet).
///
/// Retraining is triggered if:
/// - there is no dictionary yet and at least DICT_MIN_SAMPLES samples accumulated;
/// - a dictionary exists but DICT_RETRAIN_INTERVAL new zstd versions have
///   appeared since it was trained.
pub fn should_retrain(zstd_count: usize, trained_at: Option<usize>) -> bool {
    match trained_at {
        None => zstd_count >= DICT_MIN_SAMPLES,
        Some(at) => zstd_count.saturating_sub(at) >= DICT_RETRAIN_INTERVAL,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[test]
    fn compress_decompress_without_dict() {
        let dir = TempDir::new().unwrap();
        let dicts = dir.path().join("dicts");
        fs::create_dir_all(&dicts).unwrap();

        let data = b"Hello, zstd world! ".repeat(100);
        let (compressed, dict_id) = compress(&data, &dicts, None).unwrap();
        assert!(dict_id.is_none());
        assert!(compressed.len() < data.len());

        let decompressed = decompress(&compressed, &dicts, None).unwrap();
        assert_eq!(decompressed, data);
    }

    #[test]
    fn train_and_use_dict() {
        let dir = TempDir::new().unwrap();
        let dicts = dir.path().join("dicts");
        fs::create_dir_all(&dicts).unwrap();

        // Generate training samples. Their total size must comfortably exceed
        // DICT_MAX_SIZE (110 KiB), otherwise zstd has nothing to train on:
        // 64 documents of ~6 KiB of varied text ≈ 380 KiB.
        let samples: Vec<Vec<u8>> = (0..64)
            .map(|i| {
                format!("Sample document #{i}: common text pattern, shared words {i}. ")
                    .repeat(100)
                    .into_bytes()
            })
            .collect();

        let dict_path = train_dict(&dicts, &samples, 1).unwrap();
        assert!(dict_path.exists());

        let data = b"Sample document content with some common text pattern. ".repeat(80);
        let (compressed, used_dict) = compress(&data, &dicts, Some(1)).unwrap();
        assert_eq!(used_dict, Some(1));

        let decompressed = decompress(&compressed, &dicts, Some(1)).unwrap();
        assert_eq!(decompressed, data);
    }

    #[test]
    fn should_retrain_logic() {
        // No dictionary yet
        assert!(!should_retrain(3, None)); // still too few samples
        assert!(should_retrain(4, None)); // minimum reached

        // Dictionary trained at 4 zstd versions
        assert!(!should_retrain(5, Some(4))); // 1 elapsed — too early
        assert!(!should_retrain(11, Some(4))); // 7 elapsed — interval (8) not reached yet
        assert!(should_retrain(12, Some(4))); // 8 elapsed — retrain

        // Dictionary trained at 0 zstd versions (edge case)
        assert!(!should_retrain(7, Some(0))); // 7 < 8
        assert!(should_retrain(8, Some(0))); // 8 == interval
    }
}
