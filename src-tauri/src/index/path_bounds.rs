//! Границы поддерева для запросов по диапазону пути (одно место, одни тесты).

/// `(sep, prefix, upper)`: prefix = base+sep; upper = base + следующий байт
/// сепаратора (`\` 0x5C -> `]`, `/` 0x2F -> `0`). Полуинтервал [prefix, upper) —
/// ровно все вложенные пути: без ловушек LIKE, выбирается по индексу/PK,
/// сравнение байтовое (коллация BINARY). `sep` нужен вызовам, что собирают
/// новый путь (relink); остальные его игнорируют.
pub fn subtree_bounds(base: &str) -> (char, String, String) {
    let sep = if base.contains('\\') { '\\' } else { '/' };
    let prefix = format!("{base}{sep}");
    let upper = format!("{base}{}", (sep as u8 + 1) as char);
    (sep, prefix, upper)
}

/// Перенос пути при переименовании/перемещении `old` -> `new`.
/// Возвращает новый путь, если `path` равен `old` или лежит в его поддереве;
/// иначе `None` (путь вне зоны переноса — трогать не нужно). Сепаратор берётся
/// из `old`, чтобы реконструкция совпадала с `subtree_bounds`.
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
        assert!(in_range("C:\\a\\b\\x.txt", &prefix, &upper)); // вложенный
        assert!(!in_range("C:\\a\\bb\\y.txt", &prefix, &upper)); // сосед — НЕ задет
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
        // точное совпадение -> новый путь
        assert_eq!(remap("C:\\a\\b", "C:\\a\\b", "C:\\a\\c").as_deref(), Some("C:\\a\\c"));
        // вложенный -> перенос с сохранением хвоста
        assert_eq!(
            remap("C:\\a\\b\\x.txt", "C:\\a\\b", "C:\\a\\c").as_deref(),
            Some("C:\\a\\c\\x.txt")
        );
        // сосед (bb) — вне зоны переноса
        assert_eq!(remap("C:\\a\\bb\\y.txt", "C:\\a\\b", "C:\\a\\c"), None);
        // совсем посторонний путь
        assert_eq!(remap("D:\\other", "C:\\a\\b", "C:\\a\\c"), None);
    }
}
