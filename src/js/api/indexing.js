import { invoke } from './invoke.js';

/** Start/update the live index of a root: background build + recursive
 *  watching with incremental updates. Idempotent.
 *  content=true — also maintain the content index; force=true — rebuild. */
export function startIndex(root, content = false, force = false) {
  return invoke('start_index', { root, content, force });
}

/** Rebuild only the derived edges (links/imports/mentions) for a subtree,
 *  reading existing content and file_index rows from the DB instead of
 *  re-walking the filesystem. Returns when the edges are up to date. */
export function rebuildEdges(root) {
  return invoke('rebuild_edges', { root });
}
