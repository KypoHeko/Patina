//! Text-file detection heuristics and shared constants.
//!
//! Single source of truth for `TEXT_EXTS`, `MAX_FILE`, and the sniffing
//! helpers used by both `indexing` and `content` commands. Previously
//! these were duplicated across two files, drifting out of sync.

use std::io::Read;
use std::path::Path;

/// File extensions treated as text regardless of content.
pub const TEXT_EXTS: &[&str] = &[
    "txt", "md", "markdown", "rs", "js", "mjs", "ts", "jsx", "tsx", "json",
    "toml", "yaml", "yml", "ini", "cfg", "conf", "log", "csv", "tsv", "dat",
    "html", "htm", "css", "xml", "sh", "bat", "py", "go", "java", "c", "h",
    "cpp", "hpp", "sql", "kt", "swift", "rb", "php", "lua", "vue", "svelte",
];

/// Maximum file size eligible for content indexing (1 MB).
pub const MAX_FILE: u64 = 1_048_576;

/// Best-effort read of up to `cap` bytes from the head of a file.
pub fn read_head(path: &Path, cap: usize) -> Vec<u8> {
    let mut buf = Vec::new();
    if let Ok(f) = std::fs::File::open(path) {
        let _ = f.take(cap as u64).read_to_end(&mut buf);
    }
    buf
}

/// Heuristic: a head sample with no NUL byte and few stray control characters
/// is treated as text. Keeps binaries out of the content index while letting
/// unlisted text files (e.g. a `.dat` full of digits) through.
pub fn sample_looks_textual(sample: &[u8]) -> bool {
    if sample.is_empty() || sample.contains(&0) {
        return false;
    }
    let control = sample
        .iter()
        .filter(|&&b| b < 0x20 && !matches!(b, b'\t' | b'\n' | b'\r' | 0x0c))
        .count();
    control * 10 < sample.len() * 3
}

/// Returns `true` when the file looks like text: known extension, or
/// small enough and the head sniff says so.
pub fn is_text(path: &Path, len: u64) -> bool {
    if len == 0 || len > MAX_FILE {
        return false;
    }
    if let Some(ext) = path
        .extension()
        .map(|e| e.to_string_lossy().to_ascii_lowercase())
        && TEXT_EXTS.contains(&ext.as_str())
    {
        return true;
    }
    sample_looks_textual(&read_head(path, 8192))
}

/// Folders we do NOT index or scan: VCS, build artifacts, caches.
fn is_ignored_name(name: &str) -> bool {
    matches!(
        name,
        ".git" | ".svn" | ".hg" | "node_modules" | "target" | "dist" | "build"
            | ".next" | ".nuxt" | ".cache" | "__pycache__" | ".venv" | "venv"
            | ".idea" | ".vscode" | ".gradle" | ".tox"
    )
}

/// Returns `true` when the entry is a directory that should be skipped.
pub fn is_ignored_dir(e: &walkdir::DirEntry) -> bool {
    e.file_type().is_dir() && is_ignored_name(e.file_name().to_str().unwrap_or(""))
}

/// Returns `true` when any component of the path is an ignored directory name.
pub fn is_ignored_path(p: &Path) -> bool {
    p.components()
        .any(|c| is_ignored_name(c.as_os_str().to_str().unwrap_or("")))
}