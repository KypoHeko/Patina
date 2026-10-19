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

/** How long one volume listing is shared between callers. */
const STORAGE_TTL_MS = 30_000;
let storageCache = null; // { at, promise }

/**
 * List of storage volumes: mount point, type, used/total.
 * The sidebar and the status bar both ask for it at startup; the backend
 * walk is slow (sysinfo, or WinAPI per volume), so one in-flight/recent
 * result is shared instead of enumerating the volumes twice. A failed call
 * is not cached. `{ fresh: true }` forces a new listing.
 */
export function listStorage({ fresh = false } = {}) {
  const now = Date.now();
  if (!fresh && storageCache && now - storageCache.at < STORAGE_TTL_MS) return storageCache.promise;
  const promise = invoke('list_storage');
  const entry = { at: now, promise };
  storageCache = entry;
  promise.catch(() => {
    if (storageCache === entry) storageCache = null;
  });
  return promise;
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