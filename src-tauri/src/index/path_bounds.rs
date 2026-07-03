//! Subtree bounds for path-range queries (one place, one set of tests).

/// `(sep, prefix, upper)`: prefix = base+sep; upper = base + the byte after the
/// separator (`\` 0x5C -> `]`, `/` 0x2F -> `0`). The half-open interval
/// [prefix, upper) is exactly all nested paths: no LIKE pitfalls, picked via the
/// index/PK, compared byte-wise (BINARY collation). `sep` is needed by callers
/// that rebuild a new path (relink); the rest ignore it.
pub fn subtree_bounds(base: &str) -> (char, String, String) {
    let sep = if base.contains('\\') { '\\' } else { '/' };
    let prefix = format!("{base}{sep}");
    let upper = format!("{base}{}", (sep as u8 + 1) as char);
    (sep, prefix, upper)
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
        .map(|rest| format!("{new}{sep}{rest}"))
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
}
