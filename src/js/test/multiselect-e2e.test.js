import { describe, it, expect, vi } from 'vitest';
import { FilePanel } from '../components/file-panel.js';
import { ContextMenu } from '../components/context-menu.js';
import { createStore } from '../core/store.js';
import { createEventBus } from '../core/event-bus.js';
import { initialTabsState, getActiveTab } from '../state/tabs.js';
import { updatePane, recordHistory } from '../state/panes.js';
import { assignTag, removeTag, tagsForPaths } from '../api/tags.js';

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
vi.mock('../api/system.js', () => ({
  openPath: vi.fn().mockResolvedValue(undefined),
  nativeIcon: vi.fn().mockResolvedValue(null),
  revealInExplorer: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../api/tags.js', () => ({
  assignTag: vi.fn().mockResolvedValue(undefined),
  removeTag: vi.fn().mockResolvedValue(undefined),
  tagsForPaths: vi.fn().mockResolvedValue({}),
  listTag: vi.fn().mockResolvedValue([]),
}));
vi.mock('../api/indexing.js', () => ({ startIndex: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../api/dir_size.js', () => ({
  computeDirSizes: vi.fn().mockResolvedValue({}),
  dirSizes: vi.fn().mockResolvedValue({}),
}));

const tick = () => new Promise((r) => setTimeout(r, 0));

function rowEl(path) {
  const r = document.createElement('div');
  r.className = 'row';
  r.dataset.path = path;
  return r;
}

describe('Multi-select tagging — FilePanel → ContextMenu end to end', () => {
  it('clicking a tag dot tags EVERY selected file', async () => {
    assignTag.mockClear();
    const store = createStore({ ...initialTabsState(), homePath: '/home' });
    const bus = createEventBus();

    // FilePanel
    const panelMount = document.createElement('div');
    panelMount.style.height = '600px';
    document.body.appendChild(panelMount);
    const panel = new FilePanel({ mount: panelMount, store, bus, side: 'left' });

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

    // ContextMenu listening on the same bus
    const menuMount = document.createElement('div');
    document.body.appendChild(menuMount);
    const menu = new ContextMenu({ mount: menuMount, store, bus });
    menu.init();

    // Ctrl-click all three, then right-click one of them.
    for (const e of entries) panel.onClick({ target: rowEl(e.path), ctrlKey: true });
    panel.onContextMenu({ target: rowEl('/b.txt'), clientX: 5, clientY: 5, preventDefault() {} });
    await tick(); // menu.openAt resolves tagsForPaths

    const dot = menuMount.querySelector('.ctx-tag');
    expect(dot, 'context menu should render tag dots').toBeTruthy();
    dot.click();
    await tick(); // toggleTag resolves Promise.all(assignTag...)

    const tagId = dot.dataset.tag;
    expect(assignTag).toHaveBeenCalledTimes(3);
    for (const p of ['/a.txt', '/b.txt', '/c.txt']) {
      expect(assignTag).toHaveBeenCalledWith(p, tagId);
    }
  });
});
