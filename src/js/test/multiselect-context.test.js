import { describe, it, expect, vi } from 'vitest';
import { FilePanel } from '../components/file-panel.js';
import { createStore } from '../core/store.js';
import { createEventBus } from '../core/event-bus.js';
import { initialTabsState, getActiveTab } from '../state/tabs.js';
import { updatePane, recordHistory } from '../state/panes.js';

vi.mock('../api/fs.js', () => ({
  listDir: vi.fn().mockResolvedValue([]),
  copyEntries: vi.fn().mockResolvedValue(undefined),
  moveEntries: vi.fn().mockResolvedValue(undefined),
  deleteEntries: vi.fn().mockResolvedValue(undefined),
  renameEntry: vi.fn().mockResolvedValue(undefined),
  checkConflicts: vi.fn().mockResolvedValue([]),
  createFolder: vi.fn().mockResolvedValue('/home/new'),
  searchFiles: vi.fn().mockResolvedValue([]),
}));
vi.mock('../api/system.js', () => ({ openPath: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../api/tags.js', () => ({
  tagsForPaths: vi.fn().mockResolvedValue({}),
  listTag: vi.fn().mockResolvedValue([]),
}));
vi.mock('../api/indexing.js', () => ({ startIndex: vi.fn().mockResolvedValue(undefined) }));

function rowEl(path) {
  const r = document.createElement('div');
  r.className = 'row';
  r.dataset.path = path;
  return r;
}

function setup() {
  const mount = document.createElement('div');
  mount.style.height = '600px';
  document.body.appendChild(mount);
  const store = createStore({ ...initialTabsState(), homePath: '/home' });
  const bus = createEventBus();
  const panel = new FilePanel({ mount, store, bus, side: 'left' });

  const entries = [
    { name: 'a.txt', kind: 'file', size: 1, modified: 1, extension: 'txt', path: '/a.txt' },
    { name: 'b.txt', kind: 'file', size: 1, modified: 2, extension: 'txt', path: '/b.txt' },
    { name: 'c.txt', kind: 'file', size: 1, modified: 3, extension: 'txt', path: '/c.txt' },
  ];
  updatePane(store, 'left', { entries, path: '/home', loading: false });
  recordHistory(store, 'left', '/home');
  panel._lastPane = getActiveTab(store.getState()).panes.left;
  panel._view = entries;
  panel._sort = { key: 'name', dir: 'asc' };
  panel.ensureVisible = vi.fn();
  panel.renderWindow = vi.fn();
  return { panel, store, bus, entries };
}

describe('FilePanel — multi-select reaches the context menu', () => {
  // No manual _lastPane refresh here: selection handlers must read the store
  // directly, so Ctrl-click accumulation must not depend on the render cache.
  function ctrlClick(panel, path) {
    panel.onClick({ target: rowEl(path), ctrlKey: true });
  }

  it('ctrl-click selects three, store holds all three', () => {
    const { panel, store, entries } = setup();
    for (const e of entries) ctrlClick(panel, e.path);
    expect(getActiveTab(store.getState()).panes.left.selected).toEqual(['/a.txt', '/b.txt', '/c.txt']);
  });

  it('right-clicking a selected row emits ALL selected paths', () => {
    const { panel, bus, entries } = setup();
    for (const e of entries) ctrlClick(panel, e.path);

    let payload = null;
    bus.on('contextmenu:open', (p) => { payload = p; });
    panel.onContextMenu({ target: rowEl('/b.txt'), clientX: 5, clientY: 5, preventDefault() {} });

    expect(payload).toBeTruthy();
    expect(payload.paths).toEqual(['/a.txt', '/b.txt', '/c.txt']);
  });
});
