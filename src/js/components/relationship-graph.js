import { Component } from '../core/component.js';
import { escapeHtml } from '../core/dom.js';
import { fileGraph, hashGraphFiles } from '../api/relationships.js';
import { searchFiles } from '../api/fs.js';
import { startIndex } from '../api/indexing.js';
import { onEvent } from '../api/events.js';
import { getPane } from '../state/panes.js';
import { getActiveSide } from '../state/tabs.js';
import { pathToColor } from '../lib/path-color.js';
import { t } from '../lib/i18n.js';

const NODE_H = 28; // node panel height
const NODE_PAD_X = 12; // horizontal padding inside the panel
const NODE_PAD_Y = 6; // vertical padding
const NODE_MIN_W = 64; // minimum panel width
const NODE_MAX_W = 180; // maximum panel width
const NODE_RADIUS = 6; // panel corner rounding
const NODE_FONT = '11px system-ui, -apple-system, "Segoe UI", sans-serif';
const OVERVIEW_CAP = 80; // don't build a canvas out of thousands of nodes
const OVERVIEW_INDEX_CAP = 300; // overview node cap including nested files from the index
const BUSY_DELAY = 350; // ms: show the spinner only if the operation lasts longer — otherwise no flicker
const DEFAULT_W = 900; // a reference value before the first canvas layout
const DEFAULT_H = 600;

// Physics (tuned for dozens of nodes, scaled up for the panels)
const REPULSION = 18000; // Coulomb repulsion (larger — node panels spread wider)
const SPRING_LEN = 240; // edge rest length (larger — longer links)
const SPRING_K = 0.010; // spring stiffness
const GRAVITY = 0.008; // pull toward the center (keeps detached nodes in)
const DAMPING = 0.86;
const ALPHA_MIN = 0.02;
const ZOOM_MIN = 0.2;
const ZOOM_MAX = 3;

// Progressive build: number of nodes that appear per tick
const APPEAR_BATCH = 4;
const APPEAR_INTERVAL = 60; // ms between batches

// Arrow colors (legend)
const C_DEP = '#10b981'; // dependencies (green — emerald)
const C_BACK = '#f59e0b'; // back-references (yellow — amber)
const C_MANUAL = 'rgba(150,158,176,0.75)';
const C_CTX = 'rgba(120,130,150,0.5)';
const C_MENTION = 'rgba(120,130,150,0.3)';

// Extension colors (from icons.js — the same palette as in the file panel)
const EXT_COLOR = {
  ts: '#3b82f6', tsx: '#3b82f6',
  js: '#f7df1e', mjs: '#f7df1e',
  jsx: '#38bdf8', css: '#38bdf8',
  html: '#e34c26', htm: '#e34c26',
  xml: '#f59e0b', rs: '#f74c00',
  py: '#3776ab', go: '#00add8',
  java: '#ea2d2e',
  c: '#5c6bc0', h: '#5c6bc0', cpp: '#5c6bc0',
  rb: '#cc342d', php: '#777bb4',
  sh: '#4eaa25', sql: '#0ea5e9',
  yaml: '#94a3b8', yml: '#94a3b8', toml: '#94a3b8', ini: '#94a3b8',
  json: '#f59e0b',
  md: '#64748b', markdown: '#64748b',
  pdf: '#ef4444', doc: '#2563eb', docx: '#2563eb', odt: '#2563eb',
  txt: '#94a3b8', log: '#94a3b8', rtf: '#94a3b8',
  svg: '#f97316',
  png: '#a855f7', jpg: '#a855f7', jpeg: '#a855f7', gif: '#a855f7',
  webp: '#a855f7', bmp: '#a855f7', ico: '#a855f7', avif: '#a855f7',
  psd: '#0ea5e9', ai: '#f97316', fig: '#a259ff', sketch: '#fdb300',
  xlsx: '#22c55e', xls: '#22c55e', ods: '#22c55e', csv: '#22c55e', tsv: '#22c55e',
  ttf: '#8b5cf6', otf: '#8b5cf6', woff: '#8b5cf6', woff2: '#8b5cf6',
  zip: '#eab308', rar: '#eab308', '7z': '#eab308', tar: '#eab308',
  gz: '#eab308', bz2: '#eab308', xz: '#eab308', zst: '#eab308',
  mp3: '#ec4899', wav: '#ec4899', flac: '#ec4899', ogg: '#ec4899',
  m4a: '#ec4899', aac: '#ec4899',
  mp4: '#f43f5e', mkv: '#f43f5e', mov: '#f43f5e', avi: '#f43f5e',
  webm: '#f43f5e', wmv: '#f43f5e',
  exe: '#64748b', msi: '#64748b', dll: '#64748b', iso: '#64748b',
};
const DEFAULT_NODE_COLOR = '#94a3b8';

/** Get the node color by file extension. */
/** Parent folder of a path (used for the border color = the tab color of that folder). */
function parentDir(p) {
  const i = Math.max(p.lastIndexOf('\\'), p.lastIndexOf('/'));
  return i > 0 ? p.slice(0, i) : p;
}

function nodeColor(name) {
  const dot = name.lastIndexOf('.');
  if (dot < 0) return DEFAULT_NODE_COLOR;
  const ext = name.slice(dot + 1).toLowerCase();
  return EXT_COLOR[ext] || DEFAULT_NODE_COLOR;
}

/** Node label: only the file/folder's own name (without the parent folder —
 *  otherwise every node from the same folder would repeat its name in the label). */
function shortLabel(name, fullPath) {
  const label = name || fullPath.split(/[/\\]/).pop() || fullPath;
  return label.length > 28 ? label.slice(0, 27) + '…' : label;
}

/** Measure the width of a node label's text on the canvas. */
function measureLabelWidth(ctx, name, fullPath) {
  ctx.font = NODE_FONT;
  const text = shortLabel(name, fullPath || name);
  const w = ctx.measureText(text).width;
  return Math.min(NODE_MAX_W, Math.max(NODE_MIN_W, Math.ceil(w) + NODE_PAD_X * 2));
}

// Relationship graph (Ctrl+G) — a floating window: it can be dragged by the title
// bar and resized by the corner. The canvas fills the whole window; nodes are not
// bound to its edges (they may go off-screen), the background can be panned by
// dragging and zoomed with the wheel. A single click on a node makes it the focus;
// a double-click shows the file in the panel; a double-click on empty space resets the view.
export class RelationshipGraph extends Component {
  init() {
    this._open = false;
    this._side = 'left';
    this._root = '';
    this._mode = 'overview'; // 'focus' | 'overview'
    this._focus = null;
    this._connectedPaths = null; // Set<path> — nodes with links to the focus
    this._nodes = new Map();
    this._edges = [];
    this._curSeeds = [];
    this._curHops = 1;

    this._raf = null;
    this._alpha = 0;
    this._fetchSeq = 0;

    // State of the background index build (for a live status instead of a "hung"
    // badge): progress arrives via index:progress events, the end via index:ready.
    this._loading = false;
    this._indexing = false;
    this._indexCount = 0;
    this._indexTotal = 0;
    this._indexPhase = '';
    this._showBusy = false; // show the spinner with a BUSY_DELAY delay (anti-flicker on fast operations)
    this._busyTimer = null;
    this._selfRebuild = false; // true while a rebuild started by the graph itself ("Refresh") is running

    // Progressive build
    this._appeared = new Set(); // paths of nodes that have already appeared
    this._appearQueue = []; // nodes waiting to appear
    this._appearTimer = null;

    // Hashing phase
    this._hashing = false;
    this._hashSeq = 0; // serial number — to tell apart stale calls
    this._hashProgress = 0;
    this._hashTotal = 0;
    this._hashes = new Map(); // path → hash

    // Canvas size (updated by ResizeObserver), view (pan/zoom), drags.
    this._w = DEFAULT_W;
    this._h = DEFAULT_H;
    this._ox = 0;
    this._oy = 0;
    this._zoom = 1;
    this._pan = null; // active background panning
    this._winDrag = null; // active window drag
    this._moved = false; // whether a drag happened — to not confuse it with a click
    this._ro = null;

    this._colors = this.readColors();
    this.listen('theme:changed', () => {
      this._colors = this.readColors();
      if (!this._open) return;
      this.draw();
      const dots = this.mount.querySelectorAll('.graph__dot');
      if (dots[0]) dots[0].style.background = C_DEP;
      if (dots[1]) dots[1].style.background = C_BACK;
    });

    this.listen('graph:open', () => (this._open ? this.close() : this.open()));
    this.on(document, 'keydown', (e) => {
      if (!this._open) return;
      if (e.key === 'Escape') this.close();
      if (e.key === 'Backspace' && this._mode === 'focus') {
        e.preventDefault();
        this.backToOverview();
      }
    });
    // Drags are handled at the document level (always, with guards), so the cursor
    // can be moved outside the window without losing the grab.
    this.on(document, 'mousemove', (e) => this.onDocMove(e));
    this.on(document, 'mouseup', () => this.onDocUp());

    onEvent('index:ready', (root) => {
      if (!this._open) return;
      if (root && this._root && root !== this._root) return;
      // Our own rebuild ("Refresh") gets a badge; someone else's, background one —
      // we update silently so a just-shown "Loaded!" doesn't switch back to
      // "Loading".
      const wasSelf = this._selfRebuild;
      this._selfRebuild = false;
      this._indexing = false;
      this.updateRebuildButton();
      // We ALWAYS update the data silently (no "Loading…" flicker). If it was
      // our own rebuild ("Refresh") — show "Loaded!"; we don't advertise a
      // background build.
      this.refetch({ silent: true });
      if (wasSelf) this.markLoaded();
      else this.updateLoadingState();
    }).then((un) => this._cleanups.push(un));

    // Live progress of the background index build — so it's visible that work is
    // happening, not "hung". Nodes will appear on index:ready (refetch above).
    onEvent('index:progress', (p) => {
      if (!this._open) return;
      if (p && p.root && this._root && p.root !== this._root) return;
      // We show progress ONLY for a build started from the graph itself
      // ("Refresh" → rebuild() sets _indexing). We don't latch onto background
      // indexing (e.g. from the palette) — otherwise the "Loading" badge would
      // hang, never seeing its own index:ready.
      if (!this._indexing) return;
      this._indexCount = (p && p.count) || 0;
      this._indexTotal = (p && p.total) || 0;
      this._indexPhase = (p && p.phase) || 'scan';
      this.updateLoadingState();
      this.updateRebuildButton();
    }).then((un) => this._cleanups.push(un));
  }

  /* ── Open / close ─────────────────── */

  open() {
    const state = this.store.getState();
    this._side = getActiveSide(state);
    const pane = getPane(state, this._side);
    this._root = pane.path || '';
    const selected = (pane.selected || []).filter(Boolean);
    const entries = pane.entries || [];

    let seeds;
    if (selected.length) {
      this._mode = 'focus';
      this._focus = selected[0];
      seeds = selected;
    } else {
      this._mode = 'overview';
      this._focus = null;
      seeds = null; // overview seeds are gathered asynchronously below (current folder + index)
    }

    this._ox = 0;
    this._oy = 0;
    this._zoom = 1;
    // On open — a clean start
    this._nodes.clear();
    this._edges = [];
    this._appeared.clear();
    this._appearQueue = [];
    this._hashes.clear();
    this._hashing = false;
    this._hashSeq++;
    this._indexing = false;
    this._indexCount = 0;
    this._selfRebuild = false;
    this._loaded = false;
    if (this._loadedTimer) {
      clearTimeout(this._loadedTimer);
      this._loadedTimer = null;
    }
    this._showBusy = false;
    if (this._busyTimer) {
      clearTimeout(this._busyTimer);
      this._busyTimer = null;
    }
    this.render();

    // We do NOT start an auto-build on open — we only read the already-built index
    // (if it exists, the graph shows up instantly). A full (re)build happens via the
    // "Refresh" button (rebuild()).
        if (this._mode === 'focus') {
          this.fetch(seeds, 1);
        } else {
          // Overview: files of the current folder + indexed files of the subtree
          // (nested, e.g. src/main.rs).
          this.overviewSeeds(this._root, entries).then((s) => {
            if (this._open) this.fetch(s, 1);
          });
        }
      }
    
      /** Overview seeds: files of the current folder (always) + indexed files of
       *  the subtree from the index (nested). If the index is not built yet — only
       *  the files of the current folder remain. */
      async overviewSeeds(root, entries) {
        const key = (p) => (p || '').toLowerCase();
        const seen = new Set();
        const seeds = [];
        for (const e of entries.slice(0, OVERVIEW_CAP)) {
          if (e.path && !seen.has(key(e.path))) {
            seen.add(key(e.path));
            seeds.push(e.path);
          }
        }
        try {
          const files = await searchFiles(root, '', OVERVIEW_INDEX_CAP); // '' → all files of the subtree
          for (const f of files || []) {
            if (seeds.length >= OVERVIEW_INDEX_CAP) break;
            if (f.path && !seen.has(key(f.path))) {
              seen.add(key(f.path));
              seeds.push(f.path);
            }
          }
        } catch {
          /* index unavailable — we'll show only the files of the current folder */
        }
        return seeds;
      }

  close() {
    if (!this._open) return;
    this._open = false;
    document.getElementById('graph-btn')?.classList.remove('is-on');
    this.stopSim();
    if (this._appearTimer) {
      clearInterval(this._appearTimer);
      this._appearTimer = null;
    }
    if (this._ro) {
      this._ro.disconnect();
      this._ro = null;
    }
    this._pan = null;
    this._winDrag = null;
    this._loading = false;
    this._indexing = false;
    this._selfRebuild = false;
    this._loaded = false;
    if (this._loadedTimer) {
      clearTimeout(this._loadedTimer);
      this._loadedTimer = null;
    }
    this._showBusy = false;
    if (this._busyTimer) {
      clearTimeout(this._busyTimer);
      this._busyTimer = null;
    }
    this._hashing = false;
    this._hashSeq++;
    this._hashes.clear();
    this._appeared.clear();
    this._appearQueue = [];
    this.mount.innerHTML = '';
  }

  destroy() {
    this.stopSim();
    if (this._ro) this._ro.disconnect();
    super.destroy();
  }

  /* ── Data loading ─────────────────────── */

  refetch({ silent = false } = {}) {
    this.fetch(this._curSeeds, this._curHops, { silent });
  }

  /** Forced (re)build of the relationship index — ONLY via the "Refresh" button.
   *  There is no auto-start when the graph opens. Nodes update on the index:ready event. */
  rebuild() {
    if (this._indexing) return;
    if (!this._root) {
          this.bus.emit('shortcut:hint', { text: t('graph.error.noFolder'), type: 'warn' });
      return;
    }
    this._indexing = true;
    this._selfRebuild = true; // this build is started by the graph itself → its index:ready is not "silent"
    this._indexCount = 0;
    this._indexTotal = 0;
    this._indexPhase = 'scan';
    this.updateLoadingState();
    this.updateRebuildButton();
    // content=true, force=true → full rebuild in the background with progress.
    startIndex(this._root, true, true).catch(() => {
      this._indexing = false;
      this._selfRebuild = false;
      this.updateLoadingState();
      this.updateRebuildButton();
    });
  }

  /** "Refresh" button: disabled and labeled "Building…" during a build. */
  updateRebuildButton() {
    if (!this._rebuildBtn) return;
    this._rebuildBtn.disabled = this._indexing;
    this._rebuildBtn.textContent = this._indexing ? '…' : t('graph.rebuild');
  }

  async fetch(seeds, hops, { silent = false } = {}) {
    this._curSeeds = seeds;
    this._curHops = hops;
    const seq = ++this._fetchSeq;
    // silent=true — a background update (on someone else's index:ready): we update
    // the graph data but don't touch the "Loading…"/"Loaded!" badge, otherwise it
    // would flip from the checkmark back to the spinner.
    if (!silent) {
      this._loading = true;
      this.updateLoadingState();
    }
    let data;
    try {
      data = await fileGraph(seeds, hops);
    } catch (err) {
      if (seq === this._fetchSeq) {
        this._loading = false;
        this.updateLoadingState();
                this.bus.emit('shortcut:hint', { text: t('graph.error', { msg: err.message }), type: 'error' });
      }
      return;
    }
    if (seq !== this._fetchSeq || !this._open) {
      // We became a stale request — reset _loading, otherwise the "Loading…" badge
      // may get stuck (the old fetch doesn't reset the flag while the new one already runs).
      if (this._loading && !silent) {
        this._loading = false;
        this.updateLoadingState();
      }
      return;
    }
    this.ingest(data, seeds);
    if (this._mode === 'focus' && this._focus) {
      this._connectedPaths = this.computeConnectedPaths(this._focus);
    }
    this.renderAside();
    // The hashing button is available as soon as nodes appear (it only starts on
    // click — hashing never starts automatically).
    this.updateHashButton();
    this._loading = false;
    // We show "Loaded!" only for a visible load (the initial one or our own
    // rebuild), but not for a silent background update on someone else's index:ready.
    if (!silent && !this._indexing) this.markLoaded();
    this.updateLoadingState();
    // Progressive build: add only the new nodes
    this.startProgressiveAppear();
  }

  ingest(data, seeds) {
    const rawNodes = (data && data.nodes) || [];
    const rawEdges = (data && data.edges) || [];
    const cx = this._w / 2;
    const cy = this._h / 2;

    // Filter out folders: they are not shown as graph nodes
    const folderPaths = new Set();
    const fileNodes = rawNodes.filter((n) => {
      if (n.isDir) {
        folderPaths.add(n.path);
        return false;
      }
      return true;
    });

    // Drop edges referencing folders (they won't be displayed)
    const edges = rawEdges.filter((e) => !folderPaths.has(e.src) && !folderPaths.has(e.dst));

    // Incremental merge: old nodes stay, new ones are added.
    // Positions of existing nodes are preserved — no "jumps" on refetch.
    fileNodes.forEach((n, i) => {
      if (this._nodes.has(n.path)) {
        // Update the metadata, but keep the position and velocity
        const prev = this._nodes.get(n.path);
        prev.name = n.name;
        prev.isDir = false;
      } else {
        const ang = (i / Math.max(fileNodes.length, 1)) * Math.PI * 2;
        const r = 80 + (i % 5) * 32;
        this._nodes.set(n.path, {
          path: n.path,
          name: n.name,
          isDir: false,
          x: cx + r * Math.cos(ang),
          y: cy + r * Math.sin(ang),
          vx: 0,
          vy: 0,
          w: NODE_MIN_W,
        });
      }
    });
    // Remove nodes that are no longer in the data (except seeds)
    const validPaths = new Set(fileNodes.map((n) => n.path));
    for (const s of seeds) {
      if (!folderPaths.has(s)) validPaths.add(s);
    }
    for (const path of [...this._nodes.keys()]) {
      if (!validPaths.has(path)) this._nodes.delete(path);
    }
    // Add seed paths if they weren't in the data (files only, not folders)
    for (const s of seeds) {
      if (folderPaths.has(s)) continue;
      if (!this._nodes.has(s)) {
        this._nodes.set(s, {
          path: s,
          name: s.split(/[\\/]/).pop() || s,
          isDir: false,
          x: cx + (Math.random() - 0.5) * 40,
          y: cy + (Math.random() - 0.5) * 40,
          vx: 0,
          vy: 0,
          w: NODE_MIN_W,
        });
      }
    }
    this._edges = edges;
    if (this._mode === 'focus' && !this._nodes.has(this._focus)) {
      this._focus = seeds[0] || null;
    }
  }

  /* ── Progressive build ─────────────────── */

  /** Starts the gradual appearance of nodes on the canvas.
   *  Already-appeared nodes stay visible — we don't restart the animation. */
  startProgressiveAppear() {
    // Only new (not-yet-appeared) nodes go into the queue
    this._appearQueue = [...this._nodes.keys()].filter((p) => !this._appeared.has(p));
    if (this._appearTimer) clearInterval(this._appearTimer);
    if (this._appearQueue.length === 0) {
      // All nodes are already visible — start the physics right away
      this.onProgressiveDone();
      return;
    }
    this._appearTimer = setInterval(() => {
      for (let i = 0; i < APPEAR_BATCH && this._appearQueue.length > 0; i++) {
        this._appeared.add(this._appearQueue.shift());
      }
      this.draw();
      if (this._appearQueue.length === 0) {
        clearInterval(this._appearTimer);
        this._appearTimer = null;
        this.onProgressiveDone();
      }
    }, APPEAR_INTERVAL);
  }

  /** All nodes have appeared — start the physics. Hashing is started by the button. */
  onProgressiveDone() {
    this.startSim();
    // Show the hashing button
    this.updateHashButton();
  }

  /* ── Hashing the graph's files ────────────── */

  async startHashing() {
    // Don't restart if already running
    if (this._hashing) return;

    const paths = [...this._nodes.keys()];
    // Hash only the files that haven't been hashed yet
    const unhashed = paths.filter((p) => !this._hashes.has(p));
    if (unhashed.length === 0) {
      this.updateHashButton();
      return;
    }

    this._hashing = true;
    this._hashSeq++;
    const mySeq = this._hashSeq;
    this._hashProgress = 0;
    this._hashTotal = unhashed.length;
    this.updateHashButton();
    try {
      const result = await hashGraphFiles(unhashed);
      // Check that this isn't a stale call and the window is still open
      if (mySeq !== this._hashSeq || !this._open) {
        this._hashing = false;
        this.updateHashButton();
        return;
      }
      for (const h of result) {
        if (h.hash) this._hashes.set(h.path, h.hash);
      }
    } catch (err) {
      // hashing is not critical — swallow silently
    }
    this._hashing = false;
    this.updateHashButton();
    this.draw();
  }

  /* ── Physics ──────────────────────────────── */

  startSim() {
    this._alpha = 1;
    if (this._raf) return;
    const tick = () => {
      this.step();
      this.draw();
      this._alpha *= 0.985;
      if (this._alpha > ALPHA_MIN && this._open) {
        this._raf = requestAnimationFrame(tick);
      } else {
        this._raf = null;
        this.draw();
      }
    };
    this._raf = requestAnimationFrame(tick);
  }

  stopSim() {
    if (this._raf) cancelAnimationFrame(this._raf);
    this._raf = null;
  }

  step() {
    const nodes = [...this._nodes.values()];
    const cx = this._w / 2;
    const cy = this._h / 2;
    const a = this._alpha;

    for (let i = 0; i < nodes.length; i++) {
      for (let j = i + 1; j < nodes.length; j++) {
        const p = nodes[i];
        const q = nodes[j];
        let dx = p.x - q.x;
        let dy = p.y - q.y;
        let d2 = dx * dx + dy * dy;
        if (d2 < 0.01) {
          dx = Math.random() - 0.5;
          dy = Math.random() - 0.5;
          d2 = 0.01;
        }
        const f = (REPULSION / d2) * a;
        const d = Math.sqrt(d2);
        const fx = (dx / d) * f;
        const fy = (dy / d) * f;
        p.vx += fx;
        p.vy += fy;
        q.vx -= fx;
        q.vy -= fy;
      }
    }

    for (const e of this._edges) {
      const p = this._nodes.get(e.src);
      const q = this._nodes.get(e.dst);
      if (!p || !q) continue;
      const dx = q.x - p.x;
      const dy = q.y - p.y;
      const d = Math.hypot(dx, dy) || 0.01;
      const f = SPRING_K * (d - SPRING_LEN) * a;
      const fx = (dx / d) * f;
      const fy = (dy / d) * f;
      p.vx += fx;
      p.vy += fy;
      q.vx -= fx;
      q.vy -= fy;
    }

    // gravity toward the center + integration. We do NOT clamp to bounds —
    // nodes spread freely, off-screen areas are reachable via panning/zoom.
    for (const p of nodes) {
      p.vx += (cx - p.x) * GRAVITY * a;
      p.vy += (cy - p.y) * GRAVITY * a;
      p.vx *= DAMPING;
      p.vy *= DAMPING;
      if (this._mode === 'focus' && p.path === this._focus) {
        p.x = cx;
        p.y = cy;
        p.vx = 0;
        p.vy = 0;
        continue;
      }
      p.x += p.vx;
      p.y += p.vy;
    }
  }

  /* ── Canvas rendering ───────────────────── */

  draw() {
    const c = this.ctx;
    if (!c) return;
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.clearRect(0, 0, this._w, this._h);

    if (!this._nodes.size) {
      c.fillStyle = this._colors.labelDim;
      c.font = '14px sans-serif';
      c.textAlign = 'center';
      c.fillText(t('graph.noRelations'), this._w / 2, this._h / 2);
      return;
    }

    // Apply pan/zoom: draw in "world" coordinates.
    c.setTransform(this._zoom, 0, 0, this._zoom, this._ox, this._oy);
    for (const e of this._edges) {
      const p = this._nodes.get(e.src);
      const q = this._nodes.get(e.dst);
      if (!p || !q) continue;
      // Draw the edge only if both nodes have already appeared
      if (!this._appeared.has(p.path) || !this._appeared.has(q.path)) continue;
      this.drawEdge(c, p, q, e);
    }
    for (const n of this._nodes.values()) this.drawNode(c, n);
    c.setTransform(1, 0, 0, 1, 0, 0);
  }

  readColors() {
    const cs = getComputedStyle(document.documentElement);
    const v = (name, fb) => cs.getPropertyValue(name).trim() || fb;
    return {
      dep: v('--accent', C_DEP),
      back: v('--tag-progress', C_BACK),
      folder: v('--accent-2', '#14b8a6'),
      file: v('--text-faint', '#5b6478'),
      // Canvas text — from tokens, so it's readable in the light theme too
      // (previously it was hardcoded "light on dark" and vanished on a light background).
      label: v('--text', '#e5e7eb'),
      labelDim: v('--text-dim', '#9ca3af'),
    };
  }

  /** Determines the arrow's color and style by edge type.
   *  Green — dependency (src→dst), yellow — back-reference (dst→seed).
   *  In focus mode: outgoing from the focus = green, incoming to the focus = yellow.
   *  In overview mode: by the edge's kind. */
  edgeStyle(e) {
    // Manual links — dashed, neutral color
    if (e.kind === 'manual') return { color: C_MANUAL, dash: [5, 4], arrow: false, strong: false };
    // In focus mode — outgoing green, incoming yellow
    if (this._focus) {
      if (e.src === this._focus) return { color: C_DEP, dash: [], arrow: true, strong: true };
      if (e.dst === this._focus) return { color: C_BACK, dash: [], arrow: true, strong: true };
    }
    // In overview mode or for transitive edges:
    // dependencies (import/include) — green, mentions — dim
    if (e.kind === 'mention') return { color: C_MENTION, dash: [2, 4], arrow: true, strong: false };
    // Other (contextual) edges — green by default (dependency)
    return { color: C_DEP, dash: [], arrow: true, strong: false };
  }

  drawEdge(c, p, q, e) {
    const st = this.edgeStyle(e);
    // In focus mode: edges with no direct link to the focus are semi-transparent
    const isRelated = !this._focus || !this._connectedPaths ||
      (this._connectedPaths.has(e.src) && this._connectedPaths.has(e.dst));
    if (!isRelated) c.globalAlpha = 0.35;
    c.strokeStyle = st.color;
    c.fillStyle = st.color;
    c.lineWidth = st.strong ? 2 : 1.2;
    c.setLineDash(st.dash);
    c.beginPath();
    // Arrow from the edge of panel p to the edge of panel q
    const dx = q.x - p.x;
    const dy = q.y - p.y;
    const ang = Math.atan2(dy, dx);
    // Point on the boundary of panel p
    const pEdge = this.edgePoint(p, ang, p.w || NODE_MIN_W, NODE_H);
    // Point on the boundary of panel q
    const qEdge = this.edgePoint(q, ang + Math.PI, q.w || NODE_MIN_W, NODE_H);
    c.moveTo(pEdge.x, pEdge.y);
    c.lineTo(qEdge.x, qEdge.y);
    c.stroke();
    c.setLineDash([]);
    if (st.arrow) {
      const a1 = ang + Math.PI - 0.4;
      const a2 = ang + Math.PI + 0.4;
      c.beginPath();
      c.moveTo(qEdge.x, qEdge.y);
      c.lineTo(qEdge.x + Math.cos(a1) * 8, qEdge.y + Math.sin(a1) * 8);
      c.lineTo(qEdge.x + Math.cos(a2) * 8, qEdge.y + Math.sin(a2) * 8);
      c.closePath();
      c.fill();
    }
    // Restore opacity after an unrelated edge
    if (!isRelated) c.globalAlpha = 1;
  }

  /** Point on the boundary of a node's rectangular panel by the angle from its center. */
  edgePoint(n, angle, w, h) {
    const hw = w / 2;
    const hh = h / 2;
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    // Intersection of the ray with the rectangle
    let t;
    if (Math.abs(cos) * hh > Math.abs(sin) * hw) {
      t = hw / Math.abs(cos);
    } else {
      t = hh / Math.abs(sin);
    }
    return { x: n.x + cos * t, y: n.y + sin * t };
  }

  drawNode(c, n) {
    if (!this._appeared.has(n.path)) return; // not appeared yet

    // In focus mode: nodes not connected to the focus are semi-transparent
    const isRelated = !this._focus || !this._connectedPaths || this._connectedPaths.has(n.path);
    if (!isRelated) c.globalAlpha = 0.35;

    const isFocus = n.path === this._focus;
    const hasHash = this._hashes.has(n.path);

    // Compute the panel width from the text
    c.font = NODE_FONT;
    const text = shortLabel(n.name, n.path);
    const textW = c.measureText(text).width;
    const nw = Math.min(NODE_MAX_W, Math.max(NODE_MIN_W, Math.ceil(textW) + NODE_PAD_X * 2));
    n.w = nw;
    const nh = NODE_H;
    const x = n.x - nw / 2;
    const y = n.y - nh / 2;

    // Node color by extension (as in the file panel)
    const extCol = nodeColor(n.name);

    // Panel background — tinted with the extension color
    c.beginPath();
    this.roundRect(c, x, y, nw, nh, NODE_RADIUS);
    const bgColor = extCol + (isFocus ? '30' : '18');
    c.fillStyle = bgColor;
    c.fill();

    // Border — the color of the node's FOLDER (the same as that folder's tab): files
    // from one folder are visually grouped. The fill stays based on the file extension.
    const folderCol = pathToColor(parentDir(n.path));
    c.lineWidth = isFocus ? 2.5 : 1.5;
    c.strokeStyle = isFocus ? folderCol : folderCol + 'cc';
    c.stroke();

    // Text inside the panel — show the path (folder/file) instead of just the name
    const labelText = shortLabel(n.name, n.path);
    c.fillStyle = this._colors.label;
    c.font = isFocus ? 'bold ' + NODE_FONT : NODE_FONT;
    c.textAlign = 'center';
    c.textBaseline = 'middle';
    c.fillText(labelText, n.x, n.y);
    c.textBaseline = 'alphabetic';

    // Hashing icon (a small spinner circle in the top-right corner)
    if (this._hashing) {
      const ix = x + nw - 6;
      const iy = y + 6;
      c.beginPath();
      c.arc(ix, iy, 3.5, 0, Math.PI * 2);
      c.fillStyle = extCol + '66';
      c.fill();
      // Rotating arc
      const angle = (Date.now() / 200) % (Math.PI * 2);
      c.beginPath();
      c.arc(ix, iy, 3.5, angle, angle + Math.PI * 0.8);
      c.strokeStyle = extCol;
      c.lineWidth = 1.5;
      c.stroke();
    } else if (hasHash) {
      // Checkmark — the file is hashed
      const ix = x + nw - 8;
      const iy = y + 6;
      c.beginPath();
      c.arc(ix, iy, 4, 0, Math.PI * 2);
      c.fillStyle = extCol + '44';
      c.fill();
      c.beginPath();
      c.moveTo(ix - 2, iy);
      c.lineTo(ix - 0.5, iy + 2);
      c.lineTo(ix + 2.5, iy - 2);
      c.strokeStyle = extCol;
      c.lineWidth = 1.2;
      c.stroke();
    }

    // Restore opacity after an unrelated node
    if (!isRelated) c.globalAlpha = 1;
  }

  /** Rounded rectangle (canvas path). */
  roundRect(c, x, y, w, h, r) {
    c.moveTo(x + r, y);
    c.lineTo(x + w - r, y);
    c.quadraticCurveTo(x + w, y, x + w, y + r);
    c.lineTo(x + w, y + h - r);
    c.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
    c.lineTo(x + r, y + h);
    c.quadraticCurveTo(x, y + h, x, y + h - r);
    c.lineTo(x, y + r);
    c.quadraticCurveTo(x, y, x + r, y);
    c.closePath();
  }

  /* ── Side lists ──────────────────────── */

  renderAside() {
    if (!this.aside) return;
    const focus = this._focus;
    if (!focus) {
      this.aside.innerHTML = `<div class="graph__empty">${escapeHtml(t('graph.emptyHint'))}</div>`;
      return;
    }
    const fnode = this._nodes.get(focus);
    const deps = [];
    const backs = [];
    const manual = [];
    for (const e of this._edges) {
      if (e.kind === 'manual') {
        if (e.src === focus) manual.push(e.dst);
        else if (e.dst === focus) manual.push(e.src);
        continue;
      }
      if (e.src === focus) deps.push(e.dst);
      else if (e.dst === focus) backs.push(e.src);
    }
    const title = fnode ? shortLabel(fnode.name, fnode.path) : focus.split(/[\\/]/).pop();
    this.aside.innerHTML = `
      <div class="graph__focus" title="${escapeHtml(focus)}">${escapeHtml(title)}</div>
      ${this.listBlock(t('graph.aside.deps'), deps, 'dep')}
      ${this.listBlock(t('graph.aside.backs'), backs, 'back')}
      ${manual.length ? this.listBlock(t('graph.aside.manual'), manual, 'manual') : ''}
    `;
    this.aside.querySelectorAll('[data-reveal]').forEach((el) =>
      el.addEventListener('click', () => this.bus.emit('graph:reveal', { path: el.dataset.reveal })),
    );
  }

  listBlock(title, paths, cls) {
    const uniq = [...new Set(paths)];
    const items = uniq.length
      ? uniq
        .map((p) => {
          const node = this._nodes.get(p);
          const name = node ? shortLabel(node.name, node.path) : p.split(/[\\/]/).pop() || p;
          return `<li class="graph__item graph__item--${cls}" data-reveal="${escapeHtml(p)}" title="${escapeHtml(p)}">${escapeHtml(name)}</li>`;
        })
        .join('')
      : `<li class="graph__item graph__item--empty">—</li>`;
    return `<div class="graph__group"><div class="graph__group-title">${escapeHtml(title)} <span class="graph__count">${uniq.length}</span></div><ul class="graph__list">${items}</ul></div>`;
  }

  /* ── Window markup + events ─────────────── */

  render() {
    this._open = true;
    document.getElementById('graph-btn')?.classList.add('is-on');
    this.mount.innerHTML = `
      <div class="graph graph--window">
        <div class="graph__head" data-drag>
          <div class="graph__title">${escapeHtml(t('graph.title'))}</div>
          <div class="graph__legend">
            <span class="graph__dot" style="background:${C_DEP}"></span>${escapeHtml(t('graph.legend.deps'))}
            <span class="graph__dot" style="background:${C_BACK}"></span>${escapeHtml(t('graph.legend.backs'))}
          </div>
          <button class="graph__rebuild" data-rebuild title="${escapeHtml(t('graph.rebuild.title'))}">${escapeHtml(t('graph.rebuild'))}</button>
          <button class="graph__close" data-close title="${escapeHtml(t('common.close'))}">×</button>
        </div>
        <div class="graph__body">
          <div class="graph__canvas-wrap">
            <canvas class="graph__canvas"></canvas>
            <div class="graph__loading" hidden>
              <div class="graph__spinner"></div>
              <span class="graph__loading-text">${escapeHtml(t('graph.loading'))}</span>
            </div>
            <button class="graph__hash-btn" hidden data-hash-btn>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 2l-2 2m-7.61 7.61a5.5 5.5 0 1 1-7.778 7.778 5.5 5.5 0 0 1 7.777-7.777zm0 0L15.5 7.5m0 0l3 3L22 7l-3-3m-3.5 3.5l3 3"/></svg>
              <span class="graph__hash-btn-text">${escapeHtml(t('graph.hash'))}</span>
            </button>
          </div>
          <aside class="graph__aside"></aside>
        </div>
      </div>`;
    this.win = this.mount.querySelector('.graph');
    this.canvas = this.mount.querySelector('.graph__canvas');
    this.ctx = this.canvas.getContext('2d');
    this.aside = this.mount.querySelector('.graph__aside');
    this._loadingEl = this.mount.querySelector('.graph__loading');
    this._hashBtn = this.mount.querySelector('[data-hash-btn]');
    this._rebuildBtn = this.mount.querySelector('[data-rebuild]');

    this.mount
      .querySelectorAll('[data-close]')
      .forEach((el) => el.addEventListener('click', () => this.close()));
    if (this._hashBtn) {
      this._hashBtn.addEventListener('click', () => this.startHashing());
    }
    if (this._rebuildBtn) {
      this._rebuildBtn.addEventListener('click', () => this.rebuild());
    }

    const head = this.mount.querySelector('[data-drag]');
    head.addEventListener('mousedown', (e) => this.onHeadDown(e));

    this.canvas.addEventListener('mousedown', (e) => this.onCanvasDown(e));
    this.canvas.addEventListener('click', (e) => this.onClick(e));
    this.canvas.addEventListener('dblclick', (e) => this.onDblClick(e));
    this.canvas.addEventListener('wheel', (e) => this.onWheel(e), { passive: false });

    // Center the window and fit the canvas to its size.
    this.centerWindow();
    this.resizeCanvas();
    if (typeof ResizeObserver !== 'undefined') {
      this._ro = new ResizeObserver(() => this.resizeCanvas());
      this._ro.observe(this.canvas.parentElement);
    }
    // Draw the side lists — otherwise the aside stays empty until a click after a language change.
    this.renderAside();
  }

  centerWindow() {
    const r = this.win.getBoundingClientRect();
    const left = Math.max(8, Math.round((window.innerWidth - r.width) / 2));
    const top = Math.max(8, Math.round((window.innerHeight - r.height) / 2));
    this.win.style.left = `${left}px`;
    this.win.style.top = `${top}px`;
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
    this.draw();
  }

  /** Show the "Loaded!" badge — it stays until the next load. */
  markLoaded() {
    if (this._loadedTimer) clearTimeout(this._loadedTimer);
    this._loadedTimer = null;
    this._loaded = true;
    this.updateLoadingState();
  }

  /** "Busy" for badge purposes. KEY rule: we show the "Loading…" spinner only on
   *  an EMPTY graph (the first render). Once there are nodes, any further
   *  loads/refetches are background and do NOT raise the badge; even if the
   *  _loading flag got stuck true due to a race, the spinner won't appear over the data.
   *  A rebuild (_indexing, the "Refresh" button) is always shown. This is what
   *  removes the "checkmark → Loading again" on an already-rendered graph. */
  _isBusy() {
    return (this._loading && this._nodes.size === 0) || this._indexing;
  }

  /** Update the indicator: "Loading…"/"Indexing…" while working, "Loaded!"
   *  briefly on completion, otherwise hidden. */
  updateLoadingState() {
    // We show the spinner not immediately but after BUSY_DELAY: fast operations (small
    // folders) should not produce a flickering indicator. If the work finishes during
    // the delay — the spinner won't appear at all, going straight to "Loaded!".
    if (this._isBusy()) {
      if (!this._showBusy && !this._busyTimer) {
        this._busyTimer = setTimeout(() => {
          this._busyTimer = null;
          if (this._isBusy()) {
            this._showBusy = true;
            this.applyPlate();
          }
        }, BUSY_DELAY);
      }
    } else {
      if (this._busyTimer) {
        clearTimeout(this._busyTimer);
        this._busyTimer = null;
      }
      this._showBusy = false;
    }
    this.applyPlate();
  }

  /** Apply the state to the badge. busyVisible — the spinner is already allowed to show
   *  (after the delay); "Loaded!" is shown instantly, without a delay. */
  applyPlate() {
    const busyVisible = this._showBusy && this._isBusy();
    const loadingVisible = busyVisible && this._loading && this._nodes.size === 0;
    const show = busyVisible || this._loaded;
    if (this._loadingEl) {
      this._loadingEl.hidden = !show;
      const done = !busyVisible && this._loaded;
      this._loadingEl.classList.toggle('is-done', done);
      const spin = this._loadingEl.querySelector('.graph__spinner');
      if (spin) spin.style.display = (done || !show) ? 'none' : '';
    }
    const txt = this.mount && this.mount.querySelector('.graph__loading-text');
    if (txt) {
      if (busyVisible && this._indexing) {
        if (this._indexPhase === 'relations') {
          txt.textContent = this._indexTotal
            ? t('graph.buildingRelations.count', { done: this._indexCount, total: this._indexTotal })
            : t('graph.buildingRelations');
        } else {
          txt.textContent = t('graph.indexing', { n: this._indexCount });
        }
      } else if (loadingVisible) {
        txt.textContent = t('graph.loading');
      } else if (this._loaded) {
        txt.textContent = t('graph.loaded');
      }
    }
  }

  /** Update the hashing button state. */
  updateHashButton() {
    if (!this._hashBtn) return;
    if (this._hashing) {
      this._hashBtn.hidden = false;
      this._hashBtn.classList.add('is-hashing');
      this._hashBtn.querySelector('.graph__hash-btn-text').textContent = t('graph.hash.progress');
      this._hashBtn.disabled = true;
    } else {
      const paths = [...this._nodes.keys()];
      const unhashed = paths.filter((p) => !this._hashes.has(p));
      if (unhashed.length === 0) {
        this._hashBtn.hidden = true;
      } else {
        this._hashBtn.hidden = false;
        this._hashBtn.classList.remove('is-hashing');
        this._hashBtn.querySelector('.graph__hash-btn-text').textContent = t('graph.hash.count', { n: unhashed.length });
        this._hashBtn.disabled = false;
      }
    }
  }

  /** Return from focus mode to the graph overview. */
  backToOverview() {
    if (this._mode !== 'focus') return;
    this._mode = 'overview';
    this._focus = null;
    // Reload the overview for the current root
    const state = this.store.getState();
    const pane = getPane(state, this._side);
    const entries = pane.entries || [];
    this.overviewSeeds(this._root, entries).then((seeds) => {
      if (this._open) this.fetch(seeds, 1);
    });
  }
  
    /** Re-render on language change. Preserves nodes, edges, focus, window position. */
    applyLang() {
      if (!this._open) return;
      // Update only the texts in the header, legend, buttons pointwise — we don't touch the canvas.
      const titleEl = this.mount.querySelector('.graph__title');
      if (titleEl) titleEl.textContent = t('graph.title');
      const dots = this.mount.querySelectorAll('.graph__legend .graph__dot');
      if (dots.length >= 2) {
        // The text neighbors of the legend dots are the text nodes between them.
        const legend = this.mount.querySelector('.graph__legend');
        if (legend) {
          // Rebuild the whole legend: 2 dots + 2 labels.
          legend.innerHTML = '';
          legend.append(
            document.createElement('span'),
          );
          const dot1 = document.createElement('span');
          dot1.className = 'graph__dot';
          dot1.style.background = C_DEP;
          legend.append(dot1, t('graph.legend.deps'));
          const dot2 = document.createElement('span');
          dot2.className = 'graph__dot';
          dot2.style.background = C_BACK;
          legend.append(dot2, t('graph.legend.backs'));
        }
      }
      if (this._rebuildBtn) {
        this._rebuildBtn.title = t('graph.rebuild.title');
        this._rebuildBtn.textContent = this._indexing ? '…' : t('graph.rebuild');
      }
      const closeBtn = this.mount.querySelector('.graph__close');
      if (closeBtn) closeBtn.title = t('common.close');
      if (this._hashBtn) this._hashBtn.title = t('graph.hash');
      this.updateHashButton();
      this.updateLoadingState();
      this.renderAside();
      this.draw(); // canvas: the "No relations found" text depends on the language.
    }

  /* ── Window drag / panning / zoom ── */

  onHeadDown(e) {
    if (e.target.closest('button')) return; // clicks on buttons are not a drag
    this._winDrag = { x: e.clientX, y: e.clientY, left: this.win.offsetLeft, top: this.win.offsetTop };
    e.preventDefault();
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

  onWheel(e) {
    e.preventDefault();
    const [sx, sy] = this.canvasPoint(e);
    const wx = (sx - this._ox) / this._zoom;
    const wy = (sy - this._oy) / this._zoom;
    const factor = e.deltaY < 0 ? 1.12 : 1 / 1.12;
    const z = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, this._zoom * factor));
    this._zoom = z;
    this._ox = sx - wx * z; // the point under the cursor stays in place
    this._oy = sy - wy * z;
    this.draw();
  }

  /* ── Coordinates and hit-testing ──────────────── */

  // Event coordinates in canvas pixels (accounting for possible CSS scaling).
  canvasPoint(e) {
    const rect = this.canvas.getBoundingClientRect();
    const sx = ((e.clientX - rect.left) / rect.width) * this._w;
    const sy = ((e.clientY - rect.top) / rect.height) * this._h;
    return [sx, sy];
  }

  nodeAt(e) {
    const [sx, sy] = this.canvasPoint(e);
    const wx = (sx - this._ox) / this._zoom; // screen -> world
    const wy = (sy - this._oy) / this._zoom;
    let best = null;
    let bestDist = Infinity;
    for (const n of this._nodes.values()) {
      if (!this._appeared.has(n.path)) continue;
      const nw = n.w || NODE_MIN_W;
      const nh = NODE_H;
      // Hit-test against the rectangle
      if (wx >= n.x - nw / 2 && wx <= n.x + nw / 2 && wy >= n.y - nh / 2 && wy <= n.y + nh / 2) {
        const d = Math.hypot(n.x - wx, n.y - wy);
        if (d < bestDist) {
          bestDist = d;
          best = n;
        }
      }
    }
    return best;
  }

  async onClick(e) {
    if (this._moved) {
      this._moved = false; // it was panning, not a click
      return;
    }
    const node = this.nodeAt(e);
    if (!node) {
      // Click on empty space — clear the selection, all nodes are visible again
      if (this._focus) {
        this._focus = null;
        this._connectedPaths = null;
        this._mode = 'overview';
        this.renderAside();
        this.draw();
      }
      return;
    }
    // Switch the focus without loading new data:
    // all nodes stay, unrelated ones become semi-transparent
    this._mode = 'focus';
    this._focus = node.path;
    this._connectedPaths = this.computeConnectedPaths(node.path);
    this.renderAside();
    this.draw();
  }

  /** Collect the set of node paths connected to the focus (direct links in both directions). */
  computeConnectedPaths(focusPath) {
    const connected = new Set([focusPath]);
    for (const e of this._edges) {
      if (e.src === focusPath) connected.add(e.dst);
      if (e.dst === focusPath) connected.add(e.src);
    }
    return connected;
  }

  onDblClick(e) {
    const node = this.nodeAt(e);
    if (node) {
      this.bus.emit('graph:reveal', { path: node.path });
      this.close();
    } else {
      // double-click on empty space — reset the view
      this._ox = 0;
      this._oy = 0;
      this._zoom = 1;
      this.draw();
    }
  }
}