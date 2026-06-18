import { Component } from '../core/component.js';
import { escapeHtml } from '../core/dom.js';
import { readPreview } from '../api/fs.js';
import { snapshotVersion, listVersions, restoreVersion, deleteVersion } from '../api/versions.js';
import { tagsForPaths } from '../api/tags.js';
import { TAGS } from '../config/tags.js';
import { formatSize, formatDate } from '../lib/format.js';
import { getPane } from '../state/panes.js';
import { getActiveSide } from '../state/tabs.js';
import { parentPath } from '../lib/paths.js';

/**
 * Превью выбранного файла + информация + история версий.
 *
 * Секции (сверху вниз):
 *  1. Превью — миниатюра / текст / «нет превью»
 *  2. FILE INFO — имя, размер, дата изменения, дата создания
 *  3. VERSION HISTORY — список версий v1…vN с бейджем «текущая»
 *  4. Кнопки: Добавить / Сменить / Удалить*
 */
export class PreviewPanel extends Component {
  init() {
    this._open = false;
    this._path = null;
    this._preview = null;   // данные readPreview
    this._versions = [];    // список версий
    this._tags = [];        // id тегов выбранного файла
    this._verBusy = false;  // загрузка версий
    this._snapBusy = false; // создание снимка
    this._selectedVer = null; // id версии для восстановления
    this.mainEl = document.querySelector('.main');

    this.listen('preview:toggle', () => (this._open ? this.close() : this.openNow()));
    this.listen('tags:changed', () => {
      if (this._open) this.refreshTags();
    });
    this.subscribe(() => {
      if (this._open) this.maybeLoad();
    });
    this.on(this.mount, 'click', (e) => this.onClick(e));
  }

  openNow() {
    this._open = true;
    this._path = null;
    this._preview = null;
    this._versions = [];
    this._tags = [];
    if (this.mainEl) this.mainEl.classList.add('has-dock');
    this.renderFrame();
    this.maybeLoad();
  }

  close() {
    this._open = false;
    this._path = null;
    this._preview = null;
    this._versions = [];
    this._tags = [];
    if (this.mainEl) this.mainEl.classList.remove('has-dock');
    this.mount.innerHTML = '';
  }

  selectedPath() {
    const s = this.store.getState();
    const sel = getPane(s, getActiveSide(s)).selected || [];
    return sel.length === 1 ? sel[0] : null;
  }

  async maybeLoad() {
    const path = this.selectedPath();
    if (path === this._path) return;
    this._path = path;
    this._preview = null;
    this._versions = [];
    this._tags = [];
    this._selectedVer = null;
    if (!path) {
      this.renderFrame();
      return;
    }
    // Показываем спиннер
    this.renderFrame();
    try {
      const [preview, versions, tagMap] = await Promise.all([
        readPreview(path),
        listVersions(path).catch(() => []),
        tagsForPaths([path]).catch(() => ({})),
      ]);
      if (this._path !== path) return; // выбор сменился
      this._preview = preview;
      this._versions = versions || [];
      this._tags = (tagMap && tagMap[path]) || [];
      this._selectedVer = null;
      this.renderFrame();
    } catch (err) {
      if (this._path !== path) return;
      this._preview = null;
      this._versions = [];
      this._tags = [];
      this.renderFrame();
    }
  }

  onClick(e) {
    if (e.target.closest('[data-close]')) return this.close();

    // Добавить версию (снимок)
    if (e.target.closest('[data-snap]')) {
      this.doSnapshot();
      return;
    }

    // Восстановить выбранную версию
    if (e.target.closest('[data-restore]')) {
      const btn = e.target.closest('[data-restore]');
      const id = +btn.dataset.restore;
      if (id) this.doRestore(id);
      return;
    }

    // Удалить версию
    if (e.target.closest('[data-del]')) {
      const btn = e.target.closest('[data-del]');
      const id = +btn.dataset.del;
      if (id) this.doDelete(id);
      return;
    }

    // Клик по строке версии — выделить
    const verRow = e.target.closest('[data-ver]');
    if (verRow) {
      this._selectedVer = +verRow.dataset.ver;
      this.renderFrame();
    }
  }

  async doSnapshot() {
    if (!this._path || this._snapBusy) return;
    this._snapBusy = true;
    this.renderFrame();
    try {
      this._versions = (await snapshotVersion(this._path)) || [];
      this.bus.emit('shortcut:hint', 'Снимок создан');
    } catch (err) {
      this.bus.emit('shortcut:hint', err.message || 'Ошибка создания снимка');
    }
    this._snapBusy = false;
    this.renderFrame();
  }

  async doRestore(id) {
    try {
      await restoreVersion(id);
      this.bus.emit('fs:changed', { dirs: [parentPath(this._path)].filter(Boolean) });
      this.bus.emit('shortcut:hint', 'Версия восстановлена');
      await this.refreshVersions();
    } catch (err) {
      this.bus.emit('shortcut:hint', err.message || 'Ошибка восстановления');
    }
  }

  async doDelete(id) {
    try {
      this._versions = (await deleteVersion(id)) || [];
      this.bus.emit('shortcut:hint', 'Версия удалена');
      this._selectedVer = null;
      this.renderFrame();
    } catch (err) {
      this.bus.emit('shortcut:hint', err.message || 'Ошибка удаления');
    }
  }

  async refreshVersions() {
    if (!this._path) return;
    try {
      this._versions = (await listVersions(this._path)) || [];
    } catch { this._versions = []; }
    this.renderFrame();
  }
  
    async refreshTags() {
      if (!this._path) {
        this._tags = [];
        return;
      }
      try {
        const map = await tagsForPaths([this._path]);
        this._tags = (map && map[this._path]) || [];
      } catch { this._tags = []; }
      this.renderFrame();
    }

  // ── Рендер ──────────────────────────────────────────────────
  
  /** Строка «Теги» для секции ИНФОРМАЦИЯ: цветные чипы. Если тегов нет — строка не выводится. */
  tagsRowHtml() {
    const ids = this._tags || [];
    if (!ids.length) return '';

      const byId = new Map(TAGS.map((t) => [t.id, t]));
      const chips = ids.map((id) => {
        const t = byId.get(id);
        const color = t ? t.color : 'var(--tag-archive)';
        const label = escapeHtml(t ? t.label : id);
        return `<span style="display:inline-flex;align-items:center;gap:4px">`
          + `<span class="tag-dot" style="background:${color}"></span>${label}</span>`;
      }).join('');
    const valHtml = `<span class="pv__info-val" style="white-space:normal;display:flex;flex-wrap:wrap;gap:4px 10px;justify-content:flex-end">${chips}</span>`;
    
    return `<div class="pv__info-row">
            <span class="pv__info-key">Теги</span>
            ${valHtml}
          </div>`;
  }

  renderFrame() {
    if (!this._open) return;

    const p = this._preview;
    const path = this._path;
    const vers = this._versions;

    // ── Превью ──
    let previewHtml;
    if (!path) {
      previewHtml = '<div class="pv__msg">Выберите один файл</div>';
    } else if (!p) {
      previewHtml = '<div class="pv__msg">Загрузка…</div>';
    } else if (p.kind === 'image') {
      previewHtml = `<div class="pv__imgwrap"><img class="pv__img" src="${escapeHtml(p.dataUrl || '')}" alt=""></div>`;
    } else if (p.kind === 'text') {
      previewHtml = `<pre class="pv__text">${escapeHtml(p.text || '')}</pre>`;
    } else {
      previewHtml = '<div class="pv__msg">Нет превью</div>';
    }

    // ── FILE INFO ──
    let infoHtml = '';
    if (p) {
      const modifiedStr = p.modified ? formatDate(p.modified) : '—';
      const createdStr = p.created ? formatDate(p.created) : '—';
      infoHtml = `
        <div class="pv__section">ИНФОРМАЦИЯ</div>
        <div class="pv__info">
          <div class="pv__info-row">
            <span class="pv__info-key">Имя</span>
            <span class="pv__info-val" title="${escapeHtml(p.name)}">${escapeHtml(p.name)}</span>
          </div>
          <div class="pv__info-row">
            <span class="pv__info-key">Размер</span>
            <span class="pv__info-val">${formatSize(p.size)}</span>
          </div>
          <div class="pv__info-row">
            <span class="pv__info-key">Изменён</span>
            <span class="pv__info-val pv__info-val--accent">${escapeHtml(modifiedStr)}</span>
          </div>
          <div class="pv__info-row">
            <span class="pv__info-key">Создан</span>
            <span class="pv__info-val">${escapeHtml(createdStr)}</span>
          </div>
          ${this.tagsRowHtml()}
          ${vers.length ? `<div class="pv__info-row">
            <span class="pv__info-key">Версия</span>
            <span class="pv__info-val pv__info-val--teal">${escapeHtml(vers[0].label)} · текущая</span>
          </div>` : ''}
        </div>`;
    }

    // ── VERSION HISTORY ──
    let verHtml = '';
    if (p) {
      let verListHtml;
      if (this._verBusy) {
        verListHtml = '<div class="pv__msg">Загрузка…</div>';
      } else if (vers.length === 0) {
        verListHtml = '<div class="pv__msg">Снимков пока нет</div>';
      } else {
        verListHtml = vers.map((v, i) => {
          const isCurrent = i === 0;
          const isSelected = v.id === this._selectedVer;
          return `<div class="pv__ver-row${isCurrent ? ' pv__ver-row--current' : ''}${isSelected ? ' pv__ver-row--selected' : ''}" data-ver="${v.id}">
            <span class="pv__ver-label${isCurrent ? ' pv__ver-label--current' : ''}">${escapeHtml(v.label)}</span>
            <span class="pv__ver-date">${escapeHtml(formatDate(v.ts))}</span>
            ${isCurrent ? '<span class="pv__ver-badge">текущая</span>' : ''}
          </div>`;
        }).join('');
      }

      verHtml = `
        <div class="pv__section">ИСТОРИЯ ВЕРСИЙ</div>
        <div class="pv__ver-list">${verListHtml}</div>
        <div class="pv__ver-actions">
          <button class="pv__btn pv__btn--accent" data-snap ${this._snapBusy ? 'disabled' : ''}>
            ${this._snapBusy ? '…' : '＋ Добавить'}
          </button>
          <button class="pv__btn" data-restore="${this._selectedVer || ''}" ${!this._selectedVer ? 'disabled' : ''}>
            Сменить
          </button>
          <button class="pv__btn pv__btn--danger" data-del="${this._selectedVer || ''}" ${!this._selectedVer ? 'disabled' : ''}>
            Удалить
          </button>
        </div>`;
    }

    // ── Сборка ──
    this.mount.innerHTML = `
      <div class="pv">
        <div class="pv__head">
          <div class="pv__title" title="${escapeHtml(p?.name || '')}">${escapeHtml(p?.name || 'Превью')}</div>
          <button class="pv__close" data-close title="Закрыть">×</button>
        </div>
        <div class="pv__body">
          ${previewHtml}
          ${infoHtml}
          ${verHtml}
        </div>
      </div>`;
  }
}
