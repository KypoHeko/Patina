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

/** Search the persistent index: up to limit subtree rows. */
/** Contents of `<dir>/.gitignore`, or null when there is none. */
export function readGitignore(dir) {
  return invoke('read_gitignore', { dir });
}

export function searchFiles(root, query, limit = 20000) {
  return invoke('search_files', { root, query, limit });
}

/** Create a folder in parent; returns the path of the created folder. */
export function createFolder(parent, name) {
  return invoke('create_folder', { parent, name });
}