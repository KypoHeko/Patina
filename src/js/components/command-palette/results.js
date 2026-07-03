// CommandPalette — the result model: filtering, tag dots, the tag filter, and
// the shared "commit results / signature / hint" plumbing used by both the
// tree and content scopes. Mixed into CommandPalette.prototype.

import { tagsForPaths, pathsForTag } from '../../api/tags.js';
import { escapeHtml } from '../../core/dom.js';
import { pathKey } from '../../lib/paths.js';
import { safeRegExp } from '../../lib/regex.js';
import { TAGS } from '../../config/tags.js';

const TAG_COLOR = Object.fromEntries(TAGS.map((tag) => [tag.id, tag.color]));

export const ResultsMixin = {
  showHint(text) {
    this._entries = [];
    this._results = [];
    this._resultsCount = 0;
    this._loading = false;
    this._lastSig = '';
    if (this._resultsEl)
      this._resultsEl.innerHTML = `<div class="palette__empty">${escapeHtml(text)}</div>`;
  },

  // Signature of the result set: paths + snippets. If unchanged, we skip the
  // re-render (removes flicker on index events).
  _resultsSig(list) {
    let out = '';
    for (const e of list) out += `${e.path}\u0000${e.snippet || ''}\u0001`;
    return out;
  },

  // Commit query results, accounting for staleness and without extra re-renders.
  commitResults(entries, seq) {
    if (seq !== this._scanSeq || !this._open) return;
    this._loading = false;
    const sig = this._resultsSig(entries);
    this._entries = entries;
    if (sig === this._lastSig) return; // nothing changed — do not re-render
    this._lastSig = sig;
    this.update();
  },

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
  },

  update() {
    this.renderResults();
    this.loadDots();
  },

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
  },

  paintDots() {
    if (!this._resultsEl) return;
    this._resultsEl.querySelectorAll('.palette__item').forEach((it) => {
      const e = this._results[+it.dataset.i];
      const rt = it.querySelector('.palette__rtags');
      if (e && rt) rt.innerHTML = this.dotsHtml(e.path);
    });
  },

  dotsHtml(path) {
    return (this._tags[path] || [])
      .map((id) => `<span class="tag-dot" style="background:${TAG_COLOR[id] || '#888'}"></span>`)
      .join('');
  },

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
  },

  relParent(path) {
    let rel = path;
    if (this._root && path.startsWith(this._root)) rel = path.slice(this._root.length);
    rel = rel.replace(/^[\\/]+/, '');
    const idx = Math.max(rel.lastIndexOf('/'), rel.lastIndexOf('\\'));
    return idx > 0 ? rel.slice(0, idx) : '';
  },
};
