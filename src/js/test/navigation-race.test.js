import { describe, it, expect, vi } from 'vitest';
import { FilePanel } from '../components/file-panel.js';
import { createStore } from '../core/store.js';
import { createEventBus } from '../core/event-bus.js';
import { initialTabsState } from '../state/tabs.js';
import { getPane } from '../state/panes.js';

// listDir resolves only when the test says so — to reorder responses.
const pending = {};
vi.mock('../api/fs.js', () => ({
  listDir: vi.fn(
    (path) =>
      new Promise((resolve, reject) => {
        pending[path] = { resolve, reject };
      }),
  ),
}));
vi.mock('../api/system.js', () => ({ openPath: vi.fn(), nativeIcon: vi.fn().mockResolvedValue(null) }));
vi.mock('../api/tags.js', () => ({ tagsForPaths: vi.fn().mockResolvedValue({}), listTag: vi.fn() }));
vi.mock('../api/dir_size.js', () => ({ dirSizes: vi.fn().mockResolvedValue({}), computeDirSizes: vi.fn() }));

const file = (dir, name) => ({ path: `${dir}/${name}`, name, kind: 'file', size: 1, modified: 1 });

function makePanel() {
  const mount = document.createElement('div');
  document.body.appendChild(mount);
  const store = createStore({ ...initialTabsState(), homePath: '' });
  const panel = new FilePanel({ mount, store, bus: createEventBus(), side: 'left' });
  panel.init();
  return { panel, store };
}

describe('FilePanel navigation race', () => {
  it('a slow response for a folder the user already left is ignored', async () => {
    const { panel, store } = makePanel();
    const toA = panel.navigate('/A');
    const toB = panel.navigate('/B');
    pending['/B'].resolve([file('/B', 'b.txt')]);
    await toB;
    pending['/A'].resolve([file('/A', 'a.txt')]);
    await toA;
    const pane = getPane(store.getState(), 'left');
    expect(pane.path).toBe('/B');
    expect(pane.entries.map((e) => e.path)).toEqual(['/B/b.txt']);
    expect(pane.history).toEqual(['/B']);
  });

  it('a late error of a superseded navigation does not replace the listing', async () => {
    const { panel, store } = makePanel();
    const toA = panel.navigate('/A2');
    const toB = panel.navigate('/B2');
    pending['/B2'].resolve([file('/B2', 'x')]);
    await toB;
    pending['/A2'].reject(new Error('denied'));
    await toA;
    expect(getPane(store.getState(), 'left').error).toBeNull();
  });
});
