import { invoke } from './invoke.js';

/**
 * Посчитать рекурсивные размеры всех папок поддерева `root` и сохранить в индекс.
 * Резолвится по завершении обхода. Прогресс шлётся событием `dirsize:progress`,
 * завершение — `dirsize:done`. Возвращает число обработанных каталогов.
 */
export function computeDirSizes(root) {
  return invoke('compute_dir_sizes', { root });
}

/** Готовые размеры для путей папок (для показа). Возвращает map: путь → размер. */
export function dirSizes(paths) {
  return invoke('dir_sizes', { paths });
}
