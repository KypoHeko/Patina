// FilePanel — rendering: column header, sorting, filtering, the virtualized
// row window, native-icon lazy loading, and language re-rendering.
// Mixed into FilePanel.prototype.

import { escapeHtml } from '../../core/dom.js';
import { t, tagLabel } from '../../lib/i18n.js';
import { makeMatcher } from '../../lib/regex.js';
import { formatSize, formatDate } from '../../lib/format.js';
import { fileIcon, hasOwnIcon } from '../../lib/icons.js';
import { nativeIcon } from '../../api/system.js';
import { TAGS } from '../../config/tags.js';

const TAG_COLOR = Object.fromEntries(TAGS.map((tag) => [tag.id, tag.color]));

export const RenderMixin = {
  dotsHtml(path) {
    return (this._tags[path] || [])
      .map(
        (id) =>
          `<span class="tag-dot" style="background:${TAG_COLOR[id] || '#888'}" title="${escapeHtml(
            tagLabel(id),
          )}"></span>`,
      )
      .join('');
  },

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
  },

  onSort(e) {
    const h = e.target.closest('[data-sort]');
    if (!h) return;
    const key = h.dataset.sort;
    if (this._sort.key === key) this._sort.dir = this._sort.dir === 'asc' ? 'desc' : 'asc';
    else this._sort = { key, dir: 'asc' };
    this.renderColhead();
    if (this._lastPane) this.renderList(this._lastPane);
  },

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
  },

  renderColhead() {
    if (!this.colheadEl) return;
    this.colheadEl.querySelectorAll('.col-sort').forEach((h) => {
      const active = h.dataset.sort === this._sort.key;
      h.classList.toggle('is-sorted', active);
      const arrow = h.querySelector('.sort-arrow');
      if (arrow) arrow.textContent = active ? (this._sort.dir === 'asc' ? '▲' : '▼') : '';
    });
  },

  filterList(list) {
    const q = (this._filter || '').trim();
    if (!q) return list;
    const match = makeMatcher(q, { regex: true });
    return list.filter((e) => match(e.name));
  },

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
  },

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
  },

  _scheduleWindow() {
    if (this._raf) return;
    this._raf = requestAnimationFrame(() => {
      this._raf = null;
      this.renderWindow();
      this.loadNativeIcons();
    });
  },

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
  },

  updateTags() {
    this.renderWindow();
  },

  updateSelection() {
    if (!this._lastPane || !this.listEl) return;
    const selected = new Set(this._lastPane.selected || []);
    for (const row of this.listEl.querySelectorAll('.row')) {
      row.classList.toggle('is-selected', selected.has(row.dataset.path));
    }
  },
};
