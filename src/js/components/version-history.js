import { Component } from '../core/component.js';
import { escapeHtml } from '../core/dom.js';
import { snapshotVersion, listVersions, restoreVersion } from '../api/versions.js';
import { formatSize, formatDate } from '../lib/format.js';
import { parentPath } from '../lib/paths.js';

// Выдвижная панель истории версий файла (из контекстного меню).
export class VersionHistory extends Component {
  init() {
    this._open = false;
    this._path = '';
    this._name = '';
    this._versions = [];
    this._busy = false;

    this.listen('versions:open', ({ path, name }) => this.open(path, name));
    this.on(document, 'keydown', (e) => {
      if (this._open && e.key === 'Escape') this.close();
    });
    this.on(this.mount, 'click', (e) => this.onClick(e));
  }

  async open(path, name) {
    this._open = true;
    this._path = path;
    this._name = name || path;
    this._versions = [];
    this._busy = true;
    this.render();
    await this.refresh();
  }

  close() {
    if (!this._open) return;
    this._open = false;
    this.mount.innerHTML = '';
  }

  async refresh() {
    this._busy = true;
    this.render();
    try {
      this._versions = (await listVersions(this._path)) || [];
    } catch (err) {
      this.bus.emit('shortcut:hint', err.message);
    }
    this._busy = false;
    this.render();
  }

  async onClick(e) {
    if (e.target.closest('[data-close]')) return this.close();
    if (e.target.closest('[data-snap]')) {
      try {
        this._versions = (await snapshotVersion(this._path)) || [];
        this.bus.emit('shortcut:hint', 'Снимок сделан');
        this.render();
      } catch (err) {
        this.bus.emit('shortcut:hint', err.message);
      }
      return;
    }
    const rest = e.target.closest('[data-restore]');
    if (rest) {
      try {
        await restoreVersion(+rest.dataset.restore);
        this.bus.emit('fs:changed', { dirs: [parentPath(this._path)].filter(Boolean) });
        this.bus.emit('shortcut:hint', 'Версия восстановлена');
        await this.refresh();
      } catch (err) {
        this.bus.emit('shortcut:hint', err.message);
      }
    }
  }

  render() {
    if (!this._open) {
      this.mount.innerHTML = '';
      return;
    }
    const body = this._busy
      ? '<div class="vh__msg">Загрузка…</div>'
      : this._versions.length
        ? this._versions
            .map(
              (v, i) => `<div class="vh__row">
                <div class="vh__meta">
                  <span class="vh__when">${escapeHtml(formatDate(v.ts))}</span>
                  <span class="vh__size">${formatSize(v.size)}${i === 0 ? ' · текущая' : ''}</span>
                </div>
                <button class="vh__restore" data-restore="${v.id}">Восстановить</button>
              </div>`,
            )
            .join('')
        : '<div class="vh__msg">Снимков пока нет</div>';

    this.mount.innerHTML = `
      <div class="vh">
        <div class="vh__head">
          <div>
            <div class="vh__title">История версий</div>
            <div class="vh__sub" title="${escapeHtml(this._path)}">${escapeHtml(this._name)}</div>
          </div>
          <button class="vh__close" data-close title="Закрыть">×</button>
        </div>
        <div class="vh__bar"><button class="vh__snap" data-snap>＋ Сделать снимок</button></div>
        <div class="vh__body">${body}</div>
      </div>`;
  }
}
