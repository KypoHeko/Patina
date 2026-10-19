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
/// Case-insensitive on Windows, where `Node_Modules` is the same folder.
fn is_ignored_name(name: &str) -> bool {
    let lowered;
    let name = if cfg!(windows) {
        lowered = name.to_ascii_lowercase();
        lowered.as_str()
    } else {
        name
    };
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

/// Returns `true` when a component of `p` BELOW `root` is an ignored
/// directory name. Components of the root itself and above it do not count:
/// with a root inside e.g. `D:\build\project`, checking every component made
/// the live index ignore every change under that root.
pub fn is_ignored_below(p: &Path, root: &Path) -> bool {
    let skip = root.components().count();
    p.components()
        .skip(skip)
        .any(|c| is_ignored_name(c.as_os_str().to_str().unwrap_or("")))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_components_below_the_root_count() {
        let root = Path::new("/srv/build/project");
        assert!(!is_ignored_below(Path::new("/srv/build/project/src/a.rs"), root));
        assert!(is_ignored_below(Path::new("/srv/build/project/node_modules/x/i.js"), root));
        assert!(is_ignored_below(Path::new("/srv/build/project/target"), root));
    }

    #[cfg(windows)]
    #[test]
    fn ignored_names_are_case_insensitive_on_windows() {
        assert!(is_ignored_name("Node_Modules"));
    }
}
