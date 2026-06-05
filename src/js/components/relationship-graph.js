import { Component } from '../core/component.js';
import { escapeHtml } from '../core/dom.js';
import { fileGraph, addRelationship, removeRelationship } from '../api/relationships.js';
import { startIndex } from '../api/indexing.js';
import { onEvent } from '../api/events.js';
import { getPane } from '../state/panes.js';
import { getActiveSide } from '../state/tabs.js';

const NODE_R = 8;
const OVERVIEW_CAP = 80; // не строим полотно из тысяч узлов
const DEFAULT_W = 900; // ориентир до первой раскладки полотна
const DEFAULT_H = 600;

// Физика (подобрана под десятки узлов)
const REPULSION = 5400; // кулоновское отталкивание
const SPRING_LEN = 96; // длина покоя ребра
const SPRING_K = 0.016; // жёсткость пружины
const GRAVITY = 0.014; // притяжение к центру (держит отвязанные узлы)
const DAMPING = 0.86;
const ALPHA_MIN = 0.02;
const ZOOM_MIN = 0.2;
const ZOOM_MAX = 3;

const C_DEP = '#10b981'; // зависимости (исходящие от фокуса) — emerald
const C_BACK = '#f59e0b'; // обратные ссылки (входящие в фокус) — amber
const C_MANUAL = 'rgba(150,158,176,0.75)';
const C_CTX = 'rgba(120,130,150,0.5)';
const C_MENTION = 'rgba(120,130,150,0.3)';

function shortLabel(name) {
  return name.length > 18 ? name.slice(0, 17) + '…' : name;
}

// Граф связей (Ctrl+G) — плавающее окно: его можно перетаскивать за заголовок и
// менять размер за угол. Полотно занимает всё окно; узлы не привязаны к его
// границам (могут уходить за край), фон можно панорамировать перетаскиванием и
// масштабировать колесом. Один клик по узлу — сделать его фокусом; двойной —
// показать файл в панели; двойной по пустому месту — сбросить вид.
export class RelationshipGraph extends Component {
  init() {
    this._open = false;
    this._side = 'left';
    this._root = '';
    this._mode = 'overview'; // 'focus' | 'overview'
    this._focus = null;
    this._linkMode = false;
    this._linkSel = null;

    this._nodes = new Map();
    this._edges = [];
    this._curSeeds = [];
    this._curHops = 1;

    this._raf = null;
    this._alpha = 0;
    this._fetchSeq = 0;

    // Размер полотна (обновляется ResizeObserver), вид (пан/зум), перетаскивания.
    this._w = DEFAULT_W;
    this._h = DEFAULT_H;
    this._ox = 0;
    this._oy = 0;
    this._zoom = 1;
    this._pan = null; // активное панорамирование фона
    this._winDrag = null; // активное перетаскивание окна
    this._moved = false; // был ли drag — чтобы не путать с кликом
    this._ro = null;

    this._colors = this.readColors();
    this.listen('theme:changed', () => {
      this._colors = this.readColors();
      if (!this._open) return;
      this.draw();
      const dots = this.mount.querySelectorAll('.graph__dot');
      if (dots[0]) dots[0].style.background = this._colors.dep;
      if (dots[1]) dots[1].style.background = this._colors.back;
    });

    this.listen('graph:open', () => (this._open ? this.close() : this.open()));
    this.on(document, 'keydown', (e) => {
      if (this._open && e.key === 'Escape') this.close();
    });
    // Перетаскивания обрабатываем на уровне документа (постоянно, с защитой),
    // чтобы курсор можно было увести за пределы окна и не терять захват.
    this.on(document, 'mousemove', (e) => this.onDocMove(e));
    this.on(document, 'mouseup', () => this.onDocUp());

    onEvent('index:ready', (root) => {
      if (this._open && (!root || root === this._root)) this.refetch();
    }).then((un) => this._cleanups.push(un));
  }

  /* ── Открытие / закрытие ─────────────────── */

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
      seeds = entries.slice(0, OVERVIEW_CAP).map((e) => e.path);
    }

    this._linkMode = false;
    this._linkSel = null;
    this._ox = 0;
    this._oy = 0;
    this._zoom = 1;
    this.render();

    if (this._root) startIndex(this._root, true, false).catch(() => {});
    this.fetch(seeds, 1);
  }

  close() {
    if (!this._open) return;
    this._open = false;
    this.stopSim();
    if (this._ro) {
      this._ro.disconnect();
      this._ro = null;
    }
    this._pan = null;
    this._winDrag = null;
    this.mount.innerHTML = '';
  }

  destroy() {
    this.stopSim();
    if (this._ro) this._ro.disconnect();
    super.destroy();
  }

  /* ── Загрузка данных ─────────────────────── */

  refetch() {
    this.fetch(this._curSeeds, this._curHops);
  }

  async fetch(seeds, hops) {
    this._curSeeds = seeds;
    this._curHops = hops;
    const seq = ++this._fetchSeq;
    let data;
    try {
      data = await fileGraph(seeds, hops);
    } catch (err) {
      if (seq === this._fetchSeq) this.bus.emit('shortcut:hint', `Граф: ${err.message}`);
      return;
    }
    if (seq !== this._fetchSeq || !this._open) return;
    this.ingest(data, seeds);
    this.renderAside();
    this.startSim();
  }

  ingest(data, seeds) {
    const nodes = (data && data.nodes) || [];
    const edges = (data && data.edges) || [];
    const cx = this._w / 2;
    const cy = this._h / 2;
    const next = new Map();
    nodes.forEach((n, i) => {
      const prev = this._nodes.get(n.path);
      if (prev) {
        next.set(n.path, { ...prev, name: n.name, isDir: n.isDir });
      } else {
        const ang = (i / Math.max(nodes.length, 1)) * Math.PI * 2;
        const r = 60 + (i % 5) * 26;
        next.set(n.path, {
          path: n.path,
          name: n.name,
          isDir: n.isDir,
          x: cx + r * Math.cos(ang),
          y: cy + r * Math.sin(ang),
          vx: 0,
          vy: 0,
        });
      }
    });
    for (const s of seeds) {
      if (!next.has(s)) {
        next.set(s, {
          path: s,
          name: s.split(/[\\/]/).pop() || s,
          isDir: false,
          x: cx + (Math.random() - 0.5) * 40,
          y: cy + (Math.random() - 0.5) * 40,
          vx: 0,
          vy: 0,
        });
      }
    }
    this._nodes = next;
    this._edges = edges;
    if (this._mode === 'focus' && !this._nodes.has(this._focus)) {
      this._focus = seeds[0] || null;
    }
  }

  /* ── Физика ──────────────────────────────── */

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

    // гравитация к центру + интегрирование. Границами НЕ ограничиваем —
    // узлы свободно расходятся, за край видно панорамированием/зумом.
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

  /* ── Отрисовка полотна ───────────────────── */

  draw() {
    const c = this.ctx;
    if (!c) return;
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.clearRect(0, 0, this._w, this._h);

    if (!this._nodes.size) {
      c.fillStyle = 'rgba(160,168,184,0.8)';
      c.font = '14px sans-serif';
      c.textAlign = 'center';
      c.fillText('Связей не найдено', this._w / 2, this._h / 2);
      return;
    }

    // Применяем пан/зум: рисуем в «мировых» координатах.
    c.setTransform(this._zoom, 0, 0, this._zoom, this._ox, this._oy);
    for (const e of this._edges) {
      const p = this._nodes.get(e.src);
      const q = this._nodes.get(e.dst);
      if (!p || !q) continue;
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
    };
  }

  edgeStyle(e) {
    const col = this._colors;
    if (e.kind === 'manual') return { color: C_MANUAL, dash: [5, 4], arrow: false, strong: false };
    if (this._focus && e.src === this._focus) return { color: col.dep, dash: [], arrow: true, strong: true };
    if (this._focus && e.dst === this._focus) return { color: col.back, dash: [], arrow: true, strong: true };
    if (e.kind === 'mention') return { color: C_MENTION, dash: [2, 4], arrow: true, strong: false };
    return { color: C_CTX, dash: [], arrow: true, strong: false };
  }

  drawEdge(c, p, q, e) {
    const st = this.edgeStyle(e);
    c.strokeStyle = st.color;
    c.fillStyle = st.color;
    c.lineWidth = st.strong ? 2 : 1.2;
    c.setLineDash(st.dash);
    c.beginPath();
    c.moveTo(p.x, p.y);
    c.lineTo(q.x, q.y);
    c.stroke();
    c.setLineDash([]);
    if (st.arrow) {
      const ang = Math.atan2(q.y - p.y, q.x - p.x);
      const tx = q.x - Math.cos(ang) * (NODE_R + 2);
      const ty = q.y - Math.sin(ang) * (NODE_R + 2);
      const a1 = ang + Math.PI - 0.4;
      const a2 = ang + Math.PI + 0.4;
      c.beginPath();
      c.moveTo(tx, ty);
      c.lineTo(tx + Math.cos(a1) * 8, ty + Math.sin(a1) * 8);
      c.lineTo(tx + Math.cos(a2) * 8, ty + Math.sin(a2) * 8);
      c.closePath();
      c.fill();
    }
  }

  drawNode(c, n) {
    const isFocus = n.path === this._focus;
    const isLinkSel = this._linkSel === n.path;
    c.beginPath();
    c.arc(n.x, n.y, isFocus ? NODE_R + 2 : NODE_R, 0, Math.PI * 2);
    c.fillStyle = n.isDir ? this._colors.folder : this._colors.file;
    c.fill();
    if (isFocus || isLinkSel) {
      c.lineWidth = 2.5;
      c.strokeStyle = isLinkSel ? this._colors.dep : '#e6e8ee';
      c.stroke();
    }
    c.fillStyle = 'rgba(220,225,235,0.88)';
    c.font = isFocus ? 'bold 11px sans-serif' : '11px sans-serif';
    c.textAlign = 'center';
    c.fillText(shortLabel(n.name), n.x, n.y + NODE_R + 13);
  }

  /* ── Боковые списки ──────────────────────── */

  renderAside() {
    if (!this.aside) return;
    const focus = this._focus;
    if (!focus) {
      this.aside.innerHTML = `<div class="graph__empty">Кликните узел, чтобы увидеть его зависимости и обратные ссылки.</div>`;
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
    const title = fnode ? fnode.name : focus.split(/[\\/]/).pop();
    this.aside.innerHTML = `
      <div class="graph__focus" title="${escapeHtml(focus)}">${escapeHtml(title)}</div>
      ${this.listBlock('Зависимости', deps, 'dep')}
      ${this.listBlock('Обратные ссылки', backs, 'back')}
      ${manual.length ? this.listBlock('Ручные связи', manual, 'manual') : ''}
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
            const name = node ? node.name : p.split(/[\\/]/).pop() || p;
            return `<li class="graph__item graph__item--${cls}" data-reveal="${escapeHtml(p)}" title="${escapeHtml(p)}">${escapeHtml(name)}</li>`;
          })
          .join('')
      : `<li class="graph__item graph__item--empty">—</li>`;
    return `<div class="graph__group"><div class="graph__group-title">${escapeHtml(title)} <span class="graph__count">${uniq.length}</span></div><ul class="graph__list">${items}</ul></div>`;
  }

  /* ── Разметка окна + события ─────────────── */

  render() {
    this._open = true;
    this.mount.innerHTML = `
      <div class="graph graph--window">
        <div class="graph__head" data-drag>
          <div class="graph__title">Граф связей</div>
          <div class="graph__legend">
            <span class="graph__dot" style="background:${this._colors.dep}"></span>зависимости
            <span class="graph__dot" style="background:${this._colors.back}"></span>обратные ссылки
          </div>
          <button class="graph__link-toggle" data-link title="Режим ручного связывания">🔗 связать</button>
          <button class="graph__close" data-close title="Закрыть">×</button>
        </div>
        <div class="graph__body">
          <div class="graph__canvas-wrap">
            <canvas class="graph__canvas"></canvas>
          </div>
          <aside class="graph__aside"></aside>
        </div>
      </div>`;
    this.win = this.mount.querySelector('.graph');
    this.canvas = this.mount.querySelector('.graph__canvas');
    this.ctx = this.canvas.getContext('2d');
    this.aside = this.mount.querySelector('.graph__aside');

    this.mount
      .querySelectorAll('[data-close]')
      .forEach((el) => el.addEventListener('click', () => this.close()));
    this.linkBtn = this.mount.querySelector('[data-link]');
    this.linkBtn.addEventListener('click', () => this.toggleLinkMode());

    const head = this.mount.querySelector('[data-drag]');
    head.addEventListener('mousedown', (e) => this.onHeadDown(e));

    this.canvas.addEventListener('mousedown', (e) => this.onCanvasDown(e));
    this.canvas.addEventListener('click', (e) => this.onClick(e));
    this.canvas.addEventListener('dblclick', (e) => this.onDblClick(e));
    this.canvas.addEventListener('wheel', (e) => this.onWheel(e), { passive: false });

    // Центрируем окно и подгоняем полотно под его размер.
    this.centerWindow();
    this.resizeCanvas();
    if (typeof ResizeObserver !== 'undefined') {
      this._ro = new ResizeObserver(() => this.resizeCanvas());
      this._ro.observe(this.canvas.parentElement);
    }
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

  toggleLinkMode() {
    this._linkMode = !this._linkMode;
    this._linkSel = null;
    this.linkBtn.classList.toggle('is-active', this._linkMode);
    this.draw();
  }

  /* ── Перетаскивание окна / панорамирование / зум ── */

  onHeadDown(e) {
    if (e.target.closest('button')) return; // клики по кнопкам — не drag
    this._winDrag = { x: e.clientX, y: e.clientY, left: this.win.offsetLeft, top: this.win.offsetTop };
    e.preventDefault();
  }

  onCanvasDown(e) {
    if (this._linkMode) return; // в режиме связывания клик выбирает узлы
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
    this._ox = sx - wx * z; // точка под курсором остаётся на месте
    this._oy = sy - wy * z;
    this.draw();
  }

  /* ── Координаты и попадание ──────────────── */

  // Координаты события в пикселях полотна (с учётом возможного масштаба CSS).
  canvasPoint(e) {
    const rect = this.canvas.getBoundingClientRect();
    const sx = ((e.clientX - rect.left) / rect.width) * this._w;
    const sy = ((e.clientY - rect.top) / rect.height) * this._h;
    return [sx, sy];
  }

  nodeAt(e) {
    const [sx, sy] = this.canvasPoint(e);
    const wx = (sx - this._ox) / this._zoom; // экран -> мир
    const wy = (sy - this._oy) / this._zoom;
    const tol = NODE_R + 7;
    let best = null;
    let bd = tol * tol;
    for (const n of this._nodes.values()) {
      const dx = n.x - wx;
      const dy = n.y - wy;
      const d2 = dx * dx + dy * dy;
      if (d2 <= bd) {
        bd = d2;
        best = n;
      }
    }
    return best;
  }

  async onClick(e) {
    if (this._moved) {
      this._moved = false; // это было панорамирование, не клик
      return;
    }
    const node = this.nodeAt(e);
    if (!node) return;
    if (this._linkMode) {
      await this.handleLink(node.path);
      return;
    }
    this._mode = 'focus';
    this._focus = node.path;
    this.fetch([node.path], 1);
  }

  onDblClick(e) {
    const node = this.nodeAt(e);
    if (node) {
      this.bus.emit('graph:reveal', { path: node.path });
      this.close();
    } else {
      // двойной клик по пустому месту — сброс вида
      this._ox = 0;
      this._oy = 0;
      this._zoom = 1;
      this.draw();
    }
  }

  async handleLink(path) {
    if (!this._linkSel) {
      this._linkSel = path;
      this.draw();
      return;
    }
    if (this._linkSel === path) {
      this._linkSel = null;
      this.draw();
      return;
    }
    const a = this._linkSel;
    const b = path;
    const exists = this._edges.some(
      (e) => e.kind === 'manual' && ((e.src === a && e.dst === b) || (e.src === b && e.dst === a)),
    );
    try {
      if (exists) await removeRelationship(a, b);
      else await addRelationship(a, b);
    } catch (err) {
      this.bus.emit('shortcut:hint', err.message);
    }
    this._linkSel = null;
    this.refetch();
  }
}
