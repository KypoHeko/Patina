//! Live index: background build + recursive watching of the root +
//! incremental targeted updates (upsert/delete of specific paths from watcher
//! events) instead of a full rescan. Link edges (dependencies/back-references)
//! are also built here from file contents.

use std::collections::{HashMap, HashSet};
use std::path::Path;

use notify::{recommended_watcher, Event, RecursiveMode, Watcher};
use tauri::{AppHandle, Emitter, Manager, State};

use crate::error::{Error, Result};
use crate::index::file_index::{self, IndexRow};
use crate::index::{content_index, edges};
use crate::index::text_detect;
use crate::indexer::{build_row, links};
use crate::state::AppState;

const SCAN_LIMIT: usize = 50_000;
const MENTION_SCAN_CAP: usize = 100_000; // upper bound of the body for the mention scan

/// Explicit outgoing edges of a single file from its body (links/imports,
/// resolved to existing paths). The mention layer is NOT built here — it
/// requires a shared name map and is rebuilt on a full reindex.
///
/// `known_paths`: set of all normalized file paths in the subtree — used for
/// O(1) existence checks in `resolve()` instead of `fs::metadata` per candidate.
pub(crate) fn explicit_out_edges(
    src_path: &str,
    body: &str,
    known_paths: Option<&HashSet<String>>,
) -> Vec<(String, String)> {
    let ext = ext_lower(src_path);
    let kind = links::kind_for(&ext);
    let mut seen: HashSet<String> = HashSet::new();
    let mut out = Vec::new();
    for raw in links::extract_targets(&ext, body) {
        if let Some(dst) = links::resolve(src_path, &raw, known_paths)
            && dst != src_path
            && seen.insert(dst.clone())
        {
            out.push((dst, kind.to_string()));
        }
    }
    out
}

/// The full set of subtree edges: explicit links/imports + a mention layer by
/// unique file name (discovery). Built from the already-read bodies.
pub(crate) fn build_edges(
    app: &AppHandle,
    root: &str,
    content_rows: &[content_index::ContentRow],
    rows: &[IndexRow],
) -> Vec<(String, String, String)> {
    use aho_corasick::AhoCorasickBuilder;

    // Build an in-memory set of all normalized file paths in the subtree.
    let known_paths: HashSet<String> = rows.iter().map(|r| r.path.clone()).collect();

    // basename(lower) -> the unique path (None if the name is not unique).
    let mut by_name: HashMap<String, Option<String>> = HashMap::new();
    for r in rows {
        // Folders are not mention targets: "depending" on a folder via text is
        // meaningless, and its name (often a common word) breeds false edges.
        if r.is_dir {
            continue;
        }
        by_name
            .entry(r.name.to_lowercase())
            .and_modify(|v| *v = None)
            .or_insert_with(|| Some(r.path.clone()));
    }

    let mut out: Vec<(String, String, String)> = Vec::new();
    let mut seen: HashSet<(String, String)> = HashSet::new();

    // 1) Explicit links/imports.
    for cr in content_rows {
        for (dst, kind) in explicit_out_edges(&cr.path, &cr.body, Some(&known_paths)) {
            if seen.insert((cr.path.clone(), dst.clone())) {
                out.push((cr.path.clone(), dst, kind));
            }
        }
    }

    // 2) Mentions by unique name (the discovery layer). We take only names
    //    WITH AN EXTENSION (containing '.') and length ≥ 4: this filters out
    //    "bare" word-names (center, index, montserrat) that coincide with
    //    ordinary words in text (CSS: text-align: center) and breed false
    //    links. Names with an extension (utils.js, notes.md) stay.
    let unique: Vec<(String, String)> = by_name
        .into_iter()
        .filter_map(|(name, p)| p.map(|path| (name, path)))
        .filter(|(name, _)| name.len() >= 4 && name.contains('.'))
        .collect();

    if unique.is_empty() {
        return out;
    }

    // One Aho-Corasick automaton for all names: each body is scanned in a
    // single pass (O(body length + number of matches)) instead of iterating all
    // names over every body — this removes the former quadratic cost.
    let patterns: Vec<&str> = unique.iter().map(|(name, _)| name.as_str()).collect();
    let ac = match AhoCorasickBuilder::new()
        .ascii_case_insensitive(true)
        .build(&patterns) 
    {
        Ok(ac) => ac,
        Err(_) => return out,
    };

    let total = content_rows.len();
    for (i, cr) in content_rows.iter().enumerate() {
        let body = &cr.body;
        let slice = if body.len() > MENTION_SCAN_CAP {
            let mut end = MENTION_SCAN_CAP;
            while end > 0 && !body.is_char_boundary(end) {
                end -= 1;
            }
            &body[..end]
        } else {
            &body[..]
        };
        // Search the original-case slice directly — no to_lowercase() allocation.
        let hb = slice.as_bytes();
        // A match counts only as a SEPARATE token: the name must not be part of
        // a longer word/name. Otherwise "pt.js" is caught inside "scri[pt.js]"
        // — hence a false edge index.html -> pt.js.
        let nameish = |c: u8| c.is_ascii_alphanumeric() || c == b'.' || c == b'_' || c == b'-';
        let mut matched: HashSet<usize> = HashSet::new();
        for m in ac.find_iter(slice) {
            let (s, e) = (m.start(), m.end());
            let left_ok = s == 0 || !nameish(hb[s - 1]);
            let right_ok = e >= hb.len() || !nameish(hb[e]);
            if left_ok && right_ok {
                matched.insert(m.pattern().as_usize());
                if matched.len() == unique.len() {
                    break; // all names already found — no point scanning further
                }
            }
        }
        for idx in matched {
            let dst = &unique[idx].1;
            if dst.as_str() == cr.path {
                continue;
            }
            if seen.insert((cr.path.clone(), dst.clone())) {
                out.push((cr.path.clone(), dst.clone(), "mention".to_string()));
            }
        }

        // Live progress for the relations phase. Adaptive step + always a final
        // emit, otherwise for folders < 200 files the counter froze at 0/total.
        let step = (total / 20).clamp(1, 200);
        if (i + 1) % step == 0 || i + 1 == total {
            let _ = app.emit(
                "index:progress",
                serde_json::json!({ "root": root, "count": i + 1, "total": total, "phase": "relations" }),
            );
        }
    }

    out
}

/// Apply a change of a SINGLE path to the indexes. Best-effort: errors are
/// swallowed — this is background maintenance, and any drift is fixed by the
/// next full rebuild.
fn apply_change(app: &AppHandle, content_active: bool, path: &Path) {
    if text_detect::is_ignored_path(path) {
        return;
    }
    let state = app.state::<AppState>();
    let pstr = path.to_string_lossy().into_owned();
    if path.exists() {
        if let Some(row) = build_row(path) {
            let text_file = !row.is_dir && text_detect::is_text(path, row.size);
            if let Ok(conn) = state.db() {
                let _ = file_index::upsert_one(&conn, &row);
            }
            if content_active && text_file && let Ok(bytes) = std::fs::read(path) {
                let body = String::from_utf8_lossy(&bytes).into_owned();
                if let Ok(conn) = state.db() {
                    let _ = content_index::ensure_table(&conn);
                    let _ = content_index::upsert_one(&conn, &pstr, &body);
                    // Incrementally update only the explicit outgoing edges
                    // (the mention layer is rebuilt on a full reindex).
                    // No known_paths set available here — resolve() falls
                    // back to fs::metadata for each candidate.
                    let edges = explicit_out_edges(&pstr, &body, None);
                    let _ = edges::replace_derived_for_src(&conn, &pstr, &edges);
                }
            }
        }
    } else if let Ok(conn) = state.db() {
        let _ = file_index::delete_path(&conn, &pstr);
        let _ = edges::purge(&conn, &pstr);
        if content_active {
            let _ = content_index::delete_path(&conn, &pstr);
        }
    }
}

/// Full (re)build of the root index — runs in the background.
pub(crate) fn build_all(app: &AppHandle, root: &str, content: bool) -> Result<()> {
    let state = app.state::<AppState>();
    let mut rows: Vec<IndexRow> = Vec::new();
    let mut content_rows: Vec<content_index::ContentRow> = Vec::new();
    let mut since_emit = 0usize;
    for entry in walkdir::WalkDir::new(root)
        .min_depth(1)
        .into_iter()
        .filter_entry(|e| !text_detect::is_ignored_dir(e))
        .filter_map(|e| e.ok())
    {
        if rows.len() >= SCAN_LIMIT {
            break;
        }
        let path = entry.path();
        if let Some(row) = build_row(path) {
            if content
                && !row.is_dir
                && text_detect::is_text(path, row.size)
                && let Ok(bytes) = std::fs::read(path)
            {
                content_rows.push(content_index::ContentRow {
                    path: row.path.clone(),
                    body: String::from_utf8_lossy(&bytes).into_owned(),
                });
            }
            rows.push(row);
            // Live progress for the UI.
            since_emit += 1;
            if since_emit >= 200 {
                since_emit = 0;
                let _ = app.emit(
                    "index:progress",
                    serde_json::json!({ "root": root, "count": rows.len(), "phase": "scan" }),
                );
            }
        }
    }
    {
        let mut conn = state.db()?;
        file_index::replace_subtree(&mut conn, root, &rows)?;
    }
    if content {
        // Building edges can take noticeable time — a separate UI phase;
        // build_edges emits incremental progress internally.
        let _ = app.emit(
            "index:progress",
            serde_json::json!({ "root": root, "count": 0, "total": content_rows.len(), "phase": "relations" }),
        );
        // Content + link edges are built from the same read bodies.
        let edges = build_edges(app, root, &content_rows, &rows);
        let mut conn = state.db()?;
        content_index::ensure_table(&conn)?;
        content_index::replace_subtree(&mut conn, root, &content_rows)?;
        edges::replace_derived_subtree(&mut conn, root, &edges)?;
    }
    Ok(())
}

/// The index (re)build strategy when `start_index` is called for a root.
#[derive(Debug, PartialEq, Eq)]
enum IndexPlan {
    /// Full build: a new root, a force, or content requested for the first time.
    FullBuild,
    /// Same root and not a force — a rescan with content_active flag.
    Rescan,
}

/// The decision is extracted into a pure function for testability.
///
/// IMPORTANT: reopening the same root is ALWAYS a rescan, with no incremental
/// "fast path". USN Journal sync is disabled in 0.1. See indexer/usn_journal.rs.
fn plan_index(root_changed: bool, force: bool, need_content_build: bool) -> IndexPlan {
    if root_changed || force || need_content_build {
        IndexPlan::FullBuild
    } else {
        IndexPlan::Rescan
    }
}

/// Start/update the live index of a root: background build + a recursive
/// watcher that keeps the indexes fresh in a targeted way. Idempotent.
#[tauri::command]
pub async fn start_index(
    app: AppHandle,
    state: State<'_, AppState>,
    root: String,
    content: bool,
    force: bool,
) -> Result<()> {
    if root.is_empty() || root.starts_with("tag:") {
        return Ok(());
    }

    let (root_changed, need_content_build, content_active) = {
        let mut info = state.index_info()?;
        let was_content = info.content_active;
        if content {
            info.content_active = true;
        }
        let changed = info.root.as_deref() != Some(root.as_str());
        info.root = Some(root.clone());
        (changed, content && !was_content, info.content_active)
    };
    
    let app2 = app.clone();
    let root2 = root.clone();
    match plan_index(root_changed, force, need_content_build) {
        IndexPlan::FullBuild => {
            // build_all is a synchronous blocking walk + transactions: spawn_blocking
            // so we do not occupy an async-runtime worker for the whole index build.
            tauri::async_runtime::spawn_blocking(move || {
                let _ = build_all(&app2, &root2, content);
                let _ = app2.emit("index:ready", &root2);
            });
        }
        IndexPlan::Rescan => {
            // Same root, not a force: rebuild file_index AND content+edges when
            // the content index is active. Previously this was `content: false`,
            // which meant derived edges (links/mentions) were never refreshed on
            // a rescan — the graph showed stale or no relationships.
            tauri::async_runtime::spawn_blocking(move || {
                let _ = build_all(&app2, &root2, content_active);
                let _ = app2.emit("index:ready", &root2);
            });
        }
    }

    // (Re)start the recursive watcher on the root.
    if root_changed || force {
        let app3 = app.clone();
        let mut watcher =
            recommended_watcher(move |res: notify::Result<Event>| {
                if let Ok(ev) = res {
                    if ev.paths.is_empty() {
                        return;
                    }
                    let content_active = app3
                        .state::<AppState>()
                        .index_info
                        .lock()
                        .map(|i| i.content_active)
                        .unwrap_or(false);
                    for p in &ev.paths {
                        apply_change(&app3, content_active, p);
                    }
                    let _ = app3.emit("index:changed", ());
                }
            })
            .map_err(|e| Error::Operation(e.to_string()))?;
        watcher
            .watch(Path::new(&root), RecursiveMode::Recursive)
            .map_err(|e| Error::Operation(e.to_string()))?;
        *state.index_watcher()? = Some(watcher);
    }

    Ok(())
}

/// Rebuild derived edges (links/imports/mentions) for a subtree by walking the
/// filesystem with `is_ignored_dir` filtering. Always scans from disk.
#[tauri::command]
pub async fn rebuild_edges(app: AppHandle, root: String) -> Result<()> {
    if root.is_empty() || root.starts_with("tag:") {
        return Ok(());
    }
    tauri::async_runtime::spawn_blocking(move || {
            build_all(&app, &root, true)?;
        Ok(())
    })
    .await
    .map_err(|e| Error::Operation(format!("rebuild_edges interrupted: {e}")))?
}

fn ext_lower(path: &str) -> String {
    Path::new(path)
        .extension()
        .map(|e| e.to_string_lossy().to_ascii_lowercase())
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::{plan_index, IndexPlan};
    use crate::index::text_detect::sample_looks_textual;

    #[test]
    fn sample_looks_textual_separates_text_from_binary() {
        assert!(sample_looks_textual(b"0000000000")); // a .dat full of '0' digits
        assert!(sample_looks_textual(b"hello\nworld\t!"));
        assert!(!sample_looks_textual(b"\x00\x00\x00")); // NUL bytes -> binary
        assert!(!sample_looks_textual(&[])); // empty -> not text
        let mut binary = vec![b'A'; 100];
        for b in binary.iter_mut().take(40) {
            *b = 0x01; // 40% stray control bytes -> binary
        }
        assert!(!sample_looks_textual(&binary));
    }
    
    #[test]
    fn reopen_same_root_always_rescans() {
        assert_eq!(plan_index(false, false, false), IndexPlan::Rescan);
    }

    #[test]
    fn new_root_builds_fully() {
        assert_eq!(plan_index(true, false, false), IndexPlan::FullBuild);
    }

    #[test]
    fn force_builds_fully() {
        assert_eq!(plan_index(false, true, false), IndexPlan::FullBuild);
    }

    #[test]
    fn first_content_request_builds_fully() {
        assert_eq!(plan_index(false, false, true), IndexPlan::FullBuild);
    }
}