import { describe, it, expect, beforeEach } from 'vitest';
import {
  getPane,
  updatePane,
  setActivePane,
  selectInPane,
  recordHistory,
  stepHistory,
} from '../state/panes.js';
import { createStore } from '../core/store.js';
import { initialTabsState } from '../state/tabs.js';

function makeStore() {
  return createStore({ ...initialTabsState(), homePath: '/home' });
}

describe('getPane', () => {
  it('returns the left pane of the active tab', () => {
    const store = makeStore();
    const pane = getPane(store.getState(), 'left');
    expect(pane).toBeDefined();
    expect(pane.path).toBe('');
  });
});

describe('updatePane', () => {
  it('updates pane properties', () => {
    const store = makeStore();
    updatePane(store, 'left', { path: '/home', loading: true });
    const pane = getPane(store.getState(), 'left');
    expect(pane.path).toBe('/home');
    expect(pane.loading).toBe(true);
  });

  it('does not affect the other pane', () => {
    const store = makeStore();
    updatePane(store, 'left', { path: '/home/left' });
    const right = getPane(store.getState(), 'right');
    expect(right.path).toBe('');
  });
});

describe('setActivePane', () => {
  it('toggles the active side', () => {
    const store = makeStore();
    setActivePane(store, 'right');
    const tab = store.getState().tabs[0];
    expect(tab.activeSide).toBe('right');
  });

  it('does not mutate if already active', () => {
    const store = makeStore();
    const before = store.getState();
    setActivePane(store, 'left');
    expect(store.getState()).toBe(before); // same object — setState returned {}
  });
});

describe('selectInPane', () => {
  it('sets the selection', () => {
    const store = makeStore();
    selectInPane(store, 'left', ['/a', '/b']);
    const pane = getPane(store.getState(), 'left');
    expect(pane.selected).toEqual(['/a', '/b']);
  });
});

describe('recordHistory', () => {
  it('adds a path to history', () => {
    const store = makeStore();
    recordHistory(store, 'left', '/home');
    const pane = getPane(store.getState(), 'left');
    expect(pane.history).toContain('/home');
    expect(pane.historyIndex).toBe(0);
  });

  it('consecutive duplicates are not added', () => {
    const store = makeStore();
    recordHistory(store, 'left', '/home');
    recordHistory(store, 'left', '/home');
    const pane = getPane(store.getState(), 'left');
    expect(pane.history).toHaveLength(1);
  });

  it('the "forward" tail is truncated on a new navigation', () => {
    const store = makeStore();
    recordHistory(store, 'left', '/a');
    recordHistory(store, 'left', '/b');
    recordHistory(store, 'left', '/c');
    // step back
    stepHistory(store, 'left', -1);
    // new navigation — tail /c is truncated
    recordHistory(store, 'left', '/d');
    const pane = getPane(store.getState(), 'left');
    expect(pane.history).toEqual(['/a', '/b', '/d']);
  });
});

describe('stepHistory', () => {
  it('step back returns the previous path', () => {
    const store = makeStore();
    recordHistory(store, 'left', '/a');
    recordHistory(store, 'left', '/b');
    const result = stepHistory(store, 'left', -1);
    expect(result).toBe('/a');
  });

  it('step forward after a step back', () => {
    const store = makeStore();
    recordHistory(store, 'left', '/a');
    recordHistory(store, 'left', '/b');
    stepHistory(store, 'left', -1);
    const result = stepHistory(store, 'left', +1);
    expect(result).toBe('/b');
  });

  it('beyond history bounds → null', () => {
    const store = makeStore();
    recordHistory(store, 'left', '/a');
    expect(stepHistory(store, 'left', -1)).toBeNull();
    expect(stepHistory(store, 'left', +1)).toBeNull();
  });
});
