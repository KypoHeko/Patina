//! Потоковое хеширование файла (BLAKE3).

use std::fs::File;
use std::io;

pub fn hash_file(path: &str) -> io::Result<String> {
    let mut hasher = blake3::Hasher::new();
    let mut file = File::open(path)?;
    io::copy(&mut file, &mut hasher)?;
    Ok(hasher.finalize().to_hex().to_string())
}
