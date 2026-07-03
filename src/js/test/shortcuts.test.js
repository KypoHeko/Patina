import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createShortcuts } from '../core/shortcuts.js';

// Helper: dispatch a keydown with the given modifiers from a specific target.
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

  it('calls the registered action handler for a combo', () => {
    sc = createShortcuts([{ combo: 'ctrl+k', action: 'palette' }]);
    const fn = vi.fn();
    sc.register('palette', fn);
    press('k', { ctrl: true });
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('does not react without the required modifier', () => {
    sc = createShortcuts([{ combo: 'ctrl+k', action: 'palette' }]);
    const fn = vi.fn();
    sc.register('palette', fn);
    press('k'); // without ctrl
    expect(fn).not.toHaveBeenCalled();
  });

  it('distinguishes ctrl+shift+t from ctrl+t', () => {
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

  it('metaKey (Cmd on macOS) is treated as ctrl', () => {
    sc = createShortcuts([{ combo: 'ctrl+k', action: 'palette' }]);
    const fn = vi.fn();
    sc.register('palette', fn);
    press('k', { meta: true });
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('key case does not matter (K and k)', () => {
    sc = createShortcuts([{ combo: 'ctrl+k', action: 'palette' }]);
    const fn = vi.fn();
    sc.register('palette', fn);
    press('K', { ctrl: true });
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('preventDefault is called when triggered', () => {
    sc = createShortcuts([{ combo: 'ctrl+k', action: 'palette' }]);
    sc.register('palette', () => {});
    const ev = press('k', { ctrl: true });
    expect(ev.defaultPrevented).toBe(true);
  });

  it('does not intercept keys while typing in <input>', () => {
    sc = createShortcuts([{ combo: 'ctrl+k', action: 'palette' }]);
    const fn = vi.fn();
    sc.register('palette', fn);
    const input = document.createElement('input');
    document.body.appendChild(input);
    press('k', { ctrl: true, target: input });
    expect(fn).not.toHaveBeenCalled();
  });

  it('does not intercept in contentEditable', () => {
    sc = createShortcuts([{ combo: 'ctrl+k', action: 'palette' }]);
    const fn = vi.fn();
    sc.register('palette', fn);
    const div = document.createElement('div');
    div.isContentEditable = true; // jsdom doesn't compute this itself — set it explicitly
    document.body.appendChild(div);
    press('k', { ctrl: true, target: div });
    expect(fn).not.toHaveBeenCalled();
  });

  it('a combo without a registered handler is safely ignored', () => {
    sc = createShortcuts([{ combo: 'ctrl+k', action: 'palette' }]);
    // handler is not registered
    expect(() => press('k', { ctrl: true })).not.toThrow();
  });

  it('destroy removes the global listener', () => {
    sc = createShortcuts([{ combo: 'ctrl+k', action: 'palette' }]);
    const fn = vi.fn();
    sc.register('palette', fn);
    sc.destroy();
    sc = null;
    press('k', { ctrl: true });
    expect(fn).not.toHaveBeenCalled();
  });
});
