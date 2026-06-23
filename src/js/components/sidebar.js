import { Component } from '../core/component.js';
import { el } from '../core/dom.js';
import { quickAccess, quickAccessSave, listStorage } from '../api/system.js';
import { tagCounts } from '../api/tags.js';
import { TAGS } from '../config/tags.js';
import { getPane } from '../state/panes.js';
import { getActiveSide } from '../state/tabs.js';
import { formatSize } from '../lib/format.js';
import { t, tagLabel } from '../lib/i18n.js';

const LOC_ICON = {
  home: '🏠',
  desktop: '🖥️',
  documents: '📄',
  downloads: '⬇️',
  drive: '💽',
};

// Label for an added folder — the last path segment.
function baseLabel(path) {
  const trimmed = path.replace(/[\\/]+$/, '');
  const parts = trimmed.split(/[\\/]/);
  return parts[parts.length - 1] || trimmed || path;
}

// Sidebar: collapsible "Quick Access", "Storage", "Tags" sections.
export class Sidebar extends Component {
  init() {
    this._collapsed = { quick: false, storage: false, tags: false };
    this._counts = {};
    this._quick = [];
    this.renderFrame();
    this.on(this.mount, 'click', (e) => this.onClick(e));
    // Quick-access drag-and-drop.
    this.on(this.mount, 'dragstart', (e) => this.onQuickDragStart(e));
    this.on(this.mount, 'dragover', (e) => this.onQuickDragOver(e));
    this.on(this.mount, 'dragleave', (e) => this.onQuickDragLeave(e));
    this.on(this.mount, 'drop', (e) => this.onQuickDrop(e));
    this.on(this.mount, 'dragend', () => this.onQuickDragEnd());
    this.subscribe(() => this.updateCurrent());
    this.listen('tags:changed', () => this.refreshCounts());
    this.load();
  }

  renderFrame() {
    this.mount.innerHTML = '';
    this.mount.append(
      this.section(t('sidebar.quick'), 'quick'),
      this.section(t('sidebar.storage'), 'storage'),
      this.section(t('sidebar.tags'), 'tags'),
    );
    this.renderTags();
  }
  
  /** Re-render sections and tags on language change. Preserves collapsed sections. */
  applyLang() {
    // Update section headers in place — leave the body alone, it holds data.
    const titles = { quick: t('sidebar.quick'), storage: t('sidebar.storage'), tags: t('sidebar.tags') };
    for (const [key, label] of Object.entries(titles)) {
      const head = this.mount.querySelector(`[data-toggle="${key}"]`);
      if (head) {
        const titleEl = head.querySelector('.sidebar__title');
        if (titleEl) titleEl.textContent = label;
      }
    }
    this.renderTags();
  }

  section(title, key) {
    const sec = el('div', {
      class: 'sidebar__section' + (this._collapsed[key] ? ' is-collapsed' : ''),
      dataset: { sec: key },
    });
    const head = el(
      'button',
      { class: 'sidebar__head', dataset: { toggle: key } },
      el('span', { class: 'sidebar__chevron' }, '▾'),
      el('span', { class: 'sidebar__title' }, title), el('span', { class: 'sidebar__compact-arrow' }, '▸'),
    );
    const body = el('div', { class: 'sidebar__body', dataset: { section: key } });
    sec.append(head, body);
    return sec;
  }

  async load() {
    // First load the fast data (quickAccess + tagCounts).
    // listStorage() via sysinfo can take 10–30 s on Linux —
    // defer it so it does not block the first content paint.
    try {
      const [quick, counts] = await Promise.all([quickAccess(), tagCounts()]);
      this._counts = counts || {};
      this.fillQuick(quick || []);
      this.renderTags();
      this.updateCurrent();
    } catch (err) {
      console.error('[patina] sidebar:', err);
    }
    // Storage — loaded in the background, after the panel is already rendered.
    requestIdleCallback(() => this.loadStorage());
  }

  async loadStorage() {
    try {
      const storage = await listStorage();
      this.fillStorage(storage || []);
      this.updateCurrent();
    } catch (err) {
      console.error('[patina] sidebar storage:', err);
    }
  }

  /* ── Quick access ───────────────────────────── */

  fillQuick(locations) {
    this._quick = Array.isArray(locations) ? locations.slice() : [];
    this.renderQuick();
  }

  renderQuick() {
    const body = this._quickBody();
    if (!body) return;
    body.innerHTML = '';
    for (const loc of this._quick) {
      body.append(
        el(
          'button',
          {
            class: 'sidebar__item',
            draggable: 'true',
            dataset: { path: loc.path },
            title: loc.path,
          },
          el('span', { class: 'sidebar__ico' }, LOC_ICON[loc.kind] || '📁'),
          el('span', { class: 'sidebar__label' }, loc.label),
        ),
      );
    }
    this.updateCurrent();
  }

  _quickBody() {
    return this.mount.querySelector('[data-section="quick"]');
  }

  _isQuickItem(node) {
    const body = this._quickBody();
    return !!body && body.contains(node);
  }

  /** Insertion index by cursor position (before the item it is hovering over). */
  _insertIndexAt(clientY) {
    const body = this._quickBody();
    if (!body) return 0;
    const items = [...body.querySelectorAll('.sidebar__item')];
    for (let i = 0; i < items.length; i++) {
      const r = items[i].getBoundingClientRect();
      if (clientY < r.top + r.height / 2) return i;
    }
    return items.length;
  }

  _showDropMarker(index) {
    this._clearDropMarker();
    const body = this._quickBody();
    if (!body) return;
    const items = [...body.querySelectorAll('.sidebar__item')];
    if (index >= items.length) body.classList.add('is-drop-end');
    else items[index].classList.add('is-drop-before');
  }

  _clearDropMarker() {
    const body = this._quickBody();
    if (!body) return;
    body.classList.remove('is-drop-end');
    body.querySelectorAll('.is-drop-before').forEach((n) => n.classList.remove('is-drop-before'));
  }

  onQuickDragStart(e) {
    const item = e.target.closest('.sidebar__item');
    if (!item || !this._isQuickItem(item)) return;
    this._dragPath = item.dataset.path;
    this._droppedInside = false;
    this._dragCancelled = false;
    item.classList.add('is-dragging');
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('application/x-patina-quick', this._dragPath);
    // Distinguish Esc from "dropped outside", so cancelling a drag does not remove the item.
    this._escGuard = (ev) => {
      if (ev.key === 'Escape') this._dragCancelled = true;
    };
    window.addEventListener('keydown', this._escGuard, true);
  }

  onQuickDragOver(e) {
    const body = this._quickBody();
    if (!body || !body.contains(e.target)) {
      this._clearDropMarker();
      return;
    }
    const types = e.dataTransfer.types;
    const isQuick = types.includes('application/x-patina-quick');
    const isEntries = types.includes('application/x-patina-entries');
    if (!isQuick && !isEntries) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = isQuick ? 'move' : 'copy';
    this._showDropMarker(this._insertIndexAt(e.clientY));
  }

  onQuickDragLeave(e) {
    const body = this._quickBody();
    if (body && !body.contains(e.relatedTarget)) this._clearDropMarker();
  }

  onQuickDrop(e) {
    const body = this._quickBody();
    if (!body || !body.contains(e.target)) return;
    const types = e.dataTransfer.types;
    const at = this._insertIndexAt(e.clientY);
    if (types.includes('application/x-patina-quick')) {
      e.preventDefault();
      this._droppedInside = true;
      this._reorderQuick(e.dataTransfer.getData('application/x-patina-quick'), at);
    } else if (types.includes('application/x-patina-entries')) {
      e.preventDefault();
      let entries = [];
      try {
        entries = JSON.parse(e.dataTransfer.getData('application/x-patina-entries') || '[]');
      } catch {
        entries = [];
      }
      this._addFolders(entries.filter((x) => x.kind === 'folder'), at);
    }
    this._clearDropMarker();
  }

  onQuickDragEnd() {
    if (this._escGuard) {
      window.removeEventListener('keydown', this._escGuard, true);
      this._escGuard = null;
    }
    const dragged = this._dragPath;
    this._dragPath = null;
    this.mount
      .querySelectorAll('.sidebar__item.is-dragging')
      .forEach((n) => n.classList.remove('is-dragging'));
    this._clearDropMarker();
    // Dropped outside the block (and not an Esc cancel) → remove from quick access.
    if (dragged && !this._droppedInside && !this._dragCancelled) this._removeQuick(dragged);
  }

  _reorderQuick(fromPath, toIndex) {
    const from = this._quick.findIndex((q) => q.path === fromPath);
    if (from < 0) return;
    const [moved] = this._quick.splice(from, 1);
    let to = toIndex;
    if (from < to) to -= 1; // compensate after removing the source
    to = Math.max(0, Math.min(this._quick.length, to));
    this._quick.splice(to, 0, moved);
    this.renderQuick();
    this._saveQuick();
  }

  _addFolders(folders, atIndex) {
    if (!folders || !folders.length) return;
    let at = Math.max(0, Math.min(this._quick.length, atIndex));
    let added = 0;
    for (const f of folders) {
      if (!f.path) continue;
      const dup = this._quick.some((q) => q.path.toLowerCase() === f.path.toLowerCase());
      if (dup) continue;
      this._quick.splice(at, 0, { path: f.path, label: baseLabel(f.path), kind: 'folder' });
      at += 1;
      added += 1;
    }
    if (added) {
      this.renderQuick();
      this._saveQuick();
    } else {
      this.bus.emit('shortcut:hint', { text: t('sidebar.alreadyInQuick'), type: 'warn' });
    }
  }

  _removeQuick(path) {
    const before = this._quick.length;
    this._quick = this._quick.filter((q) => q.path !== path);
    if (this._quick.length !== before) {
      this.renderQuick();
      this._saveQuick();
    }
  }

  async _saveQuick() {
    try {
      await quickAccessSave(this._quick);
    } catch (err) {
      console.error('[patina] quick save:', err);
    }
  }

  /* ── Storage and tags ───────────────────────── */

  fillStorage(disks) {
    const body = this.mount.querySelector('[data-section="storage"]');
    if (!body) return;
    body.innerHTML = '';
    for (const d of disks) {
      const pct = d.total > 0 ? Math.min(100, Math.round((d.used / d.total) * 100)) : 0;
      body.append(
        el(
          'button',
          { class: 'sidebar__store', dataset: { path: d.path }, title: d.path },
          el(
            'div',
            { class: 'sidebar__store-top' },
            el('span', { class: 'sidebar__ico' }, '💽'),
            el('span', { class: 'sidebar__store-name' }, d.name),
            el('span', { class: 'sidebar__store-kind' }, d.kind),
          ),
          el('div', { class: 'sidebar__store-size' }, `${formatSize(d.used)} / ${formatSize(d.total)}`),
          el(
            'div',
            { class: 'sidebar__bar' },
            el('span', { class: 'sidebar__bar-fill', style: `width:${pct}%` }),
          ),
        ),
      );
    }
  }

  renderTags() {
    const body = this.mount.querySelector('[data-section="tags"]');
    if (!body) return;
    body.innerHTML = '';
    for (const tag of TAGS) {
      const count = this._counts[tag.id] || 0;
      const label = tagLabel(tag.id);
      body.append(
        el(
          'button',
          { class: 'sidebar__tagrow', dataset: { tag: tag.id }, title: label },
          el('span', { class: 'sidebar__dot', style: `background:${tag.color}` }),
          el('span', { class: 'sidebar__label' }, label),
          el('span', { class: 'sidebar__count' }, String(count)),
        ),
      );
    }
  }

  async refreshCounts() {
    try {
      this._counts = (await tagCounts()) || {};
      this.renderTags();
      this.updateCurrent();
    } catch (err) {
      console.error('[patina] sidebar counts:', err);
    }
  }

  updateCurrent() {
    const state = this.store.getState();
    const path = getPane(state, getActiveSide(state)).path;
    this.mount.querySelectorAll('[data-path]').forEach((it) => {
      it.classList.toggle('is-current', it.dataset.path === path);
    });
  }

  onClick(e) {
    const toggle = e.target.closest('[data-toggle]');
    if (toggle) {
      const k = toggle.dataset.toggle;
      this._collapsed[k] = !this._collapsed[k];
      const sec = this.mount.querySelector(`[data-sec="${k}"]`);
      if (sec) sec.classList.toggle('is-collapsed', this._collapsed[k]);
      return;
    }
    const item = e.target.closest('[data-path]');
    if (item) return this.bus.emit('location:open', { path: item.dataset.path });
    const tag = e.target.closest('[data-tag]');
    if (tag) this.bus.emit('location:open', { path: `tag:${tag.dataset.tag}` });
  }
}