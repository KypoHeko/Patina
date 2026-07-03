// Operations on the panes of the ACTIVE tab. Selector/action signatures are
// the same as before (getPane(state, side), updatePane(store, side, ...)),
// but they now operate on the active tab's panes. So components barely changed:
// only the data source changed, not the API.

import { getActiveTab } from './tabs.js';

// Immutably update the active tab (we leave the other tabs alone — their
// objects keep their references, so the re-render optimization keeps working).
function updateActiveTab(store, updater) {
  store.setState((state) => ({
    tabs: state.tabs.map((t) => (t.id === state.activeTabId ? updater(t) : t)),
  }));
}

/* ── Selectors ─────────────────────────────── */

export function getPane(state, side) {
  return getActiveTab(state).panes[side];
}

/* ── Actions ───────────────────────────────── */

export function updatePane(store, side, patch) {
  updateActiveTab(store, (tab) => ({
    ...tab,
    panes: { ...tab.panes, [side]: { ...tab.panes[side], ...patch } },
  }));
}

export function setActivePane(store, side) {
  const tab = getActiveTab(store.getState());
  if (tab.activeSide === side) return;
  updateActiveTab(store, (t) => ({ ...t, activeSide: side }));
}

export function selectInPane(store, side, paths) {
  updatePane(store, side, { selected: paths });
}

/** Record a visited path; the "forward" tail is truncated (as in a browser). */
export function recordHistory(store, side, path) {
  updateActiveTab(store, (tab) => {
    const pane = tab.panes[side];
    if (pane.history[pane.historyIndex] === path) return tab; // already here
    const history = pane.history.slice(0, pane.historyIndex + 1);
    history.push(path);
    return {
      ...tab,
      panes: {
        ...tab.panes,
        [side]: { ...pane, history, historyIndex: history.length - 1 },
      },
    };
  });
}

/** Shift the position in history; return the destination path or null. */
export function stepHistory(store, side, delta) {
  const pane = getActiveTab(store.getState()).panes[side];
  const next = pane.historyIndex + delta;
  if (next < 0 || next >= pane.history.length) return null;
  updateActiveTab(store, (t) => ({
    ...t,
    panes: { ...t.panes, [side]: { ...t.panes[side], historyIndex: next } },
  }));
  return pane.history[next];
}
