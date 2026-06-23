import { Component } from '../core/component.js';
import { startDrag, getDrag, clearDrag } from '../state/drag.js';
import { escapeHtml } from '../core/dom.js';
import { listDir, copyEntries, moveEntries, deleteEntries, renameEntry, checkConflicts, createFolder } from '../api/fs.js';
import { openPath, nativeIcon } from '../api/system.js';
import { tagsForPaths, listTag } from '../api/tags.js';
import { computeDirSizes, dirSizes } from '../api/dir_size.js';
import { TAGS } from '../config/tags.js';
import { formatSize, formatDate } from '../lib/format.js';
import { fileIcon, hasOwnIcon } from '../lib/icons.js';
import { parentPath, folderName } from '../lib/paths.js';
import {
  getPane,
  updatePane,
  setActivePane,
  selectInPane,
  recordHistory,
  stepHistory,
} from '../state/panes.js';
import { getActiveSide, closeSplit, splitTab } from '../state/tabs.js';
import { Breadcrumbs } from './breadcrumbs.js';
import { makeMatcher } from '../lib/regex.js';
import { t, tagLabel } from '../lib/i18n.js';

const TAG_COLOR = Object.fromEntries(TAGS.map((t) => [t.id, t.color]));

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

export class FilePanel extends Component {
  constructor(ctx) {
    super(ctx);
    this.side = ctx.side;
    this._lastPane = null;
    this._lastActive = null;
    this._dropRow = null;
    this._tags = {}; // path -> [tagId] for the current listing
    this._anchor = null; // anchor for Shift selection
    this._sort = { key: 'name', dir: 'asc' }; // default sort — name
    this._view = []; // the displayed (sorted) order
    this._renaming = null; // path being inline-renamed (suppresses reloads)
    this._pendingReload = false; // a reload deferred while inline-renaming
    this._filter = ''; // search string (regex / substring)
    this._appliedFilter = '';
    this._cursor = 0;
    this._nativeIcons = new Map(); // path → data-URL (native icon cache)
    this._iconPending = new Set(); // paths a request has already been sent for
  }

  init() {
    const splitBtn =
      this.side === 'left'
        ? `<button class="panel__split" data-split title="${t('panel.split')}">▥</button>`
        : '';
    const closeBtn =
      `<button class="panel__close" data-close-split title="${t('panel.closePanel')}">×</button>`;
    this.mount.innerHTML = `
      <div class="panel">
        <div class="panel__head">
          <div class="panel__crumbs"></div>
          ${splitBtn}
          ${closeBtn}
        </div>
        <div class="panel__colhead">
          <span></span>
          <span class="col-sort" data-sort="name">${t('col.name')}<i class="sort-arrow"></i></span>
          <span class="col-sort" data-sort="type">${t('col.type')}<i class="sort-arrow"></i></span>
          <span>${t('col.tag')}</span>
          <span class="col-sort col-r" data-sort="size">${t('col.size')}<i class="sort-arrow"></i></span>
          <span class="col-sort" data-sort="modified">${t('col.modified')}<i class="sort-arrow"></i></span>
        </div>
        <div class="panel__list"></div>
      </div>`;
    this.panelEl = this.mount.querySelector('.panel');
    this.crumbsEl = this.mount.querySelector('.panel__crumbs');
    this.listEl = this.mount.querySelector('.panel__list');
    this.colheadEl = this.mount.querySelector('.panel__colhead');

    // Folder sizes (Phase 1): a "path → size" cache for display + a flag for an
    // ongoing recompute (we draw spinners on folders). Triggered only by the button.
    this._dirSizes = new Map();
    this._dirComputing = false;

    this.breadcrumbs = this.addChild(
      new Breadcrumbs({
        mount: this.crumbsEl,
        store: this.store,
        bus: this.bus,
        side: this.side,
        onNavigate: (path) => this.navigate(path),
        onBack: () => this.goBack(),
      }),
    );
    this.breadcrumbs.init();

    const splitEl = this.mount.querySelector('[data-split]');
    if (splitEl) this.on(splitEl, 'click', () => splitTab(this.store));
    const closeEl = this.mount.querySelector('[data-close-split]');
    if (closeEl) this.on(closeEl, 'click', () => closeSplit(this.store, this.side));

    this.on(this.panelEl, 'mousedown', (e) => this.onMouseDown(e));
    this.on(this.listEl, 'click', (e) => this.onClick(e));
    this.on(this.listEl, 'dblclick', (e) => this.onDblClick(e));
    this.on(this.listEl, 'contextmenu', (e) => this.onContextMenu(e));
    this.on(this.colheadEl, 'click', (e) => this.onSort(e));
    this.on(window, 'keydown', (e) => this.onListKey(e));

    this.on(this.listEl, 'dragstart', (e) => this.onDragStart(e));
    this.on(this.listEl, 'dragend', () => this.onDragEnd());
    this.on(this.panelEl, 'dragover', (e) => this.onDragOver(e));
    this.on(this.panelEl, 'dragleave', (e) => this.onDragLeave(e));
    this.on(this.panelEl, 'drop', (e) => this.onDrop(e));

    this.listen('file:activate', ({ side, entry }) => {
      if (side === this.side) this.activate(entry);
    });
    this.listen('location:open', ({ path }) => {
      if (getActiveSide(this.store.getState()) === this.side) this.navigate(path);
    });
    this.listen('graph:reveal', ({ path }) => {
      if (getActiveSide(this.store.getState()) === this.side) this.revealPath(path);
    });
    this.listen('file:delete', ({ side }) => {
      if (side === this.side) this.deleteSelected();
    });
    this.listen('file:rename', ({ side, entry }) => {
      if (side === this.side) this.startRename(entry);
    });
    this.listen('folder:create', (p) => {
      const side = (p && p.side) || getActiveSide(this.store.getState());
      if (side === this.side) this.createFolderHere();
    });
    this.listen('fs:changed', ({ dirs }) => {
      if (this._lastPane && dirs.includes(this._lastPane.path)) {
        // Don't clobber an open inline-rename editor. Creating a folder triggers
        // a watcher event that would otherwise rebuild the list and drop the
        // rename input; defer the reload until the edit finishes.
        if (this._renaming) {
          this._pendingReload = true;
          return;
        }
        this.reload();
      }
    });
    this.listen('dirsize:recalc', () => {
      if (getActiveSide(this.store.getState()) === this.side) this.recalcDirSizes();
    });
    this.listen('tags:changed', ({ paths }) => {
      const cur = this._lastPane;
      if (!cur) return;
      if ((cur.path || '').startsWith('tag:')) {
        this.reload(); // in a tag-folder, removing the tag drops the file from the list
        return;
      }
      const entries = cur.entries || [];
      if (paths.some((p) => entries.find((e) => e.path === p))) this.loadTags(entries);
    });

    this._rowH = parseInt(getComputedStyle(document.documentElement).getPropertyValue('--row-h'), 10) || 28;
    this.on(this.listEl, 'scroll', () => this._scheduleWindow());
    if (typeof ResizeObserver !== 'undefined') {
      this._ro = new ResizeObserver(() => this._scheduleWindow());
      this._ro.observe(this.listEl);
    }

    this.renderColhead();
    this.subscribe((state) => this.sync(state));
    this.sync(this.store.getState());
  }

  sync(state) {
    const pane = getPane(state, this.side);

    if (pane.path && pane.historyIndex === -1 && !pane.loading && !pane.error) {
      this.navigate(pane.path);
      return;
    }

    const active = getActiveSide(state) === this.side;
    const filter = active ? state.searchQuery || '' : '';
    if (pane === this._lastPane && active === this._lastActive && filter === this._appliedFilter) return;

    const structureChanged =
      !this._lastPane ||
      pane.entries !== this._lastPane.entries ||
      pane.error !== this._lastPane.error;
    const filterChanged = filter !== this._appliedFilter;

    this._lastPane = pane;
    this._lastActive = active;
    this._filter = filter;
    this._appliedFilter = filter;

    this.panelEl.classList.toggle('is-active', active);
    if (structureChanged || filterChanged) {
      this.renderList(pane);
      if (structureChanged) {
        this.loadTags(pane.entries);
        // New folder: reset spinners from the previous recompute; pull sizes
        // from the index if already computed (otherwise folders show nothing).
        this._dirComputing = false;
        this.loadDirSizes(pane.entries);
      }
    } else this.updateSelection(pane);
  }

  async navigate(path, { record = true } = {}) {
    // Re-render of the same folder (e.g. after fs:changed from restore_version):
    // keep the selection, otherwise restore would clear it. For a new folder
    // selected is reset as before.
    const isReload = this._lastPane?.path === path;
    const prevSelected = isReload ? [...(this._lastPane?.selected || [])] : [];

    // Reset the filter on navigation — so we do not "catch" an old search in
    // the new folder. The input updates via sync().
    if (this.store.getState().searchQuery) {
      this.store.setState({ searchQuery: '' });
    }
    updatePane(this.store, this.side, { loading: true, error: null });
    try {
      const entries = path.startsWith('tag:') ? await listTag(path.slice(4)) : await listDir(path);
      this._tags = {}; // reset the previous folder's tags
      this._anchor = null;
      // Keep in the selection only the paths still present in the listing —
      // e.g. after restore the file is the same, but after deletion it is gone.
      const existing = new Set(entries.map((e) => e.path));
      const selected = prevSelected.filter((p) => existing.has(p));
      updatePane(this.store, this.side, { path, entries, selected, loading: false });
      if (record) recordHistory(this.store, this.side, path);
    } catch (err) {
      updatePane(this.store, this.side, { loading: false, error: err.message });
    }
  }

  /** Reveal a file from the graph: navigate to its folder and select it there.
   *  For a drive root (no parent) we simply open it as a folder. */
  async revealPath(path) {
    const parent = parentPath(path);
    if (parent) {
      await this.navigate(parent);
      selectInPane(this.store, this.side, [path]);
    } else {
      await this.navigate(path);
    }
  }

  async loadTags(entries) {
    if (!entries.length) return;
    try {
      const map = await tagsForPaths(entries.map((e) => e.path));
      this._tags = map || {};
      this.updateTags();
    } catch {
      /* tags — not critical, silently ignore */
    }
  }

  /** Recompute the sizes of all folders in the current directory (the ∑ button).
   *  While the walk runs a spinner spins on the folders; numbers fill in on completion. */
  async recalcDirSizes() {
    const root = this._lastPane && this._lastPane.path;
    if (!root || root.startsWith('tag:')) return; // tag folders are not on disk
    if (this._dirComputing) return;
    this._dirComputing = true;
    this._dirSizes = new Map(); // recompute — clear the shown values
    this.renderWindow(); // show spinners on folders
    try {
      await computeDirSizes(root);
    } catch {
      /* sizes — not critical, silently ignore */
    }
    this._dirComputing = false;
    await this.loadDirSizes(this._lastPane ? this._lastPane.entries : []);
  }

  /** Fetch already-computed folder sizes for the current list and show them. */
  async loadDirSizes(entries) {
    const folders = (entries || []).filter((e) => e.kind === 'folder').map((e) => e.path);
    if (!folders.length) {
      this._dirSizes = new Map();
      this.renderWindow();
      return;
    }
    try {
      const map = await dirSizes(folders);
      this._dirSizes = new Map(Object.entries(map || {}));
    } catch {
      this._dirSizes = new Map();
    }
    this.renderWindow();
  }

  reload() {
    if (this._lastPane?.path) this.navigate(this._lastPane.path, { record: false });
  }

  goBack() {
    const target = stepHistory(this.store, this.side, -1);
    if (target != null) this.navigate(target, { record: false });
  }

  goForward() {
    const target = stepHistory(this.store, this.side, +1);
    if (target != null) this.navigate(target, { record: false });
  }

  async activate(entry) {
    if (entry.kind === 'folder') {
      this.navigate(entry.path);
      return;
    }
    try {
      await openPath(entry.path);
    } catch (err) {
      this.bus.emit('shortcut:hint', { text: t('panel.openError', { msg: err.message }), type: 'error' });
    }
  }

  /* ── Keyboard navigation ─────────────────── */

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
  }

  cursorIndex() {
    const sel = this._lastPane?.selected || [];
    if (sel.length) {
      const i = this._view.findIndex((e) => e.path === sel[sel.length - 1]);
      if (i >= 0) return i;
    }
    return Math.min(Math.max(0, this._cursor | 0), Math.max(0, this._view.length - 1));
  }

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
  }

  ensureVisible(index) {
    const rowH = this._rowH;
    const top = index * rowH;
    const vh = this.listEl.clientHeight || rowH * 20;
    if (top < this.listEl.scrollTop) this.listEl.scrollTop = top;
    else if (top + rowH > this.listEl.scrollTop + vh) this.listEl.scrollTop = top + rowH - vh;
    this.renderWindow();
  }

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
  }

  async createFolderHere() {
    const pane = this._lastPane;
    if (!pane || !pane.path || pane.path.startsWith('tag:')) {
      this.bus.emit('shortcut:hint', { text: t('panel.noCreateHere'), type: 'warn' });
      return;
    }
    const dir = pane.path;
    try {
      const newPath = await createFolder(dir, t('panel.newFolderName'));
      const entries = await listDir(dir);
      updatePane(this.store, this.side, { entries, selected: [newPath] });
      requestAnimationFrame(() => {
        const idx = this._view.findIndex((e) => e.path === newPath);
        if (idx >= 0) {
          this._cursor = idx;
          this._anchor = newPath;
          this.ensureVisible(idx);
        }
        const entry = (entries || []).find((e) => e.path === newPath);
        if (entry) this.startRename(entry);
      });
    } catch (err) {
      this.bus.emit('shortcut:hint', { text: t('panel.createFolderError', { msg: err.message }), type: 'error' });
    }
  }

  entryAt(row) {
    return (this._lastPane?.entries || []).find((e) => e.path === row.dataset.path);
  }
  
    /**
     * The current selection, read from the STORE (the source of truth) rather
     * than from `_lastPane` (a render cache). Selection-changing and
     * selection-acting handlers must use this: computing the next selection from
     * a possibly-stale cache breaks Ctrl-click accumulation, which in turn makes
     * bulk actions (tagging, delete, drag) hit only the last-clicked file.
     */
    selectedPaths() {
      return getPane(this.store.getState(), this.side).selected || [];
    }

  /* ── Operations ────────────────────────────── */

  deleteSelected() {
    const paths = this.selectedPaths();
    if (!paths.length) return;
    const dir = this._lastPane.path;
    this.bus.emit('confirm:open', {
      title: t('panel.deleteTitle'),
      message: t('panel.deleteMsg', { n: paths.length }),
      confirmLabel: t('panel.deleteConfirm'),
      danger: true,
      onConfirm: async () => {
        try {
          await deleteEntries(paths);
          this.bus.emit('shortcut:hint', t('common.trashed', { n: paths.length }));
          this.bus.emit('fs:changed', { dirs: [dir] });
        } catch (err) {
                  this.bus.emit('shortcut:hint', { text: t('panel.deleteError', { msg: err.message }), type: 'error' });
        }
      },
    });
  }

  startRename(entry) {
    const row = [...this.listEl.querySelectorAll('.row')].find(
      (r) => r.dataset.path === entry.path,
    );
    if (!row) return;
    this._renaming = entry.path;
    const nameEl = row.querySelector('.row__name');
    const input = document.createElement('input');
    input.className = 'row__rename';
    input.type = 'text';
    input.spellcheck = false;
    input.value = entry.name;
    nameEl.replaceChildren(input);
    input.focus();
    input.select();

    let done = false;
    const finish = async (commit) => {
      if (done) return;
      done = true;
      this._renaming = null;
      const value = input.value.trim();
      input.removeEventListener('keydown', onKey);
      input.removeEventListener('blur', onBlur);
      if (commit && value && value !== entry.name) {
        try {
          await renameEntry(entry.path, value);
          this.bus.emit('fs:changed', { dirs: [this._lastPane.path] });
          return;
        } catch (err) {
                  this.bus.emit('shortcut:hint', { text: t('panel.renameError', { msg: err.message }), type: 'error' });
        }
      }
      nameEl.textContent = entry.name;
      // Apply any reload that arrived (and was deferred) during the edit.
      if (this._pendingReload) {
        this._pendingReload = false;
        this.reload();
      }
    };
    const onKey = (e) => {
      if (e.key === 'Enter') finish(true);
      else if (e.key === 'Escape') finish(false);
      e.stopPropagation();
    };
    const onBlur = () => finish(false);
    input.addEventListener('keydown', onKey);
    input.addEventListener('blur', onBlur);
  }

  /* ── Drag and drop ─────────────────────────── */

  onDragStart(e) {
    const row = e.target.closest('.row');
    if (!row) return;
    const path = row.dataset.path;
    const selected = this.selectedPaths();
    const paths = selected.includes(path) && selected.length > 1 ? [...selected] : [path];
    startDrag(paths, this.side);
    e.dataTransfer.effectAllowed = 'copyMove';
    e.dataTransfer.setData('text/plain', paths.join('\n'));
    const dragged = paths.map((p) => {
      const en = (this._lastPane?.entries || []).find((x) => x.path === p);
      return { path: p, kind: en ? en.kind : '' };
    });
    e.dataTransfer.setData('application/x-patina-entries', JSON.stringify(dragged));
  }

  onDragOver(e) {
    if (!getDrag()) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = e.ctrlKey ? 'copy' : 'move';
    this.panelEl.classList.add('is-drop');
    const folderRow = e.target.closest('.row[data-kind="folder"]');
    if (this._dropRow && this._dropRow !== folderRow) this._dropRow.classList.remove('is-drop-into');
    if (folderRow) folderRow.classList.add('is-drop-into');
    this._dropRow = folderRow || null;
  }

  onDragLeave(e) {
    if (!this.panelEl.contains(e.relatedTarget)) this.clearDropHighlight();
  }

  onDrop(e) {
    if (!getDrag()) return;
    e.preventDefault();
    const { paths } = getDrag();
    const copy = e.ctrlKey;
    const folderRow = e.target.closest('.row[data-kind="folder"]');
    const destDir = folderRow ? folderRow.dataset.path : this._lastPane.path;
    clearDrag();
    this.clearDropHighlight();
    if (destDir.startsWith('tag:')) {
          this.bus.emit('shortcut:hint', { text: t('panel.noDropTag'), type: 'warn' });
      return;
    }
    this.dropEntries(paths, destDir, copy);
  }

  onDragEnd() {
    clearDrag();
    this.clearDropHighlight();
  }

  clearDropHighlight() {
    this.panelEl.classList.remove('is-drop');
    if (this._dropRow) {
      this._dropRow.classList.remove('is-drop-into');
      this._dropRow = null;
    }
  }

  async dropEntries(sources, destDir, copy) {
    const filtered = sources.filter((src) => {
      if (src === destDir) return false;
      if (parentPath(src) === destDir) return false;
      const sep = src.includes('\\') ? '\\' : '/';
      if (destDir.startsWith(src + sep)) return false;
      return true;
    });
    if (!filtered.length) return;

    let conflicts = [];
    try {
      conflicts = (await checkConflicts(filtered, destDir)) || [];
    } catch {
      /* on a check error, just try without overwriting */
    }

    if (conflicts.length) {
      const conflictSet = new Set(conflicts);
      this.bus.emit('confirm:open', {
        title: t('panel.conflictTitle'),
        message: t('panel.conflictMsg', { n: conflicts.length }),
        confirmLabel: t('panel.overwrite'),
        altLabel: t('panel.skip'),
        onConfirm: () => this.doTransfer(filtered, destDir, copy, true),
        onAlt: () => {
          const rest = filtered.filter((p) => !conflictSet.has(folderName(p)));
          this.doTransfer(rest, destDir, copy, false);
        },
      });
      return;
    }
    this.doTransfer(filtered, destDir, copy, false);
  }

  async doTransfer(sources, destDir, copy, overwrite) {
    if (!sources.length) return;
    try {
      if (copy) await copyEntries(sources, destDir, overwrite);
      else await moveEntries(sources, destDir, overwrite);

      const affected = new Set([destDir]);
      sources.forEach((p) => {
        const parent = parentPath(p);
        if (parent) affected.add(parent);
      });
      this.bus.emit('fs:changed', { dirs: [...affected] });
      this.bus.emit('shortcut:hint', copy ? t('panel.copied', { n: sources.length }) : t('panel.moved', { n: sources.length }));
    } catch (err) {
          this.bus.emit('shortcut:hint', { text: t('common.error', { msg: err.message }), type: 'error' });
    }
  }

  /* ── Input ─────────────────────────────────── */

  onMouseDown(e) {
    setActivePane(this.store, this.side);
    if (e.button === 3) {
      e.preventDefault();
      this.goBack();
    } else if (e.button === 4) {
      e.preventDefault();
      this.goForward();
    }
  }

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
  }

  onDblClick(e) {
    const row = e.target.closest('.row');
    const entry = row && this.entryAt(row);
    if (entry) this.activate(entry);
  }

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
  }

  /* ── Rendering ─────────────────────────────── */

  dotsHtml(path) {
    return (this._tags[path] || [])
      .map(
        (id) =>
          `<span class="tag-dot" style="background:${TAG_COLOR[id] || '#888'}" title="${escapeHtml(
            tagLabel(id),
          )}"></span>`,
      )
      .join('');
  }

  sortedEntries(entries) {
    const { key, dir } = this._sort;
    const sign = dir === 'asc' ? 1 : -1;
    const byName = (a, b) =>
      a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
    const cmp = (a, b) => {
      let r;
      if (key === 'size') r = (a.size || 0) - (b.size || 0);
      else if (key === 'modified') r = (a.modified || 0) - (b.modified || 0);
      else if (key === 'type') r = String(a.extension || '').localeCompare(String(b.extension || ''));
      else r = byName(a, b);
      if (r === 0) r = byName(a, b);
      return sign * r;
    };
    const folders = entries.filter((e) => e.kind === 'folder').sort(cmp);
    const files = entries.filter((e) => e.kind !== 'folder').sort(cmp);
    return [...folders, ...files];
  }

  onSort(e) {
    const h = e.target.closest('[data-sort]');
    if (!h) return;
    const key = h.dataset.sort;
    if (this._sort.key === key) this._sort.dir = this._sort.dir === 'asc' ? 'desc' : 'asc';
    else this._sort = { key, dir: 'asc' };
    this.renderColhead();
    if (this._lastPane) this.renderList(this._lastPane);
  }
  
    /** Re-render on language change. Preserves navigation, selection, sort, tags. */
    applyLang() {
      if (!this.panelEl) return;
      // 1. Panel header buttons.
      const splitBtn = this.mount.querySelector('[data-split]');
      if (splitBtn) splitBtn.title = t('panel.split');
      const closeBtn = this.mount.querySelector('[data-close-split]');
      if (closeBtn) closeBtn.title = t('panel.closePanel');
      // 2. Column headers — rebuild only the text nodes inside the spans.
      const colLabels = {
        name: t('col.name'),
        type: t('col.type'),
        size: t('col.size'),
        modified: t('col.modified'),
      };
      for (const [key, label] of Object.entries(colLabels)) {
        const span = this.colheadEl && this.colheadEl.querySelector(`[data-sort="${key}"]`);
        if (span) {
          // Keep the sort icon, update only the text.
          const arrow = span.querySelector('.sort-arrow');
          span.textContent = label;
          if (arrow) span.append(arrow);
        }
      }
      // The "Tag" column (no data-sort) is a span without the col-sort class; find it nearby.
      if (this.colheadEl) {
        const tagSpan = this.colheadEl.querySelector('span:not(.col-sort):not(:empty)');
        // the span is third in colhead; look for a plain text span with no children.
        const spans = this.colheadEl.querySelectorAll('span');
        for (const s of spans) {
          if (!s.classList.contains('col-sort') && !s.hasAttribute('data-sort') && s.childElementCount === 0) {
            s.textContent = t('col.tag');
            break;
          }
        }
      }
      // 3. Breadcrumbs.
      if (this.breadcrumbs && this.breadcrumbs.applyLang) this.breadcrumbs.applyLang();
      // 4. File list (per-row texts — Computing…, dots, etc. already go through t()).
      this.renderWindow();
      // 5. Empty state / error — check whether it is showing.
      if (this._lastPane && this._lastPane.error) {
        // error — leave as is, this is a message from the backend.
      } else if (this._lastPane && (!this._lastPane.entries || this._lastPane.entries.length === 0)) {
        // panel empty / nothing found — re-render via renderList.
        this.renderList(this._lastPane);
      }
    }

  renderColhead() {
    if (!this.colheadEl) return;
    this.colheadEl.querySelectorAll('.col-sort').forEach((h) => {
      const active = h.dataset.sort === this._sort.key;
      h.classList.toggle('is-sorted', active);
      const arrow = h.querySelector('.sort-arrow');
      if (arrow) arrow.textContent = active ? (this._sort.dir === 'asc' ? '▲' : '▼') : '';
    });
  }

  filterList(list) {
    const q = (this._filter || '').trim();
    if (!q) return list;
    const match = makeMatcher(q, { regex: true });
    return list.filter((e) => match(e.name));
  }

  renderList(pane) {
    // A full rebuild destroys any inline-rename input, so drop the edit state.
    this._renaming = null;
    this._pendingReload = false;
    if (pane.error) {
      this.listEl.innerHTML = `<div class="panel__error">${escapeHtml(pane.error)}</div>`;
      this._view = [];
      this._renderedPaths = new Set();
      return;
    }
    this._view = this.filterList(this.sortedEntries(pane.entries));
    this._renderedPaths = new Set();
    this.listEl.innerHTML = '';
    this.listEl.scrollTop = 0;
    this.renderWindow();
  }

  // Virtualization: only the visible window of rows + a margin is in the DOM.
  // .vlist-sizer sets the full height for the scrollbar, rows are positioned absolutely.
  // Instead of fully replacing innerHTML on every scroll we use a diff update:
  // create missing rows, update changed ones, remove extras.
  // This is an order of magnitude faster for large lists (5,000+ files).
  renderWindow() {
    if (!this._lastPane || this._lastPane.error || !this._view) return;
    const view = this._view;
    if (!view.length) {
      this.listEl.innerHTML = `<div class="panel__empty">${this._filter ? t('panel.notFound') : t('panel.empty')}</div>`;
      this._renderedPaths = new Set();
      return;
    }
    const rowH = this._rowH;
    const total = view.length;
    const scrollTop = this.listEl.scrollTop;
    const viewport = this.listEl.clientHeight || rowH * 20;
    const over = 10; // row margin top/bottom (increased for smoothness on fast scroll)
    const start = Math.max(0, Math.floor(scrollTop / rowH) - over);
    const end = Math.min(total, start + Math.ceil(viewport / rowH) + over * 2);
    const selected = new Set(this._lastPane.selected || []);

    // Update or create the sizer
    let sizer = this.listEl.querySelector('.vlist-sizer');
    if (!sizer) {
      sizer = document.createElement('div');
      sizer.className = 'vlist-sizer';
      this.listEl.appendChild(sizer);
    }
    const totalHeight = total * rowH;
    if (sizer.style.height !== totalHeight + 'px') {
      sizer.style.height = totalHeight + 'px';
    }

    // Build the set of visible paths
    const visiblePaths = new Set();
    for (let i = start; i < end; i++) visiblePaths.add(view[i].path);

    // Remove rows that are no longer visible
    if (!this._renderedPaths) this._renderedPaths = new Set();
    for (const p of this._renderedPaths) {
      if (!visiblePaths.has(p)) {
        const row = this.listEl.querySelector(`.row[data-path="${CSS.escape(p)}"]`);
        if (row) row.remove();
      }
    }
    this._renderedPaths = visiblePaths;

    // Update/create the visible rows
    for (let i = start; i < end; i++) {
      const e = view[i];
      const path = e.path;
      let row = this.listEl.querySelector(`.row[data-path="${CSS.escape(path)}"]`);

      if (row) {
        // Update only what could change: selection, position, folder size
        const topPx = i * rowH;
        if (row.style.top !== topPx + 'px') row.style.top = topPx + 'px';
        const isSel = selected.has(path);
        if (isSel !== row.classList.contains('is-selected')) {
          row.classList.toggle('is-selected', isSel);
        }
        // Update the folder size (dynamic field)
        if (e.kind === 'folder') {
          const sizeSpan = row.querySelector('.row__size');
          if (sizeSpan) {
            let sizeText;
            if (this._dirSizes.has(path)) sizeText = formatSize(this._dirSizes.get(path));
            else if (this._dirComputing) sizeText = `<span class="dirsize-spin" title="${t('panel.computing')}"></span>`;
            else sizeText = '';
            if (sizeSpan.innerHTML !== sizeText) sizeSpan.innerHTML = sizeText;
          }
        }
        // Update tags — they could change via the context menu
        const tagsSpan = row.querySelector('.row__tags');
        if (tagsSpan) {
          const newTags = this.dotsHtml(path);
          if (tagsSpan.innerHTML !== newTags) tagsSpan.innerHTML = newTags;
        }
      } else {
        // Create a new row
        row = document.createElement('div');
        row.className = 'row' + (selected.has(path) ? ' is-selected' : '');
        row.draggable = true;
        row.dataset.path = path;
        row.dataset.kind = e.kind;
                // Prefer our own icon; only files without one are eligible for the
                // native (OS) icon, which loadNativeIcons() fetches lazily.
                const own = hasOwnIcon(e);
                row.dataset.nat = own ? '' : '1';
        row.style.top = (i * rowH) + 'px';
        const iconHtml = (!own && this._nativeIcons.has(path))
          ? `<img class="row__native-icon" src="${this._nativeIcons.get(path)}" width="16" height="16" alt="" draggable="false">`
          : fileIcon(e);
        let size;
        if (e.kind === 'folder') {
          if (this._dirSizes.has(path)) size = formatSize(this._dirSizes.get(path));
          else if (this._dirComputing) size = `<span class="dirsize-spin" title="${t('panel.computing')}"></span>`;
          else size = '';
        } else {
          size = formatSize(e.size);
        }
        const type = e.kind === 'folder' ? '' : (e.extension || '').toUpperCase();
        row.innerHTML =
          `<span class="row__icon">${iconHtml}</span>` +
          `<span class="row__name">${escapeHtml(e.name)}</span>` +
          `<span class="row__type">${escapeHtml(type)}</span>` +
          `<span class="row__tags">${this.dotsHtml(path)}</span>` +
          `<span class="row__size">${size}</span>` +
          `<span class="row__modified">${escapeHtml(formatDate(e.modified))}</span>`;
        this.listEl.appendChild(row);
      }
    }
  }

  _scheduleWindow() {
    if (this._raf) return;
    this._raf = requestAnimationFrame(() => {
      this._raf = null;
      this.renderWindow();
      this.loadNativeIcons();
    });
  }

  /** Lazy loading of native icons for the visible rows.
   *  Requests only those not yet in the cache and not already loading.
   *  On receipt — updates only the icon in the DOM, without re-rendering the whole row. */
  loadNativeIcons() {
    if (!this._nativeIcons) return;
    const rows = this.listEl.querySelectorAll('.row');
    const paths = [];
    for (const row of rows) {
      if (row.dataset.nat !== '1') continue; // we already have our own icon for this one
      const p = row.dataset.path;
      if (p && !this._nativeIcons.has(p) && !this._iconPending.has(p)) {
        paths.push(p);
        this._iconPending.add(p);
        if (paths.length >= 30) break; // limit on concurrent requests
      }
    }
    if (!paths.length) return;
    // Fire the requests in parallel; each updates the DOM itself
    for (const p of paths) {
      nativeIcon(p, 16).then((result) => {
        this._iconPending.delete(p);
        if (result && result.dataUrl) {
          this._nativeIcons.set(p, result.dataUrl);
          // Update the icon in the DOM without a full re-render
          const iconSpan = this.listEl.querySelector(`.row[data-path="${CSS.escape(p)}"] .row__icon`);
          if (iconSpan && !iconSpan.querySelector('.row__native-icon')) {
            iconSpan.innerHTML = `<img class="row__native-icon" src="${result.dataUrl}" width="16" height="16" alt="" draggable="false">`;
          }
        }
      }).catch(() => {
        this._iconPending.delete(p);
        // The SVG fallback is already rendered — do nothing
      });
    }
  }

  updateTags() {
    this.renderWindow();
  }

  updateSelection() {
    if (!this._lastPane || !this.listEl) return;
    const selected = new Set(this._lastPane.selected || []);
    for (const row of this.listEl.querySelectorAll('.row')) {
      row.classList.toggle('is-selected', selected.has(row.dataset.path));
    }
  }

  destroy() {
    this._nativeIcons?.clear();
    this._iconPending?.clear();
    this._renderedPaths?.clear();
    super.destroy();
  }
}
