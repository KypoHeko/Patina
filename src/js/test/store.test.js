import { describe, it, expect } from 'vitest';
import { createStore } from './store.js';

describe('createStore', () => {
  it('возвращает начальное состояние через getState', () => {
    const store = createStore({ a: 1, b: 'hello' });
    expect(store.getState()).toEqual({ a: 1, b: 'hello' });
  });

  it('обновляет состояние объектом-патчем', () => {
    const store = createStore({ x: 0 });
    store.setState({ x: 42 });
    expect(store.getState().x).toBe(42);
  });

  it('обновляет состояние функцией-патчем', () => {
    const store = createStore({ count: 5 });
    store.setState((s) => ({ count: s.count + 1 }));
    expect(store.getState().count).toBe(6);
  });

  it('сливает патч поверхностно (не глубоко)', () => {
    const store = createStore({ a: { x: 1 }, b: 2 });
    store.setState({ b: 3 });
    expect(store.getState().b).toBe(3);
    expect(store.getState().a).toEqual({ x: 1 });
  });

  it('уведомляет подписчиков при setState', () => {
    const store = createStore({ v: 0 });
    const spy = vi.fn();
    store.subscribe(spy);
    store.setState({ v: 1 });
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith({ v: 1 });
  });

  it('функция отписки, возвращаемая subscribe, снимает подписку', () => {
    const store = createStore({ v: 0 });
    const spy = vi.fn();
    const unsub = store.subscribe(spy);
    unsub();
    store.setState({ v: 1 });
    expect(spy).not.toHaveBeenCalled();
  });

  it('подписчики не мешают друг другу при отписке', () => {
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

  it('не мутирует прежний объект состояния', () => {
    const store = createStore({ v: 0 });
    const prev = store.getState();
    store.setState({ v: 1 });
    expect(prev.v).toBe(0);
    expect(store.getState().v).toBe(1);
  });
});
