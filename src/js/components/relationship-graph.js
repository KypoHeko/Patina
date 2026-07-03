// Relationship graph — radial directory rings.
//
// The focus folder sits at the center; ring 1 holds its files and folders,
// ring 2 the contents of ring-1 folders, and so on (rings = directory depth).
// Each folder owns an angular sector split among its children by subtree size
// (a "ring histogram"). On top of the structure we overlay dependency edges
// (file → file references); these are purely visual and never move the nodes.
//
// Layout + scan live in pure, unit-tested modules (lib/radial-layout, lib/dir-tree).
// Physics here is only a spring that "unfolds" nodes from the center to their
// radial targets.
//
// This file holds construction, lifecycle and header controls; behaviour is
// split across mixins:
//   data   — directory scan, .gitignore predicate, dependency overlay
//   sim    — radial layout, spring physics, topology helpers
//   render — window shell, canvas sizing, the draw pass
//   input  — window/canvas drag, pan/zoom, hover, hit-testing

import { Component } from '../core/component.js';
import { getPane } from '../state/panes.js';
import { getActiveSide } from '../state/tabs.js';
import { DEFAULT_W, DEFAULT_H } from './relationship-graph/constants.js';

import { DataMixin } from './relationship-graph/data.js';
import { SimMixin } from './relationship-graph/sim.js';
import { RenderMixin } from './relationship-graph/render.js';
import { InputMixin } from './relationship-graph/input.js';

export class RelationshipGraph extends Component {
  init() {
    this._open = false;
    this._root = '';
    this._side = 'left';

    this._nodes = []; // radialLayout output, augmented with x/y/vx/vy/tx/ty
    this._byPath = new Map();
    this._edges = []; // [[nodeA, nodeB]] dependency pairs (both in _byPath)
    this._counts = { files: 0, folders: 0, depth: 0, truncated: false };
    this._hover = null;

    this._w = DEFAULT_W;
    this._h = DEFAULT_H;
    this._ox = 0;
    this._oy = 0;
    this._zoom = 1;
    this._ring = 110; // px between rings (sized so the graph fits at zoom 1)

    this._pan = null;
    this._winDrag = null;
    this._moved = false;
    this._raf = null;
    this._scanSeq = 0;
    this._ro = null;

    // view toggles (header buttons)
    this._showLabels = true;
    this._showDeps = true;
    this._useGitignore = true; // respect .gitignore by default (hides target/, node_modules/, …)
    this.listen('graph:open', () => (this._open ? this.close() : this.open()));
    this.on(document, 'keydown', (e) => {
      if (this._open && e.key === 'Escape') this.close();
    });
    this.on(document, 'mousemove', (e) => this.onDocMove(e));
    this.on(document, 'mouseup', () => this.onDocUp());
  }

  /* ── lifecycle ─────────────────────────── */

  open() {
    const state = this.store.getState();
    this._side = getActiveSide(state);
    const pane = getPane(state, this._side);
    this._root = pane.path || '';

    this._ox = 0;
    this._oy = 0;
    this._zoom = 1;
    this._nodes = [];
    this._byPath = new Map();
    this._edges = [];
    this._hover = null;
    this._counts = { files: 0, folders: 0, depth: 0, truncated: false };

    this.render();
    this.scan();
  }

  close() {
    if (!this._open) return;
    this._open = false;
    document.getElementById('graph-btn')?.classList.remove('is-on');
    this.stopSim();
    if (this._ro) {
      this._ro.disconnect();
      this._ro = null;
    }
    this._pan = null;
    this._winDrag = null;
    this._scanSeq++; // invalidate any in-flight scan
    this.mount.innerHTML = '';
  }

  destroy() {
    this.stopSim();
    if (this._ro) this._ro.disconnect();
    super.destroy();
  }

  rebuild() {
    if (!this._open) return;
    // Re-read the active pane's current folder (it may have changed since the
    // graph was opened) so "Rebuild" actually re-roots on where the user is now.
    const state = this.store.getState();
    this._side = getActiveSide(state);
    this._root = getPane(state, this._side).path || '';
    this.scan();
  }

  /** Header toggles. Labels/deps just redraw; .gitignore re-scans the tree. */
  toggle(kind, el) {
    if (kind === 'labels') {
      this._showLabels = !this._showLabels;
      el.classList.toggle('is-on', this._showLabels);
      this.draw();
    } else if (kind === 'deps') {
      this._showDeps = !this._showDeps;
      el.classList.toggle('is-on', this._showDeps);
      this.draw();
    } else if (kind === 'gitignore') {
      this._useGitignore = !this._useGitignore;
      el.classList.toggle('is-on', this._useGitignore);
      this.scan();
    }
  }

  /** Re-run the unfold animation from the center. */
  replay() {
    for (const n of this._nodes) {
      n.x = 0; n.y = 0; n.vx = 0; n.vy = 0;
    }
    this.startSim();
  }
}

// Assemble behaviour onto the prototype. Method names and `this` semantics are
// identical to the previous single-file class, so callers and tests are unaffected.
Object.assign(
  RelationshipGraph.prototype,
  DataMixin,
  SimMixin,
  RenderMixin,
  InputMixin,
);
