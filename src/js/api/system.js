import { invoke } from './invoke.js';

export function openPath(path) {
  return invoke('open_path', { path });
}

export function revealInExplorer(path) {
  return invoke('reveal_in_explorer', { path });
}

/** Быстрый доступ: домашняя/рабочий стол/документы/загрузки. */
export function quickAccess() {
  return invoke('quick_access');
}

/** Список доступных дисков. */
export function listDrives() {
  return invoke('list_drives');
}

/** Список хранилищ: точка монтирования, тип, занято/всего. */
export function listStorage() {
  return invoke('list_storage');
}

/** Следить за списком папок (нативно). Изменения придут событием fs:external-change. */
export function setWatch(paths) {
  return invoke('set_watch', { paths });
}

/** Сохранить пользовательский список быстрого доступа (полная замена). */
export function quickAccessSave(items) {
  return invoke('quick_access_save', { items });
}