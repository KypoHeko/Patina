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
  createFolder: vi.fn(),
  searchFiles: vi.fn().mockResolvedValue([]),
}));
vi.mock('../api/system.js', () => ({
  openPath: vi.fn(),
  nativeIcon: vi.fn().mockResolvedValue(null),
  revealInExplorer: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../api/tags.js', () => ({ tagsForPaths: vi.fn().mockResolvedValue({}), listTag: vi.fn().mockResolvedValue([]) }));
vi.mock('../api/indexing.js', () => ({ startIndex: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../api/dir_size.js', () => ({ computeDirSizes: vi.fn().mockResolvedValue({}), dirSizes: vi.fn().mockResolvedValue({}) }));

const NEW = '/home/New Folder';

function setup() {
  const mount = document.createElement('div');
  mount.style.height = '600px';
  document.body.appendChild(mount);
  const store = createStore({ ...initialTabsState(), homePath: '/home' });
  const bus = createEventBus();
  const panel = new FilePanel({ mount, store, bus, side: 'left' });
  panel.init();
  // recordHistory first → historyIndex is set, so sync() won't auto-navigate;
  // empty entries keep renderWindow from touching CSS.escape (absent in jsdom).
  recordHistory(store, 'left', '/home');
  updatePane(store, 'left', { path: '/home', entries: [], loading: false });
  panel._lastPane = getActiveTab(store.getState()).panes.left;
  return { panel, bus };
}

// A folder row as renderWindow would build it (so startRename can find it).
function injectRow(panel) {
  const row = document.createElement('div');
  row.className = 'row';
  row.dataset.path = NEW;
  const name = document.createElement('span');
  name.className = 'row__name';
  name.textContent = 'New Folder';
  row.appendChild(name);
  panel.listEl.appendChild(row);
}

describe('Inline rename vs. fs:changed reload', () => {
  it('reloads normally on fs:changed when not renaming', () => {
    const { panel, bus } = setup();
    panel.reload = vi.fn();
    bus.emit('fs:changed', { dirs: ['/home'] });
    expect(panel.reload).toHaveBeenCalledTimes(1);
  });

  it('keeps the rename input alive across a watcher fs:changed, then reloads when done', () => {
    const { panel, bus } = setup();
    panel.reload = vi.fn();
    injectRow(panel);

    panel.startRename({ name: 'New Folder', kind: 'folder', path: NEW });
    expect(panel.listEl.querySelector('.row__rename')).toBeTruthy();
    expect(panel._renaming).toBe(NEW);

    // The OS watcher fires for the same folder (as right after creating it).
    bus.emit('fs:changed', { dirs: ['/home'] });

    // Reload deferred — the input must survive.
    expect(panel.reload).not.toHaveBeenCalled();
    expect(panel._pendingReload).toBe(true);
    expect(panel.listEl.querySelector('.row__rename')).toBeTruthy();

    // Finish (Escape) → the deferred reload is applied.
    panel.listEl
      .querySelector('.row__rename')
      .dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(panel._renaming).toBeNull();
    expect(panel.reload).toHaveBeenCalledTimes(1);
  });
});
