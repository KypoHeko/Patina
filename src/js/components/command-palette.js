import { Component } from '../core/component.js';
import { el, escapeHtml } from '../core/dom.js';
import { tagsForPaths, pathsForTag } from '../api/tags.js';
import { searchFiles } from '../api/fs.js';
import { searchContent } from '../api/content.js';
import { startIndex } from '../api/indexing.js';
import { onEvent } from '../api/events.js';
import { TAGS } from '../config/tags.js';
import { fileIcon } from '../lib/icons.js';
import { getPane } from '../state/panes.js';
import { pathKey } from '../lib/paths.js';
import { getActiveSide } from '../state/tabs.js';
import { safeRegExp } from '../lib/regex.js';
import { t, tagLabel } from '../lib/i18n.js';

const TAG_COLOR = Object.fromEntries(TAGS.map((t) => [t.id, t.color]));
const DISPLAY_CAP = 300; // how many rows we show at once
const TREE_LIMIT = 20000; // ceiling for the subtree walk

// Search palette: name (or regex) + tags, with a scope selector —
// the current folder or the whole subtree (cross-folder search via the backend).
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

  onTreeInput() {
    if (this._regex) {
      this.runTreeQuery(); // regex is filtered on the front end against the cached base
    } else {
      clearTimeout(this._treeTimer);
      this._treeTimer = setTimeout(() => this.runTreeQuery(), 150);
    }
  }

  ensureIndexed(root) {
    if (this._indexedRoots.has(root)) return Promise.resolve();
    this._indexedRoots.add(root);
    return startIndex(root, false).catch(() => {});
  }

  showHint(text) {
    this._entries = [];
    this._results = [];
    this._resultsCount = 0;
    this._loading = false;
    this._lastSig = '';
    if (this._resultsEl)
      this._resultsEl.innerHTML = `<div class="palette__empty">${escapeHtml(text)}</div>`;
  }

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

  onContentInput() {
    clearTimeout(this._contentTimer);
    this._contentTimer = setTimeout(() => this.runContentQuery(), 220);
  }
  
    /// Ensure the content index is built and READY for the given root.
    /// Unlike the simple version, this waits for the backend `index:ready`
    /// event before resolving, so that the subsequent search actually finds
    /// results instead of running against an empty table.
    ensureContentIndexed(root) {
      // If we already know the content index is ready, skip.
      if (this._contentReady.has(root)) return Promise.resolve();
  
      // Mark as "requested" so we don't fire startIndex multiple times.
      const alreadyStarted = this._contentIndexed.has(root);
      this._contentIndexed.add(root);
  
      // Start the index build if we haven't yet.
      const buildPromise = alreadyStarted
        ? Promise.resolve()
        : startIndex(root, true).catch(() => {});
  
      // Wait for the build AND for the index:ready event.
      return buildPromise.then(() => this.waitForContentReady(root));
    }
  
    /// Returns a Promise that resolves when `index:ready` fires for the given
    /// root (or immediately if already marked ready). Has a 15-second timeout
    /// so the UI doesn't hang forever if the event never arrives.
    waitForContentReady(root) {
      if (this._contentReady.has(root)) return Promise.resolve();
  
      return new Promise((resolve) => {
        const timeout = setTimeout(() => {
          // Timed out — resolve anyway so the search can proceed (against
          // whatever is in the index right now). The index:ready handler
          // will trigger a re-search when it eventually arrives.
          console.warn('[patina:palette] waitForContentReady timed out for', root);
          resolve();
        }, 15000);
  
        // Store the resolver so onIndexReady can call it.
        if (!this._contentReadyResolvers) this._contentReadyResolvers = new Map();
        const existing = this._contentReadyResolvers.get(root);
        if (existing) {
          // Chain: resolve the previous waiter too.
          const prev = existing;
          this._contentReadyResolvers.set(root, () => { prev(); resolve(); clearTimeout(timeout); });
        } else {
          this._contentReadyResolvers.set(root, () => { resolve(); clearTimeout(timeout); });
        }
      });
    }
  
    /// Called when the backend emits `index:ready`. Resolves any pending
    /// waitForContentReady promises and triggers a re-search if the palette
    /// is open in content scope.
    onIndexReady(root) {
      if (root) this._contentReady.add(root);
  
      // Resolve any waiting promises.
      if (this._contentReadyResolvers) {
        const resolve = this._contentReadyResolvers.get(root);
        if (resolve) {
          this._contentReadyResolvers.delete(root);
          resolve();
        }
      }
  
      // Re-run query if palette is open in content/tree scope.
      this.onIndexEvent();
    }

  // Signature of the result set: paths + snippets. If unchanged, we skip the
  // re-render (removes flicker on index events).
  _resultsSig(list) {
    let out = '';
    for (const e of list) out += `${e.path}\u0000${e.snippet || ''}\u0001`;
    return out;
  }

  // Commit query results, accounting for staleness and without extra re-renders.
  commitResults(entries, seq) {
    if (seq !== this._scanSeq || !this._open) return;
    this._loading = false;
    const sig = this._resultsSig(entries);
    this._entries = entries;
    if (sig === this._lastSig) return; // nothing changed — do not re-render
    this._lastSig = sig;
    this.update();
  }

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
    console.log('[patina:palette] runContentQuery: root=', root, 'query=', q, 'silent=', silent);
    this.ensureContentIndexed(root)
          .then(() => {
            console.log('[patina:palette] content index ready, searching for:', q);
            return searchContent(root, q, 200);
          })
          .then((hits) => {
            console.log('[patina:palette] searchContent returned:', (hits || []).length, 'hits');
            this.commitResults((hits || []).map((h) => ({ ...h, kind: 'file' })), seq);
          })
          .catch((err) => {
            console.error('[patina:palette] content search error:', err);
            if (seq !== this._scanSeq || !this._open || silent) return;
        this._loading = false;
        this._entries = [];
        this._lastSig = this._resultsSig([]);
        this.update();
      });
  }

  filtered() {
    if (this._scope === 'content') {
      let list = this._entries;
      if (this._tagFilter) list = list.filter((e) => this._tagFilter.has(pathKey(e.path)));
      return list;
    }
    let list = this._entries;
    if (this._tagFilter) list = list.filter((e) => this._tagFilter.has(pathKey(e.path)));
    const q = this._query.trim();
    if (q) {
      if (this._regex) {
        const { ok, re } = safeRegExp(q, 'i');
        if (!ok) return list;           // unsafe/broken pattern — do not filter, as before
        list = list.filter((e) => re.test(e.name));
      } else {
        const ql = q.toLowerCase();
        list = list.filter((e) => e.name.toLowerCase().includes(ql));
      }
    }
    return list;
  }

  update() {
    this.renderResults();
    this.loadDots();
  }

  // Lazily load tags only for the visible rows (a bounded set).
  loadDots() {
    if (this._scope === 'content') return;
    const missing = this._results.map((e) => e.path).filter((p) => !(p in this._tags));
    if (!missing.length) return;
    const seq = ++this._dotSeq;
    tagsForPaths(missing)
      .then((m) => {
        if (seq !== this._dotSeq || !this._open) return;
        for (const p of missing) this._tags[p] = m && m[p] ? m[p] : [];
        this.paintDots();
      })
      .catch(() => {});
  }

  paintDots() {
    if (!this._resultsEl) return;
    this._resultsEl.querySelectorAll('.palette__item').forEach((it) => {
      const e = this._results[+it.dataset.i];
      const rt = it.querySelector('.palette__rtags');
      if (e && rt) rt.innerHTML = this.dotsHtml(e.path);
    });
  }

  dotsHtml(path) {
    return (this._tags[path] || [])
      .map((id) => `<span class="tag-dot" style="background:${TAG_COLOR[id] || '#888'}"></span>`)
      .join('');
  }

  // Tag filter — global path sets from the DB, intersection (AND).
  rebuildTagFilter() {
    if (!this._activeTags.size) {
      this._tagFilter = null;
      this.update();
      return;
    }
    const tags = [...this._activeTags];
    const seq = ++this._tagSeq;
    Promise.all(tags.map((t) => pathsForTag(t)))
      .then((lists) => {
        if (seq !== this._tagSeq || !this._open) return;
        // Keys come back in the index's normalized form (case-folded on
        // Windows); compare via pathKey so the filter matches folder entries
        // whose paths are in original case.
        let set = new Set((lists[0] || []).map(pathKey));
        for (let i = 1; i < lists.length; i++) {
          const s = new Set((lists[i] || []).map(pathKey));
          set = new Set([...set].filter((p) => s.has(p)));
        }
        this._tagFilter = set;
        this.update();
      })
      .catch(() => {
        if (seq !== this._tagSeq) return;
        this._tagFilter = new Set();
        this.update();
      });
  }

  relParent(path) {
    let rel = path;
    if (this._root && path.startsWith(this._root)) rel = path.slice(this._root.length);
    rel = rel.replace(/^[\\/]+/, '');
    const idx = Math.max(rel.lastIndexOf('/'), rel.lastIndexOf('\\'));
    return idx > 0 ? rel.slice(0, idx) : '';
  }

  render() {
    this.mount.innerHTML = '';
    const backdrop = el('div', { class: 'palette__backdrop', onClick: () => this.close() });
    const panel = el('div', { class: 'palette' });

    const head = el('div', { class: 'palette__head' });
    this._input = el('input', {
      class: 'palette__input',
      type: 'text',
      placeholder: t('palette.placeholder.folder'),
      spellcheck: 'false',
      onInput: (e) => {
        this._query = e.target.value;
        this._sel = 0;
        if (this._scope === 'tree') this.onTreeInput();
        else if (this._scope === 'content') this.onContentInput();
        else this.update();
      },
    });
    this._regexBtn = el(
      'button',
      {
        class: 'palette__regex',
        title: t('palette.regex.title'),
        onClick: () => {
          this._regex = !this._regex;
          this._regexBtn.classList.toggle('is-on', this._regex);
          this._input.focus();
          if (this._scope === 'tree') this.runTreeQuery();
          else if (this._scope !== 'content') this.update();
        },
      },
      '.*',
    );
    head.append(this._input, this._regexBtn);

    // Search scope switcher
    const scope = el('div', { class: 'palette__scope' });
    this._scopeFolderBtn = el(
      'button',
      { class: 'palette__scopebtn is-on', onClick: () => this.setScope('folder') },
      t('palette.scope.folder'),
    );
    this._scopeTreeBtn = el(
      'button',
      {
        class: 'palette__scopebtn' + (this.treeAllowed ? '' : ' is-disabled'),
        onClick: () => this.setScope('tree'),
        title: this.treeAllowed ? t('palette.scope.treeHint') : t('palette.scope.disabledTag'),
      },
      t('palette.scope.tree'),
    );
    this._reindexBtn = el(
      'button',
      {
        class: 'palette__scopebtn palette__reindex',
        title: t('palette.reindex.title'),
        onClick: () => this.forceReindex(),
      },
      '↻',
    );
    this._scopeContentBtn = el(
      'button',
      {
        class: 'palette__scopebtn' + (this.treeAllowed ? '' : ' is-disabled'),
        onClick: () => this.setScope('content'),
        title: this.treeAllowed ? t('palette.scope.contentHint') : t('palette.scope.disabledTag'),
      },
      t('palette.scope.content'),
    );
    scope.append(this._scopeFolderBtn, this._scopeTreeBtn, this._scopeContentBtn, this._reindexBtn);

    const chips = el('div', { class: 'palette__tags' });
    for (const tag of TAGS) {
      chips.append(
        el(
          'button',
          {
            class: 'palette__chip',
            dataset: { tag: tag.id },
            onClick: (e) => {
              if (this._activeTags.has(tag.id)) this._activeTags.delete(tag.id);
              else this._activeTags.add(tag.id);
              e.currentTarget.classList.toggle('is-on');
              this._sel = 0;
              this.rebuildTagFilter();
            },
          },
          el('span', { class: 'palette__dot', style: `background:${tag.color}` }),
          tagLabel(tag.id),
        ),
      );
    }

    this._resultsEl = el('div', { class: 'palette__results' });
    panel.append(head, scope, chips, this._resultsEl);
    this.mount.append(backdrop, panel);
    this.update();
  }

  _syncScopeUI() {
    if (this._scopeFolderBtn) this._scopeFolderBtn.classList.toggle('is-on', this._scope === 'folder');
    if (this._scopeTreeBtn) this._scopeTreeBtn.classList.toggle('is-on', this._scope === 'tree');
    if (this._scopeContentBtn) this._scopeContentBtn.classList.toggle('is-on', this._scope === 'content');
    if (this._input) this._input.placeholder = t(`palette.placeholder.${this._scope}`);
    // Update the scope buttons' titles — they depend on treeAllowed.
    if (this._scopeTreeBtn) this._scopeTreeBtn.title = this.treeAllowed ? t('palette.scope.treeHint') : t('palette.scope.disabledTag');
    if (this._scopeContentBtn) this._scopeContentBtn.title = this.treeAllowed ? t('palette.scope.contentHint') : t('palette.scope.disabledTag');
    if (this._reindexBtn) this._reindexBtn.title = t('palette.reindex.title');
    if (this._regexBtn) this._regexBtn.title = t('palette.regex.title');
    }

  renderResults() {
    if (this._loading) {
      this._results = [];
      this._resultsCount = 0;
      this._resultsEl.innerHTML = `<div class="palette__empty">${escapeHtml(this._indexing ? t('palette.indexing') : t('common.loading'))}</div>`;
      return;
    }
    const all = this.filtered();
    this._resultsCount = all.length;
    const shown = all.slice(0, DISPLAY_CAP);
    this._results = shown;
    if (this._sel >= shown.length) this._sel = Math.max(0, shown.length - 1);

    if (!shown.length) {
      this._resultsEl.innerHTML = `<div class="palette__empty">${escapeHtml(t('palette.empty'))}</div>`;
      return;
    }

    const content = this._scope === 'content';
    let html = shown
      .map((e, i) => {
        const sel = i === this._sel ? ' is-sel' : '';
        const sub = this._scope === 'tree' || content ? this.relParent(e.path) : '';
        const subHtml = sub ? `<span class="palette__path">${escapeHtml(sub)}</span>` : '';
        if (content) {
          return `<div class="palette__item palette__item--content${sel}" data-i="${i}">
              <div class="palette__crow"><span class="palette__ico">${fileIcon(e)}</span>` +
            `<span class="palette__main"><span class="palette__name">${escapeHtml(e.name)}</span>${subHtml}</span></div>` +
            `<div class="palette__snippet">${escapeHtml(e.snippet || '')}</div>
            </div>`;
        }
        return `<div class="palette__item${sel}" data-i="${i}">
            <span class="palette__ico">${fileIcon(e)}</span>
            <span class="palette__main"><span class="palette__name">${escapeHtml(e.name)}</span>${subHtml}</span>
            <span class="palette__rtags">${this.dotsHtml(e.path)}</span>
          </div>`;
      })
      .join('');
    if (all.length > shown.length) {
      html += `<div class="palette__more">${escapeHtml(t('palette.more', { shown: shown.length, all: all.length }))}</div>`;
    }
    this._resultsEl.innerHTML = html;

    this._resultsEl.querySelectorAll('.palette__item').forEach((it) => {
      it.addEventListener('click', () => this.activate(this._results[+it.dataset.i]));
    });
  }
  
  /** Re-render on language change. Preserves the open palette, query, scope, tags. */
  applyLang() {
    if (!this._open) return;
    this._syncScopeUI();
    // Tag chip buttons: the last child is the text label, we update it.
    const chips = this.mount.querySelectorAll('.palette__chip');
    chips.forEach((chip, i) => {
      const tag = TAGS[i];
      if (!tag) return;
      const last = chip.lastChild;
      if (last && last.nodeType === 3) last.textContent = tagLabel(tag.id);
    });
    this.update();
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
