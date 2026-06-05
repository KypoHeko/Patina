import { Component } from '../core/component.js';
import { escapeHtml } from '../core/dom.js';
import { fileGraph, addRelationship, removeRelationship } from '../api/relationships.js';
import { startIndex } from '../api/indexing.js';
import { onEvent } from '../api/events.js';
import { getPane } from '../state/panes.js';
import { getActiveSide } from '../state/tabs.js';

const W = 600;
const H = 540;
const NODE_R = 8;
const OVERVIEW_CAP = 80; // не строим полотно из тысяч узлов

// Физика (подобрана под десятки узлов)
const REPULSION = 5400; // кулоновское отталкивание
const SPRING_LEN = 96; // длина покоя ребра
const SPRING_K = 0.016; // жёсткость пружины
const GRAVITY = 0.014; // притяжение к центру (держит отвязанные узлы)
const DAMPING = 0.86;
const ALPHA_MIN = 0.02;

const C_DEP = '#10b981'; // зависимости (исходящие от фокуса) — emerald
const C_BACK = '#f59e0b'; // обратные ссылки (входящие в фокус) — amber
const C_MANUAL = 'rgba(150,158,176,0.75)';
const C_CTX = 'rgba(120,130,150,0.5)';
const C_MENTION = 'rgba(120,130,150,0.3)';

function shortLabel(name) {
  return name.length > 18 ? name.slice(0, 17) + '…' : name;
}

// Граф связей (Ctrl+G). Если в активной панели есть выделение — режим «фокус»:
// показываем зависимости (исходящие) и обратные ссылки (входящие) выбранного
// файла. Иначе — обзор всей папки. Узлы раскладываются силовым алгоритмом.
// Один клик по узлу — сделать его фокусом; двойной — показать файл в панели.
export class RelationshipGraph extends Component {
  init() {
    this._open = false;
    this._side = 'left';
    this._root = '';
    this._mode = 'overview'; // 'focus' | 'overview'
    this._focus = null; // путь узла в фокусе (для боковых списков)
    this._linkMode = false; // режим создания ручных связей
    this._linkSel = null; // первый выбранный узел в режиме связывания

    this._nodes = new Map(); // path -> { path, name, isDir, x, y, vx, vy }
    this._edges = []; // { src, dst, kind }
    this._curSeeds = [];
    this._curHops = 1;

    this._raf = null;
    this._alpha = 0;
    this._fetchSeq = 0;

    // Цвета берём из CSS-токенов, чтобы граф следовал текущей палитре.
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

    // Рёбра строятся в фоне при индексации. Если граф открыт и индекс
    // достроился — обновляем картину. onEvent отдаёт промис с функцией отписки.
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
    this.render();

    // Гарантируем, что контент проиндексирован и рёбра построены (идемпотентно).
    if (this._root) startIndex(this._root, true, false).catch(() => {});
    this.fetch(seeds, 1);
  }

  close() {
    if (!this._open) return;
    this._open = false;
    this.stopSim();
    this.mount.innerHTML = '';
  }

  destroy() {
    this.stopSim();
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
    if (seq !== this._fetchSeq || !this._open) return; // устаревший ответ
    this.ingest(data, seeds);
    this.renderAside();
    this.startSim();
  }

  // Построить узлы/рёбра, сохраняя позиции уже существующих (плавный переход).
  ingest(data, seeds) {
    const nodes = (data && data.nodes) || [];
    const edges = (data && data.edges) || [];
    const cx = W / 2;
    const cy = H / 2;
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
    // seed без рёбер всё равно должен быть на полотне
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
    if (this._raf) return; // цикл уже крутится
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
    const cx = W / 2;
    const cy = H / 2;
    const a = this._alpha;

    // отталкивание (все пары)
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

    // пружины (рёбра)
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

    // гравитация к центру + интегрирование
    for (const p of nodes) {
      p.vx += (cx - p.x) * GRAVITY * a;
      p.vy += (cy - p.y) * GRAVITY * a;
      p.vx *= DAMPING;
      p.vy *= DAMPING;
      // фокус удерживаем в центре в режиме «фокус»
      if (this._mode === 'focus' && p.path === this._focus) {
        p.x = cx;
        p.y = cy;
        p.vx = 0;
        p.vy = 0;
        continue;
      }
      p.x += p.vx;
      p.y += p.vy;
      const m = NODE_R + 14;
      p.x = Math.max(m, Math.min(W - m, p.x));
      p.y = Math.max(m, Math.min(H - m, p.y));
    }
  }

  /* ── Отрисовка полотна ───────────────────── */

  draw() {
    const c = this.ctx;
    if (!c) return;
    c.clearRect(0, 0, W, H);

    for (const e of this._edges) {
      const p = this._nodes.get(e.src);
      const q = this._nodes.get(e.dst);
      if (!p || !q) continue;
      this.drawEdge(c, p, q, e);
    }

    for (const n of this._nodes.values()) this.drawNode(c, n);

    if (!this._nodes.size) {
      c.fillStyle = 'rgba(160,168,184,0.8)';
      c.font = '14px sans-serif';
      c.textAlign = 'center';
      c.fillText('Связей не найдено', W / 2, H / 2);
    }
  }

  // Цвета графа из CSS-токенов текущей палитры (с фолбэком на изумруд).
  readColors() {
    const cs = getComputedStyle(document.documentElement);
    const v = (name, fb) => cs.getPropertyValue(name).trim() || fb;
    return {
      dep: v('--accent', C_DEP), // зависимости (исходящие)
      back: v('--tag-progress', C_BACK), // обратные ссылки (входящие)
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

  /* ── Боковые списки (зависимости / обратные ссылки) ── */

  renderAside() {
    if (!this.aside) return;
    const focus = this._focus;
    if (!focus) {
      this.aside.innerHTML = `<div class="graph__empty">Кликните узел, чтобы увидеть его зависимости и обратные ссылки.</div>`;
      return;
    }
    const fnode = this._nodes.get(focus);
    const deps = []; // исходящие (зависимости)
    const backs = []; // входящие (обратные ссылки)
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

  /* ── Разметка модалки + события ──────────── */

  render() {
    this._open = true;
    this.mount.innerHTML = `
      <div class="graph__backdrop" data-close></div>
      <div class="graph">
        <div class="graph__head">
          <div class="graph__title">Граф связей</div>
          <div class="graph__legend">
            <span class="graph__dot" style="background:${this._colors.dep}"></span>зависимости
            <span class="graph__dot" style="background:${this._colors.back}"></span>обратные ссылки
          </div>
          <button class="graph__link-toggle" data-link title="Режим ручного связывания">🔗 связать</button>
          <button class="graph__close" data-close title="Закрыть">×</button>
        </div>
        <div class="graph__body">
          <canvas class="graph__canvas" width="${W}" height="${H}"></canvas>
          <aside class="graph__aside"></aside>
        </div>
      </div>`;
    this.canvas = this.mount.querySelector('.graph__canvas');
    this.ctx = this.canvas.getContext('2d');
    this.aside = this.mount.querySelector('.graph__aside');

    this.mount
      .querySelectorAll('[data-close]')
      .forEach((el) => el.addEventListener('click', () => this.close()));
    this.linkBtn = this.mount.querySelector('[data-link]');
    this.linkBtn.addEventListener('click', () => this.toggleLinkMode());
    this.canvas.addEventListener('click', (e) => this.onClick(e));
    this.canvas.addEventListener('dblclick', (e) => this.onDblClick(e));
  }

  toggleLinkMode() {
    this._linkMode = !this._linkMode;
    this._linkSel = null;
    this.linkBtn.classList.toggle('is-active', this._linkMode);
    this.draw();
  }

  nodeAt(e) {
    const rect = this.canvas.getBoundingClientRect();
    const x = ((e.clientX - rect.left) / rect.width) * W;
    const y = ((e.clientY - rect.top) / rect.height) * H;
    let best = null;
    let bd = (NODE_R + 7) * (NODE_R + 7);
    for (const n of this._nodes.values()) {
      const dx = n.x - x;
      const dy = n.y - y;
      const d2 = dx * dx + dy * dy;
      if (d2 <= bd) {
        bd = d2;
        best = n;
      }
    }
    return best;
  }

  async onClick(e) {
    const node = this.nodeAt(e);
    if (!node) return;
    if (this._linkMode) {
      await this.handleLink(node.path);
      return;
    }
    // обычный клик — сделать узел фокусом и перестроить вокруг него
    this._mode = 'focus';
    this._focus = node.path;
    this.fetch([node.path], 1);
  }

  onDblClick(e) {
    const node = this.nodeAt(e);
    if (!node) return;
    this.bus.emit('graph:reveal', { path: node.path });
    this.close();
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
