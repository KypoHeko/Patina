import { Component } from '../core/component.js';
import { getPane } from '../state/panes.js';
import { getActiveSide } from '../state/tabs.js';
import { startIndex } from '../api/indexing.js';
import { onEvent } from '../api/events.js';

import { TreeSearchMixin } from './command-palette/tree-search.js';
import { ContentSearchMixin } from './command-palette/content-search.js';
import { ResultsMixin } from './command-palette/results.js';
import { RenderMixin } from './command-palette/render.js';

// Search palette: name (or regex) + tags, with a scope selector — the current
// folder, the whole subtree, or full-text content (cross-folder search via the
// backend). Construction, lifecycle, scope switching and index orchestration
// live here; behaviour is split across mixins:
//   tree-search    — subtree name search over the file index
//   content-search — full-text search + index-ready coordination
//   results        — filtering, tag dots/filter, result plumbing
//   render         — building the palette DOM and result rows
export class CommandPalette extends Component {
  init() {
    this._open = false;
    this._side = 'left';
    this._root = '';
    this._scope = 'folder';
    this._loading = false;
    this._entries = [];
    this._folderEntries = [];
    this._tags = {}; // path -> [tagId] (dots, lazily)
    this._tagFilter = null; // Set<path> | null — filter by active tags
    this._activeTags = new Set();
    this._regex = false;
    this._query = '';
    this._sel = 0;
    this._results = [];
    this._resultsCount = 0;
    this._dotSeq = 0;
    this._tagSeq = 0;
    this._scanSeq = 0;
    this._indexing = false;
    this._indexedRoots = new Set();
    this._treeBase = null;
    this._treeTimer = null;
    this._contentIndexed = new Set();
    this._contentReady = new Set();
    this._contentTimer = null;
    this._idxTimer = null;
    this._lastSig = '';

    this.listen('palette:open', () => (this._open ? this.close() : this.open()));
    // Index freshness is now maintained by the backend (recursive watcher); on an
    // event we just re-run the current query.
    onEvent('index:ready', (root) => this.onIndexReady(root));
    onEvent('index:changed', () => this.onIndexEvent());
    this.on(document, 'keydown', (e) => {
      if (this._open) this.onKey(e);
    });
  }

  open() {
    const state = this.store.getState();
    this._side = getActiveSide(state);
    const pane = getPane(state, this._side);
    this._root = pane.path || '';
    this._folderEntries = pane.entries || [];
    this._scope = 'folder';
    this._entries = this._folderEntries;
    this._tags = {};
    this._tagFilter = null;
    this._activeTags = new Set();
    this._regex = false;
    this._query = '';
    this._sel = 0;
    this._loading = false;
    this._open = true;
    this.render();
    this._input.focus();
  }

  close() {
    if (!this._open) return;
    this._open = false;
    clearTimeout(this._treeTimer);
    clearTimeout(this._contentTimer);
    clearTimeout(this._idxTimer);
    this.mount.innerHTML = '';
  }

  get treeAllowed() {
    return !!this._root && !this._root.startsWith('tag:');
  }

  setScope(scope) {
    if (scope === this._scope) return;
    if (scope === 'tree' && !this.treeAllowed) return;
    this._scope = scope;
    this._sel = 0;
    this._syncScopeUI();

    if (scope === 'folder') {
      this._loading = false;
      this._entries = this._folderEntries;
      this.update();
      return;
    }

    if (scope === 'content') {
      this.runContentQuery();
      return;
    }

    // subtree — from the persistent index; the query goes to the server on input
    this._treeBase = null;
    this.runTreeQuery();
  }

  forceReindex() {
    const root = this._root;
    if (this._scope === 'content') {
      startIndex(root, true, true).catch(() => {});
      this._contentIndexed.add(root);
      this._contentReady.delete(root);
      this.runContentQuery();
      return;
    }
    if (this._scope !== 'tree') return;
    this._treeBase = null;
    startIndex(root, false, true).catch(() => {});
    this._indexedRoots.add(root);
    this.runTreeQuery();
  }

  onKey(e) {
    if (e.key === 'Escape') {
      e.preventDefault();
      this.close();
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      this._sel = Math.min(this._sel + 1, (this._results?.length || 1) - 1);
      this.renderResults();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      this._sel = Math.max(this._sel - 1, 0);
      this.renderResults();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const entry = this._results?.[this._sel];
      if (entry) this.activate(entry);
    }
  }

  // Reset the name/content index caches for roots affected by external changes.
  onIndexEvent() {
    if (!this._open) return;
    if (this._scope !== 'tree' && this._scope !== 'content') return;
    clearTimeout(this._idxTimer);
    this._idxTimer = setTimeout(() => {
      if (this._scope === 'tree') {
        this._treeBase = null;
        this.runTreeQuery(true);
      } else if (this._scope === 'content') {
        this.runContentQuery(true);
      }
    }, 200);
  }

  activate(entry) {
    if (!entry) return;
    this.bus.emit('file:activate', { side: this._side, entry });
    this.close();
  }
}

// Assemble behaviour onto the prototype. Method names and `this` semantics are
// identical to the previous single-file class, so callers and tests are unaffected.
Object.assign(
  CommandPalette.prototype,
  TreeSearchMixin,
  ContentSearchMixin,
  ResultsMixin,
  RenderMixin,
);
