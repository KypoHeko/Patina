// Срез вкладок. Каждая вкладка — рабочее пространство со своей парой
// панелей (left + right) и собственной историей навигации в каждой.
// Раскол (split) — свойство вкладки: разные вкладки могут быть в разном
// состоянии.

import { folderName } from '../lib/paths.js';
import { TAGS } from '../config/tags.js';

function sideName(path) {
  const p = path || '';
  if (p.startsWith('tag:')) {
    const t = TAGS.find((x) => x.id === p.slice(4));
    return t ? t.label : p.slice(4);
  }
  return folderName(p) || '—';
}

let _seq = 0;
const _closed = []; // снимки закрытых вкладок для повторного открытия

function makePane(path = '') {
  return {
    path,
    entries: [],
    selected: [],
    loading: false,
    error: null,
    history: [],
    historyIndex: -1,
  };
}

function makeTab(homePath = '') {
  _seq += 1;
  return {
    id: `tab-${_seq}`,
    split: false,
    activeSide: 'left',
    color: null, // {from, to} — градиент слева направо (на будущее)
    panes: { left: makePane(homePath), right: makePane('') },
  };
}

export function initialTabsState() {
  const tab = makeTab(''); // путь подставим в boot, после homeDir()
  return { tabs: [tab], activeTabId: tab.id };
}

/* ── Селекторы ─────────────────────────────── */

export function getActiveTab(state) {
  return state.tabs.find((t) => t.id === state.activeTabId);
}

export function getActiveSide(state) {
  return getActiveTab(state).activeSide;
}

export function tabTitle(tab) {
  const left = sideName(tab.panes.left.path);
  if (!tab.split) return left;
  return `${left} / ${sideName(tab.panes.right.path)}`;
}

/* ── Действия: вкладки ─────────────────────── */

export function createTab(store) {
  store.setState((state) => {
    const tab = makeTab(state.homePath);
    return { tabs: [...state.tabs, tab], activeTabId: tab.id };
  });
}

export function switchTab(store, id) {
  if (store.getState().activeTabId !== id) store.setState({ activeTabId: id });
}

export function closeTab(store, id) {
  const t0 = store.getState().tabs.find((t) => t.id === id);
  if (t0) {
    _closed.push({
      split: t0.split,
      leftPath: t0.panes.left.path,
      rightPath: t0.panes.right.path,
      activeSide: t0.activeSide,
    });
    if (_closed.length > 10) _closed.shift();
  }
  store.setState((state) => {
    const idx = state.tabs.findIndex((t) => t.id === id);
    if (idx === -1) return {};

    let tabs = state.tabs.filter((t) => t.id !== id);
    let activeTabId = state.activeTabId;

    if (tabs.length === 0) {
      const fresh = makeTab(state.homePath);
      tabs = [fresh];
      activeTabId = fresh.id;
    } else if (activeTabId === id) {
      activeTabId = tabs[Math.min(idx, tabs.length - 1)].id;
    }
    return { tabs, activeTabId };
  });
}

/** Открыть последнюю закрытую вкладку (с её панелями). */
export function reopenTab(store) {
  store.setState((state) => {
    const snap = _closed.pop();
    if (!snap) return {};
    const tab = makeTab('');
    tab.panes.left.path = snap.leftPath || state.homePath;
    if (snap.split) {
      tab.split = true;
      tab.panes.right.path = snap.rightPath || state.homePath;
    }
    tab.activeSide = snap.activeSide || 'left';
    return { tabs: [...state.tabs, tab], activeTabId: tab.id };
  });
}

/** Переставить вкладку в конец. */
export function moveTabEnd(store, id) {
  store.setState((state) => {
    const tabs = [...state.tabs];
    const i = tabs.findIndex((t) => t.id === id);
    if (i === -1) return {};
    const [m] = tabs.splice(i, 1);
    tabs.push(m);
    return { tabs };
  });
}

export function setTabColor(store, id, color) {
  store.setState((state) => ({
    tabs: state.tabs.map((t) => (t.id === id ? { ...t, color } : t)),
  }));
}

/* ── Действия: раскол активной вкладки ─────── */

// Разделить: включить вторую панель с той же папкой, что слева
// (historyIndex == -1 → правая панель сама догрузит её).
export function splitTab(store) {
  store.setState((state) => ({
    tabs: state.tabs.map((t) => {
      if (t.id !== state.activeTabId || t.split) return t;
      return { ...t, split: true, panes: { ...t.panes, right: makePane(t.panes.left.path) } };
    }),
  }));
}

// Закрыть правую половину: вернуть вкладку к одной панели, сбросить правую,
// активной сделать левую.
export function closeSplit(store, side = 'right') {
  store.setState((state) => ({
    tabs: state.tabs.map((t) => {
      if (t.id !== state.activeTabId || !t.split) return t;
      if (side === 'left') {
        // закрываем левую — правая остаётся и становится единственной
        return { ...t, split: false, activeSide: 'left', panes: { left: t.panes.right, right: makePane('') } };
      }
      return { ...t, split: false, activeSide: 'left', panes: { ...t.panes, right: makePane('') } };
    }),
  }));
}

/** Переставить вкладку fromId непосредственно перед toId. */
export function moveTab(store, fromId, toId) {
  if (fromId === toId) return;
  store.setState((state) => {
    const tabs = [...state.tabs];
    const from = tabs.findIndex((t) => t.id === fromId);
    if (from === -1) return {};
    const [moved] = tabs.splice(from, 1);
    let to = tabs.findIndex((t) => t.id === toId);
    if (to === -1) to = tabs.length;
    tabs.splice(to, 0, moved);
    return { tabs };
  });
}
