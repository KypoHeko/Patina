//! Канонический ключ пути для индекса — единый источник правды.
//!
//! NTFS регистронезависим, а ключи в SQLite сравниваются побайтно (коллация
//! BINARY — её требует диапазонный трюк в `path_bounds`; NOCASE его ломает,
//! т.к. сворачивание регистра меняет порядок относительно байта сепаратора).
//! Поэтому регистр складываем здесь, в приложении, ОДИН раз — перед любой
//! записью и поиском по ключу. Иначе один файл, пришедший как `C:\Foo` и
//! `c:/foo/`, даст разные ключи, и теги/версии/связи "отвалятся".

/// Привести путь к канонической форме ключа индекса.
/// Windows: нижний регистр, сепаратор `\`, схлопнутые повторы, без хвостового
/// слеша (кроме корня `C:\`). Прочие ОС: регистр сохраняется (FS
/// регистрозависима), сепаратор `/`, тот же трим. UNC-префикс `\\` сохраняется.
pub fn normalize(path: &str) -> String {
    let sep = std::path::MAIN_SEPARATOR;

    // Регистр складываем только на Windows.
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

    // Хвостовой сепаратор убираем, кроме корней: "/", "\\", "C:\".
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