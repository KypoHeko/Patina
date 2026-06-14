import { invoke } from './invoke.js';

export function snapshotVersion(path) {
  return invoke('snapshot_version', { path });
}
export function listVersions(path) {
  return invoke('list_versions', { path });
}
export function restoreVersion(id) {
  return invoke('restore_version', { id });
}
export function deleteVersion(id) {
  return invoke('delete_version', { id });
}
