import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DuplicatePanel } from '../components/duplicate-panel.js';
import { createStore } from '../core/store.js';
import { createEventBus } from '../core/event-bus.js';
import { initialTabsState } from '../state/tabs.js';
import { deleteEntries } from '../api/fs.js';
import { findDuplicates } from '../api/duplicates.js';

vi.mock('../api/duplicates.js', () => ({ findDuplicates: vi.fn() }));
vi.mock('../api/fs.js', () => ({ deleteEntries: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../api/events.js', () => ({ onEvent: vi.fn().mockResolvedValue(() => {}) }));

const tick = () => new Promise((r) => setTimeout(r, 0));

function setup() {
  document.body.innerHTML = '<div class="main"></div>';
  const mount = document.createElement('div');
  document.body.appendChild(mount);
  const store = createStore({ ...initialTabsState(), homePath: '/home' });
  const bus = createEventBus();
  const panel = new DuplicatePanel({ mount, store, bus });
  panel.init();
  return { panel, mount, store, bus };
}

// A list long enough that a scroll offset is meaningful.
function groups(n) {
  return Array.from({ length: n }, (_, i) => ({
    size: 1000 + i,
    paths: [`/g${i}/a.bin`, `/g${i}/b.bin`, `/g${i}/c.bin`],
  }));
}

describe('DuplicatePanel — scroll position survives Keep/Delete', () => {
  beforeEach(() => {
    deleteEntries.mockClear();
    findDuplicates.mockReset();
  });

  it('keeps scrollTop after deleting one file', async () => {
    const { panel, mount } = setup();
    findDuplicates.mockResolvedValue(groups(40));
    panel.open();
    await tick(); // scan() resolves and renders

    const body = mount.querySelector('.dup__body');
    expect(body).toBeTruthy();
    body.scrollTop = 500;

    await panel.removePaths(['/g10/b.bin']); // re-renders

    const bodyAfter = mount.querySelector('.dup__body');
    expect(bodyAfter.scrollTop).toBe(500);
    expect(deleteEntries).toHaveBeenCalledWith(['/g10/b.bin']);
    // the affected group lost exactly one file (3 → 2)
    expect(panel._groups.find((g) => g.paths[0] === '/g10/a.bin').paths).toEqual([
      '/g10/a.bin',
      '/g10/c.bin',
    ]);
  });

  it('keeps scrollTop after Keep-first collapses a group', async () => {
    const { panel, mount } = setup();
    findDuplicates.mockResolvedValue(groups(40));
    panel.open();
    await tick();

    const body = mount.querySelector('.dup__body');
    body.scrollTop = 320;

    // Keep-first on group 5 removes paths[1..] → group drops to 1 → group removed.
    await panel.removePaths(panel._groups[5].paths.slice(1));

    expect(mount.querySelector('.dup__body').scrollTop).toBe(320);
    expect(panel._groups).toHaveLength(39);
  });
});
