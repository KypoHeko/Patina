import { Component } from '../core/component.js';
import { el } from '../core/dom.js';
import { tabTitle, createTab, closeTab, switchTab, moveTab, moveTabEnd } from '../state/tabs.js';
import { pathToColor, textColorFor } from '../lib/path-color.js';
import { folderName } from '../lib/paths.js';
import { TAGS } from '../config/tags.js';
import { t, tagLabel } from '../lib/i18n.js';

const TAG_BY_ID = Object.fromEntries(TAGS.map((t) => [t.id, t]));
const DEFAULT_TAB_COLOR = '#3a3a48';

// Info for one side of a tab: background color, tag color dot, label.
function sideInfo(pane) {
  const p = pane.path || '';
  if (p.startsWith('tag:')) {
    const tag = TAG_BY_ID[p.slice(4)];
    return { color: DEFAULT_TAB_COLOR, dot: tag ? tag.color : null, label: tag ? tagLabel(tag.id) : p.slice(4) };
  }
  return { color: pathToColor(p), dot: null, label: folderName(p) || '—' };
}

// Tab strip. A tab's color is derived from its folder path; when split —
// a left-to-right gradient of two colors. Text color is chosen by brightness.
function appendSide(container, info) {
  if (info.dot) {
    container.append(
      el('span', {
        class: 'tab__tagdot',
        style: `display:inline-block;width:8px;height:8px;border-radius:50%;margin-right:5px;vertical-align:middle;background:${info.dot}`,
      }),
    );
  }
  container.append(document.createTextNode(info.label));
}

export class TabBar extends Component {
  init() {
    this._sig = null;
    this.on(this.mount, 'click', (e) => this.onClick(e));
    this.on(this.mount, 'dragstart', (e) => this.onDragStart(e));
    this.on(this.mount, 'dragover', (e) => this.onDragOver(e));
    this.on(this.mount, 'drop', (e) => this.onDrop(e));
    this.on(this.mount, 'dragend', () => this.endDrag());
    this.subscribe((state) => this.maybeRender(state));
    this.render(this.store.getState());
  }

  maybeRender(state) {
    const sig = state.tabs
      .map((t) => {
        const lp = t.panes.left.path;
        const rp = t.split ? t.panes.right.path : '';
        return `${t.id}|${tabTitle(t)}|${t.id === state.activeTabId ? 1 : 0}|${lp}|${rp}`;
      })
      .join('::') + `|c${state.tabColors === false ? 0 : 1}`;
    if (sig === this._sig) return;
    this._sig = sig;
    this.render(state);
  }

  /** Re-render on language change: reset the signature so maybeRender fires. */
  applyLang() {
    this._sig = null;
    this.maybeRender(this.store.getState());
  }

  render(state) {
    this.mount.innerHTML = '';
    const list = el('div', { class: 'tabs' });

    for (const tab of state.tabs) {
      const active = tab.id === state.activeTabId;
      const title = tabTitle(tab);
      const li = sideInfo(tab.panes.left);
      const ri = tab.split ? sideInfo(tab.panes.right) : null;
      const colorsOn = state.tabColors !== false;
      const item = el('div', {
        class: 'tab' + (active ? ' is-active' : ''),
        draggable: 'true',
        dataset: { tab: tab.id },
        title,
      });
      if (colorsOn) {
        const from = li.color;
        const to = ri ? ri.color : li.color;
        const txt = textColorFor(from, to);
        item.style.background = `linear-gradient(to right, ${from}, ${to})`;
        item.style.color = txt;
        item.style.opacity = active ? '1' : '0.72';
        if (txt !== '#0a0a0f') item.style.textShadow = '0 1px 2px rgba(0,0,0,0.45)';
      }

      const titleEl = el('span', { class: 'tab__title' });
      appendSide(titleEl, li);
      if (ri) {
        titleEl.append(document.createTextNode(' / '));
        appendSide(titleEl, ri);
      }
      item.append(titleEl);
      item.append(
        el('button', { class: 'tab__close', dataset: { close: tab.id }, title: t('tab.close') }, '×'),
      );
      list.append(item);
    }

    list.append(el('button', { class: 'tab-add', 'data-add': '', title: t('tab.new') }, '+'));
    this.mount.append(list);
  }

  onDragStart(e) {
    const tab = e.target.closest('[data-tab]');
    if (!tab) return;
    this._dragId = tab.dataset.tab;
    this._dropTarget = null;
    e.dataTransfer.effectAllowed = 'move';
    tab.classList.add('is-dragging');
  }

  onDragOver(e) {
    if (!this._dragId) return;
    e.preventDefault(); // the whole tab strip is a drop zone
    this.clearIndicators();
    const overTab = e.target.closest('[data-tab]');
    if (overTab && overTab.dataset.tab !== this._dragId) {
      overTab.classList.add('is-drop-before');
      this._dropTarget = overTab.dataset.tab;
    } else if (e.target.closest('[data-add]') || !overTab) {
      const add = this.mount.querySelector('[data-add]');
      if (add) add.classList.add('is-drop-end');
      this._dropTarget = '__end__';
    } else {
      this._dropTarget = null; // over the dragged tab itself
    }
  }

  onDrop(e) {
    if (!this._dragId) return;
    e.preventDefault();
    if (this._dropTarget === '__end__') moveTabEnd(this.store, this._dragId);
    else if (this._dropTarget) moveTab(this.store, this._dragId, this._dropTarget);
    this.endDrag();
  }

  endDrag() {
    this.clearIndicators();
    this.mount.querySelectorAll('.is-dragging').forEach((el) => el.classList.remove('is-dragging'));
    this._dragId = null;
    this._dropTarget = null;
  }

  clearIndicators() {
    this.mount.querySelectorAll('.is-drop-before').forEach((el) => el.classList.remove('is-drop-before'));
    const add = this.mount.querySelector('.is-drop-end');
    if (add) add.classList.remove('is-drop-end');
  }

  onClick(e) {
    const close = e.target.closest('[data-close]');
    if (close) return closeTab(this.store, close.dataset.close);
    if (e.target.closest('[data-add]')) return createTab(this.store);
    const tab = e.target.closest('[data-tab]');
    if (tab) switchTab(this.store, tab.dataset.tab);
  }
}
