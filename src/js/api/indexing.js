import { invoke } from './invoke.js';

/** Start/update the live index of a root: background build + recursive
 *  watching with incremental updates. Idempotent.
 *  content=true — also maintain the content index; force=true — rebuild. */
export function startIndex(root, content = false, force = false) {
  return invoke('start_index', { root, content, force });
}
