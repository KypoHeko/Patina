import { Component } from '../core/component.js';
import { escapeHtml } from '../core/dom.js';
import { findDuplicates } from '../api/duplicates.js';
import { onEvent } from '../api/events.js';
import { deleteEntries } from '../api/fs.js';
import { formatSize } from '../lib/format.js';
import { parentPath, folderName } from '../lib/paths.js';
import { getPane } from '../state/panes.js';
import { getActiveSide } from '../state/tabs.js';
import { t } from '../lib/i18n.js';

// Slide-out duplicate-search panel (Ctrl+D) for the active panel's folder.
export class DuplicatePanel extends Component {
  init() {
    this._open = false;
    this._loading = false;
    this._groups = [];
    this._dir = '';
    this._progress = null;
    this.mainEl = document.querySelector('.main');

    this.listen('duplicates:open', () => (this._open ? this.close() : this.open()));
    this.on(document, 'keydown', (e) => {
      if (this._open && e.key === 'Escape') this.close();
    });
    this.on(this.mount, 'click', (e) => this.onClick(e));

    // Hashing progress from the backend — update the indicator without
    // re-rendering the whole panel on every tick.
    onEvent('dups:progress', (p) => this.onProgress(p)).then((un) => this._cleanups.push(un));
  }

  open() {
    const state = this.store.getState();
    this._dir = getPane(state, getActiveSide(state)).path;
    this._open = true;
    document.getElementById('duplicates-btn')?.classList.add('is-on');
    this._loading = true;
    this._groups = [];
    this._progress = null;
    if (this.mainEl) this.mainEl.classList.add('has-dup');
    this.render();
    this.scan();
  }

  async scan() {
    try {
      this._groups = (await findDuplicates(this._dir)) || [];
    } catch (err) {
      this.bus.emit('shortcut:hint', { text: t('dup.scanError', { msg: err.message }), type: 'error' });
      this._groups = [];
    }
    this._loading = false;
    this.render();
  }

  onProgress(p) {
    this._progress = p;
    if (!this._open || !this._loading) return;
    // Update only the progress line in place (without re-rendering the panel).
    const el = this.mount.querySelector('.dup__progress');
    if (el) el.textContent = this.progressText();
    else this.render();
  }

  progressText() {
    const p = this._progress;
    return p && p.total ? t('dup.hashing', { done: p.done, total: p.total }) : t('dup.scanning');
  }

  close() {
    if (!this._open) return;
    this._open = false;
    document.getElementById('duplicates-btn')?.classList.remove('is-on');
    if (this.mainEl) this.mainEl.classList.remove('has-dup');
    this.mount.innerHTML = '';
  }

  async removePaths(paths) {
    if (!paths.length) return;
    try {
      await deleteEntries(paths);
      const dirs = [...new Set(paths.map((p) => parentPath(p)).filter(Boolean))];
      this.bus.emit('fs:changed', { dirs });
      this.bus.emit('shortcut:hint', t('common.trashed', { n: paths.length }));
      const gone = new Set(paths);
      this._groups = this._groups
        .map((g) => ({ ...g, paths: g.paths.filter((p) => !gone.has(p)) }))
        .filter((g) => g.paths.length > 1);
      this.render();
    } catch (err) {
      this.bus.emit('shortcut:hint', { text: t('panel.deleteError', { msg: err.message }), type: 'error' });
    }
  }

  onClick(e) {
    if (e.target.closest('[data-close]')) return this.close();

    const keep = e.target.closest('[data-keepfirst]');
    if (keep) {
      const g = this._groups[+keep.dataset.keepfirst];
      if (!g) return;
      const paths = g.paths.slice(1);
      if (!paths.length) return;
      // H1 (frontend): "Keep first" silently deletes N-1 files. Route through
      // the same confirm dialog the rest of the app uses for destructive
      // operations — a misclick on a long list should not send files to the
      // Recycle Bin without a chance to cancel.
      this.bus.emit('confirm:open', {
        title: t('dup.confirm.title'),
        message: t('dup.confirm.keepMsg', { n: paths.length }),
        confirmLabel: t('panel.deleteConfirm'),
        danger: true,
        onConfirm: () => this.removePaths(paths),
      });
      return;
    }
    const del = e.target.closest('[data-del]');
    if (del) {
      const path = del.dataset.del;
      // Single-file deletion in a duplicate group. Still destructive (the file
      // goes to the Recycle Bin), still worth a confirm — but lighter wording.
      this.bus.emit('confirm:open', {
        title: t('dup.confirm.title'),
        message: t('dup.confirm.delMsg', { name: folderName(path) || path }),
        confirmLabel: t('panel.deleteConfirm'),
        danger: true,
        onConfirm: () => this.removePaths([path]),
      });
    }
  }

  /** Re-render on language change. Preserves the found groups. */
  applyLang() {
    if (!this._open) return;
    this.render();
  }

  render() {
    if (!this._open) {
      this.mount.innerHTML = '';
      return;
    }
    // Preserve scroll position across re-renders: acting on Keep/Delete deep in
    // a long list must not snap the view back to the top.
    const prevScroll = this.mount.querySelector('.dup__body')?.scrollTop || 0;
    const total = this._groups.reduce((n, g) => n + g.paths.length - 1, 0);
    const body = this._loading
      ? `<div class="dup__msg"><span class="dup__spinner" aria-hidden="true"></span><span class="dup__progress">${this.progressText()}</span></div>`
      : this._groups.length
        ? this._groups.map((g, i) => this.renderGroup(g, i)).join('')
        : `<div class="dup__msg">${t('dup.none')}</div>`;

    this.mount.innerHTML = `
      <div class="dup">
        <div class="dup__head">
          <div>
            <div class="dup__title">${t('dup.title')}</div>
            <div class="dup__sub" title="${escapeHtml(this._dir)}">${escapeHtml(folderName(this._dir) || this._dir)}${
              !this._loading && total ? ` · ${t('dup.canFree', { n: total })}` : ''
            }</div>
          </div>
          <button class="dup__close" data-close title="${t('tab.close')}">×</button>
        </div>
        <div class="dup__body">${body}</div>
      </div>`;

    if (prevScroll) {
      const bodyEl = this.mount.querySelector('.dup__body');
      if (bodyEl) bodyEl.scrollTop = prevScroll;
    }
  }

  renderGroup(g, i) {
    const files = g.paths
      .map((p, idx) => {
        const tag = idx === 0 ? `<span class="dup__keep">${t('dup.keep')}</span>` : '';
        return `<div class="dup__file">
            <span class="dup__path" title="${escapeHtml(p)}">${escapeHtml(p)}</span>
            ${tag}
            <button class="dup__del" data-del="${escapeHtml(p)}" title="${t('dup.delTitle')}">×</button>
          </div>`;
      })
      .join('');
    return `<div class="dup__group">
        <div class="dup__group-head">
          <span>${t('dup.copies', { n: g.paths.length })} · ${formatSize(g.size)}</span>
          <button class="dup__keepbtn" data-keepfirst="${i}">${t('dup.keepFirst')}</button>
        </div>
        ${files}
      </div>`;
  }
}
