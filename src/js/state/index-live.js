// The backend keeps ONE live (watched, incrementally updated) index root.
// Every component that needs the index of a root — the palette, the graph —
// goes through here, so this mirror of the backend's live root stays true:
// with a private copy per component, the graph could move the live root away
// while the palette still believed its root was live.

import { startIndex } from '../api/indexing.js';

let liveRoot = null;
let contentEver = false; // the backend's content index, once on, stays on

/** Make `root` the live index root (with the content index if asked).
 *  Repeated calls for the live root are free; a root switch or the first
 *  content request reaches the backend, which replays the journal or rebuilds. */
export function ensureLiveIndex(root, content = false) {
  if (!root || root.startsWith('tag:')) return Promise.resolve();
  if (root === liveRoot && (!content || contentEver)) return Promise.resolve();
  liveRoot = root;
  if (content) contentEver = true;
  return startIndex(root, content).catch(() => {});
}

/** Force a full rebuild of `root` (the palette's ↻ button). */
export function forceLiveIndex(root, content = false) {
  liveRoot = root;
  if (content) contentEver = true;
  return startIndex(root, content, true).catch(() => {});
}

export function liveIndexRoot() {
  return liveRoot;
}

/** Test hook. */
export function resetLiveIndex() {
  liveRoot = null;
  contentEver = false;
}
