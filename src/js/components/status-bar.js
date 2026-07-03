import { Component } from '../core/component.js';
import { escapeHtml } from '../core/dom.js';
import { formatSize } from '../lib/format.js';
import { getPane } from '../state/panes.js';
import { getActiveSide } from '../state/tabs.js';
import { listStorage } from '../api/system.js';
import { t } from '../lib/i18n.js';

const SVG =
  'xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"';
const ICON = {
  folder: `<svg ${SVG}><path d="m6 14 1.45-2.9A2 2 0 0 1 9.24 10H20a2 2 0 0 1 1.94 2.5l-1.55 6a2 2 0 0 1-1.94 1.5H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H18a2 2 0 0 1 2 2v2"/></svg>`,
  keyboard: `<svg ${SVG}><path d="M10 8h.01"/><path d="M12 12h.01"/><path d="M14 8h.01"/><path d="M16 12h.01"/><path d="M18 8h.01"/><path d="M6 8h.01"/><path d="M7 16h10"/><path d="M8 12h.01"/><rect width="20" height="16" x="2" y="4" rx="2"/></svg>`,
  drive: `<svg ${SVG}><line x1="22" x2="2" y1="12" y2="12"/><path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/><line x1="6" x2="6.01" y1="16" y2="16"/><line x1="10" x2="10.01" y1="16" y2="16"/></svg>`,
};

// Status bar: path and counts/selection on the left, key hints and total size on the right.
export class StatusBar extends Component {
  constructor(ctx) {
    super(ctx);
    this._hintTimer = null;
    this._storage = null;
  }

  init() {
    this.subscribe(() => {
      if (!this._hintTimer) this.render();
    });
    this.listen('shortcut:hint', (payload) => {
      // Back-compatible payload: a bare string is an info message; an object
      // { text, type } carries a severity ('info' | 'warn' | 'error').
      if (typeof payload === 'string') this.flash(payload);
      else if (payload) this.flash(payload.text, payload.type);
    });
    this.loadStorage();
    this.render();
    this._cleanups.push(() => clearTimeout(this._hintTimer));
  }

  /** Re-render on language change (unless a hint flash is showing). */
  applyLang() {
    if (!this._hintTimer) this.render();
  }

  async loadStorage() {
    try {
      const disks = (await listStorage()) || [];
      const used = disks.reduce((s, d) => s + (d.used || 0), 0);
      const total = disks.reduce((s, d) => s + (d.total || 0), 0);
      this._storage = total > 0 ? { used, total } : null;
      if (!this._hintTimer) this.render();
    } catch {
      /* no data — we simply do not show the right-hand size section */
    }
  }

  render() {
    const state = this.store.getState();
    const pane = getPane(state, getActiveSide(state));
    const folders = pane.entries.filter((e) => e.kind === 'folder').length;
    const files = pane.entries.length - folders;
    const sep = '<span class="status__sep">·</span>';

    let sel = '';
    if (pane.selected.length) {
      const bytes = pane.entries
        .filter((e) => e.kind !== 'folder' && pane.selected.includes(e.path))
        .reduce((s, e) => s + e.size, 0);
      sel = ` ${sep} <span class="status__sel">${t('status.selected', { n: pane.selected.length })} ${sep} ${formatSize(bytes)}</span>`;
    }

    const storage = this._storage
      ? `<span class="status__group"><span class="status__ico">${ICON.drive}</span>${formatSize(
          this._storage.used,
        )} / ${formatSize(this._storage.total)}</span>`
      : '';

    this.mount.innerHTML =
      `<div class="status__left">` +
      `<span class="status__group status__group--path"><span class="status__ico">${ICON.folder}</span><span class="status__path">${escapeHtml(
        pane.path || '—',
      )}</span></span>` +
      `<span class="status__counts">${t('status.folders', { n: folders })} ${sep} ${t('status.files', { n: files })}${sel}</span>` +
      `</div>` +
      `<div class="status__right">` +
      `<span class="status__group"><span class="status__ico">${ICON.keyboard}</span>` +
      `<kbd class="status__kbd">Ctrl+K</kbd> ${t('status.search')} ${sep} ` +
      `<kbd class="status__kbd">Ctrl+D</kbd> ${t('status.duplicates')} ${sep} ` +
      `<kbd class="status__kbd">Ctrl+G</kbd> ${t('status.links')}</span>` +
      storage +
      `</div>`;
  }
  
    /**
     * Show a transient message in the status bar.
     * @param {string} text
     * @param {'info'|'warn'|'error'} [type='info'] info — success/neutral (emerald);
     *   warn — soft refusal (amber); error — failure (red, larger, shown ~2x longer).
     */
    flash(text, type = 'info') {
      clearTimeout(this._hintTimer);
      const cls = type === 'info' ? 'status__hint' : `status__hint status__hint--${type}`;
      this.mount.innerHTML = `<span class="${cls}">${escapeHtml(text)}</span>`;
      // Errors and warnings linger so they are not missed; info stays brief.
      const ms = type === 'error' ? 3600 : type === 'warn' ? 2600 : 1800;
      this._hintTimer = setTimeout(() => {
        this._hintTimer = null;
        this.render();
      }, ms);
    }
  }
  