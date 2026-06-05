import { invoke } from './invoke.js';

/** Группы дубликатов в ТЕКУЩЕЙ папке (без рекурсии, с ограничением по числу
 *  файлов). По ходу хеширования бэкенд шлёт событие 'dups:progress'. */
export function findDuplicates(dir) {
  return invoke('find_duplicates', { dir });
}
