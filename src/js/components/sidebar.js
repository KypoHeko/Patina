import { Component } from '../core/component.js';
import { el } from '../core/dom.js';
import { quickAccess, listStorage } from '../api/system.js';
import { tagCounts } from '../api/tags.js';
import { TAGS } from '../config/tags.js';
import { getPane } from '../state/panes.js';
import { getActiveSide } from '../state/tabs.js';
import { formatSize } from '../lib/format.js';

const LOC_ICON = {
  home: '🏠',
  desktop: '🖥️',
  documents: '📄',
  downloads: '⬇️',
  drive: '💽',
};

// Боковая панель: сворачиваемые секции «Быстрый доступ», «Хранилище», «Теги».
export class Sidebar extends Component {
  init() {
    this._collapsed = { quick: false, storage: false, tags: false };
    this._counts = {};
    this.renderFrame();
    this.on(this.mount, 'click', (e) => this.onClick(e));
    this.subscribe(() => this.updateCurrent());
    this.listen('tags:changed', () => this.refreshCounts());
    this.load();
  }

  renderFrame() {
    this.mount.innerHTML = '';
    this.mount.append(
      this.section('Быстрый доступ', 'quick'),
      this.section('Хранилище', 'storage'),
      this.section('Теги', 'tags'),
    );
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
      el('span', { class: 'sidebar__title' }, title),
    );
    const body = el('div', { class: 'sidebar__body', dataset: { section: key } });
    sec.append(head, body);
    return sec;
  }

  async load() {
    try {
      const [quick, storage, counts] = await Promise.all([
        quickAccess(),
        listStorage(),
        tagCounts(),
      ]);
      this._counts = counts || {};
      this.fillQuick(quick || []);
      this.fillStorage(storage || []);
      this.renderTags();
      this.updateCurrent();
    } catch (err) {
      console.error('[patina] sidebar:', err);
    }
  }

  fillQuick(locations) {
    const body = this.mount.querySelector('[data-section="quick"]');
    if (!body) return;
    body.innerHTML = '';
    for (const loc of locations) {
      body.append(
        el(
          'button',
          { class: 'sidebar__item', dataset: { path: loc.path } },
          el('span', { class: 'sidebar__ico' }, LOC_ICON[loc.kind] || '📁'),
          el('span', { class: 'sidebar__label' }, loc.label),
        ),
      );
    }
  }

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
    for (const t of TAGS) {
      const count = this._counts[t.id] || 0;
      body.append(
        el(
          'button',
          { class: 'sidebar__tagrow', dataset: { tag: t.id }, title: t.label },
          el('span', { class: 'sidebar__dot', style: `background:${t.color}` }),
          el('span', { class: 'sidebar__label' }, t.label),
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
