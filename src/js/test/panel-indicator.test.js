import { describe, it, expect, vi } from 'vitest';
import { DuplicatePanel } from '../components/duplicate-panel.js';
import { createStore } from '../core/store.js';
import { createEventBus } from '../core/event-bus.js';
import { initialTabsState } from '../state/tabs.js';
import { findDuplicates } from '../api/duplicates.js';

vi.mock('../api/duplicates.js', () => ({ findDuplicates: vi.fn().mockResolvedValue([]) }));
vi.mock('../api/fs.js', () => ({ deleteEntries: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../api/events.js', () => ({ onEvent: vi.fn().mockResolvedValue(() => {}) }));

const tick = () => new Promise((r) => setTimeout(r, 0));

describe('Toolbar button indicator reflects panel open state', () => {
  it('duplicates-btn gets is-on while the panel is open', async () => {
    document.body.innerHTML = '<div class="main"></div><button id="duplicates-btn"></button>';
    const btn = document.getElementById('duplicates-btn');
    const mount = document.createElement('div');
    document.body.appendChild(mount);
    const store = createStore({ ...initialTabsState(), homePath: '/home' });
    const panel = new DuplicatePanel({ mount, store, bus: createEventBus() });
    panel.init();

    expect(btn.classList.contains('is-on')).toBe(false);

    panel.open();
    expect(btn.classList.contains('is-on')).toBe(true);
    await tick(); // scan resolves

    panel.close();
    expect(btn.classList.contains('is-on')).toBe(false);
  });
});
