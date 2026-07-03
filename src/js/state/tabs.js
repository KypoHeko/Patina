// Tabs slice. Each tab is a workspace with its own pair of panes
// (left + right) and its own navigation history in each.
// Split is a property of the tab: different tabs can be in different states.

import { folderName } from '../lib/paths.js';
import { TAGS } from '../config/tags.js';
import { tagLabel } from '../lib/i18n.js';

function sideName(path) {
  const p = path || '';
  if (p.startsWith('tag:')) {
  const id = p.slice(4);
  return TAGS.some((x) => x.id === id) ? tagLabel(id) : id;
  }
  return folderName(p) || '—';
}

let _seq = 0;
const _closed = []; // snapshots of closed tabs for reopening

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
    color: null, // {from, to} — left-to-right gradient (for the future)
    panes: { left: makePane(homePath), right: makePane('') },
  };
}

export function initialTabsState() {
  const tab = makeTab(''); // path is filled in at boot, after homeDir()
  return { tabs: [tab], activeTabId: tab.id };
}

/* ── Selectors ─────────────────────────────── */

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

/* ── Actions: tabs ─────────────────────────── */

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

/** Reopen the last closed tab (with its panes). */
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

/** Move a tab to the end. */
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

/* ── Actions: split the active tab ─────────── */

// Split: enable the second panel with the same folder as the left one
// (historyIndex == -1 → the right panel loads it itself).
export function splitTab(store) {
  store.setState((state) => ({
    tabs: state.tabs.map((t) => {
      if (t.id !== state.activeTabId || t.split) return t;
      return { ...t, split: true, panes: { ...t.panes, right: makePane(t.panes.left.path) } };
    }),
  }));
}

// Close the right half: return the tab to a single panel, reset the right one,
// make the left one active.
export function closeSplit(store, side = 'right') {
  store.setState((state) => ({
    tabs: state.tabs.map((t) => {
      if (t.id !== state.activeTabId || !t.split) return t;
      if (side === 'left') {
        // closing the left — the right remains and becomes the only one
        return { ...t, split: false, activeSide: 'left', panes: { left: t.panes.right, right: makePane('') } };
      }
      return { ...t, split: false, activeSide: 'left', panes: { ...t.panes, right: makePane('') } };
    }),
  }));
}

/** Move tab fromId to immediately before toId. */
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

/* ── Persistence: keep open tabs across restarts ───────────────────────────
   We store only what is needed to rebuild the workspace — each tab's pane
   paths plus its layout (split / active side / color) and which tab was
   active. Runtime data (entries, history, selection) is intentionally NOT
   persisted; panes re-navigate to their saved path on load. */

const TABS_KEY = 'patina:tabs';
const TABS_VERSION = 1;
const MAX_PERSISTED_TABS = 50;

/** Minimal serializable snapshot of the open tabs. */
export function serializeTabs(state) {
  const tabs = (state.tabs || []).slice(0, MAX_PERSISTED_TABS).map((t) => ({
    l: t.panes.left.path || '',
    r: t.split ? t.panes.right.path || '' : '',
    split: !!t.split,
    side: t.activeSide === 'right' ? 'right' : 'left',
    color: t.color || null,
  }));
  const activeIndex = Math.max(
    0,
    (state.tabs || []).findIndex((t) => t.id === state.activeTabId),
  );
  return { v: TABS_VERSION, activeIndex, tabs };
}

/** Persist the current tabs (best-effort; storage may be unavailable/full). */
export function saveTabs(state) {
  try {
    const data = serializeTabs(state);
    if (!data.tabs.length) return;
    localStorage.setItem(TABS_KEY, JSON.stringify(data));
  } catch {
    /* ignore storage errors */
  }
}

/** Read the saved snapshot, or null if absent/invalid/old. */
export function loadSavedTabs() {
  try {
    const raw = localStorage.getItem(TABS_KEY);
    if (!raw) return null;
    const data = JSON.parse(raw);
    if (!data || data.v !== TABS_VERSION || !Array.isArray(data.tabs) || !data.tabs.length) {
      return null;
    }
    return data;
  } catch {
    return null;
  }
}

/** Rebuild a tabs state ({ tabs, activeTabId }) from a snapshot, or null. */
export function restoreTabs(saved) {
  if (!saved || !Array.isArray(saved.tabs) || !saved.tabs.length) return null;
  const tabs = saved.tabs.slice(0, MAX_PERSISTED_TABS).map((s) => {
    const tab = makeTab('');
    tab.panes.left = makePane(typeof s.l === 'string' ? s.l : '');
    tab.split = !!s.split;
    tab.panes.right = makePane(tab.split && typeof s.r === 'string' ? s.r : '');
    tab.activeSide = s.side === 'right' && tab.split ? 'right' : 'left';
    tab.color = s.color || null;
    return tab;
  });
  const idx = Number.isInteger(saved.activeIndex)
    ? Math.min(Math.max(saved.activeIndex, 0), tabs.length - 1)
    : 0;
  return { tabs, activeTabId: tabs[idx].id };
}
