// RelationshipGraph — pointer interaction: window drag, canvas pan/zoom, hover,
// click/double-click, and coordinate hit-testing. Mixed into the prototype.

import { ZOOM_MAX } from './constants.js';

export const InputMixin = {
  canvasPoint(e) {
    const rect = this.canvas.getBoundingClientRect();
    return [
      ((e.clientX - rect.left) / rect.width) * this._w,
      ((e.clientY - rect.top) / rect.height) * this._h,
    ];
  },

  nodeAt(e) {
    const [sx, sy] = this.canvasPoint(e);
    const wx = (sx - this._ox) / this._zoom;
    const wy = (sy - this._oy) / this._zoom;
    const tol = Math.max(8, this._ring * 0.2);
    let best = null;
    let bd = tol * tol;
    for (const n of this._nodes) {
      const dx = n.x - wx;
      const dy = n.y - wy;
      const d = dx * dx + dy * dy;
      if (d < bd) { bd = d; best = n; }
    }
    return best;
  },

  onHeadDown(e) {
    const r = this.win.getBoundingClientRect();
    this._winDrag = { x: e.clientX, y: e.clientY, left: r.left, top: r.top };
  },

  onCanvasDown(e) {
    this._pan = { x: e.clientX, y: e.clientY, ox: this._ox, oy: this._oy };
    this._moved = false;
  },

  onDocMove(e) {
    if (this._winDrag) {
      const d = this._winDrag;
      this.win.style.left = `${d.left + (e.clientX - d.x)}px`;
      this.win.style.top = `${d.top + (e.clientY - d.y)}px`;
      return;
    }
    if (this._pan) {
      const dx = e.clientX - this._pan.x;
      const dy = e.clientY - this._pan.y;
      if (Math.abs(dx) + Math.abs(dy) > 3) this._moved = true;
      this._ox = this._pan.ox + dx;
      this._oy = this._pan.oy + dy;
      this.draw();
    }
  },

  onDocUp() {
    this._winDrag = null;
    this._pan = null;
  },

  onCanvasMove(e) {
    if (this._pan || this._winDrag) return;
    const n = this.nodeAt(e);
    if (n !== this._hover) {
      this._hover = n;
      this.draw();
    }
  },

  onWheel(e) {
    e.preventDefault();
    const [sx, sy] = this.canvasPoint(e);
    const wx = (sx - this._ox) / this._zoom;
    const wy = (sy - this._oy) / this._zoom;
    const factor = e.deltaY < 0 ? 1.12 : 1 / 1.12;
    // floor at 1: the graph is sized to fit the window at zoom 1, so we never
    // zoom out past "everything visible".
    const z = Math.max(1, Math.min(ZOOM_MAX, this._zoom * factor));
    this._zoom = z;
    this._ox = sx - wx * z;
    this._oy = sy - wy * z;
    this.draw();
  },

  onClick() {
    this._moved = false;
  },

  onDblClick(e) {
    const node = this.nodeAt(e);
    if (node && node.dir && node._depth > 0) {
      // re-root the rings at this folder
      this._root = node.path;
      this._ox = this._w / 2;
      this._oy = this._h / 2;
      this._zoom = 1;
      this.scan();
    } else if (node && !node.dir) {
      this.bus.emit('graph:reveal', { path: node.path });
      this.close();
    } else {
      // empty space → reset the view
      this._ox = this._w / 2;
      this._oy = this._h / 2;
      this._zoom = 1;
      this.draw();
    }
  },
};
