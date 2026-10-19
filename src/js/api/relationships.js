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
