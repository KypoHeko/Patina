import { describe, it, expect, vi, beforeEach } from 'vitest';

const invoke = vi.fn();
vi.mock('../api/invoke.js', () => ({ invoke: (...a) => invoke(...a) }));

describe('listStorage cache', () => {
  beforeEach(() => {
    vi.resetModules();
    invoke.mockReset();
  });

  it('shares one backend call between the sidebar and the status bar', async () => {
    invoke.mockResolvedValue([{ name: 'C:', total: 10, used: 4 }]);
    const { listStorage } = await import('../api/system.js');
    const [a, b] = await Promise.all([listStorage(), listStorage()]);
    expect(a).toBe(b);
    expect(invoke).toHaveBeenCalledTimes(1);
    await listStorage({ fresh: true });
    expect(invoke).toHaveBeenCalledTimes(2);
  });

  it('does not cache a failure', async () => {
    invoke.mockRejectedValueOnce(new Error('boom')).mockResolvedValue([]);
    const { listStorage } = await import('../api/system.js');
    await expect(listStorage()).rejects.toThrow('boom');
    await expect(listStorage()).resolves.toEqual([]);
    expect(invoke).toHaveBeenCalledTimes(2);
  });
});
