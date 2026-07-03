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

#[cfg(test)]
mod tests {
    use super::normalize;

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
