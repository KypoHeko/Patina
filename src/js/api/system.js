import { invoke } from './invoke.js';

export function openPath(path) {
  return invoke('open_path', { path });
}

export function revealInExplorer(path) {
  return invoke('reveal_in_explorer', { path });
}

/** Quick access: home/desktop/documents/downloads. */
export function quickAccess() {
  return invoke('quick_access');
}

/** List of available drives. */
export function listDrives() {
  return invoke('list_drives');
}

/** List of storage volumes: mount point, type, used/total. */
export function listStorage() {
  return invoke('list_storage');
}

/** Watch a list of folders (natively). Changes arrive via the fs:external-change event. */
export function setWatch(paths) {
  return invoke('set_watch', { paths });
}

/** Save the user's quick-access list (full replacement). */
export function quickAccessSave(items) {
  return invoke('quick_access_save', { items });
}

/**
 * Get a native file/folder icon (WinAPI SHGetFileInfo).
 * Returns { dataUrl, width, height } or null on non-Windows.
 * Icons are cached on disk, so repeat calls are instant.
 */
export function nativeIcon(path, size = 16) {
  return invoke('native_icon', { path, size });
}