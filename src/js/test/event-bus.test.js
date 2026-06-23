import { describe, it, expect } from 'vitest';
import { createEventBus } from '../core/event-bus.js';

describe('createEventBus', () => {
  it('emit calls the subscriber with the payload', () => {
    const bus = createEventBus();
    const spy = vi.fn();
    bus.on('test', spy);
    bus.emit('test', { x: 1 });
    expect(spy).toHaveBeenCalledWith({ x: 1 });
  });

  it('multiple subscribers of one event receive the same payload', () => {
    const bus = createEventBus();
    const spy1 = vi.fn();
    const spy2 = vi.fn();
    bus.on('ev', spy1);
    bus.on('ev', spy2);
    bus.emit('ev', 42);
    expect(spy1).toHaveBeenCalledWith(42);
    expect(spy2).toHaveBeenCalledWith(42);
  });

  it('subscribers of different events do not overlap', () => {
    const bus = createEventBus();
    const spyA = vi.fn();
    const spyB = vi.fn();
    bus.on('a', spyA);
    bus.on('b', spyB);
    bus.emit('a', 1);
    expect(spyA).toHaveBeenCalledWith(1);
    expect(spyB).not.toHaveBeenCalled();
  });

  it('off removes the subscription', () => {
    const bus = createEventBus();
    const spy = vi.fn();
    bus.on('ev', spy);
    bus.off('ev', spy);
    bus.emit('ev', 1);
    expect(spy).not.toHaveBeenCalled();
  });

  it('on returns an unsubscribe function', () => {
    const bus = createEventBus();
    const spy = vi.fn();
    const unsub = bus.on('ev', spy);
    unsub();
    bus.emit('ev', 1);
    expect(spy).not.toHaveBeenCalled();
  });

  it('emit with no subscribers does not throw', () => {
    const bus = createEventBus();
    expect(() => bus.emit('missing', null)).not.toThrow();
  });

  it('repeated unsubscribe is safe', () => {
    const bus = createEventBus();
    const spy = vi.fn();
    const unsub = bus.on('ev', spy);
    unsub();
    unsub(); // second time — should not throw
    expect(() => unsub()).not.toThrow();
  });
});
