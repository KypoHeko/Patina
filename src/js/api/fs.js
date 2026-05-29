import { invoke } from './invoke.js';

/**
 * @typedef {Object} FileEntry
 * @property {string} name
 * @property {string} path
 * @property {'file'|'folder'} kind
 * @property {number} size
 * @property {number|null} modified  миллисекунды от epoch
 * @property {string|null} extension
 */

/**
 * Содержимое директории.
 * @param {string} path абсолютный путь
 * @returns {Promise<FileEntry[]>}
 */
export function listDir(path) {
  return invoke('list_dir', { path });
}

/**
 * Домашняя папка пользователя.
 * @returns {Promise<string>}
 */
export function homeDir() {
  return invoke('home_dir');
}
