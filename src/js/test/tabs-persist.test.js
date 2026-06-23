import { describe, it, expect, beforeEach } from 'vitest';
import { serializeTabs, saveTabs, loadSavedTabs, restoreTabs } from '../state/tabs.js';

function sampleState() {
  return {
    activeTabId: 'tab-B',
    tabs: [
      {
        id: 'tab-A',
        split: false,
        activeSide: 'left',
        color: null,
        panes: { left: { path: 'C:\\One' }, right: { path: '' } },
      },
      {
        id: 'tab-B',
        split: true,
        activeSide: 'right',
        color: { from: '#10b981', to: '#14b8a6' },
        panes: { left: { path: 'C:\\Two' }, right: { path: 'C:\\Three' } },
      },
    ],
  };
}

describe('tab persistence', () => {
  beforeEach(() => localStorage.clear());

  it('serializes only paths + layout + active index', () => {
    const data = serializeTabs(sampleState());
    expect(data.v).toBe(1);
    expect(data.activeIndex).toBe(1);
    expect(data.tabs).toEqual([
      { l: 'C:\\One', r: '', split: false, side: 'left', color: null },
      { l: 'C:\\Two', r: 'C:\\Three', split: true, side: 'right', color: { from: '#10b981', to: '#14b8a6' } },
    ]);
  });

  it('save → load round-trips', () => {
    saveTabs(sampleState());
    expect(loadSavedTabs()).toEqual(serializeTabs(sampleState()));
  });

  it('restores tabs with paths, split, active side, color, and active tab', () => {
    saveTabs(sampleState());
    const restored = restoreTabs(loadSavedTabs());

    expect(restored.tabs).toHaveLength(2);
    const [a, b] = restored.tabs;

    expect(a.panes.left.path).toBe('C:\\One');
    expect(a.split).toBe(false);
    expect(a.panes.right.path).toBe(''); // not split → no right path
    expect(a.activeSide).toBe('left');

    expect(b.panes.left.path).toBe('C:\\Two');
    expect(b.split).toBe(true);
    expect(b.panes.right.path).toBe('C:\\Three');
    expect(b.activeSide).toBe('right');
    expect(b.color).toEqual({ from: '#10b981', to: '#14b8a6' });

    // active index 1 → second tab is active
    expect(restored.activeTabId).toBe(b.id);

    // panes start fresh so the panel re-navigates to the saved path
    expect(a.panes.left.historyIndex).toBe(-1);
    expect(a.panes.left.entries).toEqual([]);
  });

  it('returns null when nothing is saved', () => {
    expect(loadSavedTabs()).toBeNull();
    expect(restoreTabs(null)).toBeNull();
  });

  it('ignores a snapshot from a different version', () => {
    localStorage.setItem('patina:tabs', JSON.stringify({ v: 999, tabs: [{ l: 'C:\\x' }] }));
    expect(loadSavedTabs()).toBeNull();
  });

  it('ignores corrupt JSON', () => {
    localStorage.setItem('patina:tabs', '{not json');
    expect(loadSavedTabs()).toBeNull();
  });

  it('does not persist an empty tab set', () => {
    saveTabs({ activeTabId: null, tabs: [] });
    expect(localStorage.getItem('patina:tabs')).toBeNull();
  });
});
