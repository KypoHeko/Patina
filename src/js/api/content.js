import { invoke } from './invoke.js';

/** Переиндексировать содержимое текстовых файлов поддерева. Возвращает число файлов. */
export function reindexContent(root) {
  return invoke('reindex_content', { root });
}

/** Полнотекстовый поиск по содержимому: до limit совпадений {path, name, snippet}. */
export function searchContent(root, query, limit = 200) {
  return invoke('search_content', { root, query, limit });
}
