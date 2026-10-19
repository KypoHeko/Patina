//! Subtree bounds for path-range queries (one place, one set of tests).

/// `(sep, prefix, upper)`: prefix = base+sep; upper = base + the byte after the
/// separator (`\` 0x5C -> `]`, `/` 0x2F -> `0`). The half-open interval
/// [prefix, upper) is exactly all nested paths: no LIKE pitfalls, picked via the
/// index/PK, compared byte-wise (BINARY collation). `sep` is needed by callers
/// that rebuild a new path (relink); the rest ignore it.
///
/// Roots already end with the separator (`c:\`, `/`, `\\`): for them the
/// separator is NOT appended a second time — otherwise the range would be
/// `c:\\`..`c:\]` and no child path would fall into it.
pub fn subtree_bounds(base: &str) -> (char, String, String) {
    let sep = if base.contains('\\') { '\\' } else { '/' };
    let stem = base.strip_suffix(sep).unwrap_or(base);
    let prefix = format!("{stem}{sep}");
    let upper = format!("{stem}{}", (sep as u8 + 1) as char);
    (sep, prefix, upper)
}

/// Join `base` and a relative tail with `sep`, without doubling the separator
/// when `base` is a root that already ends with it.
pub fn join_key(base: &str, sep: char, rest: &str) -> String {
    if base.ends_with(sep) {
        format!("{base}{rest}")
    } else {
        format!("{base}{sep}{rest}")
    }
}

/// Remap a path on rename/move `old` -> `new`.
/// Returns the new path if `path` equals `old` or lies inside its subtree;
/// otherwise `None` (the path is outside the remap zone — leave it alone). The
/// separator is taken from `old` so reconstruction matches `subtree_bounds`.
pub fn remap(path: &str, old: &str, new: &str) -> Option<String> {
    if path == old {
        return Some(new.to_string());
    }
    let (sep, prefix, _upper) = subtree_bounds(old);
    path.strip_prefix(prefix.as_str())
        .map(|rest| join_key(new, sep, rest))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn in_range(p: &str, prefix: &str, upper: &str) -> bool {
        p.as_bytes() >= prefix.as_bytes() && p.as_bytes() < upper.as_bytes()
    }

    #[test]
    fn windows_bounds_and_sibling_trap() {
        let (sep, prefix, upper) = subtree_bounds("C:\\a\\b");
        assert_eq!(sep, '\\');
        assert_eq!(prefix, "C:\\a\\b\\");
        assert_eq!(upper, "C:\\a\\b]"); // 0x5C + 1 = 0x5D = ']'
        assert!(in_range("C:\\a\\b\\x.txt", &prefix, &upper)); // nested
        assert!(!in_range("C:\\a\\bb\\y.txt", &prefix, &upper)); // sibling — NOT touched
    }

    #[test]
    fn unix_bounds() {
        let (sep, prefix, upper) = subtree_bounds("/home/u/b");
        assert_eq!(sep, '/');
        assert_eq!(prefix, "/home/u/b/");
        assert_eq!(upper, "/home/u/b0"); // 0x2F + 1 = 0x30 = '0'
        assert!(in_range("/home/u/b/x", &prefix, &upper));
        assert!(!in_range("/home/u/bb/y", &prefix, &upper));
    }

    #[test]
    fn remap_exact_nested_and_outside() {
        // exact match -> new path
        assert_eq!(remap("C:\\a\\b", "C:\\a\\b", "C:\\a\\c").as_deref(), Some("C:\\a\\c"));
        // nested -> remapped, keeping the tail
        assert_eq!(
            remap("C:\\a\\b\\x.txt", "C:\\a\\b", "C:\\a\\c").as_deref(),
            Some("C:\\a\\c\\x.txt")
        );
        // sibling (bb) — outside the remap zone
        assert_eq!(remap("C:\\a\\bb\\y.txt", "C:\\a\\b", "C:\\a\\c"), None);
        // completely unrelated path
        assert_eq!(remap("D:\\other", "C:\\a\\b", "C:\\a\\c"), None);
    }

    #[test]
    fn drive_root_bounds_include_children() {
        let (_, prefix, upper) = subtree_bounds("c:\\");
        assert_eq!(prefix, "c:\\");
        assert_eq!(upper, "c:]");
        assert!(in_range("c:\\users\\a.txt", &prefix, &upper));
        assert!(!in_range("d:\\x", &prefix, &upper));
    }

    #[test]
    fn posix_root_bounds_include_children() {
        let (_, prefix, upper) = subtree_bounds("/");
        assert_eq!(prefix, "/");
        assert_eq!(upper, "0");
        assert!(in_range("/home/a.txt", &prefix, &upper));
    }

    #[test]
    fn remap_into_root_does_not_double_separator() {
        assert_eq!(remap("c:\\a\\x.txt", "c:\\a", "d:\\").as_deref(), Some("d:\\x.txt"));
        assert_eq!(join_key("/", '/', "x"), "/x");
        assert_eq!(join_key("/a", '/', "x"), "/a/x");
    }
}
