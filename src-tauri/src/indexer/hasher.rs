//! Потоковое хеширование файла (BLAKE3).

use std::fs::File;
use std::io::{self, Read};

pub fn hash_file(path: &str) -> io::Result<String> {
    let mut hasher = blake3::Hasher::new();
    let mut file = File::open(path)?;
    io::copy(&mut file, &mut hasher)?;
    Ok(hasher.finalize().to_hex().to_string())
}

/// Хеширует файл и одновременно собирает его байты в память — один проход
/// по диску вместо двух (hash_file + std::fs::read).
///
/// Используется в `versions::do_snapshot` для zstd-ветки, где нам нужны и
/// BLAKE3-хеш (для CAS-адресации блоба), и содержимое (для сжатия).
///
/// Размер файла заранее не известен функции, но вызывающая сторона должна
/// ограничить вызов файлами < CHUNK_THRESHOLD (15 MB), чтобы не выкачать
/// в память крупный файл — для больших применяется чанковая стратегия,
/// которая читает файл потоково через `chunker::chunk_file`.
pub fn hash_and_read(path: &str) -> io::Result<(String, Vec<u8>)> {
    let mut hasher = blake3::Hasher::new();
    let mut file = File::open(path)?;
    // 64 KB на итерацию — достаточно для эффективности и не сильно давит на кэш.
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
        assert_eq!(h, h_only, "хеши должны совпадать");
        assert_eq!(data, payload, "байты должны совпадать с оригиналом");

        let _ = std::fs::remove_file(&tmp);
    }
}
