// Breadth-first directory scan for the radial graph.
//
// Builds a tree { name, path, dir, children } from the focus folder outward,
// one ring (depth level) at a time, stopping at the depth cap or once the node
// cap is reached. BFS means the cap is spent on the rings closest to the focus
// first — exactly what the ring view should show. Pure (the listDir function is
// injected) so it can be unit-tested without Tauri.

/** Last path segment, tolerant of both `/` and `\` separators. */
export function baseName(p) {
  if (!p) return '';
  const s = String(p).replace(/[\\/]+$/, '');
  const i = Math.max(s.lastIndexOf('\\'), s.lastIndexOf('/'));
  const name = i >= 0 ? s.slice(i + 1) : s;
  return name || s; // drive roots like "C:\" fall back to the whole string
}

function isDirEntry(e) {
  return e.kind === 'folder' || e.isDir === true || e.dir === true;
}

/**
 * @param {(path:string)=>Promise<Array>} listDir  returns FileEntry[]
 * @param {string} rootPath
 * @param {object} opts  { maxDepth = 10, maxNodes = 10000, ignore }
 *   ignore(relPath, isDir) → true to skip an entry (folders are then not
 *   descended into). relPath uses "/" separators, relative to rootPath.
 * @returns {Promise<{root, files, folders, nodes, depth, truncated, ignored, limits}>}
 */
/** How many listDir calls are in flight at once. */
const CONCURRENCY = 8;

export async function buildDirTree(listDir, rootPath, opts = {}) {
  const maxDepth = opts.maxDepth ?? 10;
  const maxNodes = opts.maxNodes ?? 10000;
  const ignore = typeof opts.ignore === 'function' ? opts.ignore : null;

  const root = { name: baseName(rootPath) || rootPath, path: rootPath, dir: true, children: [] };
  let nodes = 1; // counts the focus too
  let files = 0;
  let folders = 0;
  let depth = 0;
  let truncated = false;
  let ignored = 0;

  const list = (path) => Promise.resolve().then(() => listDir(path)).catch(() => []);

  // Level by level (BFS: the node cap is spent on the rings closest to the
  // focus). Within a level, folders are listed CONCURRENCY at a time — one
  // sequential IPC round trip per folder made a 10 000-node graph crawl — but
  // their results are applied in order, so the tree and the cap are exactly
  // what a sequential BFS gives.
  let level = [{ node: root, depth: 0, rel: '' }];
  while (level.length && !truncated) {
    const next = [];
    const expandable = level.filter((q) => q.depth < maxDepth); // deeper ones are kept, not expanded
    for (let i = 0; i < expandable.length && !truncated; i += CONCURRENCY) {
      const batch = expandable.slice(i, i + CONCURRENCY);
      const listings = await Promise.all(batch.map((q) => list(q.node.path)));
      for (let b = 0; b < batch.length && !truncated; b++) {
        const { node, depth: d, rel } = batch[b];
        for (const e of listings[b] || []) {
          if (nodes >= maxNodes) {
            truncated = true;
            break;
          }
          const dir = isDirEntry(e);
          const childRel = rel ? `${rel}/${e.name}` : e.name;
          if (ignore && ignore(childRel, dir)) {
            ignored++;
            continue; // skip ignored entries (and, for folders, their whole subtree)
          }
          const child = { name: e.name, path: e.path, dir, children: dir ? [] : undefined };
          node.children.push(child);
          nodes++;
          depth = Math.max(depth, d + 1);
          if (dir) {
            folders++;
            next.push({ node: child, depth: d + 1, rel: childRel });
          } else {
            files++;
          }
        }
        if (nodes >= maxNodes) truncated = true;
      }
    }
    level = next;
  }

  return { root, files, folders, nodes, depth, truncated, ignored, limits: { maxDepth, maxNodes } };
}
