import { Component } from '../core/component.js';
import { escapeHtml } from '../core/dom.js';
import { readPreview } from '../api/fs.js';
import { getPane } from '../state/panes.js';
import { getActiveSide } from '../state/tabs.js';

// Превью выбранного файла активной панели. Тоггл из топбара.
export class PreviewPanel extends Component {
  init() {
    this._open = false;
    this._path = null;
    this.mainEl = document.querySelector('.main');
    this.listen('preview:toggle', () => (this._open ? this.close() : this.openNow()));
    this.subscribe(() => {
      if (this._open) this.maybeLoad();
    });
  }

  openNow() {
    this._open = true;
    this._path = null;
    if (this.mainEl) this.mainEl.classList.add('has-dock');
    this.renderFrame('');
    this.maybeLoad();
  }

  close() {
    this._open = false;
    this._path = null;
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
    if (!path) {
      this.renderFrame('<div class="pv__msg">Выберите один файл</div>');
      return;
    }
    this.renderFrame('<div class="pv__msg">Загрузка…</div>');
    try {
      const p = await readPreview(path);
      if (this._path !== path) return; // выбор сменился
      this.renderContent(p);
    } catch (err) {
      this.renderFrame(`<div class="pv__msg">${escapeHtml(err.message)}</div>`);
    }
  }

  renderContent(p) {
    let body;
    if (p.kind === 'image') body = `<div class="pv__imgwrap"><img class="pv__img" src="${p.dataUrl}" alt=""></div>`;
    else if (p.kind === 'text') body = `<pre class="pv__text">${escapeHtml(p.text || '')}</pre>`;
    else body = '<div class="pv__msg">Нет превью для этого типа</div>';
    this.renderFrame(body, p.name);
  }

  renderFrame(body, name) {
    if (!this._open) return;
    this.mount.innerHTML = `
      <div class="pv">
        <div class="pv__head">
          <div class="pv__title" title="${escapeHtml(name || '')}">${escapeHtml(name || 'Превью')}</div>
          <button class="pv__close" data-close title="Закрыть">×</button>
        </div>
        <div class="pv__body">${body}</div>
      </div>`;
    const c = this.mount.querySelector('[data-close]');
    if (c) c.addEventListener('click', () => this.close());
  }
}
