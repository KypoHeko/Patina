// FilePanel — selection & pointer input (keyboard navigation, mouse, context menu).
// Mixed into FilePanel.prototype.

import { getPane, selectInPane, setActivePane } from '../../state/panes.js';
import { getActiveSide } from '../../state/tabs.js';
import { parentPath } from '../../lib/paths.js';

// Overlays that handle the keyboard themselves (arrows/Enter) — while they are
// open, list navigation must not fire.
const OVERLAY_ROOTS = ['palette-root', 'graph-root', 'confirm-root'];
function overlayOpen() {
  return OVERLAY_ROOTS.some((id) => {
    const n = document.getElementById(id);
    return n && n.childElementCount > 0;
  });
}
function isTextInput(e) {
  const t = e.target;
  return t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable);
}

export const SelectionMixin = {
  onListKey(e) {
    if (isTextInput(e) || overlayOpen()) return;
    if (getActiveSide(this.store.getState()) !== this.side) return;
    const view = this._view;
    const key = e.key;
    if (key === 'ArrowDown' || key === 'ArrowUp' || key === 'Home' || key === 'End') {
      if (!view.length) return;
      e.preventDefault();
      this.moveCursor(key, e.shiftKey);
    } else if (key === 'Enter') {
      if (!view.length) return;
      e.preventDefault();
      const sel = this._lastPane?.selected || [];
      const path = sel.length === 1 ? sel[0] : view[this.cursorIndex()]?.path;
      const entry = view.find((en) => en.path === path);
      if (entry) this.activate(entry);
    } else if (key === 'Backspace') {
      e.preventDefault();
      const cur = this._lastPane?.path || '';
      const up = parentPath(cur);
      if (up && up !== cur) this.navigate(up);
    } else if (key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
      if (view.length) this.typeAhead(key);
    }
  },

  cursorIndex() {
    const sel = this._lastPane?.selected || [];
    if (sel.length) {
      const i = this._view.findIndex((e) => e.path === sel[sel.length - 1]);
      if (i >= 0) return i;
    }
    return Math.min(Math.max(0, this._cursor | 0), Math.max(0, this._view.length - 1));
  },

  moveCursor(key, shift) {
    const view = this._view;
    const last = view.length - 1;
    let i = this.cursorIndex();
    if (key === 'ArrowDown') i = Math.min(last, i + 1);
    else if (key === 'ArrowUp') i = Math.max(0, i - 1);
    else if (key === 'Home') i = 0;
    else if (key === 'End') i = last;
    this._cursor = i;
    const path = view[i].path;
    if (shift && this._anchor) {
      const a = view.findIndex((e) => e.path === this._anchor);
      if (a >= 0) {
        const [lo, hi] = a < i ? [a, i] : [i, a];
        selectInPane(this.store, this.side, view.slice(lo, hi + 1).map((e) => e.path));
      } else selectInPane(this.store, this.side, [path]);
    } else {
      this._anchor = path;
      selectInPane(this.store, this.side, [path]);
    }
    this.ensureVisible(i);
  },

  ensureVisible(index) {
    const rowH = this._rowH;
    const top = index * rowH;
    const vh = this.listEl.clientHeight || rowH * 20;
    if (top < this.listEl.scrollTop) this.listEl.scrollTop = top;
    else if (top + rowH > this.listEl.scrollTop + vh) this.listEl.scrollTop = top + rowH - vh;
    this.renderWindow();
  },

  typeAhead(ch) {
    const now = Date.now();
    if (now - (this._taTime || 0) > 700) this._taBuf = '';
    this._taTime = now;
    this._taBuf = (this._taBuf || '') + ch.toLowerCase();
    const view = this._view;
    const n = view.length;
    const start = this.cursorIndex();
    const firstChar = this._taBuf.length === 1;
    for (let k = 0; k < n; k++) {
      const idx = (start + (firstChar ? k + 1 : k)) % n;
      if ((view[idx].name || '').toLowerCase().startsWith(this._taBuf)) {
        this._cursor = idx;
        this._anchor = view[idx].path;
        selectInPane(this.store, this.side, [view[idx].path]);
        this.ensureVisible(idx);
        return;
      }
    }
  },

  entryAt(row) {
    return (this._lastPane?.entries || []).find((e) => e.path === row.dataset.path);
  },

  /**
   * The current selection, read from the STORE (the source of truth) rather
   * than from `_lastPane` (a render cache). Selection-changing and
   * selection-acting handlers must use this: computing the next selection from
   * a possibly-stale cache breaks Ctrl-click accumulation, which in turn makes
   * bulk actions (tagging, delete, drag) hit only the last-clicked file.
   */
  selectedPaths() {
    return getPane(this.store.getState(), this.side).selected || [];
  },

  onMouseDown(e) {
    setActivePane(this.store, this.side);
    if (e.button === 3) {
      e.preventDefault();
      this.goBack();
    } else if (e.button === 4) {
      e.preventDefault();
      this.goForward();
    }
  },

  onClick(e) {
    const row = e.target.closest('.row');
    if (!row) return;
    const path = row.dataset.path;
    const entries = this._view.length ? this._view : this._lastPane?.entries || [];
    const cur = this.selectedPaths();
    let next;

    if (e.ctrlKey || e.metaKey) {
      next = cur.includes(path) ? cur.filter((p) => p !== path) : [...cur, path];
      this._anchor = path;
    } else if (e.shiftKey && this._anchor) {
      const i1 = entries.findIndex((en) => en.path === this._anchor);
      const i2 = entries.findIndex((en) => en.path === path);
      if (i1 >= 0 && i2 >= 0) {
        const [a, b] = i1 < i2 ? [i1, i2] : [i2, i1];
        next = entries.slice(a, b + 1).map((en) => en.path);
      } else {
        next = [path];
      }
    } else {
      next = [path];
      this._anchor = path;
    }
    selectInPane(this.store, this.side, next);
  },

  onDblClick(e) {
    const row = e.target.closest('.row');
    const entry = row && this.entryAt(row);
    if (entry) this.activate(entry);
  },

  onContextMenu(e) {
    e.preventDefault();
    const row = e.target.closest('.row');
    if (!row) {
      // Right-click on empty space: a minimal background menu (New folder for
      // the current directory). No target entry, no selection change.
      this.bus.emit('contextmenu:open', {
        x: e.clientX,
        y: e.clientY,
        entry: null,
        side: this.side,
        paths: [],
      });
      return;
    }
    const entry = this.entryAt(row);
    if (!entry) return;
    const selected = this.selectedPaths();
    // Act on the whole selection when the right-clicked row is part of it;
    // otherwise narrow the selection to just this row.
    const paths = selected.includes(entry.path) ? [...selected] : [entry.path];
    if (!selected.includes(entry.path)) selectInPane(this.store, this.side, [entry.path]);
    this.bus.emit('contextmenu:open', { x: e.clientX, y: e.clientY, entry, side: this.side, paths });
  },
};
