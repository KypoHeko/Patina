import { invoke } from './invoke.js';

/** Duplicate groups in the CURRENT folder (non-recursive, with a file-count
 *  cap). During hashing the backend emits the 'dups:progress' event. */
export function findDuplicates(dir) {
  return invoke('find_duplicates', { dir });
}
