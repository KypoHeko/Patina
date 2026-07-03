import { describe, it, expect } from 'vitest';
import { radialLayout } from '../lib/radial-layout.js';
import { buildDirTree, baseName } from '../lib/dir-tree.js';

const TWO_PI = Math.PI * 2;

describe('radialLayout', () => {
  const tree = () => ({
    name: 'root', dir: true, children: [
      { name: 'big', dir: true, children: [
        { name: 'a.js', dir: false }, { name: 'b.js', dir: false }, { name: 'c.js', dir: false },
      ]},
      { name: 'small', dir: true, children: [{ name: 'd.js', dir: false }] },
      { name: 'lone.txt', dir: false },
    ],
  });

  it('places the focus at depth 0 and children at increasing rings', () => {
    const nodes = radialLayout(tree());
    const byName = Object.fromEntries(nodes.map((n) => [n.name, n]));
    expect(byName.root._depth).toBe(0);
    expect(byName.big._depth).toBe(1);
    expect(byName.small._depth).toBe(1);
    expect(byName['lone.txt']._depth).toBe(1);
    expect(byName['a.js']._depth).toBe(2);
  });

  it('gives a folder with a bigger subtree a wider arc (the histogram)', () => {
    const nodes = radialLayout(tree(), { weighted: true });
    const byName = Object.fromEntries(nodes.map((n) => [n.name, n]));
    const arc = (n) => n._a1 - n._a0;
    expect(arc(byName.big)).toBeGreaterThan(arc(byName.small));
    expect(arc(byName.big)).toBeGreaterThan(arc(byName['lone.txt']));
  });

  it('equal mode gives every sibling the same arc', () => {
    const nodes = radialLayout(tree(), { weighted: false });
    const byName = Object.fromEntries(nodes.map((n) => [n.name, n]));
    const arc = (n) => n._a1 - n._a0;
    expect(arc(byName.big)).toBeCloseTo(arc(byName.small), 9);
    expect(arc(byName.small)).toBeCloseTo(arc(byName['lone.txt']), 9);
    // three equal children of root => each spans a third of the circle
    expect(arc(byName.big)).toBeCloseTo(TWO_PI / 3, 9);
  });

  it('caps expansion at maxDepth', () => {
    const nodes = radialLayout(tree(), { maxDepth: 1 });
    const depths = nodes.map((n) => n._depth);
    expect(Math.max(...depths)).toBe(1); // a.js (depth 2) not placed
    expect(nodes.find((n) => n.name === 'a.js')).toBeUndefined();
  });

  it('keeps every node within the [start, start+2π] arc and parents own their children', () => {
    const nodes = radialLayout(tree());
    const byName = Object.fromEntries(nodes.map((n) => [n.name, n]));
    for (const n of nodes) {
      expect(n._a1 - n._a0).toBeGreaterThanOrEqual(-1e-9);
    }
    // children sit inside the parent's sector
    for (const child of byName.big.children) {
      const c = byName[child.name];
      expect(c._a0).toBeGreaterThanOrEqual(byName.big._a0 - 1e-9);
      expect(c._a1).toBeLessThanOrEqual(byName.big._a1 + 1e-9);
    }
  });
});

describe('buildDirTree', () => {
  const FS = {
    '/r': [
      { name: 'a', path: '/r/a', kind: 'folder' },
      { name: 'f.txt', path: '/r/f.txt', kind: 'file' },
    ],
    '/r/a': [
      { name: 'b', path: '/r/a/b', kind: 'folder' },
      { name: 'g.js', path: '/r/a/g.js', kind: 'file' },
    ],
    '/r/a/b': [{ name: 'h.js', path: '/r/a/b/h.js', kind: 'file' }],
  };
  const listDir = async (p) => FS[p] || [];

  it('walks the whole tree breadth-first with counts', async () => {
    const r = await buildDirTree(listDir, '/r', { maxDepth: 10, maxNodes: 100 });
    expect(r.root.name).toBe('r');
    expect(r.folders).toBe(2); // a, b
    expect(r.files).toBe(3); // f.txt, g.js, h.js
    expect(r.nodes).toBe(6); // root + 5
    expect(r.depth).toBe(3); // h.js sits on ring 3
    expect(r.truncated).toBe(false);
    const a = r.root.children.find((c) => c.name === 'a');
    expect(a.children.map((c) => c.name).sort()).toEqual(['b', 'g.js']);
  });

  it('stops expanding at maxDepth but keeps the folder node', async () => {
    const r = await buildDirTree(listDir, '/r', { maxDepth: 1, maxNodes: 100 });
    const a = r.root.children.find((c) => c.name === 'a');
    expect(a.dir).toBe(true);
    expect(a.children).toEqual([]); // not expanded
    expect(r.files).toBe(1); // only f.txt
    expect(r.depth).toBe(1);
  });

  it('truncates once the node cap is hit', async () => {
    const r = await buildDirTree(listDir, '/r', { maxDepth: 10, maxNodes: 2 });
    expect(r.truncated).toBe(true);
    expect(r.nodes).toBe(2); // root + one child
    expect(r.root.children.length).toBe(1);
  });

  it('baseName handles both separators and drive roots', () => {
    expect(baseName('/r/a/b')).toBe('b');
    expect(baseName('C:\\proj\\src')).toBe('src');
    expect(baseName('C:\\')).toBe('C:');
    expect(baseName('/trailing/')).toBe('trailing');
  });
});
