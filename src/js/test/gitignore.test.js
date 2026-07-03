import { describe, it, expect } from 'vitest';
import { gitignoreMatcher, compileGitignore } from '../lib/gitignore.js';
import { buildDirTree } from '../lib/dir-tree.js';

describe('gitignore matcher', () => {
  const m = gitignoreMatcher(['# build output', 'target/', 'node_modules/', '*.log', '/build', 'dist', '!keep.log'].join('\n'));

  it('ignores a directory-only pattern (target/) for dirs at any depth', () => {
    expect(m('target', true)).toBe(true);
    expect(m('src/target', true)).toBe(true);
    expect(m('targetx', true)).toBe(false); // different name
  });

  it('does not treat target/ as matching a same-named file', () => {
    expect(m('target', false)).toBe(false); // dir-only rule
  });

  it('matches basename globs at any depth (*.log)', () => {
    expect(m('a.log', false)).toBe(true);
    expect(m('src/deep/b.log', false)).toBe(true);
    expect(m('a.txt', false)).toBe(false);
  });

  it('anchors a leading-slash pattern to the root (/build)', () => {
    expect(m('build', true)).toBe(true);
    expect(m('src/build', true)).toBe(false);
  });

  it('matches node_modules at any depth', () => {
    expect(m('node_modules', true)).toBe(true);
    expect(m('packages/x/node_modules', true)).toBe(true);
  });

  it('negation re-includes a previously matched file (!keep.log)', () => {
    expect(m('keep.log', false)).toBe(false);
    expect(m('other.log', false)).toBe(true);
  });

  it('skips comments and blank lines', () => {
    expect(compileGitignore('# c\n\n   \nfoo\n').length).toBe(1);
  });
});

describe('buildDirTree honours the ignore predicate', () => {
  const FS = {
    '/r': [
      { name: 'src', path: '/r/src', kind: 'folder' },
      { name: 'target', path: '/r/target', kind: 'folder' },
      { name: 'a.log', path: '/r/a.log', kind: 'file' },
      { name: 'main.js', path: '/r/main.js', kind: 'file' },
    ],
    '/r/src': [{ name: 'lib.js', path: '/r/src/lib.js', kind: 'file' }],
    '/r/target': [{ name: 'huge.bin', path: '/r/target/huge.bin', kind: 'file' }],
  };
  const listDir = async (p) => FS[p] || [];

  it('skips ignored entries and never descends into ignored folders', async () => {
    const ignore = gitignoreMatcher('target/\n*.log\n'); // (relPath, isDir) ⇒ bool
    const r = await buildDirTree(listDir, '/r', { maxDepth: 10, maxNodes: 100, ignore });
    expect(r.root.children.map((c) => c.name).sort()).toEqual(['main.js', 'src']);
    expect(r.folders).toBe(1); // only src; target pruned
    expect(r.files).toBe(2); // main.js + src/lib.js; a.log and target/huge.bin skipped
    expect(r.ignored).toBeGreaterThanOrEqual(2);
  });
});
