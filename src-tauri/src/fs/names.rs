//! Validation of a single file or folder name typed by the user (rename,
//! new folder).
//!
//! The name is joined onto a parent directory, so it must be exactly ONE
//! normal path component: a separator or `..` would let it escape the parent
//! (`Path::join` with an absolute name even replaces the parent entirely).
//! On Windows the name must also be one that Win32 can create and address
//! again: no `<>:"|?*` or control characters (`:` would open an alternate
//! data stream — `a.txt:hidden` — instead of naming a file), no reserved
//! device names (`CON`, `NUL.txt`, `COM1`…), and no trailing dot or space
//! (Win32 strips them, so the file would be created under a different name
//! than the one checked for conflicts).

use std::path::{Component, Path};

use crate::error::{Error, Result};

/// Longest name a component may have on common file systems.
const MAX_NAME_BYTES: usize = 255;

const RESERVED: &[&str] = &[
    "CON", "PRN", "AUX", "NUL", "CONIN$", "CONOUT$", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6",
    "COM7", "COM8", "COM9", "COM¹", "COM²", "COM³", "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6",
    "LPT7", "LPT8", "LPT9", "LPT¹", "LPT²", "LPT³",
];

/// Check `name` with the rules of the current OS.
pub fn validate_name(name: &str) -> Result<()> {
    validate_name_for(name, cfg!(windows))
}

/// Check `name`; `windows` adds the Win32 naming rules (split out so both
/// rule sets are tested on every OS).
pub fn validate_name_for(name: &str, windows: bool) -> Result<()> {
    let bad = |why: &str| Err(Error::InvalidPath(format!("invalid name {name:?}: {why}")));
    if name.is_empty() || name.trim().is_empty() {
        return bad("empty");
    }
    if name.len() > MAX_NAME_BYTES {
        return bad("too long");
    }
    if name.contains(['/', '\\', '\0']) {
        return bad("contains a path separator");
    }
    let mut comps = Path::new(name).components();
    if !matches!((comps.next(), comps.next()), (Some(Component::Normal(_)), None)) {
        return bad("not a single file name");
    }
    if windows {
        if name.chars().any(|c| matches!(c, '<' | '>' | ':' | '"' | '|' | '?' | '*') || (c as u32) < 0x20) {
            return bad("contains a character Windows does not allow");
        }
        if name.ends_with(['.', ' ']) {
            return bad("ends with a dot or a space");
        }
        // `NUL.txt` and `con .log` are the device too: the stem before the
        // first dot, without trailing spaces, is what Win32 compares.
        let stem = name.split('.').next().unwrap_or(name).trim_end();
        if RESERVED.iter().any(|r| r.eq_ignore_ascii_case(stem)) {
            return bad("reserved device name");
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_ordinary_names() {
        for n in ["report.txt", "Отчёт 2026", ".gitignore", "a..b", "con-tract.md", "COM10", "nul_file"] {
            assert!(validate_name_for(n, true).is_ok(), "{n}");
            assert!(validate_name_for(n, false).is_ok(), "{n}");
        }
    }

    #[test]
    fn rejects_traversal_everywhere() {
        for n in ["", "   ", ".", "..", "../x", "a/b", r"a\b", r"..\..\evil", "/etc", "x\0y"] {
            assert!(validate_name_for(n, false).is_err(), "{n:?}");
            assert!(validate_name_for(n, true).is_err(), "{n:?}");
        }
        assert!(validate_name_for(&"x".repeat(256), false).is_err());
    }

    #[test]
    fn applies_win32_rules_only_on_windows() {
        for n in ["a.txt:hidden", "C:", "what?", "a*b", "pipe|", "q\"uote", "tab\there", "trail.", "trail ", "CON", "nul.txt", "Com1.log", "lpt9", "con .txt"] {
            assert!(validate_name_for(n, true).is_err(), "{n:?} must be rejected on Windows");
        }
        // Legal on Unix file systems.
        for n in ["a.txt:hidden", "what?", "trail.", "CON"] {
            assert!(validate_name_for(n, false).is_ok(), "{n:?}");
        }
    }
}
