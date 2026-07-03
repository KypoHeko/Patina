// CommandPalette — content scope: full-text search over the content index.
//
// Coordinating with the backend's asynchronous index build used to be done by
// blocking the search until the `index:ready` event arrived. That was fragile:
// if the event never came — an empty folder builds to a no-op, the event was
// missed because the listener attached a tick too late, or the build failed
// silently — the gating promise never resolved and the loading spinner spun
// forever (a 15s "timeout" only turned an infinite hang into a 15s one).
//
// Instead we now kick the build off and search IMMEDIATELY against whatever the
// index already holds. When `index:ready` later fires, onIndexReady() runs a
// silent re-search that refreshes the results. No event is ever on the critical
// path, so the spinner can always clear, and a missed/late event can no longer
// wedge the UI. Mixed into CommandPalette.prototype.

import { searchContent } from '../../api/content.js';
import { startIndex } from '../../api/indexing.js';
import { t } from '../../lib/i18n.js';

export const ContentSearchMixin = {
  onContentInput() {
    clearTimeout(this._contentTimer);
    this._contentTimer = setTimeout(() => this.runContentQuery(), 220);
  },

  // Kick off the content-index build for `root` (once) and resolve right away.
  // We deliberately do NOT wait for the `index:ready` event here: a search must
  // never hang on an event that may never arrive. The first query runs against
  // the current index state; onIndexReady() refreshes results when the build
  // completes.
  ensureContentIndexed(root) {
    // If we already know the content index is ready, skip.
    if (this._contentReady.has(root)) return Promise.resolve();
    if (!this._contentIndexed.has(root)) {
      this._contentIndexed.add(root);
      startIndex(root, true).catch(() => {});
    }
    return Promise.resolve();
  },

  // Called when the backend emits `index:ready`. Marks the root ready and runs
  // a silent re-search (via onIndexEvent) so results pick up the freshly built
  // index without flashing the spinner.
  onIndexReady(root) {
    if (root) this._contentReady.add(root);
    this.onIndexEvent();
  },

  // Full-text content search: the server already selected the matches,
  // the front end just shows the path and snippet.
  runContentQuery(silent = false) {
    const root = this._root;
    const q = this._query.trim();
    const seq = ++this._scanSeq;
    if (!q) {
      this.showHint(t('palette.hint.content'));
      return;
    }
    if (!silent) {
      // null (not '') so an empty result set — whose signature is '' — still
      // differs from _lastSig and re-renders, clearing the loading spinner.
      this._lastSig = null;
      this._loading = true;
      this.renderResults();
    }
    this.ensureContentIndexed(root)
          .then(() => searchContent(root, q, 200))
          .then((hits) => {
            this.commitResults((hits || []).map((h) => ({ ...h, kind: 'file' })), seq);
          })
          .catch(() => {
        // Stale scan, closed palette, or a silent re-run — leave the UI alone.
            if (seq !== this._scanSeq || !this._open || silent) return;
        // A real error on the active query: clear the spinner and show empty.
        this._loading = false;
        this._entries = [];
        this._lastSig = this._resultsSig([]);
        this.update();
      });
  },
};
