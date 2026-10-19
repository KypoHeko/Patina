// RelationshipGraph — radial layout, the spring "unfold" physics, and the
// topology helpers used for hover dimming. Mixed into RelationshipGraph.prototype.

import { SPRING_K, DAMPING, SETTLE } from './constants.js';

export const SimMixin = {
  /** Recompute ring spacing + radial targets for the current canvas size. */
  layout() {
    const depth = Math.max(1, this._counts.depth);
    this._ring = Math.max(40, (Math.min(this._w, this._h) * 0.46) / depth);
    for (const n of this._nodes) {
      const r = n._depth * this._ring;
      n.tx = Math.cos(n._angle) * r;
      n.ty = Math.sin(n._angle) * r;
    }
    // place the world origin at the canvas center
    this._ox = this._w / 2;
    this._oy = this._h / 2;
  },

  startSim() {
    if (this._raf) return;
    const loop = () => {
      const moving = this.step();
      this.draw();
      if (moving) {
        this._raf = requestAnimationFrame(loop);
      } else {
        this._raf = null;
        this.draw();
      }
    };
    this._raf = requestAnimationFrame(loop);
  },

  stopSim() {
    if (this._raf) cancelAnimationFrame(this._raf);
    this._raf = null;
  },

  step() {
    let moving = 0;
    for (const n of this._nodes) {
      const ax = (n.tx - n.x) * SPRING_K;
      const ay = (n.ty - n.y) * SPRING_K;
      n.vx = (n.vx + ax) * DAMPING;
      n.vy = (n.vy + ay) * DAMPING;
      n.x += n.vx;
      n.y += n.vy;
      if (Math.abs(n.vx) + Math.abs(n.vy) > SETTLE) moving++;
    }
    return moving;
  },

  depNeighbors(node) {
    const s = new Set();
    for (const [a, b] of this._edges) {
      if (a === node) s.add(b);
      if (b === node) s.add(a);
    }
    return s;
  },

  related(a, b) {
    return this.isAncestor(a, b) || this.isAncestor(b, a);
  },

  isAncestor(a, b) {
    let p = b && b._parent;
    while (p) { if (p === a) return true; p = p._parent; }
    return false;
  },
};
