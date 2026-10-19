// RelationshipGraph — data acquisition: directory scan, .gitignore predicate,
// and the dependency-edge overlay. Mixed into RelationshipGraph.prototype.

import { fileGraph } from '../../api/relationships.js';
import { rebuildEdges } from '../../api/indexing.js';
import { ensureLiveIndex } from '../../state/index-live.js';
import { listDir, readGitignore } from '../../api/fs.js';
import { radialLayout } from '../../lib/radial-layout.js';
import { buildDirTree } from '../../lib/dir-tree.js';
import { gitignoreMatcher } from '../../lib/gitignore.js';
import { MAX_DEPTH, MAX_NODES, ALWAYS_IGNORE_DIRS, DEP_SEED_CAP } from './constants.js';

export const DataMixin = {
  async scan({ force = false } = {}) {
    const seq = ++this._scanSeq;
    this.setLoading(true);
    try {
      const ignore = this._useGitignore ? await this.loadIgnore(this._root) : null;
      if (seq !== this._scanSeq || !this._open) return;
      let res;
      try {
        res = await buildDirTree(listDir, this._root, { maxDepth: MAX_DEPTH, maxNodes: MAX_NODES, ignore });
      } catch {
        res = null;
      }
      if (seq !== this._scanSeq || !this._open) return; // stale or closed

      if (!res) {
        this._nodes = [];
        this._byPath = new Map();
        this._edges = [];
        this.draw();
        return;
      }

      this._counts = { files: res.files, folders: res.folders, depth: res.depth, truncated: res.truncated };
      this._nodes = radialLayout(res.root, { maxDepth: MAX_DEPTH, weighted: true });
      this._byPath = new Map();
      for (const n of this._nodes) {
        this._byPath.set(n.path, n);
        n.x = 0; n.y = 0; n.vx = 0; n.vy = 0; // start at center → unfold outward
      }
      this.layout();
      this.updateLimits();
      this.startSim();

      this.fetchDeps(seq, { force }); // dependency overlay, best-effort
    } finally {
      // Always clear the spinner for the current scan — even on early return,
      // a thrown error, or a failed .gitignore read. Stale scans leave it alone.
      if (seq === this._scanSeq) this.setLoading(false);
    }
  },

  /** Read the focus folder's .gitignore (over IPC) and return an
   *  ignore(relPath, isDir) predicate. The VCS `.git` dir is always hidden when
   *  the toggle is on; .gitignore rules apply on top if the file exists. */
  async loadIgnore(root) {
    if (!root) return null;
    let match = null;
    let timer;
    try {
      // Never let a slow (network) folder block the scan.
      const timeout = new Promise((resolve) => (timer = setTimeout(() => resolve(null), 2500)));
      const text = await Promise.race([readGitignore(root), timeout]);
      if (text && text.trim()) match = gitignoreMatcher(text);
    } catch {
      /* no readable .gitignore — baseline ignores below still apply */
    } finally {
      clearTimeout(timer);
    }
    return (rel, isDir) => {
      const name = rel.slice(rel.lastIndexOf('/') + 1);
      // Baseline: always prune heavy build/VCS/dependency dirs so a huge tree
      // (e.g. Rust `target/`) never stalls the scan, even if .gitignore can't
      // be read. Toggle the button off to see everything.
      if (isDir && ALWAYS_IGNORE_DIRS.has(name)) return true;
      return match ? match(rel, isDir) : false;
    };
  },

  /** Dependency overlay. Opening the graph (and every toggle / re-root) used to
   *  run `rebuild_edges` — a full re-read of every text file of the tree. Now
   *  the root's live index (kept fresh by its watcher) is requested once and
   *  the stored edges are read right away; when the index reports ready or
   *  changed, the overlay is re-read (see init). An explicit "Rebuild" still
   *  forces a full rebuild (`force`). */
  async fetchDeps(seq, { force = false } = {}) {
    const files = this._nodes.filter((n) => !n.dir && n._depth > 0).map((n) => n.path);
    if (!files.length) return;
    let data;
    try {
      if (force) await rebuildEdges(this._root);
      else ensureLiveIndex(this._root, true);
      data = await fileGraph(files.slice(0, DEP_SEED_CAP), 1);
    } catch (err) {
      console.error('[patina:graph] fetchDeps error:', err);
      return;
    }
    if (seq !== this._scanSeq || !this._open) return;
    const edges = [];
    for (const e of (data && data.edges) || []) {
      const a = this._byPath.get(e.src);
      const b = this._byPath.get(e.dst);
      if (a && b && a !== b) edges.push([a, b]);
    }
    this._edges = edges;
    this.draw();
  },
};
