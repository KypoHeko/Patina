import { describe, it, expect } from 'vitest';
import { initialUiState, getSplitRatio, setSplitRatio } from '../state/ui.js';
import { createStore } from '../core/store.js';

describe('initialUiState', () => {
  it('даёт ожидаемые значения по умолчанию', () => {
    const s = initialUiState();
    expect(s.splitRatio).toBe(0.5);
    expect(s.homePath).toBe('');
    expect(s.searchQuery).toBe('');
  });

  it('возвращает новый объект на каждый вызов (без общего мутабельного стейта)', () => {
    expect(initialUiState()).not.toBe(initialUiState());
  });
});

describe('getSplitRatio / setSplitRatio', () => {
  it('getSplitRatio читает текущее значение', () => {
    const store = createStore(initialUiState());
    expect(getSplitRatio(store.getState())).toBe(0.5);
  });

  it('setSplitRatio пишет новое значение в стор', () => {
    const store = createStore(initialUiState());
    setSplitRatio(store, 0.3);
    expect(getSplitRatio(store.getState())).toBe(0.3);
  });

  it('setSplitRatio уведомляет подписчиков', () => {
    const store = createStore(initialUiState());
    let seen = null;
    store.subscribe((s) => { seen = s.splitRatio; });
    setSplitRatio(store, 0.72);
    expect(seen).toBe(0.72);
  });

  it('не затирает другие поля среза', () => {
    const store = createStore({ ...initialUiState(), homePath: 'C:\\Users\\me' });
    setSplitRatio(store, 0.6);
    expect(store.getState().homePath).toBe('C:\\Users\\me');
  });
});
