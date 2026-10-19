//! Live index: background build + recursive watching of the root +
//! incremental targeted updates (upsert/delete of specific paths from watcher
//! events) instead of a full rescan. Link edges (dependencies/back-references)
//! are also built here from file contents.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::Ordering;

use notify::{recommended_watcher, Event, RecursiveMode, Watcher};
use tauri::{AppHandle, Emitter, Manager, State};

use crate::error::{Error, Result};
use crate::index::file_index::{self, IndexRow};
use crate::index::path_bounds::is_within;
use crate::index::{content_index, edges, path_key, usn_position};
use crate::platform::{self, UsnRead};
use crate::index::text_detect;
use crate::indexer::{build_row, links};
use crate::state::AppState;

const SCAN_LIMIT: usize = 50_000;
const MENTION_SCAN_CAP: usize = 100_000; // upper bound of the body for the mention scan
/// Text files written to the content index per transaction during a build.
const CONTENT_BATCH: usize = 200;

/// Explicit outgoing edges of a single file from its body (links/imports,
/// resolved to existing paths). The mention layer is NOT built here — it
/// requires a shared name map and is rebuilt on a full reindex.
///
/// `known_paths`: all file paths of the scanned subtree — O(1) existence
/// checks inside the root instead of `fs::metadata` per candidate (targets
/// outside the root are still checked on disk).
pub(crate) fn explicit_out_edges(
    src_path: &str,
    body: &str,
    known_paths: Option<&links::KnownPaths>,
) -> Vec<(String, String)> {
    let ext = ext_lower(src_path);
    let kind = links::kind_for(&ext);
    let mut seen: HashSet<String> = HashSet::new();
    let mut out = Vec::new();
    for raw in links::extract_targets(src_path, &ext, body) {
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
/// unique file name (discovery).
///
/// Bodies are loaded ONE AT A TIME through `load` (from disk) and dropped
/// after use: the build no longer keeps the text of every file of the tree in
/// memory (up to 50 000 × 1 MB) just to compute edges.
pub(crate) fn build_edges<L, P>(
    root: &str,
    text_files: &[String],
    rows: &[IndexRow],
    load: L,
    progress: P,
) -> Vec<(String, String, String)>
where
    L: Fn(&str) -> Option<String>,
    P: Fn(usize, usize),
{
    use aho_corasick::AhoCorasickBuilder;

    // Build an in-memory set of all file paths in the subtree.
    let known_set: HashSet<String> = rows.iter().map(|r| r.path.clone()).collect();
    let known_paths = links::KnownPaths { paths: &known_set, root_key: path_key::normalize(root) };

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

    // Mentions by unique name (the discovery layer): only names WITH AN
    // EXTENSION and length ≥ 4 — bare word-names (center, index) coincide with
    // ordinary words and breed false links.
    let unique: Vec<(String, String)> = by_name
        .into_iter()
        .filter_map(|(name, p)| p.map(|path| (name, path)))
        .filter(|(name, _)| name.len() >= 4 && name.contains('.'))
        .collect();
    // One Aho-Corasick automaton for all names: each body is scanned in a
    // single pass (O(body length + number of matches)).
    let patterns: Vec<&str> = unique.iter().map(|(name, _)| name.as_str()).collect();
    let ac = if unique.is_empty() {
        None
    } else {
        AhoCorasickBuilder::new().ascii_case_insensitive(true).build(&patterns).ok()
    };

    let mut out: Vec<(String, String, String)> = Vec::new();
    let mut seen: HashSet<(String, String)> = HashSet::new();
    // A match counts only as a SEPARATE token: "pt.js" inside "scri[pt.js]"
    // must not produce an edge index.html -> pt.js.
    let nameish = |c: u8| c.is_ascii_alphanumeric() || c == b'.' || c == b'_' || c == b'-';

    let total = text_files.len();
    for (i, path) in text_files.iter().enumerate() {
        let Some(body) = load(path) else { continue };

        // 1) Explicit links/imports.
        for (dst, kind) in explicit_out_edges(path, &body, Some(&known_paths)) {
            if seen.insert((path.clone(), dst.clone())) {
                out.push((path.clone(), dst, kind));
            }
        }

        // 2) Mentions.
        if let Some(ac) = &ac {
            let mut end = body.len().min(MENTION_SCAN_CAP);
            while end > 0 && !body.is_char_boundary(end) {
                end -= 1;
            }
            let slice = &body[..end];
            let hb = slice.as_bytes();
            let mut matched: HashSet<usize> = HashSet::new();
            for m in ac.find_iter(slice) {
                let (s, e) = (m.start(), m.end());
                let left_ok = s == 0 || !nameish(hb[s - 1]);
                let right_ok = e >= hb.len() || !nameish(hb[e]);
                if left_ok && right_ok {
                    matched.insert(m.pattern().as_usize());
                    if matched.len() == unique.len() {
                        break; // all names already found
                    }
                }
            }
            for idx in matched {
                let dst = &unique[idx].1;
                if dst != path && seen.insert((path.clone(), dst.clone())) {
                    out.push((path.clone(), dst.clone(), "mention".to_string()));
                }
            }
        }

        // Live progress for the relations phase (always a final emit).
        let step = (total / 20).clamp(1, 200);
        if (i + 1) % step == 0 || i + 1 == total {
            progress(i + 1, total);
        }
    }

    out
}

/// Apply a change of a SINGLE path to the indexes. Best-effort: errors are
/// swallowed — this is background maintenance, and any drift is fixed by the
/// next full rebuild.
fn apply_change(app: &AppHandle, root: &Path, content_active: bool, path: &Path) {
    apply_one(app, root, content_active, path, true);
}

/// `expand_new_dir`: index the subtree of a folder the index did not know.
/// The subtree walk itself passes `false` — it already visits every level.
fn apply_one(app: &AppHandle, root: &Path, content_active: bool, path: &Path, expand_new_dir: bool) {
    if text_detect::is_ignored_below(path, root) {
        return;
    }
    let state = app.state::<AppState>();
    let pstr = path.to_string_lossy().into_owned();
    if path.exists() {
        if let Some(row) = build_row(path) {
            let text_file = !row.is_dir && text_detect::is_text(path, row.size);
            // A folder the index does not know yet (created, or renamed/moved
            // here) brings its whole subtree with it; without this a renamed
            // folder's children stayed under the old path only.
            let new_dir = expand_new_dir
                && row.is_dir
                && state
                    .db()
                    .ok()
                    .is_some_and(|conn| !file_index::contains(&conn, &row.path).unwrap_or(true));
            if let Ok(conn) = state.db() {
                let _ = file_index::upsert_one(&conn, &row);
            }
            if new_dir {
                for entry in walkdir::WalkDir::new(path)
                    .min_depth(1)
                    .into_iter()
                    .filter_entry(|e| !text_detect::is_ignored_dir(e))
                    .filter_map(|e| e.ok())
                    .take(SCAN_LIMIT)
                {
                    apply_one(app, root, content_active, entry.path(), false);
                }
            }
            if content_active && text_file && let Ok(bytes) = std::fs::read(path) {
                let body = String::from_utf8_lossy(&bytes).into_owned();
                if let Ok(conn) = state.db() {
                    let _ = content_index::ensure_table(&conn);
                    let stamp = (row.size as i64, row.mtime.map(|m| m as i64));
                    let _ = content_index::upsert_one(&conn, &pstr, &body, stamp);
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
        // Derived edges only: a manual link must survive the moment a move or
        // rename by Patina makes the old path vanish before `relink` runs.
        let _ = edges::purge_derived(&conn, &pstr);
        if content_active {
            let _ = content_index::delete_path(&conn, &pstr);
        }
    }
}

/// Full (re)build of the root index — runs in the background.
pub(crate) fn build_all(app: &AppHandle, root: &str, content: bool) -> Result<()> {
    build_all_gen(app, root, content, None)
}

/// `generation`: the live-index generation this build belongs to. When a newer
/// `start_index` bumps `AppState::index_gen`, this build stops before writing
/// anything (Err(Cancelled)). On-demand rebuilds pass `None` and always finish.
fn build_all_gen(app: &AppHandle, root: &str, content: bool, generation: Option<u64>) -> Result<()> {
    let state = app.state::<AppState>();
    let superseded = || generation.is_some_and(|g| state.index_gen.load(Ordering::SeqCst) != g);
    let cancelled = || Error::Operation("index build superseded by a newer one".into());
    // Journal position taken BEFORE the walk: everything that changes during
    // the walk is replayed on the next start, so nothing slips between them.
    let cursor = platform::query_usn_cursor(root);

    // 1) Walk: metadata only. Text files are just remembered — bodies are
    //    read later in bounded batches, never all at once.
    let mut rows: Vec<IndexRow> = Vec::new();
    let mut text_files: Vec<(String, u64, Option<u64>)> = Vec::new();
    let mut since_emit = 0usize;
    for entry in walkdir::WalkDir::new(root)
        .min_depth(1)
        .into_iter()
        .filter_entry(|e| !text_detect::is_ignored_dir(e))
        .filter_map(|e| e.ok())
    {
        if rows.len() >= SCAN_LIMIT {
            // Say so instead of silently indexing a part of the tree.
            let _ = app.emit("index:truncated", serde_json::json!({ "root": root, "limit": SCAN_LIMIT }));
            break;
        }
        if rows.len().is_multiple_of(1000) && superseded() {
            return Err(cancelled());
        }
        let path = entry.path();
        if let Some(row) = build_row(path) {
            if content && !row.is_dir && text_detect::is_text(path, row.size) {
                text_files.push((row.path.clone(), row.size, row.mtime));
            }
            rows.push(row);
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
    if superseded() {
        return Err(cancelled());
    }

    {
        let mut conn = state.db()?;
        file_index::replace_subtree(&mut conn, root, &rows)?;
    }

    if content {
        // 2) Content: re-read only new or changed text files (size/mtime differ
        //    from the previous index), in batches; drop rows of files that are
        //    gone or no longer text.
        let (indexed, previous) = {
            let conn = state.db()?;
            content_index::ensure_table(&conn)?;
            (content_index::keys_in_subtree(&conn, root)?, content_index::stamps_in_subtree(&conn, root)?)
        };
        let current: HashSet<String> = text_files.iter().map(|(p, _, _)| path_key::normalize(p)).collect();
        let stale: Vec<String> = indexed.difference(&current).cloned().collect();
        {
            let mut conn = state.db()?;
            content_index::delete_keys(&mut conn, &stale)?;
        }
        let mut batch: Vec<content_index::ContentRow> = Vec::with_capacity(CONTENT_BATCH);
        let total = text_files.len();
        for (i, (path, size, mtime)) in text_files.iter().enumerate() {
            let key = path_key::normalize(path);
            let stamp = (*size as i64, mtime.map(|m| m as i64));
            if indexed.contains(&key) && previous.get(&key) == Some(&stamp) {
                continue; // unchanged since the last build
            }
            if let Ok(bytes) = std::fs::read(path) {
                batch.push(content_index::ContentRow {
                    path: path.clone(),
                    body: String::from_utf8_lossy(&bytes).into_owned(),
                    stamp,
                });
            }
            if batch.len() >= CONTENT_BATCH || (i + 1 == total && !batch.is_empty()) {
                if superseded() {
                    return Err(cancelled());
                }
                let mut conn = state.db()?;
                content_index::upsert_many(&mut conn, &batch)?;
                batch.clear();
                let _ = app.emit(
                    "index:progress",
                    serde_json::json!({ "root": root, "count": i + 1, "total": total, "phase": "content" }),
                );
            }
        }
        if !batch.is_empty() {
            let mut conn = state.db()?;
            content_index::upsert_many(&mut conn, &batch)?;
        }

        // 3) Link edges, reading one body at a time.
        let _ = app.emit(
            "index:progress",
            serde_json::json!({ "root": root, "count": 0, "total": total, "phase": "relations" }),
        );
        let paths: Vec<String> = text_files.into_iter().map(|(p, _, _)| p).collect();
        let edges = build_edges(
            root,
            &paths,
            &rows,
            |p| std::fs::read(p).ok().map(|b| String::from_utf8_lossy(&b).into_owned()),
            |count, total| {
                let _ = app.emit(
                    "index:progress",
                    serde_json::json!({ "root": root, "count": count, "total": total, "phase": "relations" }),
                );
            },
        );
        if superseded() {
            return Err(cancelled());
        }
        let mut conn = state.db()?;
        edges::replace_derived_subtree(&mut conn, root, &edges)?;
    }
    {
        let conn = state.db()?;
        match cursor {
            Some(c) => usn_position::set(&conn, root, c)?,
            None => usn_position::remove(&conn, root)?,
        }
    }
    Ok(())
}

/// Bring the index of `root` up to date from the USN Journal: re-read only the
/// paths touched since the saved cursor. Returns false when the journal cannot
/// be used (no cursor, unavailable, recreated) — the caller does a full build.
fn sync_from_journal(app: &AppHandle, root: &str, content_active: bool) -> bool {
    let state = app.state::<AppState>();
    let saved = match state.db().and_then(|c| usn_position::get(&c, root)) {
        Ok(Some(c)) => c,
        _ => return false,
    };
    match platform::read_usn_journal(root, saved) {
        UsnRead::Changes { paths, cursor } => {
            let root_key = path_key::normalize(root);
            for p in paths.iter().filter(|p| is_within(&path_key::normalize(p), &root_key)) {
                apply_change(app, Path::new(root), content_active, Path::new(p));
            }
            if let Ok(conn) = state.db() {
                let _ = usn_position::set(&conn, root, cursor);
            }
            true
        }
        UsnRead::Reset | UsnRead::Unavailable => false,
    }
}

/// `index:ready` payload. `content` tells the palette whether the content
/// index of this root is now built — it used to treat ANY ready event (also
/// one of a name-only build) as "content ready".
fn ready_payload(root: &str, content: bool) -> serde_json::Value {
    serde_json::json!({ "root": root, "content": content })
}

/// The index (re)build strategy when `start_index` is called for a root.
#[derive(Debug, PartialEq, Eq)]
enum IndexPlan {
    /// Full walk: forced, content requested for the first time, or no saved
    /// journal position for this root.
    FullBuild,
    /// The root was indexed before (saved USN cursor): replay the journal,
    /// falling back to a full walk if it is unavailable.
    Incremental,
    /// The same root is already live in this session — its recursive watcher
    /// keeps it fresh, nothing to rebuild.
    UpToDate,
}

/// The decision is extracted into a pure function for testability.
fn plan_index(root_changed: bool, force: bool, need_content_build: bool, has_cursor: bool) -> IndexPlan {
    if force || need_content_build {
        IndexPlan::FullBuild
    } else if !root_changed {
        IndexPlan::UpToDate
    } else if has_cursor {
        IndexPlan::Incremental
    } else {
        IndexPlan::FullBuild
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
    
    let has_cursor = state
        .db()
        .and_then(|c| usn_position::get(&c, &root))
        .ok()
        .flatten()
        .is_some();
    let app2 = app.clone();
    let root2 = root.clone();
    let plan = plan_index(root_changed, force, need_content_build, has_cursor);
    // A new build supersedes any build still running for an older request.
    let generation = if plan == IndexPlan::UpToDate {
        state.index_gen.load(Ordering::SeqCst)
    } else {
        state.index_gen.fetch_add(1, Ordering::SeqCst) + 1
    };
    match plan {
        IndexPlan::FullBuild => {
            // build_all is a synchronous blocking walk + transactions: spawn_blocking
            // so we do not occupy an async-runtime worker for the whole index build.
            // `content_active`, not `content`: a forced rebuild of a root whose
            // content index is live must refresh the content index too.
            tauri::async_runtime::spawn_blocking(move || {
                if build_all_gen(&app2, &root2, content_active, Some(generation)).is_ok() {
                    let _ = app2.emit("index:ready", ready_payload(&root2, content_active));
                }
            });
        }
        IndexPlan::Incremental => {
            tauri::async_runtime::spawn_blocking(move || {
                let ok = sync_from_journal(&app2, &root2, content_active)
                    || build_all_gen(&app2, &root2, content_active, Some(generation)).is_ok();
                if ok {
                    let _ = app2.emit("index:ready", ready_payload(&root2, content_active));
                }
            });
        }
        IndexPlan::UpToDate => {
            let _ = app.emit("index:ready", ready_payload(&root, content_active));
        }
    }

    // (Re)start the recursive watcher on the root.
    if root_changed || force {
        // The notify callback only forwards paths; a worker thread batches
        // them (300 ms of quiet, at most 2 s), de-duplicates and applies them,
        // then emits ONE `index:changed`. Before, every single event touched
        // the DB on notify's thread and emitted its own event — copying 10 000
        // files flooded the UI with 10 000 re-queries. The worker ends when the
        // watcher (and with it the sender) is dropped.
        let (tx, rx) = std::sync::mpsc::channel::<PathBuf>();
        let app3 = app.clone();
        let root3 = PathBuf::from(&root);
        std::thread::spawn(move || watch_worker(app3, root3, rx));
        let mut watcher =
            recommended_watcher(move |res: notify::Result<Event>| {
                if let Ok(ev) = res {
                    for p in ev.paths {
                        let _ = tx.send(p);
                    }
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

/// Drain watcher events in batches (see `start_index`).
fn watch_worker(app: AppHandle, root: PathBuf, rx: std::sync::mpsc::Receiver<PathBuf>) {
    use std::sync::mpsc::RecvTimeoutError;
    use std::time::{Duration, Instant};
    const QUIET: Duration = Duration::from_millis(300);
    const MAX_BATCH: Duration = Duration::from_secs(2);
    while let Ok(first) = rx.recv() {
        let mut batch: HashSet<PathBuf> = HashSet::from([first]);
        let started = Instant::now();
        loop {
            match rx.recv_timeout(QUIET) {
                Ok(p) => {
                    batch.insert(p);
                    if started.elapsed() >= MAX_BATCH {
                        break;
                    }
                }
                Err(RecvTimeoutError::Timeout) => break,
                Err(RecvTimeoutError::Disconnected) => {
                    batch.clear(); // the watcher was replaced — drop the rest
                    break;
                }
            }
        }
        if batch.is_empty() {
            return;
        }
        let content_active = app
            .state::<AppState>()
            .index_info
            .lock()
            .map(|i| i.content_active)
            .unwrap_or(false);
        for p in &batch {
            apply_change(&app, &root, content_active, p);
        }
        let _ = app.emit("index:changed", ());
    }
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
    fn build_edges_streams_bodies_and_finds_imports_and_mentions() {
        use super::build_edges;
        use crate::index::file_index::IndexRow;
        let row = |p: &str| IndexRow {
            path: p.into(),
            name: p.rsplit('/').next().unwrap().into(),
            is_dir: false,
            size: 1,
            mtime: None,
            ext: None,
        };
        let rows = vec![row("/p/a.js"), row("/p/utils.js"), row("/p/notes.md")];
        let texts: Vec<String> = rows.iter().map(|r| r.path.clone()).collect();
        let loads = std::cell::Cell::new(0);
        let edges = build_edges(
            "/p",
            &texts,
            &rows,
            |p| {
                loads.set(loads.get() + 1);
                Some(match p {
                    "/p/a.js" => "import u from './utils.js'".to_string(),
                    "/p/notes.md" => "see utils.js for details".to_string(),
                    _ => String::new(),
                })
            },
            |_, _| {},
        );
        assert_eq!(loads.get(), 3, "each body is loaded exactly once");
        assert!(edges.contains(&("/p/a.js".into(), "/p/utils.js".into(), "import".into())));
        assert!(edges.contains(&("/p/notes.md".into(), "/p/utils.js".into(), "mention".into())));
    }

    #[test]
    fn same_live_root_needs_nothing() {
        assert_eq!(plan_index(false, false, false, true), IndexPlan::UpToDate);
        assert_eq!(plan_index(false, false, false, false), IndexPlan::UpToDate);
    }

    #[test]
    fn new_root_with_cursor_replays_journal() {
        assert_eq!(plan_index(true, false, false, true), IndexPlan::Incremental);
    }

    #[test]
    fn new_root_without_cursor_builds_fully() {
        assert_eq!(plan_index(true, false, false, false), IndexPlan::FullBuild);
    }

    #[test]
    fn force_or_first_content_request_builds_fully() {
        assert_eq!(plan_index(false, true, false, true), IndexPlan::FullBuild);
        assert_eq!(plan_index(false, false, true, true), IndexPlan::FullBuild);
    }
}
