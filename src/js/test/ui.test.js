import { describe, it, expect } from 'vitest';
import { initialUiState, getSplitRatio, setSplitRatio } from '../state/ui.js';
import { createStore } from '../core/store.js';

describe('initialUiState', () => {
  it('gives the expected default values', () => {
    const s = initialUiState();
    expect(s.splitRatio).toBe(0.5);
    expect(s.homePath).toBe('');
    expect(s.searchQuery).toBe('');
  });

  it('returns a new object on each call (no shared mutable state)', () => {
    expect(initialUiState()).not.toBe(initialUiState());
  });
});

describe('getSplitRatio / setSplitRatio', () => {
  it('getSplitRatio reads the current value', () => {
    const store = createStore(initialUiState());
    expect(getSplitRatio(store.getState())).toBe(0.5);
  });

  it('setSplitRatio writes a new value to the store', () => {
    const store = createStore(initialUiState());
    setSplitRatio(store, 0.3);
    expect(getSplitRatio(store.getState())).toBe(0.3);
  });

  it('setSplitRatio notifies subscribers', () => {
    const store = createStore(initialUiState());
    let seen = null;
    store.subscribe((s) => { seen = s.splitRatio; });
    setSplitRatio(store, 0.72);
    expect(seen).toBe(0.72);
  });

  it('does not clobber other fields of the slice', () => {
    const store = createStore({ ...initialUiState(), homePath: 'C:\\Users\\me' });
    setSplitRatio(store, 0.6);
    expect(store.getState().homePath).toBe('C:\\Users\\me');
  });
});
