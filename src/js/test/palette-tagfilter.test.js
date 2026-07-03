import { describe, it, expect, vi, beforeEach } from 'vitest';
import { CommandPalette } from '../components/command-palette.js';
import { createStore } from '../core/store.js';
import { createEventBus } from '../core/event-bus.js';
import { initialTabsState, getActiveSide } from '../state/tabs.js';
import { updatePane } from '../state/panes.js';
import { pathsForTag } from '../api/tags.js';
import { pathKey } from '../lib/paths.js';

vi.mock('../api/tags.js', () => ({
  pathsForTag: vi.fn(),
  tagsForPaths: vi.fn().mockResolvedValue({}),
}));
vi.mock('../api/fs.js', () => ({ searchFiles: vi.fn().mockResolvedValue([]) }));
vi.mock('../api/content.js', () => ({ searchContent: vi.fn().mockResolvedValue([]) }));
vi.mock('../api/indexing.js', () => ({ startIndex: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../api/events.js', () => ({ onEvent: vi.fn().mockResolvedValue(() => {}) }));

const tick = () => new Promise((r) => setTimeout(r, 0));

function openPalette(entries) {
  const mount = document.createElement('div');
  document.body.appendChild(mount);
  const store = createStore({ ...initialTabsState(), homePath: 'C:\\Dir' });
  updatePane(store, getActiveSide(store.getState()), { path: 'C:\\Dir', entries, loading: false });
  const bus = createEventBus();
  const palette = new CommandPalette({ mount, store, bus });
  palette.init();
  palette.open();
  return palette;
}

describe('CommandPalette — tag filter matches across path casing (Windows)', () => {
  beforeEach(() => pathsForTag.mockReset());

  const entries = [
    { name: 'Alpha.txt', kind: 'file', path: 'C:\\Dir\\Alpha.txt' },
    { name: 'Beta.txt', kind: 'file', path: 'C:\\Dir\\Beta.txt' },
    { name: 'Gamma.txt', kind: 'file', path: 'C:\\Dir\\Gamma.txt' },
  ];

  it('keeps folder entries whose case-folded path is in the tag set', async () => {
    const palette = openPalette(entries);
    // Index stores normalized (lowercased) paths — as on Windows.
    pathsForTag.mockResolvedValue(['c:\\dir\\alpha.txt', 'c:\\dir\\gamma.txt']);

    palette._activeTags = new Set(['urgent']);
    palette.rebuildTagFilter();
    await tick();

    expect(palette.filtered().map((e) => e.name)).toEqual(['Alpha.txt', 'Gamma.txt']);
  });

  it('AND-intersects multiple tags (case-insensitively)', async () => {
    const palette = openPalette(entries);
    // urgent → Alpha, Beta ; done → Beta, Gamma ; intersection → Beta
    pathsForTag.mockImplementation((tag) =>
      Promise.resolve(
        tag === 'urgent'
          ? ['c:\\dir\\alpha.txt', 'c:\\dir\\beta.txt']
          : ['c:\\dir\\beta.txt', 'c:\\dir\\gamma.txt'],
      ),
    );
    palette._activeTags = new Set(['urgent', 'done']);
    palette.rebuildTagFilter();
    await tick();

    expect(palette.filtered().map((e) => e.name)).toEqual(['Beta.txt']);
  });

  it('a tag that matches nothing in this folder yields an empty list (not a crash)', async () => {
    const palette = openPalette(entries);
    pathsForTag.mockResolvedValue(['c:\\other\\zzz.txt']);
    palette._activeTags = new Set(['archive']);
    palette.rebuildTagFilter();
    await tick();
    expect(palette.filtered()).toEqual([]);
  });
});

describe('pathKey — matches the backend normalize', () => {
  it('folds case, unifies separators, trims trailing, keeps roots and UNC', () => {
    expect(pathKey('C:\\Foo\\Bar.TXT')).toBe('c:\\foo\\bar.txt');
    expect(pathKey('c:/foo/BAR.txt')).toBe('c:\\foo\\bar.txt');
    expect(pathKey('C:\\Foo\\')).toBe('c:\\foo');
    expect(pathKey('C:\\')).toBe('c:\\');
    expect(pathKey('C:\\\\Foo\\\\Bar')).toBe('c:\\foo\\bar');
    expect(pathKey('\\\\Server\\Share\\F.txt')).toBe('\\\\server\\share\\f.txt');
  });
});
