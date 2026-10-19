import { describe, it, expect, vi } from 'vitest';

const setSplitRatio = vi.fn();
vi.mock('../state/ui.js', () => ({ setSplitRatio: (...a) => setSplitRatio(...a) }));
const { Divider } = await import('../components/divider.js');

describe('Divider', () => {
  it('writes the split ratio at most once per frame and once more on release', () => {
    const frames = [];
    vi.stubGlobal('requestAnimationFrame', (cb) => frames.push(cb));
    vi.stubGlobal('cancelAnimationFrame', () => frames.pop());
    const mount = document.createElement('div');
    const workspace = { getBoundingClientRect: () => ({ left: 0, width: 1000 }) };
    const d = new Divider({ mount, store: {}, bus: { on() {}, emit() {} }, workspace });
    d.init();
    mount.dispatchEvent(new MouseEvent('mousedown', { clientX: 500 }));
    for (let x = 300; x < 400; x += 10) document.dispatchEvent(new MouseEvent('mousemove', { clientX: x }));
    expect(setSplitRatio).not.toHaveBeenCalled();
    frames.shift()();
    expect(setSplitRatio).toHaveBeenCalledTimes(1);
    expect(setSplitRatio.mock.calls[0][1]).toBeCloseTo(0.39);
    document.dispatchEvent(new MouseEvent('mousemove', { clientX: 600 }));
    document.dispatchEvent(new MouseEvent('mouseup'));
    expect(setSplitRatio).toHaveBeenCalledTimes(2);
    expect(setSplitRatio.mock.calls[1][1]).toBeCloseTo(0.6);
    vi.unstubAllGlobals();
  });
});
