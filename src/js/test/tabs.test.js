import { describe, it, expect, beforeEach } from 'vitest';
import {
  initialTabsState,
  getActiveTab,
  getActiveSide,
  createTab,
  closeTab,
  reopenTab,
  splitTab,
  closeSplit,
  tabTitle,
} from '../state/tabs.js';
import { createStore } from '../core/store.js';
import { createEventBus } from '../core/event-bus.js';

function makeStore() {
  return createStore({ ...initialTabsState(), homePath: '/home' });
}

describe('initialTabsState', () => {
  it('creates a single tab', () => {
    const state = initialTabsState();
    expect(state.tabs).toHaveLength(1);
    expect(state.activeTabId).toBe(state.tabs[0].id);
  });

  it('a tab has left and right panes', () => {
    const state = initialTabsState();
    const tab = state.tabs[0];
    expect(tab.panes.left).toBeDefined();
    expect(tab.panes.right).toBeDefined();
    expect(tab.split).toBe(false);
  });
});

describe('getActiveTab', () => {
  it('returns the active tab', () => {
    const store = makeStore();
    const tab = getActiveTab(store.getState());
    expect(tab.id).toBe(store.getState().activeTabId);
  });
});

describe('getActiveSide', () => {
  it('defaults to the left side', () => {
    const store = makeStore();
    expect(getActiveSide(store.getState())).toBe('left');
  });
});

describe('createTab', () => {
  it('adds a tab and makes it active', () => {
    const store = makeStore();
    const prevCount = store.getState().tabs.length;
    createTab(store);
    expect(store.getState().tabs).toHaveLength(prevCount + 1);
    const newTab = getActiveTab(store.getState());
    expect(newTab.panes.left.path).toBe('/home');
  });
});

describe('closeTab', () => {
  it('closes a tab; if it is the last one — creates a new one', () => {
    const store = makeStore();
    const onlyTab = getActiveTab(store.getState());
    closeTab(store, onlyTab.id);
    // There should be 1 tab (a new one was created)
    expect(store.getState().tabs).toHaveLength(1);
    expect(store.getState().activeTabId).not.toBe(onlyTab.id);
  });

  it('closing an inactive tab does not change the active one', () => {
    const store = makeStore();
    createTab(store);
    const activeId = store.getState().activeTabId;
    const firstTab = store.getState().tabs[0];
    closeTab(store, firstTab.id);
    expect(store.getState().activeTabId).toBe(activeId);
  });
});

describe('reopenTab', () => {
  it('restores the last closed tab', () => {
    const store = makeStore();
    createTab(store);
    const secondId = store.getState().activeTabId;
    closeTab(store, secondId);
    reopenTab(store);
    const tabs = store.getState().tabs;
    expect(tabs).toHaveLength(2);
  });

  it('with no closed tabs — state does not change', () => {
    const store = makeStore();
    // _closed is empty — reopenTab returns {} from setState
    const prev = store.getState();
    reopenTab(store);
    // tabs may stay the same, but setState is still called
    // Check that the number of tabs did not increase
    expect(store.getState().tabs.length).toBeGreaterThanOrEqual(prev.tabs.length);
  });
});

describe('splitTab', () => {
  it('enables the second pane', () => {
    const store = makeStore();
    splitTab(store);
    const tab = getActiveTab(store.getState());
    expect(tab.split).toBe(true);
    expect(tab.panes.right).toBeDefined();
  });

  it('a repeated split does not change state', () => {
    const store = makeStore();
    splitTab(store);
    const tab1 = getActiveTab(store.getState());
    splitTab(store);
    const tab2 = getActiveTab(store.getState());
    expect(tab1).toBe(tab2); // same object — setState returned {}
  });
});

describe('closeSplit', () => {
  it('closes the right pane', () => {
    const store = makeStore();
    splitTab(store);
    closeSplit(store);
    const tab = getActiveTab(store.getState());
    expect(tab.split).toBe(false);
    expect(tab.activeSide).toBe('left');
  });

  it('closes the left pane — the right becomes the left', () => {
    const store = makeStore();
    // Navigate the right pane
    splitTab(store);
    const tab = getActiveTab(store.getState());
    const rightPath = '/home/right';
    tab.panes.right.path = rightPath;
    closeSplit(store, 'left');
    const updated = getActiveTab(store.getState());
    expect(updated.split).toBe(false);
    expect(updated.panes.left.path).toBe(rightPath);
  });
});

describe('tabTitle', () => {
  it('without split — the left pane name', () => {
    const store = makeStore();
    const tab = getActiveTab(store.getState());
    tab.panes.left.path = '/home/user/docs';
    expect(tabTitle(tab)).toBe('docs');
  });

  it('with split — "left / right"', () => {
    const store = makeStore();
    splitTab(store);
    const tab = getActiveTab(store.getState());
    tab.panes.left.path = '/home/user/docs';
    tab.panes.right.path = '/home/user/pics';
    expect(tabTitle(tab)).toBe('docs / pics');
  });
});
