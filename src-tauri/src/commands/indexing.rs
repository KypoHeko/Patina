//! Живой индекс: фоновое построение + рекурсивное слежение за корнем +
//! инкрементальные точечные апдейты (upsert/delete по конкретным путям из
//! событий вотчера) вместо полного рескана. Здесь же строятся рёбра связей
//! (зависимости/обратные ссылки) из содержимого файлов.

use std::collections::{HashMap, HashSet};
use std::path::Path;

use notify::{recommended_watcher, Event, RecursiveMode, Watcher};
use tauri::{AppHandle, Emitter, Manager, State};

use crate::error::{Error, Result};
use crate::index::file_index::{self, IndexRow};
use crate::index::{content_index, edges_repo, usn_position_repo};
use crate::indexer::{build_row, links, usn_journal};
use crate::state::AppState;

const TEXT_EXTS: &[&str] = &[
    "txt", "md", "markdown", "rs", "js", "mjs", "ts", "jsx", "tsx", "json", "toml", "yaml", "yml",
    "ini", "cfg", "conf", "log", "csv", "tsv", "html", "htm", "css", "xml", "sh", "bat", "py", "go",
    "java", "c", "h", "cpp", "hpp", "sql", "kt", "swift", "rb", "php", "lua", "vue", "svelte",
];
const MAX_FILE: u64 = 1_048_576; // 1 МБ
const SCAN_LIMIT: usize = 50_000;
const MENTION_SCAN_CAP: usize = 200_000; // верхняя граница тела для скана упоминаний

/// Папки, которые НЕ индексируем и не сканируем: VCS, артефакты сборки, кэши.
/// Иначе индекс/граф забивается мусором (.git/**, target/**, node_modules/**),
/// а пересборка занимает секунды на пустом месте.
fn is_ignored_name(name: &str) -> bool {
    matches!(
        name,
        ".git" | ".svn" | ".hg" | "node_modules" | "target" | "dist" | "build"
            | ".next" | ".nuxt" | ".cache" | "__pycache__" | ".venv" | "venv"
            | ".idea" | ".vscode" | ".gradle" | ".tox"
    )
}

fn is_ignored_dir(e: &walkdir::DirEntry) -> bool {
    e.file_type().is_dir() && is_ignored_name(e.file_name().to_str().unwrap_or(""))
}

fn is_ignored_path(p: &Path) -> bool {
    p.components()
        .any(|c| is_ignored_name(c.as_os_str().to_str().unwrap_or("")))
}

fn is_text(path: &Path, len: u64) -> bool {
    if len == 0 || len > MAX_FILE {
        return false;
    }
    match path.extension().map(|e| e.to_string_lossy().to_ascii_lowercase()) {
        Some(ext) => TEXT_EXTS.contains(&ext.as_str()),
        None => false,
    }
}

fn ext_lower(path: &str) -> String {
    Path::new(path)
        .extension()
        .map(|e| e.to_string_lossy().to_ascii_lowercase())
        .unwrap_or_default()
}

/// Явные исходящие рёбра одного файла по его телу (ссылки/импорты, резолвятся в
/// существующие пути). Mention-слой здесь НЕ строится — он требует общей карты
/// имён и пересобирается при полной переиндексации.
fn explicit_out_edges(src_path: &str, body: &str) -> Vec<(String, String)> {
    let ext = ext_lower(src_path);
    let kind = links::kind_for(&ext);
    let mut seen: HashSet<String> = HashSet::new();
    let mut out = Vec::new();
    for raw in links::extract_targets(&ext, body) {
        if let Some(dst) = links::resolve(src_path, &raw) {
            if dst != src_path && seen.insert(dst.clone()) {
                out.push((dst, kind.to_string()));
            }
        }
    }
    out
}

/// Полный набор рёбер поддерева: явные ссылки/импорты + слой упоминаний по
/// уникальному имени файла (дискавери). Строится из уже прочитанных тел.
fn build_edges(
    app: &AppHandle,
    root: &str,
    content_rows: &[content_index::ContentRow],
    rows: &[IndexRow],
) -> Vec<(String, String, String)> {
    use aho_corasick::AhoCorasick;

    // basename(lower) -> уникальный путь (None, если имя неуникально).
    let mut by_name: HashMap<String, Option<String>> = HashMap::new();
    for r in rows {
        // Папки целями упоминаний не делаем: «зависеть» от папки по тексту
        // бессмысленно, а её имя (часто общее слово) плодит ложные рёбра.
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

    // 1) Явные ссылки/импорты.
    for cr in content_rows {
        for (dst, kind) in explicit_out_edges(&cr.path, &cr.body) {
            if seen.insert((cr.path.clone(), dst.clone())) {
                out.push((cr.path.clone(), dst, kind));
            }
        }
    }

    // 2) Упоминания по уникальному имени (слой дискавери). Берём только имена
    //    С РАСШИРЕНИЕМ (есть '.') и длиной ≥ 4: это отсекает «голые» слова-имена
    //    (center, index, montserrat), совпадающие с обычными словами в тексте
    //    (CSS: text-align: center) и плодящие ложные связи. Имена с расширением
    //    (utils.js, notes.md) остаются.
    let unique: Vec<(String, String)> = by_name
        .into_iter()
        .filter_map(|(name, p)| p.map(|path| (name, path)))
        .filter(|(name, _)| name.len() >= 4 && name.contains('.'))
        .collect();

    if unique.is_empty() {
        return out;
    }

    // Один Aho-Corasick-автомат на все имена: каждое тело сканируется за один
    // проход (O(длина тела + число совпадений)) вместо перебора всех имён по
    // каждому телу — это убирает прежнюю квадратичную стоимость.
    let patterns: Vec<&str> = unique.iter().map(|(name, _)| name.as_str()).collect();
    let ac = match AhoCorasick::new(&patterns) {
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
        let hay = slice.to_lowercase();
        let hb = hay.as_bytes();
        // Совпадение засчитываем только как ОТДЕЛЬНЫЙ токен: имя не должно быть
        // частью более длинного слова/имени. Иначе «pt.js» ловится внутри
        // «scri[pt.js]» — отсюда ложное ребро index.html → pt.js.
        let nameish = |c: u8| c.is_ascii_alphanumeric() || c == b'.' || c == b'_' || c == b'-';
        let mut matched: HashSet<usize> = HashSet::new();
        for m in ac.find_iter(hay.as_str()) {
            let (s, e) = (m.start(), m.end());
            let left_ok = s == 0 || !nameish(hb[s - 1]);
            let right_ok = e >= hb.len() || !nameish(hb[e]);
            if left_ok && right_ok {
                matched.insert(m.pattern().as_usize());
                if matched.len() == unique.len() {
                    break; // все имена уже найдены — дальше сканировать тело незачем
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

        // Живой прогресс фазы связей. Шаг адаптивный + всегда финальный эмит,
        // иначе для папок < 200 файлов счётчик замирал на 0/total.
        let step = (total / 20).max(1).min(200);
        if (i + 1) % step == 0 || i + 1 == total {
            let _ = app.emit(
                "index:progress",
                serde_json::json!({ "root": root, "count": i + 1, "total": total, "phase": "relations" }),
            );
        }
    }

    out
}

/// Применить изменение ОДНОГО пути к индексам. Best-effort: ошибки глотаются —
/// это фоновое сопровождение, рассинхрон выправит следующая полная пересборка.
fn apply_change(app: &AppHandle, content_active: bool, path: &Path) {
    if is_ignored_path(path) {
        return; // .git/target/node_modules и т.п. — не индексируем и не реагируем
    }
    let state = app.state::<AppState>();
    let pstr = path.to_string_lossy().into_owned();
    if path.exists() {
        if let Some(row) = build_row(path) {
            let text_file = !row.is_dir && is_text(path, row.size);
            if let Ok(conn) = state.db() {
                let _ = file_index::upsert_one(&conn, &row);
            }
            if content_active && text_file {
                if let Ok(bytes) = std::fs::read(path) {
                    let body = String::from_utf8_lossy(&bytes).into_owned();
                    if let Ok(conn) = state.db() {
                        let _ = content_index::ensure_table(&conn);
                        let _ = content_index::upsert_one(&conn, &pstr, &body);
                        // Инкрементально обновляем только явные исходящие рёбра
                        // (mention-слой пересоберётся при полной переиндексации).
                        let edges = explicit_out_edges(&pstr, &body);
                        let _ = edges_repo::replace_derived_for_src(&conn, &pstr, &edges);
                    }
                }
            }
        }
    } else if let Ok(conn) = state.db() {
        let _ = file_index::delete_path(&conn, &pstr);
        let _ = edges_repo::purge(&conn, &pstr);
        if content_active {
            let _ = content_index::delete_path(&conn, &pstr);
        }
    }
}

/// Полное (пере)построение индекса корня — выполняется в фоне.
/// После успешной сборки сохраняет текущую USN-позицию, чтобы при следующем
/// запуске инкрементальное обновление через USN Journal начиналось с нужной точки.
fn build_all(app: &AppHandle, root: &str, content: bool) -> Result<()> {
    let state = app.state::<AppState>();
    let _t0 = std::time::Instant::now(); // ВРЕМЕННО: диагностика времени фаз
    let mut rows: Vec<IndexRow> = Vec::new();
    let mut content_rows: Vec<content_index::ContentRow> = Vec::new();
    let mut since_emit = 0usize;
    for entry in walkdir::WalkDir::new(root)
        .min_depth(1)
        .into_iter()
        .filter_entry(|e| !is_ignored_dir(e))
        .filter_map(|e| e.ok())
    {
        if rows.len() >= SCAN_LIMIT {
            break;
        }
        let path = entry.path();
        if let Some(row) = build_row(path) {
            if content && !row.is_dir && is_text(path, row.size) {
                if let Ok(bytes) = std::fs::read(path) {
                    content_rows.push(content_index::ContentRow {
                        path: row.path.clone(),
                        body: String::from_utf8_lossy(&bytes).into_owned(),
                    });
                }
            }
            rows.push(row);
            // Живой прогресс для UI (граф показывает счётчик вместо «висящей» плашки).
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
    eprintln!("[index] walk+read: {} файлов ({} текстовых) за {:?}", rows.len(), content_rows.len(), _t0.elapsed());
    let _t1 = std::time::Instant::now();
    {
        let mut conn = state.db()?;
        file_index::replace_subtree(&mut conn, root, &rows)?;
        // После успешной записи индекса — сохранить USN-позицию для инкрементального
        // обновления при следующем запуске. Позиция 0 означает «со следующего记录»,
        // но мы записываем 1, чтобы sync_from_journal при следующем вызове начал
        // читать изменения, произошедшие ПОСЛЕ этого полного скана.
        let _ = usn_position_repo::set(&conn, root, 1);
    }
    eprintln!("[index] file_index write за {:?}", _t1.elapsed());
    if content {
        // Построение рёбер может быть заметным по времени — отдельная фаза в UI,
        // build_edges шлёт инкрементальный прогресс внутри.
        let _ = app.emit(
            "index:progress",
            serde_json::json!({ "root": root, "count": 0, "total": content_rows.len(), "phase": "relations" }),
        );
        // Содержимое + рёбра связей строятся из одних и тех же прочитанных тел.
        let _t2 = std::time::Instant::now();
        let edges = build_edges(app, root, &content_rows, &rows);
        eprintln!("[index] build_edges: {} рёбер за {:?}", edges.len(), _t2.elapsed());
        let _t3 = std::time::Instant::now();
        let mut conn = state.db()?;
        content_index::ensure_table(&conn)?;
        content_index::replace_subtree(&mut conn, root, &content_rows)?;
        edges_repo::replace_derived_subtree(&mut conn, root, &edges)?;
        eprintln!("[index] content+edges write за {:?}", _t3.elapsed());
    }
    eprintln!("[index] ИТОГО build_all за {:?}", _t0.elapsed());
    Ok(())
}

/// Запустить/обновить живой индекс корня: фоновое построение + рекурсивный
/// вотчер, который точечно поддерживает индексы свежими. Идемпотентно.
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

    // Обновить флаги; узнать, сменился ли корень и нужно ли впервые строить контент.
    let (root_changed, need_content_build) = {
        let mut info = state.index_info()?;
        let was_content = info.content_active;
        if content {
            info.content_active = true;
        }
        let changed = info.root.as_deref() != Some(root.as_str());
        info.root = Some(root.clone());
        (changed, content && !was_content)
    };

    // Строим в фоне только при реальной необходимости: новый корень, форс, либо
    // контент запросили впервые для этого корня. Иначе (повторное открытие графа
    // на том же корне) индекс уже построен и поддерживается вотчером — полный
    // ребилд не нужен, и граф открывается мгновенно, без «висящей» плашки.
    //
    // Исключение: если корень НЕ сменился и это НЕ форс, пробуем инкрементальное
    // обновление через USN Journal (только на NTFS). Если USN Journal доступна —
    // точечно обновляем изменённые записи и пропускаем полный перескан. Если нет —
    // fallback на полный build_all.
    if root_changed || force || need_content_build {
        let app2 = app.clone();
        let root2 = root.clone();
        // build_all — синхронный блокирующий обход + транзакции: spawn_blocking,
        // чтобы не занимать воркер async-рантайма на всё время сборки индекса.
        tauri::async_runtime::spawn_blocking(move || {
            let _ = build_all(&app2, &root2, content);
            let _ = app2.emit("index:ready", &root2);
        });
    } else {
        // Тот же корень, не форс — пробуем быстрый путь через USN Journal.
        let app2 = app.clone();
        let root2 = root.clone();
        tauri::async_runtime::spawn_blocking(move || {
            let state = app2.state::<AppState>();
            let usn_ok = match state.db() {
                Ok(conn) => {
                    let last = usn_position_repo::get(&conn, &root2).ok().flatten();
                    match last {
                        Some(last_usn) => {
                            match usn_journal::sync_from_journal(&root2, last_usn, &conn) {
                                Ok(result) if result.used_journal => {
                                    let new_usn = result.new_usn;
                                    let _ = usn_position_repo::set(&conn, &root2, new_usn);
                                    let _ = app2.emit("index:ready", &root2);
                                    true
                                }
                                _ => false, // USN Journal недоступна — fallback
                            }
                        }
                        None => false, // Нет сохранённой позиции — первый запуск
                    }
                }
                Err(_) => false,
            };

            if !usn_ok {
                // Fallback: полный перескан (но только file_index, без контента —
                // контент уже был построен ранее, need_content_build == false).
                let _ = build_all(&app2, &root2, false);
                let _ = app2.emit("index:ready", &root2);
            }
        });
    }

    // (Пере)запустить рекурсивный вотчер на корень.
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
