import { describe, it, expect, beforeEach } from 'vitest';
import { Component } from '../core/component.js';
import { createStore } from '../core/store.js';
import { createEventBus } from '../core/event-bus.js';

function makeCtx() {
  const mount = document.createElement('div');
  document.body.appendChild(mount);
  const store = createStore({ val: 0 });
  const bus = createEventBus();
  return { mount, store, bus };
}

describe('Component', () => {
  it('constructor stores mount, store, bus', () => {
    const ctx = makeCtx();
    const c = new Component(ctx);
    expect(c.mount).toBe(ctx.mount);
    expect(c.store).toBe(ctx.store);
    expect(c.bus).toBe(ctx.bus);
  });

  it('subscribe subscribes to the store, unsubscribes on destroy', () => {
    const ctx = makeCtx();
    const c = new Component(ctx);
    c.init();
    const spy = vi.fn();
    c.subscribe(spy);
    ctx.store.setState({ val: 1 });
    expect(spy).toHaveBeenCalledTimes(1);
    c.destroy();
    ctx.store.setState({ val: 2 });
    expect(spy).toHaveBeenCalledTimes(1); // no longer called
  });

  it('listen subscribes to the bus, unsubscribes on destroy', () => {
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

  it('on adds a listener, removes it on destroy', () => {
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

  it('destroy clears mount innerHTML', () => {
    const ctx = makeCtx();
    ctx.mount.innerHTML = '<span>hello</span>';
    const c = new Component(ctx);
    c.init();
    c.destroy();
    expect(ctx.mount.innerHTML).toBe('');
  });

  it('addChild: child component is destroyed together with the parent', () => {
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

  it('double destroy does not throw', () => {
    const ctx = makeCtx();
    const c = new Component(ctx);
    c.init();
    c.destroy();
    expect(() => c.destroy()).not.toThrow();
  });
});
