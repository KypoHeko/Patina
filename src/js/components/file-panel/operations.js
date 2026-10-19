// FilePanel — mutating file operations: delete, create folder, inline rename.
// Mixed into FilePanel.prototype.

import { deleteEntries, renameEntry, createFolder, listDir } from '../../api/fs.js';
import { updatePane } from '../../state/panes.js';
import { t } from '../../lib/i18n.js';

export const OperationsMixin = {
  deleteSelected() {
    const paths = this.selectedPaths();
    if (!paths.length) return;
    const dir = this._lastPane.path;
    this.bus.emit('confirm:open', {
      title: t('panel.deleteTitle'),
      message: t('panel.deleteMsg', { n: paths.length }),
      confirmLabel: t('panel.deleteConfirm'),
      danger: true,
      onConfirm: async () => {
        try {
          await deleteEntries(paths);
          this.bus.emit('shortcut:hint', t('common.trashed', { n: paths.length }));
          this.bus.emit('fs:changed', { dirs: [dir] });
        } catch (err) {
          this.bus.emit('shortcut:hint', { text: t('panel.deleteError', { msg: err.message }), type: 'error' });
        }
      },
    });
  },

  async createFolderHere() {
    const pane = this._lastPane;
    if (!pane || !pane.path || pane.path.startsWith('tag:')) {
      this.bus.emit('shortcut:hint', { text: t('panel.noCreateHere'), type: 'warn' });
      return;
    }
    const dir = pane.path;
    try {
      const newPath = await createFolder(dir, t('panel.newFolderName'));
      const entries = await listDir(dir);
      updatePane(this.store, this.side, { entries, selected: [newPath] });
      requestAnimationFrame(() => {
        const idx = this._view.findIndex((e) => e.path === newPath);
        if (idx >= 0) {
          this._cursor = idx;
          this._anchor = newPath;
          this.ensureVisible(idx);
        }
        const entry = (entries || []).find((e) => e.path === newPath);
        if (entry) this.startRename(entry);
      });
    } catch (err) {
      this.bus.emit('shortcut:hint', { text: t('panel.createFolderError', { msg: err.message }), type: 'error' });
    }
  },

  startRename(entry) {
    const row = [...this.listEl.querySelectorAll('.row')].find(
      (r) => r.dataset.path === entry.path,
    );
    if (!row) return;
    this._renaming = entry.path;
    const nameEl = row.querySelector('.row__name');
    const input = document.createElement('input');
    input.className = 'row__rename';
    input.type = 'text';
    input.spellcheck = false;
    input.value = entry.name;
    nameEl.replaceChildren(input);
    input.focus();
    input.select();

    let done = false;
    const finish = async (commit) => {
      if (done) return;
      done = true;
      this._renaming = null;
      const value = input.value.trim();
      input.removeEventListener('keydown', onKey);
      input.removeEventListener('blur', onBlur);
      if (commit && value && value !== entry.name) {
        try {
          await renameEntry(entry.path, value);
          this.bus.emit('fs:changed', { dirs: [this._lastPane.path] });
          return;
        } catch (err) {
          this.bus.emit('shortcut:hint', { text: t('panel.renameError', { msg: err.message }), type: 'error' });
        }
      }
      nameEl.textContent = entry.name;
      // Apply any reload that arrived (and was deferred) during the edit.
      if (this._pendingReload) {
        this._pendingReload = false;
        this.reload();
      }
    };
    const onKey = (e) => {
      if (e.key === 'Enter') finish(true);
      else if (e.key === 'Escape') finish(false);
      e.stopPropagation();
    };
    const onBlur = () => finish(false);
    input.addEventListener('keydown', onKey);
    input.addEventListener('blur', onBlur);
  },
};
