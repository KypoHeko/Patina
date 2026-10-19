import { describe, it, expect, vi } from 'vitest';

const readGitignore = vi.fn();
vi.mock('../api/fs.js', () => ({ listDir: vi.fn(), readGitignore: (...a) => readGitignore(...a) }));
vi.mock('../api/relationships.js', () => ({ fileGraph: vi.fn() }));
vi.mock('../api/indexing.js', () => ({ rebuildEdges: vi.fn() }));
vi.mock('../state/index-live.js', () => ({ ensureLiveIndex: vi.fn() }));

const { DataMixin } = await import('../components/relationship-graph/data.js');

describe('graph .gitignore', () => {
  it('is read over IPC, not through the asset protocol', async () => {
    readGitignore.mockResolvedValue('secret/\n');
    const ignore = await DataMixin.loadIgnore.call({}, '/proj');
    expect(readGitignore).toHaveBeenCalledWith('/proj');
    expect(ignore('secret', true)).toBe(true);
    expect(ignore('src', true)).toBe(false);
    expect(ignore('node_modules', true)).toBe(true); // baseline still applies
  });

  it('falls back to the baseline when there is no file', async () => {
    readGitignore.mockResolvedValue(null);
    const ignore = await DataMixin.loadIgnore.call({}, '/proj');
    expect(ignore('secret', true)).toBe(false);
    expect(ignore('target', true)).toBe(true);
  });
});
