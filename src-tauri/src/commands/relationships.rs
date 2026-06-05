//! Команды связей между файлами: ручные связи + построение графа
//! (зависимости/обратные ссылки) вокруг выбранных файлов.

use std::collections::BTreeSet;

use rusqlite::{Connection, OptionalExtension};
use serde::Serialize;
use tauri::State;

use crate::error::Result;
use crate::index::edges_repo::{self, Edge};
use crate::state::AppState;

#[tauri::command]
pub fn add_relationship(state: State<AppState>, a: String, b: String) -> Result<()> {
    let conn = state.db()?;
    edges_repo::add_manual(&conn, &a, &b)
}

#[tauri::command]
pub fn remove_relationship(state: State<AppState>, a: String, b: String) -> Result<()> {
    let conn = state.db()?;
    edges_repo::remove_manual(&conn, &a, &b)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GraphNode {
    path: String,
    name: String,
    is_dir: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GraphData {
    nodes: Vec<GraphNode>,
    edges: Vec<Edge>,
}

/// Имя и тип узла: из file_index, иначе из basename (тип — «файл»).
fn node_meta(conn: &Connection, path: &str) -> (String, bool) {
    let row = conn
        .query_row(
            "SELECT name, is_dir FROM file_index WHERE path = ?1",
            [path],
            |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)? != 0)),
        )
        .optional()
        .ok()
        .flatten();
    match row {
        Some((name, is_dir)) => (name, is_dir),
        None => {
            let name = path
                .rsplit(|c| c == '\\' || c == '/')
                .next()
                .unwrap_or(path)
                .to_string();
            (name, false)
        }
    }
}

/// Граф вокруг seed-путей: рёбра в пределах `hops` прыжков (исходящие —
/// зависимости, входящие — обратные ссылки) + узлы (seed и все концы рёбер).
#[tauri::command]
pub fn file_graph(state: State<AppState>, seeds: Vec<String>, hops: usize) -> Result<GraphData> {
    let conn = state.db()?;
    let edges = edges_repo::neighborhood(&conn, &seeds, hops)?;

    let mut paths: BTreeSet<String> = seeds.into_iter().collect();
    for e in &edges {
        paths.insert(e.src.clone());
        paths.insert(e.dst.clone());
    }
    let nodes = paths
        .into_iter()
        .map(|p| {
            let (name, is_dir) = node_meta(&conn, &p);
            GraphNode { path: p, name, is_dir }
        })
        .collect();

    Ok(GraphData { nodes, edges })
}
