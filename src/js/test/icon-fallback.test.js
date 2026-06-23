import { describe, it, expect, vi, beforeEach } from 'vitest';
import { hasOwnIcon } from '../lib/icons.js';
import { FilePanel } from '../components/file-panel.js';
import { createStore } from '../core/store.js';
import { createEventBus } from '../core/event-bus.js';
import { initialTabsState } from '../state/tabs.js';
import { nativeIcon } from '../api/system.js';

vi.mock('../api/fs.js', () => ({
  listDir: vi.fn().mockResolvedValue([]),
  copyEntries: vi.fn(),
  moveEntries: vi.fn(),
  deleteEntries: vi.fn(),
  renameEntry: vi.fn(),
  checkConflicts: vi.fn(),
  createFolder: vi.fn(),
  searchFiles: vi.fn().mockResolvedValue([]),
}));
vi.mock('../api/system.js', () => ({
  openPath: vi.fn(),
  nativeIcon: vi.fn().mockResolvedValue(null),
  revealInExplorer: vi.fn(),
}));
vi.mock('../api/tags.js', () => ({ tagsForPaths: vi.fn().mockResolvedValue({}), listTag: vi.fn().mockResolvedValue([]) }));
vi.mock('../api/indexing.js', () => ({ startIndex: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../api/dir_size.js', () => ({ computeDirSizes: vi.fn().mockResolvedValue({}), dirSizes: vi.fn().mockResolvedValue({}) }));

describe('hasOwnIcon', () => {
  it('folders always have our icon', () => {
    expect(hasOwnIcon({ kind: 'folder', extension: null })).toBe(true);
  });
  it('known extensions have our icon (case-insensitive)', () => {
    expect(hasOwnIcon({ kind: 'file', extension: 'js' })).toBe(true);
    expect(hasOwnIcon({ kind: 'file', extension: 'PNG' })).toBe(true);
    expect(hasOwnIcon({ kind: 'file', extension: 'zip' })).toBe(true);
  });
  it('unknown / missing extensions do not — caller falls back to the native icon', () => {
    expect(hasOwnIcon({ kind: 'file', extension: 'xyz' })).toBe(false);
    expect(hasOwnIcon({ kind: 'file', extension: '' })).toBe(false);
    expect(hasOwnIcon({ kind: 'file', extension: null })).toBe(false);
  });
});

describe('FilePanel.loadNativeIcons — native only as a fallback', () => {
  beforeEach(() => nativeIcon.mockClear());

  it('requests the OS icon only for rows that lack our own icon', () => {
    const panel = new FilePanel({
      mount: document.createElement('div'),
      store: createStore({ ...initialTabsState() }),
      bus: createEventBus(),
      side: 'left',
    });
    // Minimal manual wiring (no init()): just what loadNativeIcons touches.
    panel._nativeIcons = new Map();
    panel._iconPending = new Set();
    panel.listEl = document.createElement('div');
    panel.listEl.innerHTML =
      '<div class="row" data-path="/a.js" data-nat=""></div>' + // we have an icon → skip
      '<div class="row" data-path="/b.xyz" data-nat="1"></div>' + // no icon → fetch native
      '<div class="row" data-path="/c" data-nat="1"></div>'; // no extension → fetch native

    panel.loadNativeIcons();

    expect(nativeIcon).toHaveBeenCalledTimes(2);
    expect(nativeIcon).toHaveBeenCalledWith('/b.xyz', 16);
    expect(nativeIcon).toHaveBeenCalledWith('/c', 16);
    const requested = nativeIcon.mock.calls.map((c) => c[0]);
    expect(requested).not.toContain('/a.js');
  });
});
