import { Component } from '../core/component.js';
import { escapeHtml } from '../core/dom.js';
import { readPreview } from '../api/fs.js';
import { assetUrl } from '../api/invoke.js';
import { snapshotVersion, listVersions, restoreVersion, deleteVersion } from '../api/versions.js';
import { tagsForPaths } from '../api/tags.js';
import { TAGS } from '../config/tags.js';
import { formatSize, formatDate } from '../lib/format.js';
import { getPane } from '../state/panes.js';
import { getActiveSide } from '../state/tabs.js';
import { parentPath } from '../lib/paths.js';
import { t, tagLabel } from '../lib/i18n.js';

/**
 * Preview of the selected file + info + version history.
 *
 * Sections (top to bottom):
 *  1. Preview — thumbnail / text / "no preview"
 *  2. FILE INFO — name, size, modified date, created date
 *  3. VERSION HISTORY — list of versions v1…vN with a "current" badge
 *  4. Buttons: Add / Replace / Delete*
 */
export class PreviewPanel extends Component {
  init() {
    this._open = false;
    this._path = null;
    this._preview = null;   // readPreview data
    this._versions = [];    // list of versions
    this._tags = [];        // tag ids of the selected file
    this._verBusy = false;  // loading versions
    this._snapBusy = false; // creating a snapshot
    this._selectedVer = null; // version id for restore/delete
    this._currentVerId = null; // id of the version matching the current file
    this.mainEl = document.querySelector('.main');

    this.listen('preview:toggle', () => (this._open ? this.close() : this.openNow()));
    this.listen('tags:changed', () => {
      if (this._open) this.refreshTags();
    });
    // External file changes (external editor, restore from elsewhere, etc.) —
    // re-read the whole preview: text, metadata, versions, tags.
    // Without this the preview shows stale content after a save in an external
    // editor or after a restore from the adjacent pane.
    this.listen('fs:changed', ({ dirs }) => {
      if (!this._open || !this._path) return;
      const parent = parentPath(this._path);
      if (parent && dirs.includes(parent)) this.refreshPreview();
    });
    this.subscribe(() => {
      if (this._open) this.maybeLoad();
    });
    this.on(this.mount, 'click', (e) => this.onClick(e));
  }

  openNow() {
    this._open = true;
    document.getElementById('preview-btn')?.classList.add('is-on');
    this._path = null;
    this._preview = null;
    this._versions = [];
    this._tags = [];
    this._currentVerId = null;
    if (this.mainEl) this.mainEl.classList.add('has-dock');
    this.renderFrame();
    this.maybeLoad();
  }

  close() {
    this._open = false;
    document.getElementById('preview-btn')?.classList.remove('is-on');
    this._path = null;
    this._preview = null;
    this._versions = [];
    this._tags = [];
    this._currentVerId = null;
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
    this._currentVerId = null; // reset: for a new file we don't know the "current" one yet
    if (!path) {
      this.renderFrame();
      return;
    }
    // Show the spinner
    this.renderFrame();
    try {
      const [preview, versions, tagMap] = await Promise.all([
        readPreview(path),
        listVersions(path).catch(() => []),
        tagsForPaths([path]).catch(() => ({})),
      ]);
      if (this._path !== path) return; // selection changed
      this._preview = preview;
      this._versions = versions || [];
      this._tags = (tagMap && tagMap[path]) || [];
      this._selectedVer = null;
      // By default the "current" one is the newest version (we assume the file
      // matches it if the preview was just opened). After a restore,
      // _currentVerId is overridden in doRestore.
      this._currentVerId = this._versions[0]?.id || null;
      this.renderFrame();
    } catch (err) {
      if (this._path !== path) return;
      this._preview = null;
      this._versions = [];
      this._tags = [];
      this._currentVerId = null;
      this.renderFrame();
    }
  }
  
    /**
     * Re-read the preview, versions, tags and "current" version for the already open file.
     *
     * Used:
     *  - after doSnapshot (the file is unchanged, but a new version was added, and
     *    mtime / size may have changed — the preview must be fresh);
     *  - after doRestore (the file was overwritten, content and metadata changed);
     *  - on the fs:changed event (an external editor saved the file).
     *
     * Preserves _path and _selectedVer; updates everything else.
     */
    async refreshPreview() {
      if (!this._path) return;
      const path = this._path;
      // Preserve selectedVer — the user may have selected a version row.
      const savedSel = this._selectedVer;
      try {
        const [preview, versions, tagMap] = await Promise.all([
          readPreview(path),
          listVersions(path).catch(() => []),
          tagsForPaths([path]).catch(() => ({})),
        ]);
        if (this._path !== path) return; // selection changed while the request was in flight
        this._preview = preview;
        this._versions = versions || [];
        this._tags = (tagMap && tagMap[path]) || [];
        this._selectedVer = savedSel;
        // The "current" version is the one matching the file. If we just did a
        // restore or snapshot, the caller already set _currentVerId explicitly
        // before calling refreshPreview; otherwise we assume the newest (default).
        if (!this._versions.some(v => v.id === this._currentVerId)) {
          this._currentVerId = this._versions[0]?.id || null;
        }
        this.renderFrame();
      } catch {
        if (this._path !== path) return;
        // Re-read failed — keep the previous state so the user does not see an
        // empty panel because of a transient error.
      }
    }

  onClick(e) {
    if (e.target.closest('[data-close]')) return this.close();

    // Add a version (snapshot)
    if (e.target.closest('[data-snap]')) {
      this.doSnapshot();
      return;
    }

    // Restore the selected version
    if (e.target.closest('[data-restore]')) {
      const btn = e.target.closest('[data-restore]');
      const id = +btn.dataset.restore;
      if (!id) return;
      // H2 (frontend): restoring a version overwrites the live file. The
      // backend takes a safety snapshot first (C3 invariant), so the data is
      // recoverable, but the UI gave no warning — a user browsing old versions
      // who clicks "Switch" (RU: "Сменить") silently replaced their current
      // file. Gate the action behind the same confirm dialog used elsewhere.
      const ver = this._versions.find((v) => v.id === id);
      const label = ver?.label || '';
      this.bus.emit('confirm:open', {
        title: t('pv.restoreTitle'),
        message: t('pv.restoreConfirm', { label }),
        confirmLabel: t('pv.btn.restore'),
        danger: true,
        onConfirm: () => this.doRestore(id),
      });
      return;
    }

    // Delete a version
    if (e.target.closest('[data-del]')) {
      const btn = e.target.closest('[data-del]');
      const id = +btn.dataset.del;
      if (id) this.doDelete(id);
      return;
    }

    // Click on a version row — select it
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
      // The new snapshot becomes the "current" version — the file did not change,
      // we just saved its state.
      this._currentVerId = this._versions[0]?.id || null;
      this.bus.emit('shortcut:hint', t('pv.snapshotCreated'));
      // Re-read the whole preview: after a snapshot the file may have a new
      // mtime/size (even though the content is the same), and the preview should
      // show fresh metadata + the current text (in case it changed between
      // opening the preview and clicking "Add version").
      await this.refreshPreview();
    } catch (err) {
      this.bus.emit('shortcut:hint', { text: err.message || t('pv.snapshotError'), type: 'error' });
    }
    this._snapBusy = false;
    this.renderFrame();
  }

  async doRestore(id) {
    try {
      await restoreVersion(id);
      // After a restore the file matches the selected version — mark it as the
      // "current" one in the UI. The backend's do_snapshot checked has_hash_for_path
      // and did not create a duplicate if the state was already saved.
      this._currentVerId = id;
      this.bus.emit('fs:changed', { dirs: [parentPath(this._path)].filter(Boolean) });
      this.bus.emit('shortcut:hint', t('pv.versionRestored'));
      // Re-read the preview: the file content changed (restore overwrote it),
      // mtime was updated, size may have changed. refreshPreview will show the
      // fresh text and metadata. The fs:changed above also triggers refreshPreview
      // (via the subscription), but it's cheap — Promise.all parallelizes the requests.
      await this.refreshPreview();
    } catch (err) {
          this.bus.emit('shortcut:hint', { text: err.message || t('pv.restoreError'), type: 'error' });
    }
  }

  async doDelete(id) {
    try {
      this._versions = (await deleteVersion(id)) || [];
      this.bus.emit('shortcut:hint', t('pv.versionDeleted'));
      this._selectedVer = null;
      // If the "current" version was deleted — reset to the newest of the remaining ones.
      if (this._currentVerId === id || !this._versions.some(v => v.id === this._currentVerId)) {
        this._currentVerId = this._versions[0]?.id || null;
      }
      this.renderFrame();
    } catch (err) {
          this.bus.emit('shortcut:hint', { text: err.message || t('pv.deleteError'), type: 'error' });
    }
  }

  async refreshVersions() {
    if (!this._path) return;
    try {
      this._versions = (await listVersions(this._path)) || [];
      // If _currentVerId is no longer in the list (deleted?) — reset to the newest.
      if (this._currentVerId && !this._versions.some(v => v.id === this._currentVerId)) {
        this._currentVerId = this._versions[0]?.id || null;
      }
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

  // ── Render ──────────────────────────────────────────────────

  /** The "Tags" row for the INFO section: colored chips. If there are no tags, the row is not rendered. */
  tagsRowHtml() {
    const ids = this._tags || [];
    if (!ids.length) return '';

      const chips = ids.map((id) => {
        const label = escapeHtml(tagLabel(id));
        const color = TAGS.find((x) => x.id === id)?.color || 'var(--tag-archive)';
        return `<span style="display:inline-flex;align-items:center;gap:4px">`
          + `<span class="tag-dot" style="background:${color}"></span>${label}</span>`;
      }).join('');
    const valHtml = `<span class="pv__info-val" style="white-space:normal;display:flex;flex-wrap:wrap;gap:4px 10px;justify-content:flex-end">${chips}</span>`;
    
    return `<div class="pv__info-row">
            <span class="pv__info-key">${escapeHtml(t('pv.info.tags'))}</span>
            ${valHtml}
          </div>`;
  }

  renderFrame() {
    if (!this._open) return;

    const p = this._preview;
    const path = this._path;
    const vers = this._versions;
    // The current version is the one matching the file on disk. By default it's
    // the newest; after a restore or snapshot _currentVerId points to it explicitly.
    const currentVersion = vers.find(v => v.id === this._currentVerId) || vers[0];

    // ── Preview ──
    let previewHtml;
    if (!path) {
      previewHtml = `<div class="pv__msg">${escapeHtml(t('pv.selectFile'))}</div>`;
    } else if (!p) {
      previewHtml = `<div class="pv__msg">${escapeHtml(t('common.loading'))}</div>`;
    } else if (p.kind === 'image') {
          // Prefer the cached thumbnail via the asset protocol (streamed by the web
          // engine, no base64 over IPC). SVG and any fallback still arrive inline.
          const src = p.thumbPath ? assetUrl(p.thumbPath) : (p.dataUrl || '');
      previewHtml = `<div class="pv__imgwrap"><img class="pv__img" src="${escapeHtml(src)}" alt=""></div>`;
    } else if (p.kind === 'text') {
      previewHtml = `<pre class="pv__text">${escapeHtml(p.text || '')}</pre>`;
    } else {
      previewHtml = `<div class="pv__msg">${escapeHtml(t('pv.noPreview'))}</div>`;
    }

    // ── FILE INFO ──
    let infoHtml = '';
    if (p) {
      const modifiedStr = p.modified ? formatDate(p.modified) : '—';
      const createdStr = p.created ? formatDate(p.created) : '—';
      infoHtml = `
        <div class="pv__section">${escapeHtml(t('pv.infoSection'))}</div>
        <div class="pv__info">
          <div class="pv__info-row">
            <span class="pv__info-key">${escapeHtml(t('pv.info.name'))}</span>
            <span class="pv__info-val" title="${escapeHtml(p.name)}">${escapeHtml(p.name)}</span>
          </div>
          <div class="pv__info-row">
            <span class="pv__info-key">${escapeHtml(t('pv.info.size'))}</span>
            <span class="pv__info-val">${formatSize(p.size)}</span>
          </div>
          <div class="pv__info-row">
            <span class="pv__info-key">${escapeHtml(t('pv.info.modified'))}</span>
            <span class="pv__info-val pv__info-val--accent">${escapeHtml(modifiedStr)}</span>
          </div>
          <div class="pv__info-row">
            <span class="pv__info-key">${escapeHtml(t('pv.info.created'))}</span>
            <span class="pv__info-val">${escapeHtml(createdStr)}</span>
          </div>
          ${this.tagsRowHtml()}
          ${vers.length ? `<div class="pv__info-row">
            <span class="pv__info-key">${escapeHtml(t('pv.info.version'))}</span>
            <span class="pv__info-val pv__info-val--teal">${escapeHtml(currentVersion?.label || '—')} · ${escapeHtml(t('pv.info.current'))}</span>
          </div>` : ''}
        </div>`;
    }

    // ── VERSION HISTORY ──
    let verHtml = '';
    if (p) {
      let verListHtml;
      if (this._verBusy) {
        verListHtml = `<div class="pv__msg">${escapeHtml(t('common.loading'))}</div>`;
      } else if (vers.length === 0) {
        verListHtml = `<div class="pv__msg">${escapeHtml(t('pv.versions.empty'))}</div>`;
      } else {
        verListHtml = vers.map((v, i) => {
          const isCurrent = v.id === currentVersion?.id;
          const isSelected = v.id === this._selectedVer;
          return `<div class="pv__ver-row${isCurrent ? ' pv__ver-row--current' : ''}${isSelected ? ' pv__ver-row--selected' : ''}" data-ver="${v.id}">
            <span class="pv__ver-label${isCurrent ? ' pv__ver-label--current' : ''}">${escapeHtml(v.label)}</span>
            <span class="pv__ver-date">${escapeHtml(formatDate(v.ts))}</span>
            ${isCurrent ? `<span class="pv__ver-badge">${escapeHtml(t('pv.info.current'))}</span>` : ''}
          </div>`;
        }).join('');
      }

      verHtml = `
        <div class="pv__section">${escapeHtml(t('pv.versionsSection'))}</div>
        <div class="pv__ver-list">${verListHtml}</div>
        <div class="pv__ver-actions">
          <button class="pv__btn pv__btn--accent" data-snap ${this._snapBusy ? 'disabled' : ''}>
            ${this._snapBusy ? '…' : escapeHtml(t('pv.btn.add'))}
          </button>
          <button class="pv__btn" data-restore="${this._selectedVer || ''}" ${!this._selectedVer ? 'disabled' : ''}>
            ${escapeHtml(t('pv.btn.restore'))}
          </button>
          <button class="pv__btn pv__btn--danger" data-del="${this._selectedVer || ''}" ${!this._selectedVer ? 'disabled' : ''}>
            ${escapeHtml(t('pv.btn.delete'))}
          </button>
        </div>`;
    }

    // ── Assembly ──
    this.mount.innerHTML = `
      <div class="pv">
        <div class="pv__head">
          <div class="pv__title" title="${escapeHtml(p?.name || '')}">${escapeHtml(p?.name || t('pv.title'))}</div>
          <button class="pv__close" data-close title="${escapeHtml(t('common.close'))}">×</button>
        </div>
        <div class="pv__body">
          ${previewHtml}
          ${infoHtml}
          ${verHtml}
        </div>
      </div>`;
  }

  /** Re-render on language change. Preserves the path, versions, tags. */
  applyLang() {
    if (!this._open) return;
    this.renderFrame();
  }
}
