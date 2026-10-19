import { invoke } from './invoke.js';

export function snapshotVersion(path) {
  return invoke('snapshot_version', { path });
}
export function listVersions(path) {
  return invoke('list_versions', { path });
}
/** Id of the version equal to the file on disk, or null (unsaved changes). */
export function currentVersion(path) {
  return invoke('current_version', { path });
}
export function restoreVersion(id) {
  return invoke('restore_version', { id });
}
export function deleteVersion(id) {
  return invoke('delete_version', { id });
}
