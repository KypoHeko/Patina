import { invoke } from './invoke.js';

/** Start/update the live index of a root: background build + recursive
 *  watching with incremental updates. Idempotent.
 *  content=true — also maintain the content index; force=true — rebuild. */
export function startIndex(root, content = false, force = false) {
  return invoke('start_index', { root, content, force });
}

/** Rebuild the derived edges (links/imports/mentions) of a subtree. Walks
 *  the subtree on disk and re-reads its text files (it also refreshes the
 *  name and content index of that subtree). Resolves when it is done. */
export function rebuildEdges(root) {
  return invoke('rebuild_edges', { root });
}
