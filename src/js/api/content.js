import { invoke } from './invoke.js';

/** Reindex the contents of a subtree's text files. Returns the number of files. */
export function reindexContent(root) {
  return invoke('reindex_content', { root });
}

/** Full-text content search: up to limit matches {path, name, snippet}. */
export function searchContent(root, query, limit = 200) {
  return invoke('search_content', { root, query, limit });
}
