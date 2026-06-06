import { Component } from '../core/component.js';
import { startDrag, getDrag, clearDrag } from '../state/drag.js';
import { escapeHtml } from '../core/dom.js';
import { listDir, copyEntries, moveEntries, deleteEntries, renameEntry, checkConflicts, createFolder } from '../api/fs.js';
import { openPath } from '../api/system.js';
import { tagsForPaths, listTag } from '../api/tags.js';
import { TAGS } from '../config/tags.js';
import { formatSize, formatDate } from '../lib/format.js';
import { fileIcon } from '../lib/icons.js';
import { parentPath, folderName } from '../lib/paths.js';
import {
  getPane,
  updatePane,
  setActivePane,
  selectInPane,
  recordHistory,
  stepHistory,
} from '../state/panes.js';
import { getActiveSide, closeSplit, splitTab } from '../state/tabs.js';
import { Breadcrumbs } from './breadcrumbs.js';
import { makeMatcher } from '../lib/regex.js';

const TAG_COLOR = Object.fromEntries(TAGS.map((t) => [t.id, t.color]));
const TAG_LABEL = Object.fromEntries(TAGS.map((t) => [t.id, t.label]));

// Оверлеи, которые сами обрабатывают клавиатуру (стрелки/Enter) — при их
// открытии навигация по списку не должна срабатывать.
const OVERLAY_ROOTS = ['palette-root', 'versions-root', 'graph-root', 'confirm-root'];
function overlayOpen() {
  return OVERLAY_ROOTS.some((id) => {
    const n = document.getElementById(id);
    return n && n.childElementCount > 0;
  });
}
function isTextInput(e) {
  const t = e.target;
  return t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable);
}

export class FilePanel extends Component {
  constructor(ctx) {
    super(ctx);
    this.side = ctx.side;
    this._lastPane = null;
    this._lastActive = null;
    this._dropRow = null;
    this._tags = {}; // путь -> [tagId] для текущего листинга
    this._anchor = null; // якорь для Shift-выделения
    this._sort = { key: 'name', dir: 'asc' }; // сортировка по умолчанию — имя
    this._view = []; // отображаемый (отсортированный) порядок
    this._filter = ''; // строка поиска (regex / подстрока)
    this._appliedFilter = '';
    this._cursor = 0;
  }

  init() {
    const splitBtn =
      this.side === 'left'
        ? '<button class="panel__split" data-split title="Разделить">▥</button>'
        : '';
    const closeBtn =
      '<button class="panel__close" data-close-split title="Закрыть панель">×</button>';
    this.mount.innerHTML = `
      <div class="panel">
        <div class="panel__head">
          <div class="panel__crumbs"></div>
          ${splitBtn}
          ${closeBtn}
        </div>
        <div class="panel__colhead">
          <span></span>
          <span class="col-sort" data-sort="name">Имя<i class="sort-arrow"></i></span>
          <span class="col-sort" data-sort="type">Тип<i class="sort-arrow"></i></span>
          <span>Метка</span>
          <span class="col-sort col-r" data-sort="size">Размер<i class="sort-arrow"></i></span>
          <span class="col-sort" data-sort="modified">Изменено<i class="sort-arrow"></i></span>
        </div>
        <div class="panel__list"></div>
      </div>`;
    this.panelEl = this.mount.querySelector('.panel');
    this.crumbsEl = this.mount.querySelector('.panel__crumbs');
    this.listEl = this.mount.querySelector('.panel__list');
    this.colheadEl = this.mount.querySelector('.panel__colhead');

    this.breadcrumbs = this.addChild(
      new Breadcrumbs({
        mount: this.crumbsEl,
        store: this.store,
        bus: this.bus,
        side: this.side,
        onNavigate: (path) => this.navigate(path),
        onBack: () => this.goBack(),
      }),
    );
    this.breadcrumbs.init();

    const splitEl = this.mount.querySelector('[data-split]');
    if (splitEl) this.on(splitEl, 'click', () => splitTab(this.store));
    const closeEl = this.mount.querySelector('[data-close-split]');
    if (closeEl) this.on(closeEl, 'click', () => closeSplit(this.store, this.side));

    this.on(this.panelEl, 'mousedown', (e) => this.onMouseDown(e));
    this.on(this.listEl, 'click', (e) => this.onClick(e));
    this.on(this.listEl, 'dblclick', (e) => this.onDblClick(e));
    this.on(this.listEl, 'contextmenu', (e) => this.onContextMenu(e));
    this.on(this.colheadEl, 'click', (e) => this.onSort(e));
    this.on(window, 'keydown', (e) => this.onListKey(e));

    this.on(this.listEl, 'dragstart', (e) => this.onDragStart(e));
    this.on(this.listEl, 'dragend', () => this.onDragEnd());
    this.on(this.panelEl, 'dragover', (e) => this.onDragOver(e));
    this.on(this.panelEl, 'dragleave', (e) => this.onDragLeave(e));
    this.on(this.panelEl, 'drop', (e) => this.onDrop(e));

    this.listen('file:activate', ({ side, entry }) => {
      if (side === this.side) this.activate(entry);
    });
    this.listen('location:open', ({ path }) => {
      if (getActiveSide(this.store.getState()) === this.side) this.navigate(path);
    });
    this.listen('graph:reveal', ({ path }) => {
      if (getActiveSide(this.store.getState()) === this.side) this.revealPath(path);
    });
    this.listen('file:delete', ({ side }) => {
      if (side === this.side) this.deleteSelected();
    });
    this.listen('file:rename', ({ side, entry }) => {
      if (side === this.side) this.startRename(entry);
    });
    this.listen('folder:create', (p) => {
      const side = (p && p.side) || getActiveSide(this.store.getState());
      if (side === this.side) this.createFolderHere();
    });
    this.listen('fs:changed', ({ dirs }) => {
      if (this._lastPane && dirs.includes(this._lastPane.path)) this.reload();
    });
    this.listen('tags:changed', ({ paths }) => {
      const cur = this._lastPane;
      if (!cur) return;
      if ((cur.path || '').startsWith('tag:')) {
        this.reload(); // в тег-папке снятие тега убирает файл из списка
        return;
      }
      const entries = cur.entries || [];
      if (paths.some((p) => entries.find((e) => e.path === p))) this.loadTags(entries);
    });

    this._rowH = parseInt(getComputedStyle(document.documentElement).getPropertyValue('--row-h'), 10) || 28;
    this.on(this.listEl, 'scroll', () => this._scheduleWindow());
    if (typeof ResizeObserver !== 'undefined') {
      this._ro = new ResizeObserver(() => this._scheduleWindow());
      this._ro.observe(this.listEl);
    }

    this.renderColhead();
    this.subscribe((state) => this.sync(state));
    this.sync(this.store.getState());
  }

  sync(state) {
    const pane = getPane(state, this.side);

    if (pane.path && pane.historyIndex === -1 && !pane.loading && !pane.error) {
      this.navigate(pane.path);
      return;
    }

    const active = getActiveSide(state) === this.side;
    const filter = active ? state.searchQuery || '' : '';
    if (pane === this._lastPane && active === this._lastActive && filter === this._appliedFilter) return;

    const structureChanged =
      !this._lastPane ||
      pane.entries !== this._lastPane.entries ||
      pane.error !== this._lastPane.error;
    const filterChanged = filter !== this._appliedFilter;

    this._lastPane = pane;
    this._lastActive = active;
    this._filter = filter;
    this._appliedFilter = filter;

    this.panelEl.classList.toggle('is-active', active);
    if (structureChanged || filterChanged) {
      this.renderList(pane);
      if (structureChanged) this.loadTags(pane.entries);
    } else this.updateSelection(pane);
  }

  async navigate(path, { record = true } = {}) {
    updatePane(this.store, this.side, { loading: true, error: null });
    try {
      const entries = path.startsWith('tag:') ? await listTag(path.slice(4)) : await listDir(path);
      this._tags = {}; // сбрасываем теги прошлой папки
      this._anchor = null;
      updatePane(this.store, this.side, { path, entries, selected: [], loading: false });
      if (record) recordHistory(this.store, this.side, path);
    } catch (err) {
      updatePane(this.store, this.side, { loading: false, error: err.message });
    }
  }

  /** Показать файл из графа: перейти в его папку и выделить там. Для корня
   *  диска (родителя нет) просто открываем его как папку. */
  async revealPath(path) {
    const parent = parentPath(path);
    if (parent) {
      await this.navigate(parent);
      selectInPane(this.store, this.side, [path]);
    } else {
      await this.navigate(path);
    }
  }

  async loadTags(entries) {
    if (!entries.length) return;
    try {
      const map = await tagsForPaths(entries.map((e) => e.path));
      this._tags = map || {};
      this.updateTags();
    } catch {
      /* теги — не критично, молча игнорируем */
    }
  }

  reload() {
    if (this._lastPane?.path) this.navigate(this._lastPane.path, { record: false });
  }

  goBack() {
    const target = stepHistory(this.store, this.side, -1);
    if (target != null) this.navigate(target, { record: false });
  }

  goForward() {
    const target = stepHistory(this.store, this.side, +1);
    if (target != null) this.navigate(target, { record: false });
  }

  async activate(entry) {
    if (entry.kind === 'folder') {
      this.navigate(entry.path);
      return;
    }
    try {
      await openPath(entry.path);
    } catch (err) {
      this.bus.emit('shortcut:hint', `Не удалось открыть: ${err.message}`);
    }
  }

  /* ── Клавиатурная навигация ──────────────── */

  onListKey(e) {
    if (isTextInput(e) || overlayOpen()) return;
    if (getActiveSide(this.store.getState()) !== this.side) return;
    const view = this._view;
    const key = e.key;
    if (key === 'ArrowDown' || key === 'ArrowUp' || key === 'Home' || key === 'End') {
      if (!view.length) return;
      e.preventDefault();
      this.moveCursor(key, e.shiftKey);
    } else if (key === 'Enter') {
      if (!view.length) return;
      e.preventDefault();
      const sel = this._lastPane?.selected || [];
      const path = sel.length === 1 ? sel[0] : view[this.cursorIndex()]?.path;
      const entry = view.find((en) => en.path === path);
      if (entry) this.activate(entry);
    } else if (key === 'Backspace') {
      e.preventDefault();
      const cur = this._lastPane?.path || '';
      const up = parentPath(cur);
      if (up && up !== cur) this.navigate(up);
    } else if (key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
      if (view.length) this.typeAhead(key);
    }
  }

  cursorIndex() {
    const sel = this._lastPane?.selected || [];
    if (sel.length) {
      const i = this._view.findIndex((e) => e.path === sel[sel.length - 1]);
      if (i >= 0) return i;
    }
    return Math.min(Math.max(0, this._cursor | 0), Math.max(0, this._view.length - 1));
  }

  moveCursor(key, shift) {
    const view = this._view;
    const last = view.length - 1;
    let i = this.cursorIndex();
    if (key === 'ArrowDown') i = Math.min(last, i + 1);
    else if (key === 'ArrowUp') i = Math.max(0, i - 1);
    else if (key === 'Home') i = 0;
    else if (key === 'End') i = last;
    this._cursor = i;
    const path = view[i].path;
    if (shift && this._anchor) {
      const a = view.findIndex((e) => e.path === this._anchor);
      if (a >= 0) {
        const [lo, hi] = a < i ? [a, i] : [i, a];
        selectInPane(this.store, this.side, view.slice(lo, hi + 1).map((e) => e.path));
      } else selectInPane(this.store, this.side, [path]);
    } else {
      this._anchor = path;
      selectInPane(this.store, this.side, [path]);
    }
    this.ensureVisible(i);
  }

  ensureVisible(index) {
    const rowH = this._rowH;
    const top = index * rowH;
    const vh = this.listEl.clientHeight || rowH * 20;
    if (top < this.listEl.scrollTop) this.listEl.scrollTop = top;
    else if (top + rowH > this.listEl.scrollTop + vh) this.listEl.scrollTop = top + rowH - vh;
    this.renderWindow();
  }

  typeAhead(ch) {
    const now = Date.now();
    if (now - (this._taTime || 0) > 700) this._taBuf = '';
    this._taTime = now;
    this._taBuf = (this._taBuf || '') + ch.toLowerCase();
    const view = this._view;
    const n = view.length;
    const start = this.cursorIndex();
    const firstChar = this._taBuf.length === 1;
    for (let k = 0; k < n; k++) {
      const idx = (start + (firstChar ? k + 1 : k)) % n;
      if ((view[idx].name || '').toLowerCase().startsWith(this._taBuf)) {
        this._cursor = idx;
        this._anchor = view[idx].path;
        selectInPane(this.store, this.side, [view[idx].path]);
        this.ensureVisible(idx);
        return;
      }
    }
  }

  async createFolderHere() {
    const pane = this._lastPane;
    if (!pane || !pane.path || pane.path.startsWith('tag:')) {
      this.bus.emit('shortcut:hint', 'Здесь нельзя создать папку');
      return;
    }
    const dir = pane.path;
    try {
      const newPath = await createFolder(dir, 'Новая папка');
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
      this.bus.emit('shortcut:hint', `Не удалось создать папку: ${err.message}`);
    }
  }

  entryAt(row) {
    return (this._lastPane?.entries || []).find((e) => e.path === row.dataset.path);
  }

  /* ── Операции ──────────────────────────────── */

  deleteSelected() {
    const paths = this._lastPane?.selected || [];
    if (!paths.length) return;
    const dir = this._lastPane.path;
    this.bus.emit('confirm:open', {
      title: 'Удаление',
      message: `Удалить в корзину: ${paths.length}?`,
      confirmLabel: 'Удалить',
      danger: true,
      onConfirm: async () => {
        try {
          await deleteEntries(paths);
          this.bus.emit('shortcut:hint', `В корзину: ${paths.length}`);
          this.bus.emit('fs:changed', { dirs: [dir] });
        } catch (err) {
          this.bus.emit('shortcut:hint', `Ошибка удаления: ${err.message}`);
        }
      },
    });
  }

  startRename(entry) {
    const row = [...this.listEl.querySelectorAll('.row')].find(
      (r) => r.dataset.path === entry.path,
    );
    if (!row) return;
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
      const value = input.value.trim();
      input.removeEventListener('keydown', onKey);
      input.removeEventListener('blur', onBlur);
      if (commit && value && value !== entry.name) {
        try {
          await renameEntry(entry.path, value);
          this.bus.emit('fs:changed', { dirs: [this._lastPane.path] });
          return;
        } catch (err) {
          this.bus.emit('shortcut:hint', `Ошибка переименования: ${err.message}`);
        }
      }
      nameEl.textContent = entry.name;
    };
    const onKey = (e) => {
      if (e.key === 'Enter') finish(true);
      else if (e.key === 'Escape') finish(false);
      e.stopPropagation();
    };
    const onBlur = () => finish(false);
    input.addEventListener('keydown', onKey);
    input.addEventListener('blur', onBlur);
  }

  /* ── Перетаскивание ────────────────────────── */

  onDragStart(e) {
    const row = e.target.closest('.row');
    if (!row) return;
    const path = row.dataset.path;
    const selected = this._lastPane?.selected || [];
    const paths = selected.includes(path) && selected.length > 1 ? [...selected] : [path];
    startDrag(paths, this.side);
    e.dataTransfer.effectAllowed = 'copyMove';
    e.dataTransfer.setData('text/plain', paths.join('\n'));
    const dragged = paths.map((p) => {
      const en = (this._lastPane?.entries || []).find((x) => x.path === p);
      return { path: p, kind: en ? en.kind : '' };
    });
    e.dataTransfer.setData('application/x-patina-entries', JSON.stringify(dragged));
  }

  onDragOver(e) {
    if (!getDrag()) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = e.ctrlKey ? 'copy' : 'move';
    this.panelEl.classList.add('is-drop');
    const folderRow = e.target.closest('.row[data-kind="folder"]');
    if (this._dropRow && this._dropRow !== folderRow) this._dropRow.classList.remove('is-drop-into');
    if (folderRow) folderRow.classList.add('is-drop-into');
    this._dropRow = folderRow || null;
  }

  onDragLeave(e) {
    if (!this.panelEl.contains(e.relatedTarget)) this.clearDropHighlight();
  }

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
      this.bus.emit('shortcut:hint', 'Нельзя бросать в тег-папку');
      return;
    }
    this.dropEntries(paths, destDir, copy);
  }

  onDragEnd() {
    clearDrag();
    this.clearDropHighlight();
  }

  clearDropHighlight() {
    this.panelEl.classList.remove('is-drop');
    if (this._dropRow) {
      this._dropRow.classList.remove('is-drop-into');
      this._dropRow = null;
    }
  }

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
      /* при ошибке проверки просто пробуем без перезаписи */
    }

    if (conflicts.length) {
      const conflictSet = new Set(conflicts);
      this.bus.emit('confirm:open', {
        title: 'Конфликт имён',
        message: `Уже существует в назначении: ${conflicts.length}`,
        confirmLabel: 'Перезаписать',
        altLabel: 'Пропустить',
        onConfirm: () => this.doTransfer(filtered, destDir, copy, true),
        onAlt: () => {
          const rest = filtered.filter((p) => !conflictSet.has(folderName(p)));
          this.doTransfer(rest, destDir, copy, false);
        },
      });
      return;
    }
    this.doTransfer(filtered, destDir, copy, false);
  }

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
      this.bus.emit('shortcut:hint', `${copy ? 'Скопировано' : 'Перемещено'}: ${sources.length}`);
    } catch (err) {
      this.bus.emit('shortcut:hint', `Ошибка: ${err.message}`);
    }
  }

  /* ── Ввод ──────────────────────────────────── */

  onMouseDown(e) {
    setActivePane(this.store, this.side);
    if (e.button === 3) {
      e.preventDefault();
      this.goBack();
    } else if (e.button === 4) {
      e.preventDefault();
      this.goForward();
    }
  }

  onClick(e) {
    const row = e.target.closest('.row');
    if (!row) return;
    const path = row.dataset.path;
    const entries = this._view.length ? this._view : this._lastPane?.entries || [];
    const cur = this._lastPane?.selected || [];
    let next;

    if (e.ctrlKey || e.metaKey) {
      next = cur.includes(path) ? cur.filter((p) => p !== path) : [...cur, path];
      this._anchor = path;
    } else if (e.shiftKey && this._anchor) {
      const i1 = entries.findIndex((en) => en.path === this._anchor);
      const i2 = entries.findIndex((en) => en.path === path);
      if (i1 >= 0 && i2 >= 0) {
        const [a, b] = i1 < i2 ? [i1, i2] : [i2, i1];
        next = entries.slice(a, b + 1).map((en) => en.path);
      } else {
        next = [path];
      }
    } else {
      next = [path];
      this._anchor = path;
    }
    selectInPane(this.store, this.side, next);
  }

  onDblClick(e) {
    const row = e.target.closest('.row');
    const entry = row && this.entryAt(row);
    if (entry) this.activate(entry);
  }

  onContextMenu(e) {
    const row = e.target.closest('.row');
    if (!row) return;
    const entry = this.entryAt(row);
    if (!entry) return;
    e.preventDefault();
    const selected = this._lastPane?.selected || [];
    if (!selected.includes(entry.path)) selectInPane(this.store, this.side, [entry.path]);
    this.bus.emit('contextmenu:open', { x: e.clientX, y: e.clientY, entry, side: this.side });
  }

  /* ── Отрисовка ─────────────────────────────── */

  dotsHtml(path) {
    return (this._tags[path] || [])
      .map(
        (id) =>
          `<span class="tag-dot" style="background:${TAG_COLOR[id] || '#888'}" title="${escapeHtml(
            TAG_LABEL[id] || id,
          )}"></span>`,
      )
      .join('');
  }

  sortedEntries(entries) {
    const { key, dir } = this._sort;
    const sign = dir === 'asc' ? 1 : -1;
    const byName = (a, b) =>
      a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
    const cmp = (a, b) => {
      let r;
      if (key === 'size') r = (a.size || 0) - (b.size || 0);
      else if (key === 'modified') r = (a.modified || 0) - (b.modified || 0);
      else if (key === 'type') r = String(a.extension || '').localeCompare(String(b.extension || ''));
      else r = byName(a, b);
      if (r === 0) r = byName(a, b);
      return sign * r;
    };
    const folders = entries.filter((e) => e.kind === 'folder').sort(cmp);
    const files = entries.filter((e) => e.kind !== 'folder').sort(cmp);
    return [...folders, ...files];
  }

  onSort(e) {
    const h = e.target.closest('[data-sort]');
    if (!h) return;
    const key = h.dataset.sort;
    if (this._sort.key === key) this._sort.dir = this._sort.dir === 'asc' ? 'desc' : 'asc';
    else this._sort = { key, dir: 'asc' };
    this.renderColhead();
    if (this._lastPane) this.renderList(this._lastPane);
  }

  renderColhead() {
    if (!this.colheadEl) return;
    this.colheadEl.querySelectorAll('.col-sort').forEach((h) => {
      const active = h.dataset.sort === this._sort.key;
      h.classList.toggle('is-sorted', active);
      const arrow = h.querySelector('.sort-arrow');
      if (arrow) arrow.textContent = active ? (this._sort.dir === 'asc' ? '▲' : '▼') : '';
    });
  }

  filterList(list) {
    const q = (this._filter || '').trim();
    if (!q) return list;
    const match = makeMatcher(q, { regex: true });
    return list.filter((e) => match(e.name));
  }

  renderList(pane) {
    if (pane.error) {
      this.listEl.innerHTML = `<div class="panel__error">${escapeHtml(pane.error)}</div>`;
      this._view = [];
      return;
    }
    this._view = this.filterList(this.sortedEntries(pane.entries));
    this.listEl.scrollTop = 0;
    this.renderWindow();
  }

  // Виртуализация: в DOM только видимое окно строк + небольшой запас.
  // Полную высоту задаёт распорка .vlist-sizer, строки позиционируются абсолютно.
  renderWindow() {
    if (!this._lastPane || this._lastPane.error || !this._view) return;
    const view = this._view;
    if (!view.length) {
      this.listEl.innerHTML = `<div class="panel__empty">${this._filter ? 'Ничего не найдено' : 'Папка пуста'}</div>`;
      return;
    }
    const rowH = this._rowH;
    const total = view.length;
    const scrollTop = this.listEl.scrollTop;
    const viewport = this.listEl.clientHeight || rowH * 20;
    const over = 6; // запас строк сверху/снизу
    const start = Math.max(0, Math.floor(scrollTop / rowH) - over);
    const end = Math.min(total, start + Math.ceil(viewport / rowH) + over * 2);
    const selected = new Set(this._lastPane.selected || []);

    let html = `<div class="vlist-sizer" style="height:${total * rowH}px"></div>`;
    for (let i = start; i < end; i++) html += this.rowHtml(view[i], i, selected);
    this.listEl.innerHTML = html;
  }

  rowHtml(e, index, selected) {
    const sel = selected.has(e.path) ? ' is-selected' : '';
    const size = e.kind === 'folder' ? '' : formatSize(e.size);
    const type = e.kind === 'folder' ? '' : (e.extension || '').toUpperCase();
    const top = index * this._rowH;
    return `<div class="row${sel}" draggable="true" data-path="${escapeHtml(e.path)}" data-kind="${e.kind}" style="top:${top}px">
        <span class="row__icon">${fileIcon(e)}</span>
        <span class="row__name">${escapeHtml(e.name)}</span>
        <span class="row__type">${escapeHtml(type)}</span>
        <span class="row__tags">${this.dotsHtml(e.path)}</span>
        <span class="row__size">${size}</span>
        <span class="row__modified">${escapeHtml(formatDate(e.modified))}</span>
      </div>`;
  }

  _scheduleWindow() {
    if (this._raf) return;
    this._raf = requestAnimationFrame(() => {
      this._raf = null;
      this.renderWindow();
    });
  }

  updateTags() {
    this.renderWindow();
  }

  updateSelection() {
    if (!this._lastPane || !this.listEl) return;
    const selected = new Set(this._lastPane.selected || []);
    for (const row of this.listEl.querySelectorAll('.row')) {
      row.classList.toggle('is-selected', selected.has(row.dataset.path));
    }
  }
}
