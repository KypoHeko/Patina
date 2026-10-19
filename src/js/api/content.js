import { invoke } from './invoke.js';

/** Full-text content search: up to limit matches {path, name, snippet}. */
export function searchContent(root, query, limit = 200) {
  return invoke('search_content', { root, query, limit });
}
