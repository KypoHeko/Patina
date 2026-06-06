//! Направленные рёбра между файлами (таблица file_edges).
//! Зависимости = исходящие (src -> dst), обратные ссылки = входящие (по dst).

use std::collections::HashSet;

use rusqlite::Connection;
use serde::Serialize;

use crate::error::Result;
use crate::index::path_bounds::{remap, subtree_bounds};
use crate::index::path_key::normalize;

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Edge {
    pub src: String,
    pub dst: String,
    pub kind: String,
}

fn norm<'a>(a: &'a str, b: &'a str) -> (&'a str, &'a str) {
    if a <= b { (a, b) } else { (b, a) }
}

/// Ручная (неориентированная) связь: храним нормализованной парой с kind='manual'.
pub fn add_manual(conn: &Connection, a: &str, b: &str) -> Result<()> {
    let a = normalize(a);
    let b = normalize(b);
    let (a, b) = (a.as_str(), b.as_str());
    if a == b {
        return Ok(());
    }
    let (x, y) = norm(a, b);
    conn.execute(
        "INSERT OR IGNORE INTO file_edges (src, dst, kind) VALUES (?1, ?2, 'manual')",
        (x, y),
    )?;
    Ok(())
}

pub fn remove_manual(conn: &Connection, a: &str, b: &str) -> Result<()> {
    let a = normalize(a);
    let b = normalize(b);
    let (a, b) = (a.as_str(), b.as_str());
    let (x, y) = norm(a, b);
    conn.execute(
        "DELETE FROM file_edges WHERE src = ?1 AND dst = ?2 AND kind = 'manual'",
        (x, y),
    )?;
    Ok(())
}

/// Заменить производные (не-manual) исходящие рёбра одного источника —
/// для инкрементального сопровождения при изменении файла. Ручные не трогаем.
pub fn replace_derived_for_src(
    conn: &Connection,
    src: &str,
    edges: &[(String, String)],
) -> Result<()> {
    let src = normalize(src);
    let src = src.as_str();
    conn.execute(
        "DELETE FROM file_edges WHERE src = ?1 AND kind <> 'manual'",
        (src,),
    )?;
    let mut stmt =
        conn.prepare("INSERT OR IGNORE INTO file_edges (src, dst, kind) VALUES (?1, ?2, ?3)")?;
    for (dst, kind) in edges {
        stmt.execute((src, &normalize(dst), kind))?;
    }
    Ok(())
}

/// Полная замена производных рёбер поддерева (после полной переиндексации).
/// Удаляются все не-manual рёбра, исходящие из поддерева, и вставляются новые —
/// одной транзакцией. Ручные связи сохраняются.
pub fn replace_derived_subtree(
    conn: &mut Connection,
    root: &str,
    edges: &[(String, String, String)],
) -> Result<()> {
    let root = normalize(root);
    let root = root.as_str();
    let (_, prefix, upper) = subtree_bounds(root);
    let tx = conn.transaction()?;
    tx.execute(
        "DELETE FROM file_edges WHERE kind <> 'manual' AND (src = ?1 OR (src >= ?2 AND src < ?3))",
        (root, &prefix, &upper),
    )?;
    {
        let mut stmt =
            tx.prepare("INSERT OR IGNORE INTO file_edges (src, dst, kind) VALUES (?1, ?2, ?3)")?;
        for (s, d, k) in edges {
            stmt.execute((&normalize(s), &normalize(d), k))?;
        }
    }
    tx.commit()?;
    Ok(())
}

/// Окрестность графа: рёбра в пределах `hops` прыжков от seed-путей, в обе
/// стороны (исходящие = зависимости, входящие = обратные ссылки).
pub fn neighborhood(conn: &Connection, seeds: &[String], hops: usize) -> Result<Vec<Edge>> {
    let mut seen: HashSet<String> = seeds.iter().map(|s| normalize(s)).collect();
    let mut frontier: Vec<String> = seen.iter().cloned().collect();
    let mut edges: HashSet<(String, String, String)> = HashSet::new();

    let mut out_stmt = conn.prepare("SELECT dst, kind FROM file_edges WHERE src = ?1")?;
    let mut in_stmt = conn.prepare("SELECT src, kind FROM file_edges WHERE dst = ?1")?;

    for _ in 0..hops.max(1) {
        let mut next: Vec<String> = Vec::new();
        for node in &frontier {
            let outs: Vec<(String, String)> = out_stmt
                .query_map([node], |r| Ok((r.get(0)?, r.get(1)?)))?
                .collect::<rusqlite::Result<_>>()?;
            for (dst, kind) in outs {
                edges.insert((node.clone(), dst.clone(), kind));
                if seen.insert(dst.clone()) {
                    next.push(dst);
                }
            }
            let ins: Vec<(String, String)> = in_stmt
                .query_map([node], |r| Ok((r.get(0)?, r.get(1)?)))?
                .collect::<rusqlite::Result<_>>()?;
            for (src, kind) in ins {
                edges.insert((src.clone(), node.clone(), kind));
                if seen.insert(src.clone()) {
                    next.push(src);
                }
            }
        }
        if next.is_empty() {
            break;
        }
        frontier = next;
    }

    Ok(edges
        .into_iter()
        .map(|(src, dst, kind)| Edge { src, dst, kind })
        .collect())
}

/// Перенос рёбер при переименовании/перемещении: old -> new (с любого конца,
/// включая поддерево). Затронутые строки удаляются и переинсертятся с новыми
/// концами; ручные пары ренормализуются (a<=b).
pub fn relink(conn: &Connection, old: &str, new: &str) -> Result<()> {
    let old = normalize(old);
    let new = normalize(new);
    let (old, new) = (old.as_str(), new.as_str());

    let (_, prefix, upper) = subtree_bounds(old);
    let affected: Vec<(String, String, String)> = {
        let mut stmt = conn.prepare(
            "SELECT src, dst, kind FROM file_edges
             WHERE src = ?1 OR (src >= ?2 AND src < ?3) OR dst = ?1 OR (dst >= ?2 AND dst < ?3)",
        )?;
        stmt.query_map((old, &prefix, &upper), |r| {
            Ok((r.get(0)?, r.get(1)?, r.get(2)?))
        })?
        .collect::<rusqlite::Result<_>>()?
    };
    if affected.is_empty() {
        return Ok(());
    }

    conn.execute_batch("BEGIN")?;
    let res: Result<()> = (|| {
        for (src, dst, kind) in &affected {
            conn.execute(
                "DELETE FROM file_edges WHERE src = ?1 AND dst = ?2 AND kind = ?3",
                (src, dst, kind),
            )?;
            let ns = remap(src, old, new).unwrap_or_else(|| src.clone());
            let nd = remap(dst, old, new).unwrap_or_else(|| dst.clone());
            if ns == nd {
                continue;
            }
            if kind == "manual" {
                let (x, y) = norm(&ns, &nd);
                conn.execute(
                    "INSERT OR IGNORE INTO file_edges (src, dst, kind) VALUES (?1, ?2, 'manual')",
                    (x, y),
                )?;
            } else {
                conn.execute(
                    "INSERT OR IGNORE INTO file_edges (src, dst, kind) VALUES (?1, ?2, ?3)",
                    (&ns, &nd, kind),
                )?;
            }
        }
        Ok(())
    })();
    match res {
        Ok(()) => {
            conn.execute_batch("COMMIT")?;
            Ok(())
        }
        Err(e) => {
            let _ = conn.execute_batch("ROLLBACK");
            Err(e)
        }
    }
}

/// Удалить все рёбра пути и поддерева (с любого конца) — при удалении в Корзину.
pub fn purge(conn: &Connection, path: &str) -> Result<()> {
    let path = normalize(path);
    let path = path.as_str();
    let (_, prefix, upper) = subtree_bounds(path);
    conn.execute(
        "DELETE FROM file_edges
         WHERE src = ?1 OR (src >= ?2 AND src < ?3) OR dst = ?1 OR (dst >= ?2 AND dst < ?3)",
        (path, &prefix, &upper),
    )?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn mem() -> Connection {
        let c = Connection::open_in_memory().unwrap();
        c.execute_batch(
            "CREATE TABLE file_edges (src TEXT NOT NULL, dst TEXT NOT NULL, kind TEXT NOT NULL, PRIMARY KEY (src, dst, kind));",
        )
        .unwrap();
        c
    }

    fn ins(c: &Connection, s: &str, d: &str, k: &str) {
        c.execute(
            "INSERT OR IGNORE INTO file_edges (src, dst, kind) VALUES (?1, ?2, ?3)",
            (s, d, k),
        )
        .unwrap();
    }

    #[test]
    fn neighborhood_finds_out_and_back_edges() {
        let c = mem();
        ins(&c, "a.md", "b.md", "link"); // a зависит от b
        ins(&c, "c.md", "b.md", "link"); // c тоже ссылается на b
        ins(&c, "x.md", "y.md", "link"); // несвязанная пара
        // окрестность b: исходящих нет, входящие = обратные ссылки (a, c)
        let e = neighborhood(&c, &["b.md".into()], 1).unwrap();
        let mut got: Vec<(String, String)> =
            e.iter().map(|x| (x.src.clone(), x.dst.clone())).collect();
        got.sort();
        assert_eq!(
            got,
            vec![
                ("a.md".to_string(), "b.md".to_string()),
                ("c.md".to_string(), "b.md".to_string()),
            ]
        );
    }

    #[test]
    fn replace_derived_keeps_manual() {
        let c = mem();
        ins(&c, "a", "b", "manual");
        ins(&c, "a", "old", "link");
        replace_derived_for_src(&c, "a", &[("new".to_string(), "link".to_string())]).unwrap();
        let e = neighborhood(&c, &["a".into()], 1).unwrap();
        let mut pairs: Vec<(String, String)> =
            e.iter().map(|x| (x.dst.clone(), x.kind.clone())).collect();
        pairs.sort();
        assert_eq!(
            pairs,
            vec![
                ("b".to_string(), "manual".to_string()),
                ("new".to_string(), "link".to_string()),
            ]
        );
    }

    #[test]
    fn purge_removes_from_either_end() {
        let c = mem();
        ins(&c, "dir\\a", "other", "link");
        ins(&c, "other2", "dir\\b", "link");
        ins(&c, "keep1", "keep2", "link");
        purge(&c, "dir").unwrap();
        let mut all: Vec<(String, String)> = {
            let mut s = c
                .prepare("SELECT src, dst FROM file_edges ORDER BY src")
                .unwrap();
            s.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))
                .unwrap()
                .map(|r| r.unwrap())
                .collect()
        };
        all.sort();
        assert_eq!(all, vec![("keep1".to_string(), "keep2".to_string())]);
    }
}
