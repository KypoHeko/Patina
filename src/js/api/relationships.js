import { invoke } from './invoke.js';

// Ручная (неориентированная) связь между двумя файлами. Хранится с kind='manual'
// и не перетирается переиндексацией.
export function addRelationship(a, b) {
  return invoke('add_relationship', { a, b });
}
export function removeRelationship(a, b) {
  return invoke('remove_relationship', { a, b });
}

/** Граф вокруг seed-путей.
 *  Возвращает { nodes: [{ path, name, isDir }], edges: [{ src, dst, kind }] }.
 *  Исходящие рёбра (src=seed) — зависимости, входящие (dst=seed) — обратные
 *  ссылки. hops — глубина обхода (1 = только прямые соседи). */
export function fileGraph(seeds, hops = 1) {
  return invoke('file_graph', { seeds, hops });
}

/** Хеширование файлов графа (BLAKE3). Возвращает [{ path, hash, cached }].
 *  Кэширует результат в таблице files (инвалидируется по mtime). */
export function hashGraphFiles(paths) {
  return invoke('hash_graph_files', { paths });
}
