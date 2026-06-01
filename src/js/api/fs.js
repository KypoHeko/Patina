import { invoke } from './invoke.js';

export function listDir(path) {
  return invoke('list_dir', { path });
}
export function homeDir() {
  return invoke('home_dir');
}
export function copyEntries(sources, destDir, overwrite = false) {
  return invoke('copy_entries', { sources, destDir, overwrite });
}
export function moveEntries(sources, destDir, overwrite = false) {
  return invoke('move_entries', { sources, destDir, overwrite });
}
export function deleteEntries(paths) {
  return invoke('delete_entries', { paths });
}
export function renameEntry(path, newName) {
  return invoke('rename_entry', { path, newName });
}
export function checkConflicts(sources, destDir) {
  return invoke('check_conflicts', { sources, destDir });
}
export function readPreview(path) {
  return invoke('read_preview', { path });
}

/** Переиндексировать поддерево в персистентном индексе. Возвращает число записей. */
export function reindexTree(root) {
  return invoke('reindex_tree', { root });
}

/** Поиск по персистентному индексу: до limit записей поддерева. */
export function searchFiles(root, query, limit = 20000) {
  return invoke('search_files', { root, query, limit });
}
