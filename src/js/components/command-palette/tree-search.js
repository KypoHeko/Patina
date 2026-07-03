// CommandPalette — subtree ("tree") scope: cross-folder name search backed by
// the persistent file index. Mixed into CommandPalette.prototype.

import { searchFiles } from '../../api/fs.js';
import { startIndex } from '../../api/indexing.js';
import { t } from '../../lib/i18n.js';

const TREE_LIMIT = 20000; // ceiling for the subtree walk

export const TreeSearchMixin = {
  onTreeInput() {
    if (this._regex) {
      this.runTreeQuery(); // regex is filtered on the front end against the cached base
    } else {
      clearTimeout(this._treeTimer);
      this._treeTimer = setTimeout(() => this.runTreeQuery(), 150);
    }
  },

  ensureIndexed(root) {
    if (this._indexedRoots.has(root)) return Promise.resolve();
    this._indexedRoots.add(root);
    return startIndex(root, false).catch(() => {});
  },

  // Normal mode — server-side substring search (little data over IPC).
  // Regex — fetch the root's base set once and filter on the front end.
  runTreeQuery(silent = false) {
    const root = this._root;
    const q = this._query.trim();
    const seq = ++this._scanSeq;

    if (!q) {
      this.showHint(t('palette.hint.tree'));
      return;
    }

    if (!silent) this._lastSig = null; // null, so an empty result still re-renders (clears loading)

    if (this._regex && this._treeBase) {
      this.commitResults(this._treeBase, seq);
      return;
    }

    if (!silent) {
      this._loading = true;
      this.renderResults();
    }
    const fetchQuery = this._regex ? '' : q;
    this.ensureIndexed(root)
      .then(() => searchFiles(root, fetchQuery, TREE_LIMIT))
      .then((list) => {
        const arr = list || [];
        if (this._regex) this._treeBase = arr;
        this.commitResults(arr, seq);
      })
      .catch(() => {
        if (seq !== this._scanSeq || !this._open || silent) return;
        this._loading = false;
        this._entries = [];
        this._lastSig = this._resultsSig([]);
        this.update();
      });
  },
};
