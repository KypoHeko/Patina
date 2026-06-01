import { invoke } from './invoke.js';

export function addRelationship(a, b) {
  return invoke('add_relationship', { a, b });
}
export function removeRelationship(a, b) {
  return invoke('remove_relationship', { a, b });
}
export function relationshipsFor(paths) {
  return invoke('relationships_for', { paths });
}
