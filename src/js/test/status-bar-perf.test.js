import { describe, it, expect, vi } from 'vitest';
import { StatusBar } from '../components/status-bar.js';
import { createStore } from '../core/store.js';
import { createEventBus } from '../core/event-bus.js';
import { initialTabsState } from '../state/tabs.js';
import { updatePane } from '../state/panes.js';

vi.mock('../api/system.js', () => ({ listStorage: vi.fn().mockResolvedValue([]) }));

describe('StatusBar with a large selection', () => {
  it('sums the selected sizes in linear time', () => {
    const mount = document.createElement('div');
    const store = createStore({ ...initialTabsState(), homePath: '' });
    new StatusBar({ mount, store, bus: createEventBus() }).init();
    const N = 20000;
    const entries = Array.from({ length: N }, (_, i) => ({ path: `/d/f${i}`, name: `f${i}`, kind: 'file', size: 2 }));
    const t0 = performance.now();
    updatePane(store, 'left', { path: '/d', entries, selected: entries.map((e) => e.path), historyIndex: 0 });
    const ms = performance.now() - t0;
    expect(mount.textContent).toContain('39.1 KB'); // 40 000 bytes
    expect(ms).toBeLessThan(150); // was ~430 ms with Array.includes
  });
});

describe('StatusBar hints', () => {
  it('turns only known hint kinds into a class and escapes the text', () => {
    const mount = document.createElement('div');
    const store = createStore({ ...initialTabsState(), homePath: '' });
    const bar = new StatusBar({ mount, store, bus: createEventBus() });
    bar.init();
    bar.flash('<img src=x onerror=alert(1)>', '"><img src=x onerror=alert(1)>');
    expect(mount.querySelector('img')).toBeNull();
    expect(mount.querySelector('span').className).toBe('status__hint');
    bar.flash('bad', 'error');
    expect(mount.querySelector('span').className).toBe('status__hint status__hint--error');
  });
});
