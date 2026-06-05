//! Извлечение ссылок/зависимостей из содержимого файлов и резолв их в пути.
//! Без regex (ручной разбор), чтобы не тащить зависимость. Цели резолвятся
//! относительно папки файла и принимаются только если реально существуют.

use std::path::{Component, Path, PathBuf};

/// Тип производного ребра по расширению источника.
pub fn kind_for(ext: &str) -> &'static str {
    match ext {
        "md" | "markdown" | "html" | "htm" | "css" => "link",
        _ => "import",
    }
}

/// Сырые цели ссылок (ещё не резолвленные) по расширению файла.
pub fn extract_targets(ext: &str, body: &str) -> Vec<String> {
    match ext {
        "md" | "markdown" => md_targets(body),
        "html" | "htm" => attr_targets(body),
        "css" => css_targets(body),
        _ => code_targets(body),
    }
}

/// Markdown: `](target)`, `![](target)` и вики-ссылки `[[target]]`.
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

/// HTML: значения атрибутов src=/href= (в одинарных или двойных кавычках).
fn attr_targets(body: &str) -> Vec<String> {
    let mut out = Vec::new();
    out.extend(quoted_following(body, "src="));
    out.extend(quoted_following(body, "href="));
    out
}

/// CSS: url(...) и `@import "..."`.
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

/// Код: строковые литералы (' " `), похожие на путь (есть '/' или начинается с '.').
/// Так отсекаются имена npm-пакетов ('react') и прочий шум.
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

/// Найти все вхождения `marker`, пропустить пробелы и снять следующий
/// строковый литерал в кавычках. Используется для html-атрибутов и @import.
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

/// Лексическая нормализация пути: сворачивает `.` и `..` без обращения к ФС.
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

/// Резолв сырой цели в абсолютный путь относительно папки `src_path`.
/// Внешние ссылки/протоколы и якоря отбрасываются. Путь принимается только
/// если файл существует (для импортов без расширения пробуются типовые).
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

    // Импорт без расширения: ./mod -> ./mod.ts, ./mod/index.ts и т.п.
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
        assert_eq!(
            normalize(Path::new("/a/b/../c/./d")).to_string_lossy(),
            "/a/c/d"
        );
    }

    #[test]
    fn resolve_rejects_urls_and_anchors() {
        assert_eq!(resolve("/x/a.md", "https://example.com"), None);
        assert_eq!(resolve("/x/a.md", "#section"), None);
        assert_eq!(resolve("/x/a.md", "mailto:n@e.co"), None);
    }
}
