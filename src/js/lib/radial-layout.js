// Radial directory layout for the relationship graph.
//
// Rings = directory depth from the focus (center). Each folder owns an angular
// sector; that sector is split among its children, weighted by subtree size
// (the "ring histogram"), so dense branches occupy a wider arc. Files are
// leaves and terminate; folders branch into the next ring.
//
// This is a PURE function (no DOM, no canvas) so it can be unit-tested and
// reused. The caller turns (_depth, _angle) into pixel coordinates:
//   x = Math.cos(node._angle) * node._depth * RING
//   y = Math.sin(node._angle) * node._depth * RING

const START_ANGLE = -Math.PI / 2; // first child begins at 12 o'clock
const FULL = Math.PI * 2;

/**
 * @param {object} root  tree node: { name, dir, children?, ... }
 * @param {object} opts  { maxDepth = Infinity, weighted = true }
 * @returns {object[]}   flat list of the same node objects, each annotated with
 *   _depth, _angle, _a0, _a1, _parent, _w (subtree weight). Order is a
 *   stable pre-order (root first), suitable for deterministic rendering.
 */
export function radialLayout(root, opts = {}) {
  const maxDepth = opts.maxDepth ?? Infinity;
  const weighted = opts.weighted !== false; // default true
  const out = [];
  if (!root) return out;

  // Subtree weight = number of descendant leaves within maxDepth (min 1). A
  // leaf (file, empty/collapsed folder, or a folder at maxDepth) weighs 1.
  function weigh(node, depth) {
    const kids = expandable(node, depth) ? node.children : null;
    if (!kids || !kids.length) {
      node._w = 1;
      return 1;
    }
    let w = 0;
    for (const c of kids) w += weigh(c, depth + 1);
    node._w = Math.max(1, w);
    return node._w;
  }

  function expandable(node, depth) {
    return !!node.dir && Array.isArray(node.children) && depth < maxDepth;
  }

  function place(node, parent, depth, a0, a1) {
    node._depth = depth;
    node._angle = (a0 + a1) / 2;
    node._a0 = a0;
    node._a1 = a1;
    node._parent = parent;
    out.push(node);

    if (!expandable(node, depth) || !node.children.length) return;
    const kids = node.children;
    let total = 0;
    for (const c of kids) total += weighted ? c._w : 1;
    if (total <= 0) total = 1;

    let a = a0;
    for (const c of kids) {
      const span = (a1 - a0) * ((weighted ? c._w : 1) / total);
      place(c, node, depth + 1, a, a + span);
      a += span;
    }
  }

  weigh(root, 0);
  place(root, null, 0, START_ANGLE, START_ANGLE + FULL);
  return out;
}
