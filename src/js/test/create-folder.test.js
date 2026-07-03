import { describe, it, expect, vi } from 'vitest';
import { ContextMenu } from '../components/context-menu.js';
import { FilePanel } from '../components/file-panel.js';
import { createStore } from '../core/store.js';
import { createEventBus } from '../core/event-bus.js';
import { initialTabsState, getActiveTab } from '../state/tabs.js';
import { updatePane, recordHistory } from '../state/panes.js';
import { createFolder, listDir } from '../api/fs.js';

vi.mock('../api/tags.js', () => ({
  assignTag: vi.fn(),
  removeTag: vi.fn(),
  tagsForPaths: vi.fn().mockResolvedValue({}),
}));
vi.mock('../api/system.js', () => ({
  openPath: vi.fn(),
  nativeIcon: vi.fn().mockResolvedValue(null),
  revealInExplorer: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../api/fs.js', () => ({
  listDir: vi.fn().mockResolvedValue([]),
  copyEntries: vi.fn().mockResolvedValue(undefined),
  moveEntries: vi.fn().mockResolvedValue(undefined),
  deleteEntries: vi.fn().mockResolvedValue(undefined),
  renameEntry: vi.fn().mockResolvedValue(undefined),
  checkConflicts: vi.fn().mockResolvedValue([]),
  createFolder: vi.fn(),
  searchFiles: vi.fn().mockResolvedValue([]),
}));
vi.mock('../api/indexing.js', () => ({ startIndex: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../api/dir_size.js', () => ({ computeDirSizes: vi.fn().mockResolvedValue({}), dirSizes: vi.fn().mockResolvedValue({}) }));

const frame = () => new Promise((r) => requestAnimationFrame(() => r()));

describe('Context menu — empty-area (background) mode', () => {
  it('shows only New folder, no tag strip, and emits folder:create with side', () => {
    const mount = document.createElement('div');
    document.body.appendChild(mount);
    const bus = createEventBus();
    const menu = new ContextMenu({ mount, store: createStore({}), bus });
    menu.init();

    bus.emit('contextmenu:open', { x: 10, y: 10, entry: null, side: 'right', paths: [] });

    expect(mount.querySelector('.ctx-tag')).toBeNull(); // no tag strip without a target
    const items = mount.querySelectorAll('.ctx-menu__item');
    expect(items).toHaveLength(1);

    let payload = null;
    bus.on('folder:create', (p) => (payload = p));
    items[0].click();
    expect(payload).toEqual({ side: 'right' });
  });
});

describe('FilePanel — create folder', () => {
  function setup() {
    const mount = document.createElement('div');
    mount.style.height = '600px';
    document.body.appendChild(mount);
    const store = createStore({ ...initialTabsState(), homePath: '/home' });
    const bus = createEventBus();
    const panel = new FilePanel({ mount, store, bus, side: 'left' });
    updatePane(store, 'left', { path: '/home', entries: [], loading: false });
    recordHistory(store, 'left', '/home');
    panel._lastPane = getActiveTab(store.getState()).panes.left;
    panel._view = [];
    panel._sort = { key: 'name', dir: 'asc' };
    panel.ensureVisible = vi.fn();
    panel.renderWindow = vi.fn();
    return { panel, store, bus };
  }

  it('right-clicking empty space emits a background menu (entry: null)', () => {
    const { panel, bus } = setup();
    let payload = null;
    bus.on('contextmenu:open', (p) => (payload = p));
    // target is not inside a .row → background menu
    panel.onContextMenu({ target: document.createElement('div'), clientX: 3, clientY: 3, preventDefault() {} });
    expect(payload).toBeTruthy();
    expect(payload.entry).toBeNull();
    expect(payload.side).toBe('left');
  });

  it('selects the new folder and enters inline rename', async () => {
    const { panel, store } = setup();
    const newPath = '/home/New Folder';
    createFolder.mockResolvedValue(newPath);
    listDir.mockResolvedValue([{ name: 'New Folder', kind: 'directory', path: newPath }]);
    panel.startRename = vi.fn();

    await panel.createFolderHere();

    // selection moves to the freshly created folder
    expect(getActiveTab(store.getState()).panes.left.selected).toEqual([newPath]);
    expect(createFolder).toHaveBeenCalled();

    await frame(); // createFolderHere defers startRename to the next frame
    expect(panel.startRename).toHaveBeenCalledWith(expect.objectContaining({ path: newPath }));
  });
});
