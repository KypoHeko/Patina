import { Component } from '../core/component.js';
import { addRelationship, removeRelationship, relationshipsFor } from '../api/relationships.js';
import { getPane } from '../state/panes.js';
import { getActiveSide } from '../state/tabs.js';

const W = 820;
const H = 560;
const NODE_R = 7;

function pairKey(a, b) {
  return a <= b ? `${a}\u0000${b}` : `${b}\u0000${a}`;
}
function stem(name) {
  const i = name.lastIndexOf('.');
  return i > 0 ? name.slice(0, i).toLowerCase() : name.toLowerCase();
}

// Граф связей (Ctrl+G): узлы — файлы текущей папки активной панели.
// Рёбра: явные связи из БД (акцент) + производные «общая основа имени» (тускло).
// Клик — выделить/связать, двойной клик — открыть.
export class RelationshipGraph extends Component {
  init() {
    this._open = false;
    this._side = 'left';
    this._nodes = []; // { entry, x, y }
    this._explicit = new Set();
    this._derived = new Set();
    this._sel = null;

    this.listen('graph:open', () => (this._open ? this.close() : this.open()));
    this.on(document, 'keydown', (e) => {
      if (this._open && e.key === 'Escape') this.close();
    });
  }

  async open() {
    const state = this.store.getState();
    this._side = getActiveSide(state);
    const entries = getPane(state, this._side).entries || [];
    this._sel = null;
    this.layout(entries);
    this.computeDerived(entries);
    this.render();
    await this.loadExplicit();
    this.draw();
  }

  close() {
    if (!this._open) return;
    this._open = false;
    this.mount.innerHTML = '';
  }

  layout(entries) {
    const cx = W / 2;
    const cy = H / 2;
    const r = Math.min(W, H) / 2 - 70;
    const n = entries.length;
    this._nodes = entries.map((entry, i) => {
      if (n === 1) return { entry, x: cx, y: cy };
      const ang = (i / n) * Math.PI * 2 - Math.PI / 2;
      return { entry, x: cx + r * Math.cos(ang), y: cy + r * Math.sin(ang) };
    });
  }

  computeDerived(entries) {
    const byStem = new Map();
    for (const e of entries) {
      const s = stem(e.name);
      if (!byStem.has(s)) byStem.set(s, []);
      byStem.get(s).push(e.path);
    }
    this._derived = new Set();
    for (const paths of byStem.values()) {
      if (paths.length < 2) continue;
      for (let i = 0; i < paths.length; i++)
        for (let j = i + 1; j < paths.length; j++)
          this._derived.add(pairKey(paths[i], paths[j]));
    }
  }

  async loadExplicit() {
    try {
      const pairs = (await relationshipsFor(this._nodes.map((n) => n.entry.path))) || [];
      this._explicit = new Set(pairs.map(([a, b]) => pairKey(a, b)));
    } catch {
      this._explicit = new Set();
    }
  }

  render() {
    this._open = true;
    this.mount.innerHTML = `
      <div class="graph__backdrop" data-close></div>
      <div class="graph">
        <div class="graph__head">
          <div class="graph__title">Граф связей</div>
          <div class="graph__hint">клик — выделить/связать · двойной — открыть</div>
          <button class="graph__close" data-close title="Закрыть">×</button>
        </div>
        <canvas class="graph__canvas" width="${W}" height="${H}"></canvas>
      </div>`;
    this.canvas = this.mount.querySelector('.graph__canvas');
    this.ctx = this.canvas.getContext('2d');

    this.mount.querySelectorAll('[data-close]').forEach((el) =>
      el.addEventListener('click', () => this.close()),
    );
    this.canvas.addEventListener('click', (e) => this.onClick(e));
    this.canvas.addEventListener('dblclick', (e) => this.onDblClick(e));
  }

  nodeAt(e) {
    const rect = this.canvas.getBoundingClientRect();
    const x = ((e.clientX - rect.left) / rect.width) * W;
    const y = ((e.clientY - rect.top) / rect.height) * H;
    return this._nodes.find((n) => Math.hypot(n.x - x, n.y - y) <= NODE_R + 6) || null;
  }

  async onClick(e) {
    const node = this.nodeAt(e);
    if (!node) {
      this._sel = null;
      this.draw();
      return;
    }
    if (!this._sel) {
      this._sel = node.entry.path;
    } else if (this._sel === node.entry.path) {
      this._sel = null;
    } else {
      const a = this._sel;
      const b = node.entry.path;
      try {
        if (this._explicit.has(pairKey(a, b))) await removeRelationship(a, b);
        else await addRelationship(a, b);
        await this.loadExplicit();
      } catch (err) {
        this.bus.emit('shortcut:hint', err.message);
      }
      this._sel = null;
    }
    this.draw();
  }

  onDblClick(e) {
    const node = this.nodeAt(e);
    if (node) {
      this.bus.emit('file:activate', { side: this._side, entry: node.entry });
      this.close();
    }
  }

  draw() {
    const c = this.ctx;
    c.clearRect(0, 0, W, H);
    const pos = new Map(this._nodes.map((n) => [n.entry.path, n]));

    // производные рёбра (тускло, пунктир)
    c.lineWidth = 1;
    c.setLineDash([4, 4]);
    c.strokeStyle = 'rgba(120,130,150,0.45)';
    for (const key of this._derived) {
      if (this._explicit.has(key)) continue;
      this.edge(c, pos, key);
    }
    // явные рёбра (акцент, сплошные)
    c.setLineDash([]);
    c.lineWidth = 2;
    c.strokeStyle = '#10b981';
    for (const key of this._explicit) this.edge(c, pos, key);

    // узлы
    for (const n of this._nodes) {
      const isFolder = n.entry.kind === 'folder';
      const selected = this._sel === n.entry.path;
      c.beginPath();
      c.arc(n.x, n.y, NODE_R, 0, Math.PI * 2);
      c.fillStyle = isFolder ? '#14b8a6' : '#5b6478';
      c.fill();
      if (selected) {
        c.lineWidth = 2.5;
        c.strokeStyle = '#e6e8ee';
        c.stroke();
      }
      c.fillStyle = 'rgba(220,225,235,0.85)';
      c.font = '11px sans-serif';
      c.textAlign = 'center';
      const label = n.entry.name.length > 16 ? n.entry.name.slice(0, 15) + '…' : n.entry.name;
      c.fillText(label, n.x, n.y + NODE_R + 12);
    }

    if (!this._nodes.length) {
      c.fillStyle = 'rgba(160,168,184,0.8)';
      c.font = '14px sans-serif';
      c.textAlign = 'center';
      c.fillText('Папка пуста', W / 2, H / 2);
    }
  }

  edge(c, pos, key) {
    const [a, b] = key.split('\u0000');
    const na = pos.get(a);
    const nb = pos.get(b);
    if (!na || !nb) return;
    c.beginPath();
    c.moveTo(na.x, na.y);
    c.lineTo(nb.x, nb.y);
    c.stroke();
  }
}
