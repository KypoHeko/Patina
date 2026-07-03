import { invoke } from './invoke.js';

/**
 * Compute recursive sizes of all folders under `root` and store them in the index.
 * Resolves when the walk completes. Progress is sent via the `dirsize:progress`
 * event, completion via `dirsize:done`. Returns the number of processed directories.
 */
export function computeDirSizes(root) {
  return invoke('compute_dir_sizes', { root });
}

/** Ready sizes for folder paths (for display). Returns a map: path → size. */
export function dirSizes(paths) {
  return invoke('dir_sizes', { paths });
}
