//! Canonical index path key — the single source of truth.
//!
//! NTFS is case-insensitive, while SQLite keys are compared byte-for-byte
//! (the BINARY collation — required by the range trick in `path_bounds`; NOCASE
//! breaks it, because case folding changes ordering relative to the separator
//! byte). So we fold case here, in the application, ONCE — before any write or
//! key lookup. Otherwise a single file arriving as `C:\Foo` and `c:/foo/` would
//! produce different keys and its tags/versions/links would "fall off".

/// Bring a path to the canonical key form.
/// Windows: lowercase, `\` separator, collapsed repeats, no trailing slash
/// (except the root `C:\`). Other OSes: case preserved (the FS is
/// case-sensitive), `/` separator, same trimming. The UNC prefix `\\` is kept.
pub fn normalize(path: &str) -> String {
    let sep = std::path::MAIN_SEPARATOR;

    // Fold case on Windows only.
    #[cfg(windows)]
    let path = path.to_lowercase();

    let chars: Vec<char> = path.chars().collect();
    let unc = chars.len() >= 2
        && (chars[0] == '/' || chars[0] == '\\')
        && (chars[1] == '/' || chars[1] == '\\');

    let mut out = String::with_capacity(path.len());
    if unc {
        out.push(sep);
        out.push(sep);
    }
    let mut prev_sep = false;
    for &ch in chars.iter().skip(if unc { 2 } else { 0 }) {
        if ch == '/' || ch == '\\' {
            if !prev_sep {
                out.push(sep);
            }
            prev_sep = true;
        } else {
            out.push(ch);
            prev_sep = false;
        }
    }

    // Strip the trailing separator, except for roots: "/", "\\", "C:\".
    let root_len = if unc { 2 } else { 1 };
    if out.ends_with(sep) {
        let is_drive_root = cfg!(windows) && out.len() == 3 && out.as_bytes()[1] == b':';
        let is_bare_root = out.len() <= root_len;
        if !is_drive_root && !is_bare_root {
            out.pop();
        }
    }
    out
}

/// Rebase an ORIGINAL-case path from `old` to `new` (both in original case)
/// after a rename/move, matching the prefix by canonical key. The tail keeps
/// its own letter case: `C:\Docs\Report.TXT` moved from `c:\docs` to
/// `D:\Archive` becomes `D:\Archive\Report.TXT`. `None` when `path` is not
/// `old` or inside it.
pub fn rebase_display(path: &str, old: &str, new: &str) -> Option<String> {
    let key = normalize(path);
    let old_key = normalize(old);
    if key == old_key {
        return Some(new.to_string());
    }
    if !crate::index::path_bounds::is_within(&key, &old_key) {
        return None;
    }
    let is_sep = |c: char| c == '/' || c == '\\';
    let skip = old.split(is_sep).filter(|s| !s.is_empty()).count();
    let tail: Vec<&str> = path.split(is_sep).filter(|s| !s.is_empty()).skip(skip).collect();
    let sep = if new.contains('\\') || (!new.contains('/') && cfg!(windows)) { '\\' } else { '/' };
    Some(crate::index::path_bounds::join_key(new, sep, &tail.join(&sep.to_string())))
}

/// The ORIGINAL-case form of a path whose key may be case-folded (legacy rows
/// stored before original paths were kept): each component is replaced by the
/// directory entry whose canonical form matches. Components that do not exist
/// on disk are kept as given. Cheap enough for short lists (tags, versions,
/// graph nodes), not for bulk search results.
pub fn on_disk_case(path: &str) -> String {
    if !cfg!(windows) {
        return path.to_string(); // case-sensitive FS: the key IS the real path
    }
    let p = std::path::Path::new(path);
    let mut out = std::path::PathBuf::new();
    for comp in p.components() {
        use std::path::Component;
        match comp {
            Component::Normal(name) => {
                let want = normalize(&name.to_string_lossy());
                let found = std::fs::read_dir(if out.as_os_str().is_empty() { std::path::Path::new(".") } else { &out })
                    .ok()
                    .and_then(|rd| {
                        rd.flatten()
                            .map(|e| e.file_name())
                            .find(|n| normalize(&n.to_string_lossy()) == want)
                    });
                out.push(found.unwrap_or_else(|| name.to_os_string()));
            }
            Component::Prefix(pre) => out.push(pre.as_os_str().to_ascii_uppercase()),
            other => out.push(other.as_os_str()),
        }
    }
    out.to_string_lossy().into_owned()
}

#[cfg(test)]
mod tests {
    use super::{normalize, rebase_display};

    #[test]
    fn rebase_keeps_tail_case() {
        assert_eq!(
            rebase_display("/Home/U/Docs/Report.TXT", "/Home/U/Docs", "/Home/U/Archive").as_deref(),
            Some("/Home/U/Archive/Report.TXT")
        );
        assert_eq!(rebase_display("/a/B", "/a/B", "/a/C").as_deref(), Some("/a/C"));
        assert_eq!(rebase_display("/a/Bb/x", "/a/B", "/a/C"), None);
    }

    #[cfg(windows)]
    #[test]
    fn rebase_matches_prefix_case_insensitively() {
        assert_eq!(
            rebase_display("C:\\Docs\\Sub\\Report.TXT", "c:\\docs", "D:\\Archive").as_deref(),
            Some("D:\\Archive\\Sub\\Report.TXT")
        );
    }

    #[cfg(windows)]
    #[test]
    fn windows_folds_case_seps_and_trailing() {
        assert_eq!(normalize("C:\\Foo\\Bar.TXT"), "c:\\foo\\bar.txt");
        assert_eq!(normalize("c:/foo/BAR.txt"), "c:\\foo\\bar.txt");
        assert_eq!(normalize("C:\\Foo\\"), "c:\\foo");
        assert_eq!(normalize("C:\\"), "c:\\");
        assert_eq!(normalize("C:\\\\Foo\\\\Bar"), "c:\\foo\\bar");
        assert_eq!(normalize("\\\\Server\\Share\\F.txt"), "\\\\server\\share\\f.txt");
    }

    #[cfg(unix)]
    #[test]
    fn unix_keeps_case_normalizes_seps() {
        assert_eq!(normalize("/home/U/B/x.txt"), "/home/U/B/x.txt");
        assert_eq!(normalize("/home/u//b/"), "/home/u/b");
        assert_eq!(normalize("/"), "/");
    }

    #[test]
    fn idempotent() {
        let once = normalize("C:/Foo/Bar/");
        assert_eq!(normalize(&once), once);
    }
}
