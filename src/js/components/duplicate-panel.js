import { Component } from '../core/component.js';
import { escapeHtml } from '../core/dom.js';
import { findDuplicates } from '../api/duplicates.js';
import { deleteEntries } from '../api/fs.js';
import { formatSize } from '../lib/format.js';
import { parentPath, folderName } from '../lib/paths.js';
import { getPane } from '../state/panes.js';
import { getActiveSide } from '../state/tabs.js';

// Выдвижная панель поиска дубликатов (Ctrl+D) по папке активной панели.
export class DuplicatePanel extends Component {
  init() {
    this._open = false;
    this._loading = false;
    this._groups = [];
    this._dir = '';
    this.mainEl = document.querySelector('.main');

    this.listen('duplicates:open', () => (this._open ? this.close() : this.open()));
    this.on(document, 'keydown', (e) => {
      if (this._open && e.key === 'Escape') this.close();
    });
    this.on(this.mount, 'click', (e) => this.onClick(e));
  }

  open() {
    const state = this.store.getState();
    this._dir = getPane(state, getActiveSide(state)).path;
    this._open = true;
    this._loading = true;
    this._groups = [];
    if (this.mainEl) this.mainEl.classList.add('has-dup');
    this.render();
    this.scan();
  }

  async scan() {
    try {
      this._groups = (await findDuplicates(this._dir)) || [];
    } catch (err) {
      this.bus.emit('shortcut:hint', `Ошибка поиска: ${err.message}`);
      this._groups = [];
    }
    this._loading = false;
    this.render();
  }

  close() {
    if (!this._open) return;
    this._open = false;
    if (this.mainEl) this.mainEl.classList.remove('has-dup');
    this.mount.innerHTML = '';
  }

  async removePaths(paths) {
    if (!paths.length) return;
    try {
      await deleteEntries(paths);
      const dirs = [...new Set(paths.map((p) => parentPath(p)).filter(Boolean))];
      this.bus.emit('fs:changed', { dirs });
      this.bus.emit('shortcut:hint', `В корзину: ${paths.length}`);
      const gone = new Set(paths);
      this._groups = this._groups
        .map((g) => ({ ...g, paths: g.paths.filter((p) => !gone.has(p)) }))
        .filter((g) => g.paths.length > 1);
      this.render();
    } catch (err) {
      this.bus.emit('shortcut:hint', `Ошибка удаления: ${err.message}`);
    }
  }

  onClick(e) {
    if (e.target.closest('[data-close]')) return this.close();

    const keep = e.target.closest('[data-keepfirst]');
    if (keep) {
      const g = this._groups[+keep.dataset.keepfirst];
      if (g) this.removePaths(g.paths.slice(1));
      return;
    }
    const del = e.target.closest('[data-del]');
    if (del) this.removePaths([del.dataset.del]);
  }

  render() {
    if (!this._open) {
      this.mount.innerHTML = '';
      return;
    }
    const total = this._groups.reduce((n, g) => n + g.paths.length - 1, 0);
    const body = this._loading
      ? '<div class="dup__msg">Сканирование…</div>'
      : this._groups.length
        ? this._groups.map((g, i) => this.renderGroup(g, i)).join('')
        : '<div class="dup__msg">Дубликаты не найдены</div>';

    this.mount.innerHTML = `
      <div class="dup">
        <div class="dup__head">
          <div>
            <div class="dup__title">Дубликаты</div>
            <div class="dup__sub" title="${escapeHtml(this._dir)}">${escapeHtml(folderName(this._dir) || this._dir)}${
              !this._loading && total ? ` · можно освободить ${total} копий` : ''
            }</div>
          </div>
          <button class="dup__close" data-close title="Закрыть">×</button>
        </div>
        <div class="dup__body">${body}</div>
      </div>`;
  }

  renderGroup(g, i) {
    const files = g.paths
      .map((p, idx) => {
        const tag = idx === 0 ? '<span class="dup__keep">оставить</span>' : '';
        return `<div class="dup__file">
            <span class="dup__path" title="${escapeHtml(p)}">${escapeHtml(p)}</span>
            ${tag}
            <button class="dup__del" data-del="${escapeHtml(p)}" title="Удалить в корзину">×</button>
          </div>`;
      })
      .join('');
    return `<div class="dup__group">
        <div class="dup__group-head">
          <span>${g.paths.length} копий · ${formatSize(g.size)}</span>
          <button class="dup__keepbtn" data-keepfirst="${i}">Оставить первый</button>
        </div>
        ${files}
      </div>`;
  }
}
