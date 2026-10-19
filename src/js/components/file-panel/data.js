// FilePanel — async data loading for the current listing: tags and folder sizes.
// Mixed into FilePanel.prototype.

import { tagsForPaths } from '../../api/tags.js';
import { computeDirSizes, dirSizes } from '../../api/dir_size.js';

export const DataMixin = {
  async loadTags(entries) {
    if (!entries.length) return;
    try {
      const map = await tagsForPaths(entries.map((e) => e.path));
      this._tags = map || {};
      this.updateTags();
    } catch {
      /* tags — not critical, silently ignore */
    }
  },

  /** Recompute the sizes of all folders in the current directory (the ∑ button).
   *  While the walk runs a spinner spins on the folders; numbers fill in on completion. */
  async recalcDirSizes() {
    const root = this._lastPane && this._lastPane.path;
    if (!root || root.startsWith('tag:')) return; // tag folders are not on disk
    if (this._dirComputing) return;
    this._dirComputing = true;
    this._dirSizes = new Map(); // recompute — clear the shown values
    this.renderWindow(); // show spinners on folders
    try {
      await computeDirSizes(root);
    } catch {
      /* sizes — not critical, silently ignore */
    }
    this._dirComputing = false;
    await this.loadDirSizes(this._lastPane ? this._lastPane.entries : []);
  },

  /** Fetch already-computed folder sizes for the current list and show them. */
  async loadDirSizes(entries) {
    const folders = (entries || []).filter((e) => e.kind === 'folder').map((e) => e.path);
    if (!folders.length) {
      this._dirSizes = new Map();
      this.renderWindow();
      return;
    }
    try {
      const map = await dirSizes(folders);
      this._dirSizes = new Map(Object.entries(map || {}));
    } catch {
      this._dirSizes = new Map();
    }
    this.renderWindow();
  },
};
