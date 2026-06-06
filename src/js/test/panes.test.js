import { describe, it, expect, beforeEach } from 'vitest';
import {
  getPane,
  updatePane,
  setActivePane,
  selectInPane,
  recordHistory,
  stepHistory,
} from './panes.js';
import { createStore } from '../core/store.js';
import { initialTabsState } from './tabs.js';

function makeStore() {
  return createStore({ ...initialTabsState(), homePath: '/home' });
}

describe('getPane', () => {
  it('возвращает левую панель активной вкладки', () => {
    const store = makeStore();
    const pane = getPane(store.getState(), 'left');
    expect(pane).toBeDefined();
    expect(pane.path).toBe('');
  });
});

describe('updatePane', () => {
  it('обновляет свойства панели', () => {
    const store = makeStore();
    updatePane(store, 'left', { path: '/home', loading: true });
    const pane = getPane(store.getState(), 'left');
    expect(pane.path).toBe('/home');
    expect(pane.loading).toBe(true);
  });

  it('не затрагивает другую панель', () => {
    const store = makeStore();
    updatePane(store, 'left', { path: '/home/left' });
    const right = getPane(store.getState(), 'right');
    expect(right.path).toBe('');
  });
});

describe('setActivePane', () => {
  it('переключает активную сторону', () => {
    const store = makeStore();
    setActivePane(store, 'right');
    const tab = store.getState().tabs[0];
    expect(tab.activeSide).toBe('right');
  });

  it('не мутирует если уже активна', () => {
    const store = makeStore();
    const before = store.getState();
    setActivePane(store, 'left');
    expect(store.getState()).toBe(before); // тот же объект — setState вернул {}
  });
});

describe('selectInPane', () => {
  it('устанавливает выделение', () => {
    const store = makeStore();
    selectInPane(store, 'left', ['/a', '/b']);
    const pane = getPane(store.getState(), 'left');
    expect(pane.selected).toEqual(['/a', '/b']);
  });
});

describe('recordHistory', () => {
  it('добавляет путь в историю', () => {
    const store = makeStore();
    recordHistory(store, 'left', '/home');
    const pane = getPane(store.getState(), 'left');
    expect(pane.history).toContain('/home');
    expect(pane.historyIndex).toBe(0);
  });

  it('дубликаты подряд не добавляются', () => {
    const store = makeStore();
    recordHistory(store, 'left', '/home');
    recordHistory(store, 'left', '/home');
    const pane = getPane(store.getState(), 'left');
    expect(pane.history).toHaveLength(1);
  });

  it('хвост «вперёд» обрезается при новом переходе', () => {
    const store = makeStore();
    recordHistory(store, 'left', '/a');
    recordHistory(store, 'left', '/b');
    recordHistory(store, 'left', '/c');
    // шаг назад
    stepHistory(store, 'left', -1);
    // новый переход — хвост /c обрезается
    recordHistory(store, 'left', '/d');
    const pane = getPane(store.getState(), 'left');
    expect(pane.history).toEqual(['/a', '/b', '/d']);
  });
});

describe('stepHistory', () => {
  it('шаг назад возвращает предыдущий путь', () => {
    const store = makeStore();
    recordHistory(store, 'left', '/a');
    recordHistory(store, 'left', '/b');
    const result = stepHistory(store, 'left', -1);
    expect(result).toBe('/a');
  });

  it('шаг вперёд после шага назад', () => {
    const store = makeStore();
    recordHistory(store, 'left', '/a');
    recordHistory(store, 'left', '/b');
    stepHistory(store, 'left', -1);
    const result = stepHistory(store, 'left', +1);
    expect(result).toBe('/b');
  });

  it('за пределами истории — null', () => {
    const store = makeStore();
    recordHistory(store, 'left', '/a');
    expect(stepHistory(store, 'left', -1)).toBeNull();
    expect(stepHistory(store, 'left', +1)).toBeNull();
  });
});
