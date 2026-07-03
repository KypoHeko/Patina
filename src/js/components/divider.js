import { Component } from '../core/component.js';
import { setSplitRatio } from '../state/ui.js';

const MIN = 0.15;
const MAX = 0.85;

// Divider: while dragging it updates splitRatio in the UI state.
// Column widths are applied by the layout controller (main.syncLayout),
// reacting to splitRatio changes — so the layout lives in one place.
export class Divider extends Component {
  constructor(ctx) {
    super(ctx);
    this.workspace = ctx.workspace; // for measuring width while dragging
    this._dragging = false;
  }

  init() {
    this.on(this.mount, 'mousedown', (e) => this.startDrag(e));
  }

  startDrag(e) {
    e.preventDefault();
    this._dragging = true;
    document.body.classList.add('is-resizing');

    const onMove = (ev) => {
      if (!this._dragging) return;
      const rect = this.workspace.getBoundingClientRect();
      const ratio = (ev.clientX - rect.left) / rect.width;
      setSplitRatio(this.store, Math.min(MAX, Math.max(MIN, ratio)));
    };
    const onUp = () => {
      this._dragging = false;
      document.body.classList.remove('is-resizing');
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  }
}
