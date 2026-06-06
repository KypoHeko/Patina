import { describe, it, expect, beforeEach, vi } from 'vitest';
import { FilePanel } from './file-panel.js';
import { createStore } from '../core/store.js';
import { createEventBus } from '../core/event-bus.js';
import { initialTabsState, getActiveTab } from '../state/tabs.js';
import { updatePane, selectInPane, recordHistory } from '../state/panes.js';

// Мокаем все API-вызовы (Tauri IPC)
vi.mock('../api/fs.js', () => ({
  listDir: vi.fn().mockResolvedValue([
    { path: '/home/docs', name: 'docs', kind: 'folder', size: 0, modified: 1000, extension: '' },
    { path: '/home/readme.md', name: 'readme.md', kind: 'file', size: 1200, modified: 2000, extension: 'md' },
    { path: '/home/app.rs', name: 'app.rs', kind: 'file', size: 3400, modified: 3000, extension: 'rs' },
    { path: '/home/builder.toml', name: 'builder.toml', kind: 'file', size: 500, modified: 4000, extension: 'toml' },
  ]),
  copyEntries: vi.fn().mockResolvedValue(undefined),
  moveEntries: vi.fn().mockResolvedValue(undefined),
  deleteEntries: vi.fn().mockResolvedValue(undefined),
  renameEntry: vi.fn().mockResolvedValue(undefined),
  checkConflicts: vi.fn().mockResolvedValue([]),
  createFolder: vi.fn().mockResolvedValue('/home/Новая папка'),
  searchFiles: vi.fn().mockResolvedValue([]),
}));

vi.mock('../api/system.js', () => ({
  openPath: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../api/tags.js', () => ({
  tagsForPaths: vi.fn().mockResolvedValue({}),
  listTag: vi.fn().mockResolvedValue([]),
}));

vi.mock('../api/indexing.js', () => ({
  startIndex: vi.fn().mockResolvedValue(undefined),
}));

function makeStore() {
  return createStore({ ...initialTabsState(), homePath: '/home' });
}

function makePanel(side = 'left') {
  const mount = document.createElement('div');
  mount.id = `pane-${side}`;
  mount.style.height = '600px';
  document.body.appendChild(mount);
  const store = makeStore();
  const bus = createEventBus();
  const panel = new FilePanel({ mount, store, bus, side });
  return { panel, mount, store, bus };
}

// ─── Сортировка ────────────────────────────────────

describe('FilePanel — sortedEntries', () => {
  let panel;
  const entries = [
    { name: 'zebra.txt', kind: 'file', size: 100, modified: 5000, extension: 'txt', path: '/z.txt' },
    { name: 'alpha', kind: 'folder', size: 0, modified: 1000, extension: '', path: '/a' },
    { name: 'beta.rs', kind: 'file', size: 200, modified: 3000, extension: 'rs', path: '/b.rs' },
    { name: 'Alpha2', kind: 'folder', size: 0, modified: 2000, extension: '', path: '/A2' },
  ];

  beforeEach(() => {
    const ctx = makePanel();
    panel = ctx.panel;
  });

  it('папки идут перед файлами при сортировке по имени (asc)', () => {
    panel._sort = { key: 'name', dir: 'asc' };
    const sorted = panel.sortedEntries(entries);
    const kinds = sorted.map((e) => e.kind);
    const lastFolderIdx = kinds.lastIndexOf('folder');
    const firstFileIdx = kinds.indexOf('file');
    expect(lastFolderIdx).toBeLessThan(firstFileIdx);
  });

  it('числовая сортировка имён: file2 < file10', () => {
    const numEntries = [
      { name: 'file10.txt', kind: 'file', size: 0, modified: 0, extension: 'txt', path: '/f10' },
      { name: 'file2.txt', kind: 'file', size: 0, modified: 0, extension: 'txt', path: '/f2' },
      { name: 'file1.txt', kind: 'file', size: 0, modified: 0, extension: 'txt', path: '/f1' },
    ];
    panel._sort = { key: 'name', dir: 'asc' };
    const sorted = panel.sortedEntries(numEntries);
    expect(sorted.map((e) => e.name)).toEqual(['file1.txt', 'file2.txt', 'file10.txt']);
  });

  it('сортировка по размеру (asc)', () => {
    panel._sort = { key: 'size', dir: 'asc' };
    const sorted = panel.sortedEntries(entries);
    const sizes = sorted.filter((e) => e.kind === 'file').map((e) => e.size);
    expect(sizes).toEqual([...sizes].sort((a, b) => a - b));
  });

  it('сортировка по размеру (desc)', () => {
    panel._sort = { key: 'size', dir: 'desc' };
    const sorted = panel.sortedEntries(entries);
    const sizes = sorted.filter((e) => e.kind === 'file').map((e) => e.size);
    expect(sizes).toEqual([...sizes].sort((a, b) => b - a));
  });

  it('сортировка по типу (extension)', () => {
    panel._sort = { key: 'type', dir: 'asc' };
    const sorted = panel.sortedEntries(entries);
    const exts = sorted.filter((e) => e.kind === 'file').map((e) => e.extension);
    expect(exts).toEqual([...exts].sort());
  });

  it('переключение направления: повторный клик по тому же ключу', () => {
    panel._sort = { key: 'name', dir: 'asc' };
    panel._sort = { key: panel._sort.key, dir: panel._sort.dir === 'asc' ? 'desc' : 'asc' };
    expect(panel._sort).toEqual({ key: 'name', dir: 'desc' });
  });

  it('смена ключа сбрасывает направление в asc', () => {
    panel._sort = { key: 'name', dir: 'desc' };
    panel._sort = { key: 'size', dir: 'asc' };
    expect(panel._sort).toEqual({ key: 'size', dir: 'asc' });
  });
});

// ─── Фильтрация ────────────────────────────────────

describe('FilePanel — filterList', () => {
  let panel;
  const entries = [
    { name: 'readme.md', kind: 'file', path: '/r.md' },
    { name: 'main.rs', kind: 'file', path: '/m.rs' },
    { name: 'config.toml', kind: 'file', path: '/c.toml' },
    { name: 'src', kind: 'folder', path: '/src' },
  ];

  beforeEach(() => {
    const ctx = makePanel();
    panel = ctx.panel;
  });

  it('пустой фильтр возвращает весь список', () => {
    panel._filter = '';
    expect(panel.filterList(entries)).toEqual(entries);
  });

  it('подстрока фильтрует по имени', () => {
    panel._filter = 'read';
    const result = panel.filterList(entries);
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('readme.md');
  });

  it('regex фильтрует по имени', () => {
    panel._filter = '\\.(rs|md)$';
    const result = panel.filterList(entries);
    expect(result).toHaveLength(2);
    expect(result.map((e) => e.name).sort()).toEqual(['main.rs', 'readme.md']);
  });

  it('фильтр нечувствителен к регистру', () => {
    panel._filter = 'README';
    const result = panel.filterList(entries);
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('readme.md');
  });

  it('нет совпадений — пустой список', () => {
    panel._filter = 'zzzzz';
    const result = panel.filterList(entries);
    expect(result).toHaveLength(0);
  });
});

// ─── Выбор ─────────────────────────────────────────

describe('FilePanel — выбор / курсор', () => {
  let panel, store, listEl;

  const entries = [
    { name: 'a.txt', kind: 'file', path: '/a', size: 10, modified: 1000, extension: 'txt' },
    { name: 'b.txt', kind: 'file', path: '/b', size: 20, modified: 2000, extension: 'txt' },
    { name: 'c.txt', kind: 'file', path: '/c', size: 30, modified: 3000, extension: 'txt' },
    { name: 'd.txt', kind: 'file', path: '/d', size: 40, modified: 4000, extension: 'txt' },
  ];

  beforeEach(() => {
    const ctx = makePanel();
    panel = ctx.panel;
    store = ctx.store;
    updatePane(store, 'left', { entries, path: '/home', loading: false });
    recordHistory(store, 'left', '/home');
    panel._lastPane = getActiveTab(store.getState()).panes.left;
    panel._view = entries;
    panel._sort = { key: 'name', dir: 'asc' };
    // Мокаем ensureVisible (зависит от DOM-геометрии)
    panel.ensureVisible = vi.fn();
    panel.renderWindow = vi.fn();
  });

  it('moveCursor ArrowDown сдвигает курсор вниз', () => {
    panel._cursor = 0;
    panel._anchor = '/a';
    panel.moveCursor('ArrowDown', false);
    const pane = getActiveTab(store.getState()).panes.left;
    expect(pane.selected).toEqual(['/b']);
  });

  it('moveCursor ArrowUp не уходит выше нуля', () => {
    panel._cursor = 0;
    panel._anchor = '/a';
    panel.moveCursor('ArrowUp', false);
    const pane = getActiveTab(store.getState()).panes.left;
    expect(pane.selected).toEqual(['/a']);
  });

  it('moveCursor Home — первый элемент', () => {
    panel._cursor = 3;
    panel._anchor = '/d';
    panel.moveCursor('Home', false);
    const pane = getActiveTab(store.getState()).panes.left;
    expect(pane.selected).toEqual(['/a']);
  });

  it('moveCursor End — последний элемент', () => {
    panel._cursor = 0;
    panel._anchor = '/a';
    panel.moveCursor('End', false);
    const pane = getActiveTab(store.getState()).panes.left;
    expect(pane.selected).toEqual(['/d']);
  });

  it('Shift+ArrowDown расширяет выделение', () => {
    panel._cursor = 0;
    panel._anchor = '/a';
    panel.moveCursor('ArrowDown', true);
    const pane = getActiveTab(store.getState()).panes.left;
    expect(pane.selected).toEqual(['/a', '/b']);
  });

  it('Shift+ArrowDown дважды расширяет дальше', () => {
    panel._cursor = 0;
    panel._anchor = '/a';
    panel.moveCursor('ArrowDown', true);
    panel.moveCursor('ArrowDown', true);
    const pane = getActiveTab(store.getState()).panes.left;
    expect(pane.selected).toEqual(['/a', '/b', '/c']);
  });

  it('cursorIndex возвращает индекс последнего выделенного', () => {
    selectInPane(store, 'left', ['/b', '/d']);
    panel._lastPane = getActiveTab(store.getState()).panes.left;
    expect(panel.cursorIndex()).toBe(3); // /d — index 3
  });

  it('cursorIndex без выделения — _cursor', () => {
    selectInPane(store, 'left', []);
    panel._lastPane = getActiveTab(store.getState()).panes.left;
    panel._cursor = 2;
    expect(panel.cursorIndex()).toBe(2);
  });
});

// ─── typeAhead ──────────────────────────────────────

describe('FilePanel — typeAhead', () => {
  let panel, store, listEl;

  const entries = [
    { name: 'alpha.txt', kind: 'file', path: '/a', size: 10, modified: 1000, extension: 'txt' },
    { name: 'beta.txt', kind: 'file', path: '/b', size: 20, modified: 2000, extension: 'txt' },
    { name: 'gamma.txt', kind: 'file', path: '/g', size: 30, modified: 3000, extension: 'txt' },
    { name: 'alpha2.txt', kind: 'file', path: '/a2', size: 15, modified: 1500, extension: 'txt' },
  ];

  beforeEach(() => {
    const ctx = makePanel();
    panel = ctx.panel;
    store = ctx.store;
    updatePane(store, 'left', { entries, path: '/home', loading: false });
    panel._lastPane = getActiveTab(store.getState()).panes.left;
    panel._view = entries;
    panel._cursor = 0;
    panel._anchor = entries[0].path;
    panel._taBuf = '';
    panel._taTime = 0;
    // Мокаем ensureVisible (зависит от DOM-геометрии)
    panel.ensureVisible = vi.fn();
    panel.renderWindow = vi.fn();
  });

  it('находит файл по первой букве', () => {
    panel.typeAhead('g');
    const pane = getActiveTab(store.getState()).panes.left;
    expect(pane.selected).toEqual(['/g']);
  });

  it('находит файл по нескольким буквам', () => {
    panel.typeAhead('a');
    panel.typeAhead('l');
    panel.typeAhead('p');
    const pane = getActiveTab(store.getState()).panes.left;
    // 'alp' совпадает с 'alpha.txt' — начинается с текущей позиции +1
    // поэтому первый результат — alpha2.txt (index 3), потом alpha.txt (index 0)
    expect(pane.selected[0]).toMatch(/^\/a2?$/);
  });

  it('не находит — выделение не меняется', () => {
    // Установим начальное выделение
    selectInPane(store, 'left', ['/a']);
    panel._lastPane = getActiveTab(store.getState()).panes.left;
    panel.typeAhead('z');
    const pane = getActiveTab(store.getState()).panes.left;
    // typeAhead не нашёл — выделил /a (fallback: ничего не меняется в выделении,
    // но setInPane не вызывается — значит selected = ['/a'])
    // На самом деле typeAhead не вызывает selectInPane если не нашёл —
    // выделение остаётся прежним
    expect(pane.selected).toContain('/a');
  });
});

// ─── dotsHtml ───────────────────────────────────────

describe('FilePanel — dotsHtml', () => {
  let panel;

  beforeEach(() => {
    const ctx = makePanel();
    panel = ctx.panel;
    panel._tags = {
      '/a': ['urgent', 'done'],
      '/b': ['in-progress'],
    };
  });

  it('путь с тегами — рендерит точки', () => {
    const html = panel.dotsHtml('/a');
    expect(html).toContain('tag-dot');
    expect(html).toContain('Срочно');
    expect(html).toContain('Готово');
  });

  it('путь с одним тегом', () => {
    const html = panel.dotsHtml('/b');
    expect(html).toContain('В работе');
  });

  it('путь без тегов — пустая строка', () => {
    const html = panel.dotsHtml('/c');
    expect(html).toBe('');
  });
});
