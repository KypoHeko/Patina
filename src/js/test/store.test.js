import { describe, it, expect } from 'vitest';
import { createStore } from '../core/store.js';

describe('createStore', () => {
  it('returns the initial state via getState', () => {
    const store = createStore({ a: 1, b: 'hello' });
    expect(store.getState()).toEqual({ a: 1, b: 'hello' });
  });

  it('updates the state with an object patch', () => {
    const store = createStore({ x: 0 });
    store.setState({ x: 42 });
    expect(store.getState().x).toBe(42);
  });

  it('updates the state with a function patch', () => {
    const store = createStore({ count: 5 });
    store.setState((s) => ({ count: s.count + 1 }));
    expect(store.getState().count).toBe(6);
  });

  it('merges the patch shallowly (not deeply)', () => {
    const store = createStore({ a: { x: 1 }, b: 2 });
    store.setState({ b: 3 });
    expect(store.getState().b).toBe(3);
    expect(store.getState().a).toEqual({ x: 1 });
  });

  it('notifies subscribers on setState', () => {
    const store = createStore({ v: 0 });
    const spy = vi.fn();
    store.subscribe(spy);
    store.setState({ v: 1 });
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith({ v: 1 });
  });

  it('the unsubscribe function returned by subscribe removes the subscription', () => {
    const store = createStore({ v: 0 });
    const spy = vi.fn();
    const unsub = store.subscribe(spy);
    unsub();
    store.setState({ v: 1 });
    expect(spy).not.toHaveBeenCalled();
  });

  it('subscribers do not interfere with each other on unsubscribe', () => {
    const store = createStore({ v: 0 });
    const spy1 = vi.fn();
    const spy2 = vi.fn();
    store.subscribe(spy1);
    const unsub2 = store.subscribe(spy2);
    unsub2();
    store.setState({ v: 1 });
    expect(spy1).toHaveBeenCalledTimes(1);
    expect(spy2).not.toHaveBeenCalled();
  });

  it('does not mutate the previous state object', () => {
    const store = createStore({ v: 0 });
    const prev = store.getState();
    store.setState({ v: 1 });
    expect(prev.v).toBe(0);
    expect(store.getState().v).toBe(1);
  });
});
