import { invoke } from './invoke.js';

// A manual (undirected) link between two files. Stored with kind='manual'
// and not overwritten by reindexing.
export function addRelationship(a, b) {
  return invoke('add_relationship', { a, b });
}
export function removeRelationship(a, b) {
  return invoke('remove_relationship', { a, b });
}

/** Graph around the seed paths.
 *  Returns { nodes: [{ path, name, isDir }], edges: [{ src, dst, kind }] }.
 *  Outgoing edges (src=seed) are dependencies, incoming (dst=seed) are
 *  back-references. hops — traversal depth (1 = direct neighbors only). */
export function fileGraph(seeds, hops = 1) {
  return invoke('file_graph', { seeds, hops });
}

/** Hash the graph's files (BLAKE3). Returns [{ path, hash, cached }].
 *  Caches the result in the files table (invalidated by mtime). */
export function hashGraphFiles(paths) {
  return invoke('hash_graph_files', { paths });
}
