import { describe, it, expect } from 'vitest';
import { createEventBus } from './event-bus.js';

describe('createEventBus', () => {
  it('emit вызывает подписчика с payload', () => {
    const bus = createEventBus();
    const spy = vi.fn();
    bus.on('test', spy);
    bus.emit('test', { x: 1 });
    expect(spy).toHaveBeenCalledWith({ x: 1 });
  });

  it('несколько подписчиков одного события получают один payload', () => {
    const bus = createEventBus();
    const spy1 = vi.fn();
    const spy2 = vi.fn();
    bus.on('ev', spy1);
    bus.on('ev', spy2);
    bus.emit('ev', 42);
    expect(spy1).toHaveBeenCalledWith(42);
    expect(spy2).toHaveBeenCalledWith(42);
  });

  it('подписчики разных событий не пересекаются', () => {
    const bus = createEventBus();
    const spyA = vi.fn();
    const spyB = vi.fn();
    bus.on('a', spyA);
    bus.on('b', spyB);
    bus.emit('a', 1);
    expect(spyA).toHaveBeenCalledWith(1);
    expect(spyB).not.toHaveBeenCalled();
  });

  it('off снимает подписку', () => {
    const bus = createEventBus();
    const spy = vi.fn();
    bus.on('ev', spy);
    bus.off('ev', spy);
    bus.emit('ev', 1);
    expect(spy).not.toHaveBeenCalled();
  });

  it('on возвращает функцию отписки', () => {
    const bus = createEventBus();
    const spy = vi.fn();
    const unsub = bus.on('ev', spy);
    unsub();
    bus.emit('ev', 1);
    expect(spy).not.toHaveBeenCalled();
  });

  it('emit без подписчиков не бросает исключение', () => {
    const bus = createEventBus();
    expect(() => bus.emit('missing', null)).not.toThrow();
  });

  it('повторная отписка безопасна', () => {
    const bus = createEventBus();
    const spy = vi.fn();
    const unsub = bus.on('ev', spy);
    unsub();
    unsub(); // второй раз — не должно бросить
    expect(() => unsub()).not.toThrow();
  });
});
