// Операции над панелями АКТИВНОЙ вкладки. Сигнатуры селекторов/действий
// те же, что и раньше (getPane(state, side), updatePane(store, side, ...)),
// но теперь под ними — панели активной вкладки. Поэтому компоненты почти
// не изменились: поменялся только источник данных, не API.

import { getActiveTab } from './tabs.js';

// Иммутабельно обновить активную вкладку (остальные вкладки не трогаем —
// их объекты сохраняют ссылки, оптимизация перерисовки продолжает работать).
function updateActiveTab(store, updater) {
  store.setState((state) => ({
    tabs: state.tabs.map((t) => (t.id === state.activeTabId ? updater(t) : t)),
  }));
}

/* ── Селекторы ─────────────────────────────── */

export function getPane(state, side) {
  return getActiveTab(state).panes[side];
}

/* ── Действия ──────────────────────────────── */

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

/** Записать посещённый путь; хвост «вперёд» обрезается (как в браузере). */
export function recordHistory(store, side, path) {
  updateActiveTab(store, (tab) => {
    const pane = tab.panes[side];
    if (pane.history[pane.historyIndex] === path) return tab; // уже здесь
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

/** Сдвинуть позицию в истории; вернуть путь назначения либо null. */
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
