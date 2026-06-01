import { invoke } from './invoke.js';

/** Группы дубликатов в каталоге (рекурсивно). */
export function findDuplicates(dir) {
  return invoke('find_duplicates', { dir });
}
