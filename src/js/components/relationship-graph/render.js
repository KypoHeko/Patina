// RelationshipGraph — the window shell, canvas sizing, status overlays, and the
// canvas draw pass. Mixed into RelationshipGraph.prototype.

import { escapeHtml } from '../../core/dom.js';
import { t } from '../../lib/i18n.js';
import {
  MAX_DEPTH, MAX_NODES,
  C_CENTER, C_FOLDER, C_FILE, C_DEP, C_RING, C_SPOKE,
  extColor,
} from './constants.js';

export const RenderMixin = {
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
  },

  centerWindow() {
    const r = this.win.getBoundingClientRect();
    this.win.style.left = `${Math.max(8, Math.round((window.innerWidth - r.width) / 2))}px`;
    this.win.style.top = `${Math.max(8, Math.round((window.innerHeight - r.height) / 2))}px`;
  },

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
  },

  setLoading(on) {
    if (this._loadingEl) this._loadingEl.hidden = !on;
  },

  updateLimits() {
    if (!this._limitsEl) return;
    const c = this._counts;
    const cap = `${t('graph.limits') || 'scan limits'} — depth ${MAX_DEPTH} · files ${MAX_NODES.toLocaleString()}`;
    const now = `${t('graph.current') || 'current'} — depth ${c.depth} · files ${c.files}${c.truncated ? ' · ' + (t('graph.truncated') || 'truncated') : ''}`;
    this._limitsEl.textContent = `${cap}\n${now}`;
  },

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
  },
};
