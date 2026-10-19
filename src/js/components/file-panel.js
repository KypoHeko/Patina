import { Component } from '../core/component.js';
import { Breadcrumbs } from './breadcrumbs.js';
import { t } from '../lib/i18n.js';
import { getPane } from '../state/panes.js';
import { getActiveSide, closeSplit, splitTab } from '../state/tabs.js';

import { NavigationMixin } from './file-panel/navigation.js';
import { SelectionMixin } from './file-panel/selection.js';
import { OperationsMixin } from './file-panel/operations.js';
import { DndMixin } from './file-panel/dnd.js';
import { DataMixin } from './file-panel/data.js';
import { RenderMixin } from './file-panel/render.js';

// One of the two file-browser panels (left/right). Construction, store wiring
// and the store→render sync live here; behaviour is split across mixins:
//   navigation — navigate/history/activate
//   selection  — keyboard + pointer selection, context menu
//   operations — delete, create folder, inline rename
//   dnd        — drag and drop
//   data       — async tag and folder-size loading
//   render     — column header, sorting, the virtualized row window, icons
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

  destroy() {
    this._nativeIcons?.clear();
    this._iconPending?.clear();
    this._renderedPaths?.clear();
    super.destroy();
  }
}

// Assemble behaviour onto the prototype. Method names and `this` semantics are
// identical to the previous single-file class, so callers and tests are unaffected.
Object.assign(
  FilePanel.prototype,
  NavigationMixin,
  SelectionMixin,
  OperationsMixin,
  DndMixin,
  DataMixin,
  RenderMixin,
);
