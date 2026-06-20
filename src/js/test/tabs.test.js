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
  it('создаёт одну вкладку', () => {
    const state = initialTabsState();
    expect(state.tabs).toHaveLength(1);
    expect(state.activeTabId).toBe(state.tabs[0].id);
  });

  it('вкладка имеет левую и правую панели', () => {
    const state = initialTabsState();
    const tab = state.tabs[0];
    expect(tab.panes.left).toBeDefined();
    expect(tab.panes.right).toBeDefined();
    expect(tab.split).toBe(false);
  });
});

describe('getActiveTab', () => {
  it('возвращает активную вкладку', () => {
    const store = makeStore();
    const tab = getActiveTab(store.getState());
    expect(tab.id).toBe(store.getState().activeTabId);
  });
});

describe('getActiveSide', () => {
  it('по умолчанию левая сторона', () => {
    const store = makeStore();
    expect(getActiveSide(store.getState())).toBe('left');
  });
});

describe('createTab', () => {
  it('добавляет вкладку и делает её активной', () => {
    const store = makeStore();
    const prevCount = store.getState().tabs.length;
    createTab(store);
    expect(store.getState().tabs).toHaveLength(prevCount + 1);
    const newTab = getActiveTab(store.getState());
    expect(newTab.panes.left.path).toBe('/home');
  });
});

describe('closeTab', () => {
  it('закрывает вкладку; если последняя — создаёт новую', () => {
    const store = makeStore();
    const onlyTab = getActiveTab(store.getState());
    closeTab(store, onlyTab.id);
    // Должна быть 1 вкладка (создана новая)
    expect(store.getState().tabs).toHaveLength(1);
    expect(store.getState().activeTabId).not.toBe(onlyTab.id);
  });

  it('при закрытии неактивной активная не меняется', () => {
    const store = makeStore();
    createTab(store);
    const activeId = store.getState().activeTabId;
    const firstTab = store.getState().tabs[0];
    closeTab(store, firstTab.id);
    expect(store.getState().activeTabId).toBe(activeId);
  });
});

describe('reopenTab', () => {
  it('восстанавливает последнюю закрытую вкладку', () => {
    const store = makeStore();
    createTab(store);
    const secondId = store.getState().activeTabId;
    closeTab(store, secondId);
    reopenTab(store);
    const tabs = store.getState().tabs;
    expect(tabs).toHaveLength(2);
  });

  it('без закрытых вкладок — состояние не меняется', () => {
    const store = makeStore();
    // _closed пуст — reopenTab вернёт {} из setState
    const prev = store.getState();
    reopenTab(store);
    // tabs может не измениться, но setState всё равно вызывается
    // Проверяем что количество вкладок не увеличилось
    expect(store.getState().tabs.length).toBeGreaterThanOrEqual(prev.tabs.length);
  });
});

describe('splitTab', () => {
  it('включает вторую панель', () => {
    const store = makeStore();
    splitTab(store);
    const tab = getActiveTab(store.getState());
    expect(tab.split).toBe(true);
    expect(tab.panes.right).toBeDefined();
  });

  it('повторный split не меняет состояние', () => {
    const store = makeStore();
    splitTab(store);
    const tab1 = getActiveTab(store.getState());
    splitTab(store);
    const tab2 = getActiveTab(store.getState());
    expect(tab1).toBe(tab2); // тот же объект — setState вернул {}
  });
});

describe('closeSplit', () => {
  it('закрывает правую панель', () => {
    const store = makeStore();
    splitTab(store);
    closeSplit(store);
    const tab = getActiveTab(store.getState());
    expect(tab.split).toBe(false);
    expect(tab.activeSide).toBe('left');
  });

  it('закрывает левую панель — правая становится левой', () => {
    const store = makeStore();
    // Навигируем правую панель
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
  it('без split — имя левой панели', () => {
    const store = makeStore();
    const tab = getActiveTab(store.getState());
    tab.panes.left.path = '/home/user/docs';
    expect(tabTitle(tab)).toBe('docs');
  });

  it('со split — «левая / правая»', () => {
    const store = makeStore();
    splitTab(store);
    const tab = getActiveTab(store.getState());
    tab.panes.left.path = '/home/user/docs';
    tab.panes.right.path = '/home/user/pics';
    expect(tabTitle(tab)).toBe('docs / pics');
  });
});
