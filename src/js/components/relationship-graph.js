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

import { Component } from '../core/component.js';
import { escapeHtml } from '../core/dom.js';
import { fileGraph } from '../api/relationships.js';
import { rebuildEdges } from '../api/indexing.js';
import { listDir } from '../api/fs.js';
import { getPane } from '../state/panes.js';
import { getActiveSide } from '../state/tabs.js';
import { t } from '../lib/i18n.js';
import { radialLayout } from '../lib/radial-layout.js';
import { buildDirTree } from '../lib/dir-tree.js';
import { gitignoreMatcher } from '../lib/gitignore.js';
import { assetUrl } from '../api/invoke.js';

const MAX_DEPTH = 10; // scan safety caps (shown in the corner)
const MAX_NODES = 10000;

// Heavy build / VCS / dependency directories pruned whenever the .gitignore
// toggle is on, regardless of whether a .gitignore could be read. Keeps a huge
// tree (e.g. Rust `target/`) from stalling the scan with thousands of listDir
// round-trips. Toggle the button off to include everything.
const ALWAYS_IGNORE_DIRS = new Set([
  '.git', 'node_modules', 'target', 'dist', '.next', '.nuxt', '.svelte-kit',
  '.cache', '.turbo', '.parcel-cache', '__pycache__', '.venv', 'venv',
  'vendor', '.gradle', '.idea', '.vs', 'coverage',
]);

const C_CENTER = '#10b981'; // focus (emerald)
const C_FOLDER = '#eab308'; // folder rings (amber)
const C_FILE = '#7aa2c4'; // default file dot
const C_DEP = '#a78bfa'; // dependency edges (violet)
const C_RING = 'rgba(255,255,255,0.05)';
const C_SPOKE = 'rgba(255,255,255,0.07)';

const EXT_COLOR = {
  ts: '#3b82f6', tsx: '#3b82f6', js: '#f7df1e', mjs: '#f7df1e', jsx: '#38bdf8',
  css: '#38bdf8', html: '#e34c26', htm: '#e34c26', json: '#f59e0b', rs: '#f74c00',
  py: '#3776ab', go: '#00add8', java: '#ea2d2e', c: '#5c6bc0', h: '#5c6bc0',
  cpp: '#5c6bc0', rb: '#cc342d', php: '#777bb4', sh: '#4eaa25', sql: '#0ea5e9',
  yaml: '#94a3b8', yml: '#94a3b8', toml: '#9c8c6e', ini: '#94a3b8',
  md: '#64748b', markdown: '#64748b', svg: '#f97316', xml: '#f59e0b',
};

const DEFAULT_W = 900;
const DEFAULT_H = 600;
const ZOOM_MAX = 4;
const DEP_SEED_CAP = 600; // cap fileGraph seeds so the dependency fetch stays cheap

// spring "unfold"
const SPRING_K = 0.10;
const DAMPING = 0.80;
const SETTLE = 0.05;

function extColor(name) {
  const i = name.lastIndexOf('.');
  const ext = i >= 0 ? name.slice(i + 1).toLowerCase() : '';
  return EXT_COLOR[ext] || C_FILE;
}

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

  /* ── data ──────────────────────────────── */

  async scan() {
    const seq = ++this._scanSeq;
    this.setLoading(true);
    try {
      const ignore = this._useGitignore ? await this.loadIgnore(this._root) : null;
      if (seq !== this._scanSeq || !this._open) return;
      let res;
      try {
        res = await buildDirTree(listDir, this._root, { maxDepth: MAX_DEPTH, maxNodes: MAX_NODES, ignore });
      } catch {
        res = null;
      }
      if (seq !== this._scanSeq || !this._open) return; // stale or closed

      if (!res) {
        this._nodes = [];
        this._byPath = new Map();
        this._edges = [];
        this.draw();
        return;
      }

      this._counts = { files: res.files, folders: res.folders, depth: res.depth, truncated: res.truncated };
      this._nodes = radialLayout(res.root, { maxDepth: MAX_DEPTH, weighted: true });
      this._byPath = new Map();
      for (const n of this._nodes) {
        this._byPath.set(n.path, n);
        n.x = 0; n.y = 0; n.vx = 0; n.vy = 0; // start at center → unfold outward
      }
      this.layout();
      this.updateLimits();
      this.startSim();

      this.fetchDeps(seq); // dependency overlay, best-effort
    } finally {
      // Always clear the spinner for the current scan — even on early return,
      // a thrown error, or a failed .gitignore read. Stale scans leave it alone.
      if (seq === this._scanSeq) this.setLoading(false);
    }
  }

  /** Read the focus folder's .gitignore (via the asset protocol) and return an
   *  ignore(relPath, isDir) predicate. The VCS `.git` dir is always hidden when
   *  the toggle is on; .gitignore rules apply on top if the file exists. */
  async loadIgnore(root) {
    if (!root) return null;
    let match = null;
    const sep = root.includes('\\') ? '\\' : '/';
    const path = root.replace(/[\\/]+$/, '') + sep + '.gitignore';
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 2500); // never let this block the scan
    try {
      const url = assetUrl(path);
      if (url) {
        const res = await fetch(url, { signal: ctrl.signal });
        if (res.ok) {
          const text = await res.text();
          if (text.trim()) match = gitignoreMatcher(text);
        }
      }
    } catch {
      /* no readable .gitignore — baseline ignores below still apply */
    } finally {
      clearTimeout(timer);
    }
    return (rel, isDir) => {
      const name = rel.slice(rel.lastIndexOf('/') + 1);
      // Baseline: always prune heavy build/VCS/dependency dirs so a huge tree
      // (e.g. Rust `target/`) never stalls the scan, even if .gitignore can't
      // be read. Toggle the button off to see everything.
      if (isDir && ALWAYS_IGNORE_DIRS.has(name)) return true;
      return match ? match(rel, isDir) : false;
    };
  }

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
  }

  async fetchDeps(seq) {
    const files = this._nodes.filter((n) => !n.dir && n._depth > 0).map((n) => n.path);
    if (!files.length) return;

    let data;
    try {
      // Rebuild derived edges from the content index before querying them.
      // Without this, the graph only reads whatever was stored in file_edges
      // at the last index build — which may be stale or empty if the user
      // hasn't triggered a full rebuild since editing files.
      await rebuildEdges(this._root);
      data = await fileGraph(files.slice(0, DEP_SEED_CAP), 1);
    } catch (err) {
      console.error('[patina:graph] fetchDeps error:', err);
      return;
    }
    if (seq !== this._scanSeq || !this._open) return;
    const edges = [];
    for (const e of (data && data.edges) || []) {
      const a = this._byPath.get(e.src);
      const b = this._byPath.get(e.dst);
      if (a && b && a !== b) edges.push([a, b]);
    }
    this._edges = edges;
    this.draw();
  }

  /* ── physics (spring unfold) ───────────── */

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
  }

  stopSim() {
    if (this._raf) cancelAnimationFrame(this._raf);
    this._raf = null;
  }

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
  }

  /* ── render shell ──────────────────────── */

  render() {
    this._open = true;
    document.getElementById('graph-btn')?.classList.add('is-on');
    this.mount.innerHTML = `
      <div class="graph graph--window">
        <div class="graph__head" data-drag>
          <div class="graph__title">${escapeHtml(t('graph.title'))}</div>
          <div class="graph__legend">
            <span class="graph__dot" style="background:${C_FOLDER}"></span>${escapeHtml(t('graph.legend.folder') || 'folder')}
            <span class="graph__dot" style="background:${C_FILE}"></span>${escapeHtml(t('graph.legend.file') || 'file')}
            <span class="graph__dot" style="background:${C_DEP}"></span>${escapeHtml(t('graph.legend.deps'))}
          </div>
          <div class="graph__tools">
            <button class="graph__toggle${this._showLabels ? ' is-on' : ''}" data-toggle="labels" title="${escapeHtml(t('graph.labels'))}">${escapeHtml(t('graph.labels'))}</button>
            <button class="graph__toggle${this._showDeps ? ' is-on' : ''}" data-toggle="deps" title="${escapeHtml(t('graph.deps'))}">${escapeHtml(t('graph.deps'))}</button>
            <button class="graph__toggle${this._useGitignore ? ' is-on' : ''}" data-toggle="gitignore" title="${escapeHtml(t('graph.gitignore.title'))}">${escapeHtml(t('graph.gitignore'))}</button>
            <button class="graph__toggle" data-replay title="${escapeHtml(t('graph.replay.title'))}">${escapeHtml(t('graph.replay'))}</button>
          </div>
          <button class="graph__rebuild" data-rebuild title="${escapeHtml(t('graph.rebuild.title'))}">${escapeHtml(t('graph.rebuild'))}</button>
          <button class="graph__close" data-close title="${escapeHtml(t('common.close'))}">×</button>
        </div>
        <div class="graph__body">
          <div class="graph__canvas-wrap">
            <canvas class="graph__canvas"></canvas>
            <div class="graph__limits" data-limits></div>
            <div class="graph__loading" hidden>
              <div class="graph__spinner"></div>
              <span class="graph__loading-text">${escapeHtml(t('graph.loading'))}</span>
            </div>
          </div>
        </div>
      </div>`;
    this.win = this.mount.querySelector('.graph');
    this.canvas = this.mount.querySelector('.graph__canvas');
    this.ctx = this.canvas.getContext('2d');
    this._loadingEl = this.mount.querySelector('.graph__loading');
    this._limitsEl = this.mount.querySelector('[data-limits]');

    this.mount.querySelectorAll('[data-close]').forEach((el) => el.addEventListener('click', () => this.close()));
    this.mount.querySelector('[data-rebuild]')?.addEventListener('click', () => this.rebuild());
    this.mount.querySelector('[data-replay]')?.addEventListener('click', () => this.replay());
    this.mount.querySelectorAll('[data-toggle]').forEach((el) =>
      el.addEventListener('click', () => this.toggle(el.dataset.toggle, el)),
    );
    this.mount.querySelector('[data-drag]').addEventListener('mousedown', (e) => this.onHeadDown(e));

    this.canvas.addEventListener('mousedown', (e) => this.onCanvasDown(e));
    this.canvas.addEventListener('mousemove', (e) => this.onCanvasMove(e));
    this.canvas.addEventListener('mouseleave', () => { if (this._hover) { this._hover = null; this.draw(); } });
    this.canvas.addEventListener('click', (e) => this.onClick(e));
    this.canvas.addEventListener('dblclick', (e) => this.onDblClick(e));
    this.canvas.addEventListener('wheel', (e) => this.onWheel(e), { passive: false });

    this.centerWindow();
    this.resizeCanvas();
    if (typeof ResizeObserver !== 'undefined') {
      this._ro = new ResizeObserver(() => this.resizeCanvas());
      this._ro.observe(this.canvas.parentElement);
    }
  }

  centerWindow() {
    const r = this.win.getBoundingClientRect();
    this.win.style.left = `${Math.max(8, Math.round((window.innerWidth - r.width) / 2))}px`;
    this.win.style.top = `${Math.max(8, Math.round((window.innerHeight - r.height) / 2))}px`;
  }

  resizeCanvas() {
    if (!this.canvas) return;
    const wrap = this.canvas.parentElement;
    const w = Math.max(50, wrap.clientWidth | 0);
    const h = Math.max(50, wrap.clientHeight | 0);
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
      this._w = w;
      this._h = h;
    }
    if (this._nodes.length) this.layout();
    this.draw();
  }

  setLoading(on) {
    if (this._loadingEl) this._loadingEl.hidden = !on;
  }

  updateLimits() {
    if (!this._limitsEl) return;
    const c = this._counts;
    const cap = `${t('graph.limits') || 'scan limits'} — depth ${MAX_DEPTH} · files ${MAX_NODES.toLocaleString()}`;
    const now = `${t('graph.current') || 'current'} — depth ${c.depth} · files ${c.files}${c.truncated ? ' · ' + (t('graph.truncated') || 'truncated') : ''}`;
    this._limitsEl.textContent = `${cap}\n${now}`;
  }

  /* ── draw ──────────────────────────────── */

  draw() {
    if (!this.ctx) return;
    const ctx = this.ctx;
    const z = this._zoom;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this._w, this._h);
    ctx.save();
    ctx.translate(this._ox, this._oy);
    ctx.scale(z, z);

    const maxD = this._counts.depth;
    // ring guides
    ctx.lineWidth = 1 / z;
    ctx.strokeStyle = C_RING;
    for (let d = 1; d <= maxD; d++) {
      ctx.beginPath();
      ctx.arc(0, 0, d * this._ring, 0, Math.PI * 2);
      ctx.stroke();
    }

    // tree spokes (parent → child)
    ctx.strokeStyle = C_SPOKE;
    ctx.lineWidth = 1 / z;
    ctx.beginPath();
    for (const n of this._nodes) {
      if (!n._parent) continue;
      ctx.moveTo(n._parent.x, n._parent.y);
      ctx.lineTo(n.x, n.y);
    }
    ctx.stroke();

    // dependency edges (visual only), bowed toward the center
    const hover = this._hover;
    const hoverDeps = hover ? this.depNeighbors(hover) : null;
    if (this._showDeps) {
      for (const [a, b] of this._edges) {
        const active = hover && (a === hover || b === hover);
        ctx.strokeStyle = active ? 'rgba(167,139,250,0.95)' : hover ? 'rgba(167,139,250,0.08)' : 'rgba(167,139,250,0.30)';
        ctx.lineWidth = (active ? 2 : 1) / z;
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.quadraticCurveTo((a.x + b.x) * 0.18, (a.y + b.y) * 0.18, b.x, b.y);
        ctx.stroke();
      }
    }

    // node visual size scales with ring spacing (denser/deeper → smaller)
    const fileR = Math.max(2, Math.min(5, this._ring * 0.045));

    for (const n of this._nodes) {
      const dim = hover && n !== hover && hoverDeps && !hoverDeps.has(n) && !this.related(n, hover);
      ctx.globalAlpha = dim ? 0.35 : 1;
      if (n._depth === 0) {
        ctx.beginPath(); ctx.arc(n.x, n.y, fileR + 4, 0, Math.PI * 2);
        ctx.fillStyle = C_CENTER; ctx.fill();
        ctx.beginPath(); ctx.arc(n.x, n.y, fileR + 9, 0, Math.PI * 2);
        ctx.strokeStyle = 'rgba(16,185,129,0.4)'; ctx.lineWidth = 1.5 / z; ctx.stroke();
      } else if (n.dir) {
        const rr = fileR + 1 + Math.min(4, Math.log2((n._w || 1) + 1) * 0.7);
        ctx.beginPath(); ctx.arc(n.x, n.y, rr, 0, Math.PI * 2);
        ctx.strokeStyle = C_FOLDER; ctx.lineWidth = (n === hover ? 2.2 : 1.5) / z; ctx.stroke();
      } else {
        ctx.beginPath(); ctx.arc(n.x, n.y, fileR, 0, Math.PI * 2);
        ctx.fillStyle = extColor(n.name); ctx.fill();
        if (n === hover) { ctx.beginPath(); ctx.arc(n.x, n.y, fileR + 3 / z, 0, Math.PI * 2); ctx.strokeStyle = '#fff'; ctx.lineWidth = 1.5 / z; ctx.stroke(); }
      }
      ctx.globalAlpha = 1;
    }

    // labels — all nodes, drawn at constant screen size. Skipped while the
    // unfold animation runs so a large graph stays smooth; they appear once it
    // settles (and on hover/pan redraws, which don't animate).
    if (!this._raf && this._showLabels) {
      ctx.font = '11px ui-monospace, SFMono-Regular, Menlo, monospace';
    ctx.textBaseline = 'middle';
    for (const n of this._nodes) {
      if (n._depth === 0) continue;
      const dim = hover && n !== hover && hoverDeps && !hoverDeps.has(n) && !this.related(n, hover);
      const left = Math.cos(n._angle) < 0;
      ctx.save();
      ctx.translate(n.x, n.y);
      ctx.scale(1 / z, 1 / z);
      ctx.textAlign = left ? 'right' : 'left';
      ctx.globalAlpha = dim ? 0.22 : 1;
      ctx.fillStyle = n === hover ? '#fff' : n.dir ? 'rgba(234,179,8,0.92)' : 'rgba(210,222,233,0.8)';
      ctx.fillText(n.name, (left ? -1 : 1) * 10, 0);
      ctx.globalAlpha = 1;
      ctx.restore();
    }
    }
    ctx.restore();
  }

  depNeighbors(node) {
    const s = new Set();
    for (const [a, b] of this._edges) {
      if (a === node) s.add(b);
      if (b === node) s.add(a);
    }
    return s;
  }

  related(a, b) {
    return this.isAncestor(a, b) || this.isAncestor(b, a);
  }

  isAncestor(a, b) {
    let p = b && b._parent;
    while (p) { if (p === a) return true; p = p._parent; }
    return false;
  }

  /* ── coordinates / hit-test ────────────── */

  canvasPoint(e) {
    const rect = this.canvas.getBoundingClientRect();
    return [
      ((e.clientX - rect.left) / rect.width) * this._w,
      ((e.clientY - rect.top) / rect.height) * this._h,
    ];
  }

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
  }

  /* ── interaction ───────────────────────── */

  onHeadDown(e) {
    const r = this.win.getBoundingClientRect();
    this._winDrag = { x: e.clientX, y: e.clientY, left: r.left, top: r.top };
  }

  onCanvasDown(e) {
    this._pan = { x: e.clientX, y: e.clientY, ox: this._ox, oy: this._oy };
    this._moved = false;
  }

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
  }

  onDocUp() {
    this._winDrag = null;
    this._pan = null;
  }

  onCanvasMove(e) {
    if (this._pan || this._winDrag) return;
    const n = this.nodeAt(e);
    if (n !== this._hover) {
      this._hover = n;
      this.draw();
    }
  }

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
  }

  onClick() {
    this._moved = false;
  }

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
  }
}
