// FilePanel — drag and drop (within and between panels).
// Mixed into FilePanel.prototype.

import { startDrag, getDrag, clearDrag } from '../../state/drag.js';
import { copyEntries, moveEntries, checkConflicts } from '../../api/fs.js';
import { parentPath, folderName } from '../../lib/paths.js';
import { t } from '../../lib/i18n.js';

export const DndMixin = {
  onDragStart(e) {
    const row = e.target.closest('.row');
    if (!row) return;
    const path = row.dataset.path;
    const selected = this.selectedPaths();
    const paths = selected.includes(path) && selected.length > 1 ? [...selected] : [path];
    startDrag(paths, this.side);
    e.dataTransfer.effectAllowed = 'copyMove';
    e.dataTransfer.setData('text/plain', paths.join('\n'));
    const dragged = paths.map((p) => {
      const en = (this._lastPane?.entries || []).find((x) => x.path === p);
      return { path: p, kind: en ? en.kind : '' };
    });
    e.dataTransfer.setData('application/x-patina-entries', JSON.stringify(dragged));
  },

  onDragOver(e) {
    if (!getDrag()) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = e.ctrlKey ? 'copy' : 'move';
    this.panelEl.classList.add('is-drop');
    const folderRow = e.target.closest('.row[data-kind="folder"]');
    if (this._dropRow && this._dropRow !== folderRow) this._dropRow.classList.remove('is-drop-into');
    if (folderRow) folderRow.classList.add('is-drop-into');
    this._dropRow = folderRow || null;
  },

  onDragLeave(e) {
    if (!this.panelEl.contains(e.relatedTarget)) this.clearDropHighlight();
  },

  onDrop(e) {
    if (!getDrag()) return;
    e.preventDefault();
    const { paths } = getDrag();
    const copy = e.ctrlKey;
    const folderRow = e.target.closest('.row[data-kind="folder"]');
    const destDir = folderRow ? folderRow.dataset.path : this._lastPane.path;
    clearDrag();
    this.clearDropHighlight();
    if (destDir.startsWith('tag:')) {
      this.bus.emit('shortcut:hint', { text: t('panel.noDropTag'), type: 'warn' });
      return;
    }
    this.dropEntries(paths, destDir, copy);
  },

  onDragEnd() {
    clearDrag();
    this.clearDropHighlight();
  },

  clearDropHighlight() {
    this.panelEl.classList.remove('is-drop');
    if (this._dropRow) {
      this._dropRow.classList.remove('is-drop-into');
      this._dropRow = null;
    }
  },

  async dropEntries(sources, destDir, copy) {
    const filtered = sources.filter((src) => {
      if (src === destDir) return false;
      if (parentPath(src) === destDir) return false;
      const sep = src.includes('\\') ? '\\' : '/';
      if (destDir.startsWith(src + sep)) return false;
      return true;
    });
    if (!filtered.length) return;

    let conflicts = [];
    try {
      conflicts = (await checkConflicts(filtered, destDir)) || [];
    } catch {
      /* on a check error, just try without overwriting */
    }

    if (conflicts.length) {
      const conflictSet = new Set(conflicts);
      this.bus.emit('confirm:open', {
        title: t('panel.conflictTitle'),
        message: t('panel.conflictMsg', { n: conflicts.length }),
        confirmLabel: t('panel.overwrite'),
        altLabel: t('panel.skip'),
        onConfirm: () => this.doTransfer(filtered, destDir, copy, true),
        onAlt: () => {
          const rest = filtered.filter((p) => !conflictSet.has(folderName(p)));
          this.doTransfer(rest, destDir, copy, false);
        },
      });
      return;
    }
    this.doTransfer(filtered, destDir, copy, false);
  },

  async doTransfer(sources, destDir, copy, overwrite) {
    if (!sources.length) return;
    try {
      if (copy) await copyEntries(sources, destDir, overwrite);
      else await moveEntries(sources, destDir, overwrite);

      const affected = new Set([destDir]);
      sources.forEach((p) => {
        const parent = parentPath(p);
        if (parent) affected.add(parent);
      });
      this.bus.emit('fs:changed', { dirs: [...affected] });
      this.bus.emit('shortcut:hint', copy ? t('panel.copied', { n: sources.length }) : t('panel.moved', { n: sources.length }));
    } catch (err) {
      this.bus.emit('shortcut:hint', { text: t('common.error', { msg: err.message }), type: 'error' });
    }
  },
};
