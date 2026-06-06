import { describe, it, expect, beforeEach } from 'vitest';
import { Component } from './component.js';
import { createStore } from './store.js';
import { createEventBus } from './event-bus.js';

function makeCtx() {
  const mount = document.createElement('div');
  document.body.appendChild(mount);
  const store = createStore({ val: 0 });
  const bus = createEventBus();
  return { mount, store, bus };
}

describe('Component', () => {
  it('конструктор сохраняет mount, store, bus', () => {
    const ctx = makeCtx();
    const c = new Component(ctx);
    expect(c.mount).toBe(ctx.mount);
    expect(c.store).toBe(ctx.store);
    expect(c.bus).toBe(ctx.bus);
  });

  it('subscribe подписывается на store, отписка при destroy', () => {
    const ctx = makeCtx();
    const c = new Component(ctx);
    c.init();
    const spy = vi.fn();
    c.subscribe(spy);
    ctx.store.setState({ val: 1 });
    expect(spy).toHaveBeenCalledTimes(1);
    c.destroy();
    ctx.store.setState({ val: 2 });
    expect(spy).toHaveBeenCalledTimes(1); // больше не вызывается
  });

  it('listen подписывается на bus, отписка при destroy', () => {
    const ctx = makeCtx();
    const c = new Component(ctx);
    c.init();
    const spy = vi.fn();
    c.listen('test', spy);
    ctx.bus.emit('test', 42);
    expect(spy).toHaveBeenCalledWith(42);
    c.destroy();
    ctx.bus.emit('test', 43);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('on добавляет слушатель, снимает при destroy', () => {
    const ctx = makeCtx();
    const btn = document.createElement('button');
    document.body.appendChild(btn);
    const c = new Component(ctx);
    c.init();
    const spy = vi.fn();
    c.on(btn, 'click', spy);
    btn.click();
    expect(spy).toHaveBeenCalledTimes(1);
    c.destroy();
    btn.click();
    expect(spy).toHaveBeenCalledTimes(1);
    btn.remove();
  });

  it('destroy очищает mount innerHTML', () => {
    const ctx = makeCtx();
    ctx.mount.innerHTML = '<span>hello</span>';
    const c = new Component(ctx);
    c.init();
    c.destroy();
    expect(ctx.mount.innerHTML).toBe('');
  });

  it('addChild: дочерний компонент уничтожается вместе с родителем', () => {
    const ctx = makeCtx();
    const childMount = document.createElement('div');
    ctx.mount.appendChild(childMount);
    const parent = new Component(ctx);
    const child = new Component({ mount: childMount, store: ctx.store, bus: ctx.bus });
    child.init();
    const spy = vi.fn();
    child.subscribe(spy);
    parent.addChild(child);
    parent.destroy();
    ctx.store.setState({ val: 1 });
    expect(spy).not.toHaveBeenCalled();
  });

  it('двойной destroy не бросает исключение', () => {
    const ctx = makeCtx();
    const c = new Component(ctx);
    c.init();
    c.destroy();
    expect(() => c.destroy()).not.toThrow();
  });
});
