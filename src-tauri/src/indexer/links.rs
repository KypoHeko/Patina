//! Extracting links/dependencies from file contents and resolving them to paths.
//! No regex (manual parsing) to avoid pulling in a dependency. Targets are
//! resolved relative to the file's folder and accepted only if they really exist.

use std::collections::HashSet;
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
        "sql" => sql_targets(body),
        "js" | "mjs" | "jsx" | "ts" | "tsx" => js_targets(body),
        "rs" => rs_targets(body),
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

/// SQL: `\i 'path'`, `source 'path'`, `@@ 'path'`, `START 'path'`,
/// plus the generic code_targets (pathlike string literals like
/// COPY ... FROM '/path').
fn sql_targets(body: &str) -> Vec<String> {
    let mut out = Vec::new();
    // psql-style \i and \ir (include / include relative)
    out.extend(quoted_following(body, "\\i "));
    out.extend(quoted_following(body, "\\ir "));
    // SOURCE (MySQL/psql)
    out.extend(quoted_following(body, "source "));
    out.extend(quoted_following(body, "SOURCE "));
    // Oracle @@ (run script)
    out.extend(quoted_following(body, "@@ "));
    // START (various DBs)
    out.extend(quoted_following(body, "START "));
    out.extend(quoted_following(body, "start "));
    // Also catch generic pathlike strings (COPY ... FROM '/path', etc.)
    out.extend(code_targets(body));
    out
}

/// JavaScript/TypeScript: finds import/require paths specifically, rather than
/// relying on the generic `code_targets` which is easily confused by
/// apostrophes in comments ("It's", "don't") that pair with the next single
/// quote and break the scan. This parser looks for the keywords `from`,
/// `import`, `require`, and `path` followed by a quoted string.
fn js_targets(body: &str) -> Vec<String> {
    let mut out = Vec::new();
    out.extend(quoted_following(body, "from "));
    out.extend(quoted_following(body, "from\t"));
    out.extend(quoted_following(body, "require("));
    out.extend(quoted_following(body, "require ("));
    // import './path' (side-effect import, no `from`)
    out.extend(quoted_following(body, "import "));
    // Dynamic imports: import('./path')
    out.extend(quoted_following(body, "import("));
    // Also catch generic pathlike strings as a last resort (template literals
    // etc.) — but use the result only for strings that look like paths.
    for raw in code_targets(body) {
        if !out.contains(&raw) {
            out.push(raw);
        }
    }
    out
}

/// Rust: extracts module dependencies from `mod name;` declarations and
/// `include_str!`/`include_bytes!` macro calls. Rust does NOT use string
/// paths for imports (it uses `use crate::...`), so `code_targets` is
/// completely wrong for .rs files — it picks up escape sequences (`\t`,
/// `\n`), test fixture strings ("a.md"), and format specifiers (`{}`)
/// as false path candidates.
///
/// Resolution rules (simplified but covers the common patterns):
/// - `mod foo;` in `src/path/bar.rs` → `src/path/bar/foo.rs` or
///   `src/path/bar/foo/mod.rs`
/// - `pub mod foo;`, `pub(crate) mod foo;` — same resolution
/// - `#[cfg(windows)] mod foo;` — same resolution, conditional
fn rs_targets(body: &str) -> Vec<String> {
    let mut out = Vec::new();
    for line in body.lines() {
        let trimmed = line.trim();
        // Skip comments
        if trimmed.starts_with("//") {
            continue;
        }
        // Strip leading attributes like #[cfg(windows)]
        let mut s = trimmed;
        while s.starts_with('#') {
            if let Some(end) = s.find(']') {
                s = s[end + 1..].trim_start();
            } else {
                break;
            }
        }
        // Strip visibility modifiers: pub, pub(crate), pub(super), pub(in path)
        // These always precede `mod` in Rust.
        if let Some(rest) = s.strip_prefix("pub") {
            s = rest.trim_start();
            // Handle parenthesized visibility: pub(crate), pub(super), pub(in path)
            if s.starts_with('(') {
                if let Some(end) = s.find(')') {
                    s = s[end + 1..].trim_start();
                } else {
                    continue;
                }
            }
        }
        // Now look for `mod <name>;`
        if let Some(rest) = s.strip_prefix("mod ") {
            let name = rest.trim_end_matches(';').trim();
            // A valid module name: only ASCII alphanumeric + underscores
            if !name.is_empty() && name.chars().all(|c| c.is_ascii_alphanumeric() || c == '_') {
                // Only emit the /mod.rs candidate. Rust convention: if `mod foo;`
                // is declared in a file, the child module is either `foo.rs` (a
                // flat file) or `foo/mod.rs` (a directory module). We emit both
                // so resolve() can find whichever exists.
                out.push(format!("{name}.rs"));
                out.push(format!("{name}/mod.rs"));
            }
        }
    }
    // 2) `include_str!` and `include_bytes!` — explicit file references.
    out.extend(quoted_following(body, "include_str!"));
    out.extend(quoted_following(body, "include_bytes!"));
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
    // Reject Rust escape sequences that look like paths: \t, \n, \r, \0,
    // \xNN, \u{NNNN}, etc. These are common in .rs string literals and
    // confuse the scanner because `\` is also a Windows path separator.
    if s.starts_with('\\') && s.len() >= 2 {
        let next = s.as_bytes()[1];
        if matches!(next, b't' | b'n' | b'r' | b'0' | b'\\' | b'\'' | b'"' | b'x' | b'u') {
            return false;
        }
    }
    // Reject strings ending with a backslash — almost always an escape
    // continuation in source code, not a real path.
    if s.ends_with('\\') {
        return false;
    }
    // Reject strings containing control chars or format specifiers like {}
    if s.chars().any(|c| c < ' ' || c == '{' || c == '}') {
        return false;
    }
    // Standard path patterns (Unix and Windows separators).
    if s.starts_with("./") || s.starts_with("../") || s.starts_with('/') || s.contains('/') || s.contains('\\') {
        return true;
    }
    // Bare filename with a recognized file extension — catches SQL/CSV references
    // like 'script.sql', 'data.csv' that lack path separators. The resolve()
    // function still verifies the file exists on disk, so false positives are
    // limited to non-existent filenames.
    if let Some(dot) = s.rfind('.') {
        let ext = s[dot + 1..].to_ascii_lowercase();
        const RECOGNIZED_EXTS: &[&str] = &[
            "sql", "csv", "tsv", "json", "xml", "txt", "md", "markdown",
            "html", "htm", "css", "js", "mjs", "ts", "jsx", "tsx",
            "py", "rs", "go", "java", "c", "h", "cpp", "hpp",
            "yaml", "yml", "toml", "ini", "cfg", "conf", "sh", "bat",
            "png", "jpg", "jpeg", "gif", "svg", "webp", "ico",
            "vue", "svelte", "lua", "rb", "php", "kt", "swift",
        ];
        if RECOGNIZED_EXTS.contains(&ext.as_str()) {
            return true;
        }
    }
    false
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
        // Skip an optional opening delimiter after the marker (and any spaces
        // after it): include_str!("x"), include_bytes!["x"], require( "x" ).
        // Without this, markers like `include_str!` never reached the quote,
        // because `(` sits between the marker and the string literal.
        if j < b.len() && (b[j] == b'(' || b[j] == b'[' || b[j] == b'{') {
            j += 1;
            while j < b.len() && b[j] == b' ' {
                j += 1;
            }
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

/// Check whether a normalized path exists: first try the in-memory set of
/// known paths (O(1)), then fall back to `fs::metadata` for paths outside
/// the scanned subtree (e.g. newly created files, or incremental watcher
/// updates where no set is available).
fn path_exists(normalized: &Path, known: Option<&HashSet<String>>) -> bool {
    if let Some(set) = known {
        set.contains(normalized.to_string_lossy().as_ref())
    } else {
        std::fs::metadata(normalized).is_ok()
    }
}

/// Resolve a raw target to an absolute path relative to `src_path`'s folder.
/// External links/protocols and anchors are dropped. A path is accepted only if
/// the file exists (for extensionless imports, common extensions are tried).
///
/// `known_paths`: when provided (during a full build), path existence is
/// checked against this in-memory set instead of hitting the filesystem for
/// every candidate — this eliminates thousands of `stat` syscalls.
pub fn resolve(src_path: &str, raw: &str, known_paths: Option<&HashSet<String>>) -> Option<String> {
    let t = raw.trim();
    let t = t.split(['#', '?']).next().unwrap_or("").trim();
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

    // Direct path
    let direct = normalize(&base.join(t));
    if path_exists(&direct, known_paths) {
        return Some(direct.to_string_lossy().into_owned());
    }

    // Extensionless import: ./mod -> ./mod.ts, ./mod/index.ts, etc.
    if Path::new(t).extension().is_none() {
        for ext in ["js", "ts", "jsx", "tsx", "mjs", "json", "css", "md", "sql", "rs"] {
            let cand = normalize(&base.join(format!("{t}.{ext}")));
            if path_exists(&cand, known_paths) {
                return Some(cand.to_string_lossy().into_owned());
            }
        }
        for ext in ["js", "ts", "jsx", "tsx", "rs"] {
            let cand = normalize(&base.join(t).join(format!("index.{ext}")));
            if path_exists(&cand, known_paths) {
                return Some(cand.to_string_lossy().into_owned());
            }
        }
        // Rust module convention: mod foo -> foo/mod.rs
        let cand = normalize(&base.join(t).join("mod.rs"));
        if path_exists(&cand, known_paths) {
            return Some(cand.to_string_lossy().into_owned());
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
    fn is_pathlike_bare_filename_with_ext() {
        // Bare filenames with recognized extensions should match (SQL refs, etc.)
        assert!(is_pathlike("script.sql"));
        assert!(is_pathlike("data.csv"));
        assert!(is_pathlike("utils.js"));
        assert!(is_pathlike("style.css"));
        // Bare words without extensions should NOT match
        assert!(!is_pathlike("react"));
        assert!(!is_pathlike("center"));
        assert!(!is_pathlike("index"));
        // Paths with separators still work
        assert!(is_pathlike("./foo.js"));
        assert!(is_pathlike("../bar.css"));
        assert!(is_pathlike("path/to/file.sql"));
        // Windows-style backslash
        assert!(is_pathlike("path\\to\\file.sql"));
        // Escape sequences should NOT match
        assert!(!is_pathlike("\\t"));
        assert!(!is_pathlike("\\n"));
        assert!(!is_pathlike("\\r"));
        assert!(!is_pathlike("\\0"));
        // Trailing backslash should NOT match
        assert!(!is_pathlike("title\\"));
        assert!(!is_pathlike("foo\\"));
        // Format specifiers should NOT match
        assert!(!is_pathlike("{inner}\\"));
        assert!(!is_pathlike("foobar\\"));
    }

    #[test]
    fn sql_targets_imports() {
        let body = "\\i 'schema.sql'\nSOURCE 'seed_data.sql'\n@@ 'indexes.sql'\nSTART 'full_build.sql'";
        let got = sql_targets(body);
        assert!(got.contains(&"schema.sql".to_string()), "got: {got:?}");
        assert!(got.contains(&"seed_data.sql".to_string()), "got: {got:?}");
        assert!(got.contains(&"indexes.sql".to_string()), "got: {got:?}");
        assert!(got.contains(&"full_build.sql".to_string()), "got: {got:?}");
    }

    #[test]
    fn js_targets_import_from_require() {
        let body = r#"
// It's a test module — apostrophe in comment should not break extraction
import { createStore } from './core/store.js';
import { EventBus } from "./core/event-bus.js";
const x = require('../lib/format');
import './styles/base.css';
"#;
        let got = js_targets(body);
        assert!(got.contains(&"./core/store.js".to_string()), "got: {got:?}");
        assert!(got.contains(&"./core/event-bus.js".to_string()), "got: {got:?}");
        assert!(got.contains(&"../lib/format".to_string()), "got: {got:?}");
        assert!(got.contains(&"./styles/base.css".to_string()), "got: {got:?}");
    }

    #[test]
    fn rs_targets_mod_declarations() {
        let body = r#"
mod commands;
mod error;
mod fs;
mod index;
mod indexer;
mod models;
mod state;
mod platform;

#[cfg(windows)]
mod windows;
"#;
        let got = rs_targets(body);
        // Each `mod foo;` should produce two candidates: foo.rs and foo/mod.rs
        assert!(got.contains(&"commands.rs".to_string()), "got: {got:?}");
        assert!(got.contains(&"commands/mod.rs".to_string()), "got: {got:?}");
        assert!(got.contains(&"windows.rs".to_string()), "got: {got:?}");
        assert!(got.contains(&"windows/mod.rs".to_string()), "got: {got:?}");
        // Should NOT pick up escape sequences or test strings
        assert!(!got.iter().any(|s| s.contains("\\t") || s.contains("\\n")), "got: {got:?}");
    }

    #[test]
    fn rs_targets_pub_mod() {
        let body = r#"
pub mod chunker;
pub mod content_index;
pub mod db;
pub mod edges;
pub mod file_index;
pub mod tags;
pub mod versions;

pub(crate) mod path_key;
pub(super) mod dir_agg;
"#;
        let got = rs_targets(body);
        assert!(got.contains(&"chunker.rs".to_string()), "got: {got:?}");
        assert!(got.contains(&"chunker/mod.rs".to_string()), "got: {got:?}");
        assert!(got.contains(&"content_index.rs".to_string()), "got: {got:?}");
        assert!(got.contains(&"content_index/mod.rs".to_string()), "got: {got:?}");
        assert!(got.contains(&"db.rs".to_string()), "got: {got:?}");
        assert!(got.contains(&"edges.rs".to_string()), "got: {got:?}");
        assert!(got.contains(&"path_key.rs".to_string()), "got: {got:?}");
        assert!(got.contains(&"dir_agg.rs".to_string()), "got: {got:?}");
        assert!(got.contains(&"dir_agg/mod.rs".to_string()), "got: {got:?}");
    }

    #[test]
    fn rs_targets_include_str() {
        let body = r#"let sql = include_str!("../schema/0001_tags.sql");"#;
        let got = rs_targets(body);
        assert!(got.iter().any(|s| s.contains("0001_tags.sql")), "got: {got:?}");
    }

    #[test]
    fn rs_targets_no_test_junk() {
        // Test fixture strings should NOT appear — rs_targets doesn't use code_targets
        let body = r#"
#[test]
fn test_search() {
    let result = search(&conn, "C:\\p", "report", 10);
    assert_eq!(result.len(), 2);
}
"#;
        let got = rs_targets(body);
        // Should not contain any test fixture paths
        assert!(!got.iter().any(|s| s.contains("report") || s.contains("C:")), "got: {got:?}");
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
        assert_eq!(resolve("/x/a.md", "https://example.com", None), None);
        assert_eq!(resolve("/x/a.md", "#section", None), None);
        assert_eq!(resolve("/x/a.md", "mailto:n@e.co", None), None);
    }
}