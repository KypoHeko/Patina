//! Extracting links/dependencies from file contents and resolving them to paths.
//! No regex (manual parsing) to avoid pulling in a dependency. Targets are
//! resolved relative to the file's folder and accepted only if they really exist.

use std::path::{Component, Path, PathBuf};

/// The derived edge kind based on the source's extension.
pub fn kind_for(ext: &str) -> &'static str {
    match ext {
        "md" | "markdown" | "html" | "htm" | "css" => "link",
        _ => "import",
    }
}

/// Raw (not yet resolved) link targets, by file extension.
pub fn extract_targets(ext: &str, body: &str) -> Vec<String> {
    match ext {
        "md" | "markdown" => md_targets(body),
        "html" | "htm" => attr_targets(body),
        "css" => css_targets(body),
        _ => code_targets(body),
    }
}

/// Markdown: `](target)`, `![](target)` and wiki-links `[[target]]`.
fn md_targets(body: &str) -> Vec<String> {
    let mut out = Vec::new();
    let b = body.as_bytes();
    let mut i = 0;
    while i + 1 < b.len() {
        if b[i] == b']' && b[i + 1] == b'(' {
            let start = i + 2;
            if let Some(rel) = body[start..].find(')') {
                let inside = &body[start..start + rel];
                let target = inside
                    .split_whitespace()
                    .next()
                    .unwrap_or("")
                    .trim_matches(|c| c == '<' || c == '>');
                if !target.is_empty() {
                    out.push(target.to_string());
                }
                i = start + rel + 1;
                continue;
            }
        }
        if b[i] == b'[' && b[i + 1] == b'[' {
            let start = i + 2;
            if let Some(rel) = body[start..].find("]]") {
                let inside = &body[start..start + rel];
                let target = inside.split('|').next().unwrap_or("").trim();
                if !target.is_empty() {
                    out.push(target.to_string());
                }
                i = start + rel + 2;
                continue;
            }
        }
        i += 1;
    }
    out
}

/// HTML: src=/href= attribute values (in single or double quotes).
fn attr_targets(body: &str) -> Vec<String> {
    let mut out = Vec::new();
    out.extend(quoted_following(body, "src="));
    out.extend(quoted_following(body, "href="));
    out
}

/// CSS: url(...) and `@import "..."`.
fn css_targets(body: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut from = 0;
    while let Some(rel) = body[from..].find("url(") {
        let start = from + rel + 4;
        if let Some(crel) = body[start..].find(')') {
            let inside = body[start..start + crel]
                .trim()
                .trim_matches(|c| c == '"' || c == '\'');
            if !inside.is_empty() {
                out.push(inside.to_string());
            }
            from = start + crel + 1;
        } else {
            break;
        }
    }
    out.extend(quoted_following(body, "@import"));
    out
}

/// Code: string literals (' " `) that look like a path (contain '/' or start with '.').
/// This filters out npm package names ('react') and other noise.
fn code_targets(body: &str) -> Vec<String> {
    let mut out = Vec::new();
    let b = body.as_bytes();
    let mut i = 0;
    while i < b.len() {
        let ch = b[i];
        if ch == b'"' || ch == b'\'' || ch == b'`' {
            let start = i + 1;
            if let Some(rel) = body[start..].find(ch as char) {
                let s = &body[start..start + rel];
                if is_pathlike(s) {
                    out.push(s.to_string());
                }
                i = start + rel + 1;
                continue;
            } else {
                break;
            }
        }
        i += 1;
    }
    out
}

fn is_pathlike(s: &str) -> bool {
    if s.is_empty() || s.len() > 512 || s.contains(' ') || s.contains('\n') {
        return false;
    }
    s.starts_with("./") || s.starts_with("../") || s.starts_with('/') || s.contains('/')
}

/// Find all occurrences of `marker`, skip spaces, and take the next quoted
/// string literal. Used for HTML attributes and @import.
fn quoted_following(body: &str, marker: &str) -> Vec<String> {
    let mut out = Vec::new();
    let b = body.as_bytes();
    let mut from = 0;
    while let Some(rel) = body[from..].find(marker) {
        let mut j = from + rel + marker.len();
        while j < b.len() && b[j] == b' ' {
            j += 1;
        }
        if j < b.len() && (b[j] == b'"' || b[j] == b'\'') {
            let q = b[j];
            let vstart = j + 1;
            if let Some(vrel) = body[vstart..].find(q as char) {
                let val = &body[vstart..vstart + vrel];
                if !val.is_empty() {
                    out.push(val.to_string());
                }
                from = vstart + vrel + 1;
                continue;
            }
        }
        from = from + rel + marker.len();
    }
    out
}

/// Lexical path normalization: collapses `.` and `..` without touching the FS.
fn normalize(p: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for c in p.components() {
        match c {
            Component::CurDir => {}
            Component::ParentDir => {
                out.pop();
            }
            other => out.push(other.as_os_str()),
        }
    }
    out
}

/// Resolve a raw target to an absolute path relative to `src_path`'s folder.
/// External links/protocols and anchors are dropped. A path is accepted only if
/// the file exists (for extensionless imports, common extensions are tried).
pub fn resolve(src_path: &str, raw: &str) -> Option<String> {
    let t = raw.trim();
    let t = t.split(|c| c == '#' || c == '?').next().unwrap_or("").trim();
    if t.is_empty() || t.starts_with("//") || t.contains("://") {
        return None;
    }
    let lower = t.to_ascii_lowercase();
    for p in ["http:", "https:", "mailto:", "tel:", "data:", "javascript:", "ftp:"] {
        if lower.starts_with(p) {
            return None;
        }
    }

    let base = Path::new(src_path).parent()?;
    let direct = normalize(&base.join(t));
    if std::fs::metadata(&direct).is_ok() {
        return Some(direct.to_string_lossy().into_owned());
    }

    // Extensionless import: ./mod -> ./mod.ts, ./mod/index.ts, etc.
    if Path::new(t).extension().is_none() {
        for ext in ["js", "ts", "jsx", "tsx", "mjs", "json", "css", "md"] {
            let cand = normalize(&base.join(format!("{t}.{ext}")));
            if std::fs::metadata(&cand).is_ok() {
                return Some(cand.to_string_lossy().into_owned());
            }
        }
        for ext in ["js", "ts", "jsx", "tsx"] {
            let cand = normalize(&base.join(t).join(format!("index.{ext}")));
            if std::fs::metadata(&cand).is_ok() {
                return Some(cand.to_string_lossy().into_owned());
            }
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn md_links_images_wikilinks() {
        let body = "see [a](./b.md) and ![alt](img/x.png \"title\") and [[notes/foo|Foo]] end";
        assert_eq!(md_targets(body), vec!["./b.md", "img/x.png", "notes/foo"]);
    }

    #[test]
    fn code_pathlike_only() {
        let body = "import x from './u.js';\nconst z = require(\"../lib/z\");\nlet k='plain';";
        assert_eq!(code_targets(body), vec!["./u.js", "../lib/z"]);
    }

    #[test]
    fn html_src_href() {
        let body = "<img src=\"a/b.png\"><link href='c.css'>";
        assert_eq!(attr_targets(body), vec!["a/b.png", "c.css"]);
    }

    #[test]
    fn css_url_and_import() {
        let body = "@import \"base.css\";\n.x{background:url('./i.png')}";
        let mut got = css_targets(body);
        got.sort();
        assert_eq!(got, vec!["./i.png", "base.css"]);
    }

    #[test]
    fn normalize_collapses_dot_dotdot() {
        // Compare PathBufs (component-wise), not strings — otherwise the test
        // depends on the OS separator (on Windows it would be '\').
        assert_eq!(normalize(Path::new("/a/b/../c/./d")), PathBuf::from("/a/c/d"));
    }

    #[test]
    fn resolve_rejects_urls_and_anchors() {
        assert_eq!(resolve("/x/a.md", "https://example.com"), None);
        assert_eq!(resolve("/x/a.md", "#section"), None);
        assert_eq!(resolve("/x/a.md", "mailto:n@e.co"), None);
    }
}
