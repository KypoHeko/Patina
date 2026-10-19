import { invoke } from './invoke.js';

/** Duplicate groups in the SUBTREE of `dir` (VCS/build folders skipped,
 *  capped at 20 000 files). Each group lists the most likely original first
 *  (oldest, shortest path). During hashing the backend emits 'dups:progress'. */
export function findDuplicates(dir) {
  return invoke('find_duplicates', { dir });
}

/** Stop a running duplicate scan. */
export function cancelDuplicates() {
  return invoke('cancel_duplicates');
}
