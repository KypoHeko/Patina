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
}
