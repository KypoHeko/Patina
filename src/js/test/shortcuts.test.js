import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createShortcuts } from '../core/shortcuts.js';

// Хелпер: отправить keydown с заданными модификаторами от конкретной цели.
function press(key, { ctrl = false, shift = false, alt = false, meta = false, target = document.body } = {}) {
  const ev = new KeyboardEvent('keydown', {
    key,
    ctrlKey: ctrl,
    shiftKey: shift,
    altKey: alt,
    metaKey: meta,
    bubbles: true,
    cancelable: true,
  });
  target.dispatchEvent(ev);
  return ev;
}

describe('createShortcuts', () => {
  let sc;

  beforeEach(() => {
    document.body.innerHTML = '';
  });

  afterEach(() => {
    sc?.destroy();
    sc = null;
  });

  it('вызывает обработчик зарегистрированного действия по комбинации', () => {
    sc = createShortcuts([{ combo: 'ctrl+k', action: 'palette' }]);
    const fn = vi.fn();
    sc.register('palette', fn);
    press('k', { ctrl: true });
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('не реагирует без нужного модификатора', () => {
    sc = createShortcuts([{ combo: 'ctrl+k', action: 'palette' }]);
    const fn = vi.fn();
    sc.register('palette', fn);
    press('k'); // без ctrl
    expect(fn).not.toHaveBeenCalled();
  });

  it('различает ctrl+shift+t и ctrl+t', () => {
    sc = createShortcuts([
      { combo: 'ctrl+t', action: 'new' },
      { combo: 'ctrl+shift+t', action: 'reopen' },
    ]);
    const newTab = vi.fn();
    const reopen = vi.fn();
    sc.register('new', newTab);
    sc.register('reopen', reopen);

    press('t', { ctrl: true });
    expect(newTab).toHaveBeenCalledTimes(1);
    expect(reopen).not.toHaveBeenCalled();

    press('t', { ctrl: true, shift: true });
    expect(reopen).toHaveBeenCalledTimes(1);
    expect(newTab).toHaveBeenCalledTimes(1);
  });

  it('metaKey (Cmd на macOS) трактуется как ctrl', () => {
    sc = createShortcuts([{ combo: 'ctrl+k', action: 'palette' }]);
    const fn = vi.fn();
    sc.register('palette', fn);
    press('k', { meta: true });
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('регистр клавиши не важен (K и k)', () => {
    sc = createShortcuts([{ combo: 'ctrl+k', action: 'palette' }]);
    const fn = vi.fn();
    sc.register('palette', fn);
    press('K', { ctrl: true });
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('preventDefault вызывается при срабатывании', () => {
    sc = createShortcuts([{ combo: 'ctrl+k', action: 'palette' }]);
    sc.register('palette', () => {});
    const ev = press('k', { ctrl: true });
    expect(ev.defaultPrevented).toBe(true);
  });

  it('не перехватывает клавиши при наборе в <input>', () => {
    sc = createShortcuts([{ combo: 'ctrl+k', action: 'palette' }]);
    const fn = vi.fn();
    sc.register('palette', fn);
    const input = document.createElement('input');
    document.body.appendChild(input);
    press('k', { ctrl: true, target: input });
    expect(fn).not.toHaveBeenCalled();
  });

  it('не перехватывает в contentEditable', () => {
    sc = createShortcuts([{ combo: 'ctrl+k', action: 'palette' }]);
    const fn = vi.fn();
    sc.register('palette', fn);
    const div = document.createElement('div');
    div.isContentEditable = true; // jsdom не вычисляет это сам — задаём явно
    document.body.appendChild(div);
    press('k', { ctrl: true, target: div });
    expect(fn).not.toHaveBeenCalled();
  });

  it('комбинация без зарегистрированного обработчика безопасно игнорируется', () => {
    sc = createShortcuts([{ combo: 'ctrl+k', action: 'palette' }]);
    // обработчик не зарегистрирован
    expect(() => press('k', { ctrl: true })).not.toThrow();
  });

  it('destroy снимает глобальный слушатель', () => {
    sc = createShortcuts([{ combo: 'ctrl+k', action: 'palette' }]);
    const fn = vi.fn();
    sc.register('palette', fn);
    sc.destroy();
    sc = null;
    press('k', { ctrl: true });
    expect(fn).not.toHaveBeenCalled();
  });
});
