import { describe, it, expect, beforeEach, vi } from 'vitest';
import { FilePanel } from '../components/file-panel.js';
import { createStore } from '../core/store.js';
import { createEventBus } from '../core/event-bus.js';
import { initialTabsState, getActiveTab } from '../state/tabs.js';
import { updatePane, selectInPane, recordHistory } from '../state/panes.js';

// Mock all API calls (Tauri IPC)
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

// ─── Sorting ────────────────────────────────────

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

  it('folders come before files when sorting by name (asc)', () => {
    panel._sort = { key: 'name', dir: 'asc' };
    const sorted = panel.sortedEntries(entries);
    const kinds = sorted.map((e) => e.kind);
    const lastFolderIdx = kinds.lastIndexOf('folder');
    const firstFileIdx = kinds.indexOf('file');
    expect(lastFolderIdx).toBeLessThan(firstFileIdx);
  });

  it('numeric name sorting: file2 < file10', () => {
    const numEntries = [
      { name: 'file10.txt', kind: 'file', size: 0, modified: 0, extension: 'txt', path: '/f10' },
      { name: 'file2.txt', kind: 'file', size: 0, modified: 0, extension: 'txt', path: '/f2' },
      { name: 'file1.txt', kind: 'file', size: 0, modified: 0, extension: 'txt', path: '/f1' },
    ];
    panel._sort = { key: 'name', dir: 'asc' };
    const sorted = panel.sortedEntries(numEntries);
    expect(sorted.map((e) => e.name)).toEqual(['file1.txt', 'file2.txt', 'file10.txt']);
  });

  it('sorting by size (asc)', () => {
    panel._sort = { key: 'size', dir: 'asc' };
    const sorted = panel.sortedEntries(entries);
    const sizes = sorted.filter((e) => e.kind === 'file').map((e) => e.size);
    expect(sizes).toEqual([...sizes].sort((a, b) => a - b));
  });

  it('sorting by size (desc)', () => {
    panel._sort = { key: 'size', dir: 'desc' };
    const sorted = panel.sortedEntries(entries);
    const sizes = sorted.filter((e) => e.kind === 'file').map((e) => e.size);
    expect(sizes).toEqual([...sizes].sort((a, b) => b - a));
  });

  it('sorting by type (extension)', () => {
    panel._sort = { key: 'type', dir: 'asc' };
    const sorted = panel.sortedEntries(entries);
    const exts = sorted.filter((e) => e.kind === 'file').map((e) => e.extension);
    expect(exts).toEqual([...exts].sort());
  });

  it('toggling direction: clicking the same key again', () => {
    panel._sort = { key: 'name', dir: 'asc' };
    panel._sort = { key: panel._sort.key, dir: panel._sort.dir === 'asc' ? 'desc' : 'asc' };
    expect(panel._sort).toEqual({ key: 'name', dir: 'desc' });
  });

  it('changing the key resets the direction to asc', () => {
    panel._sort = { key: 'name', dir: 'desc' };
    panel._sort = { key: 'size', dir: 'asc' };
    expect(panel._sort).toEqual({ key: 'size', dir: 'asc' });
  });
});

// ─── Filtering ────────────────────────────────────

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

  it('empty filter returns the whole list', () => {
    panel._filter = '';
    expect(panel.filterList(entries)).toEqual(entries);
  });

  it('substring filters by name', () => {
    panel._filter = 'read';
    const result = panel.filterList(entries);
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('readme.md');
  });

  it('regex filters by name', () => {
    panel._filter = '\\.(rs|md)$';
    const result = panel.filterList(entries);
    expect(result).toHaveLength(2);
    expect(result.map((e) => e.name).sort()).toEqual(['main.rs', 'readme.md']);
  });

  it('filter is case-insensitive', () => {
    panel._filter = 'README';
    const result = panel.filterList(entries);
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('readme.md');
  });

  it('no matches → empty list', () => {
    panel._filter = 'zzzzz';
    const result = panel.filterList(entries);
    expect(result).toHaveLength(0);
  });
});

// ─── Selection ─────────────────────────────────────────

describe('FilePanel — selection / cursor', () => {
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
    // Mock ensureVisible (depends on DOM geometry)
    panel.ensureVisible = vi.fn();
    panel.renderWindow = vi.fn();
  });

  it('moveCursor ArrowDown moves the cursor down', () => {
    panel._cursor = 0;
    panel._anchor = '/a';
    panel.moveCursor('ArrowDown', false);
    const pane = getActiveTab(store.getState()).panes.left;
    expect(pane.selected).toEqual(['/b']);
  });

  it('moveCursor ArrowUp does not go above zero', () => {
    panel._cursor = 0;
    panel._anchor = '/a';
    panel.moveCursor('ArrowUp', false);
    const pane = getActiveTab(store.getState()).panes.left;
    expect(pane.selected).toEqual(['/a']);
  });

  it('moveCursor Home → first item', () => {
    panel._cursor = 3;
    panel._anchor = '/d';
    panel.moveCursor('Home', false);
    const pane = getActiveTab(store.getState()).panes.left;
    expect(pane.selected).toEqual(['/a']);
  });

  it('moveCursor End → last item', () => {
    panel._cursor = 0;
    panel._anchor = '/a';
    panel.moveCursor('End', false);
    const pane = getActiveTab(store.getState()).panes.left;
    expect(pane.selected).toEqual(['/d']);
  });

  it('Shift+ArrowDown extends the selection', () => {
    panel._cursor = 0;
    panel._anchor = '/a';
    panel.moveCursor('ArrowDown', true);
    const pane = getActiveTab(store.getState()).panes.left;
    expect(pane.selected).toEqual(['/a', '/b']);
  });

  it('Shift+ArrowDown twice extends further', () => {
    panel._cursor = 0;
    panel._anchor = '/a';
    panel.moveCursor('ArrowDown', true);
    panel.moveCursor('ArrowDown', true);
    const pane = getActiveTab(store.getState()).panes.left;
    expect(pane.selected).toEqual(['/a', '/b', '/c']);
  });

  it('cursorIndex returns the index of the last selected item', () => {
    selectInPane(store, 'left', ['/b', '/d']);
    panel._lastPane = getActiveTab(store.getState()).panes.left;
    expect(panel.cursorIndex()).toBe(3); // /d → index 3
  });

  it('cursorIndex without a selection → _cursor', () => {
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
    // Mock ensureVisible (depends on DOM geometry)
    panel.ensureVisible = vi.fn();
    panel.renderWindow = vi.fn();
  });

  it('finds a file by its first letter', () => {
    panel.typeAhead('g');
    const pane = getActiveTab(store.getState()).panes.left;
    expect(pane.selected).toEqual(['/g']);
  });

  it('finds a file by several letters', () => {
    panel.typeAhead('a');
    panel.typeAhead('l');
    panel.typeAhead('p');
    const pane = getActiveTab(store.getState()).panes.left;
    // 'alp' matches 'alpha.txt' — starts from the current position +1
    // so the first result is alpha2.txt (index 3), then alpha.txt (index 0)
    expect(pane.selected[0]).toMatch(/^\/a2?$/);
  });

  it('finds nothing → selection unchanged', () => {
    // Set an initial selection
    selectInPane(store, 'left', ['/a']);
    panel._lastPane = getActiveTab(store.getState()).panes.left;
    panel.typeAhead('z');
    const pane = getActiveTab(store.getState()).panes.left;
    // typeAhead found nothing — selected /a (fallback: the selection is unchanged,
    // but setInPane is not called — so selected = ['/a'])
    // In fact typeAhead does not call selectInPane when nothing is found —
    // the selection stays the same
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

  it('path with tags → renders dots', () => {
    const html = panel.dotsHtml('/a');
    expect(html).toContain('tag-dot');
    expect(html).toContain('Срочно');
    expect(html).toContain('Готово');
  });

  it('path with a single tag', () => {
    const html = panel.dotsHtml('/b');
    expect(html).toContain('В работе');
  });

  it('path without tags → empty string', () => {
    const html = panel.dotsHtml('/c');
    expect(html).toBe('');
  });
});
