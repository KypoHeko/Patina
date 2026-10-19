// FilePanel — navigation & history.
// Mixed into FilePanel.prototype; all methods run with `this` bound to the panel.

import { listDir } from '../../api/fs.js';
import { listTag } from '../../api/tags.js';
import { openPath } from '../../api/system.js';
import { updatePane, recordHistory, selectInPane, stepHistory } from '../../state/panes.js';
import { parentPath } from '../../lib/paths.js';
import { t } from '../../lib/i18n.js';

export const NavigationMixin = {
  async navigate(path, { record = true } = {}) {
    // Re-render of the same folder (e.g. after fs:changed from restore_version):
    // keep the selection, otherwise restore would clear it. For a new folder
    // selected is reset as before.
    const isReload = this._lastPane?.path === path;
    const prevSelected = isReload ? [...(this._lastPane?.selected || [])] : [];

    // Reset the filter on navigation — so we do not "catch" an old search in
    // the new folder. The input updates via sync().
    if (this.store.getState().searchQuery) {
      this.store.setState({ searchQuery: '' });
    }
    updatePane(this.store, this.side, { loading: true, error: null });
    try {
      const entries = path.startsWith('tag:') ? await listTag(path.slice(4)) : await listDir(path);
      this._tags = {}; // reset the previous folder's tags
      this._anchor = null;
      // Keep in the selection only the paths still present in the listing —
      // e.g. after restore the file is the same, but after deletion it is gone.
      const existing = new Set(entries.map((e) => e.path));
      const selected = prevSelected.filter((p) => existing.has(p));
      updatePane(this.store, this.side, { path, entries, selected, loading: false });
      if (record) recordHistory(this.store, this.side, path);
    } catch (err) {
      updatePane(this.store, this.side, { loading: false, error: err.message });
    }
  },

  /** Reveal a file from the graph: navigate to its folder and select it there.
   *  For a drive root (no parent) we simply open it as a folder. */
  async revealPath(path) {
    const parent = parentPath(path);
    if (parent) {
      await this.navigate(parent);
      selectInPane(this.store, this.side, [path]);
    } else {
      await this.navigate(path);
    }
  },

  reload() {
    if (this._lastPane?.path) this.navigate(this._lastPane.path, { record: false });
  },

  goBack() {
    const target = stepHistory(this.store, this.side, -1);
    if (target != null) this.navigate(target, { record: false });
  },

  goForward() {
    const target = stepHistory(this.store, this.side, +1);
    if (target != null) this.navigate(target, { record: false });
  },

  async activate(entry) {
    if (entry.kind === 'folder') {
      this.navigate(entry.path);
      return;
    }
    try {
      await openPath(entry.path);
    } catch (err) {
      this.bus.emit('shortcut:hint', { text: t('panel.openError', { msg: err.message }), type: 'error' });
    }
  },
};
