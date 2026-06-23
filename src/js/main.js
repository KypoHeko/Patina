import { createStore } from './core/store.js';
import { createEventBus } from './core/event-bus.js';
import { createShortcuts } from './core/shortcuts.js';
import { KEYMAP } from './config/keymap.js';
import {
  initialTabsState, createTab, closeTab, reopenTab, getActiveTab, getActiveSide,
  loadSavedTabs, restoreTabs, saveTabs,
} from './state/tabs.js';
import { setWatch } from './api/system.js';
import { onEvent } from './api/events.js';
import { initialUiState, getSplitRatio } from './state/ui.js';
import { TabBar } from './components/tab-bar.js';
import { Sidebar } from './components/sidebar.js';
import { FilePanel } from './components/file-panel.js';
import { StatusBar } from './components/status-bar.js';
import { ContextMenu } from './components/context-menu.js';
import { CommandPalette } from './components/command-palette.js';
import { DuplicatePanel } from './components/duplicate-panel.js';
import { RelationshipGraph } from './components/relationship-graph.js';
import { ConfirmDialog } from './components/confirm-dialog.js';
import { PreviewPanel } from './components/preview-panel.js';
import { Divider } from './components/divider.js';
import { ThemeMenu } from './components/theme-menu.js';
import { homeDir } from './api/fs.js';
import { initTheme } from './lib/theme.js';
import { initLang, getLang, setLang, t } from './lib/i18n.js';

const _restored = restoreTabs(loadSavedTabs());
const store = createStore({ ...(_restored || initialTabsState()), ...initialUiState() });
const bus = createEventBus();

// Apply the saved palette before components mount (no theme flicker).
initTheme();
// Pick the language before mounting too — components render in the right language immediately.
initLang();

// Start the homeDir() IPC BEFORE initializing the sidebar — so the fast call
// queues first, ahead of the slow listStorage() / sysinfo.
const _homePromise = homeDir();
const _cachedHome = localStorage.getItem('patina:home');

const workspace = document.querySelector('.workspace');

const sidebar = new Sidebar({ mount: document.getElementById('sidebar'), store, bus });
const tabBar = new TabBar({ mount: document.getElementById('tab-bar'), store, bus });
const left = new FilePanel({ mount: document.getElementById('pane-left'), store, bus, side: 'left' });
const right = new FilePanel({ mount: document.getElementById('pane-right'), store, bus, side: 'right' });
const statusBar = new StatusBar({ mount: document.getElementById('statusbar'), store, bus });
const contextMenu = new ContextMenu({ mount: document.getElementById('context-menu-root'), store, bus });
const palette = new CommandPalette({ mount: document.getElementById('palette-root'), store, bus });
const duplicates = new DuplicatePanel({ mount: document.getElementById('duplicate-root'), store, bus });
const graph = new RelationshipGraph({ mount: document.getElementById('graph-root'), store, bus });
const confirmDialog = new ConfirmDialog({ mount: document.getElementById('confirm-root'), store, bus });
const preview = new PreviewPanel({ mount: document.getElementById('preview-root'), store, bus });
const divider = new Divider({ mount: document.getElementById('divider'), store, bus, workspace });
const themeMenu = new ThemeMenu({ mount: document.getElementById('theme-root'), store, bus });

// Initialize robustly: a failure of one component must not break the wiring
// of the button handlers further down the file.
const components = [
  sidebar, tabBar, left, right, statusBar, contextMenu, palette,
  duplicates, graph, confirmDialog, preview, divider, themeMenu,
];
for (const c of components) {
  try {
    c.init();
  } catch (err) {
    console.error('[patina] component init error:', err);
  }
}

document.getElementById('preview-btn').addEventListener('click', () => bus.emit('preview:toggle'));

const searchInput = document.getElementById('topbar-search');
searchInput.addEventListener('input', () => store.setState({ searchQuery: searchInput.value }));
// On navigation searchQuery is reset programmatically — keep the input in sync.
store.subscribe((state) => {
  if (document.activeElement !== searchInput && searchInput.value !== (state.searchQuery || '')) {
    searchInput.value = state.searchQuery || '';
  }
});

document.getElementById('dirsize-btn').addEventListener('click', () => bus.emit('dirsize:recalc'));
document.getElementById('duplicates-btn').addEventListener('click', () => bus.emit('duplicates:open'));
document.getElementById('graph-btn').addEventListener('click', () => bus.emit('graph:open'));
document.getElementById('theme-btn').addEventListener('click', () => bus.emit('theme:open'));

// --- UI language ---
// Topbar button tooltips and the search placeholder live in the static
// index.html, so we translate them from JS (at startup and on every language change).
function syncTopbar() {
  const titles = {
    'dirsize-btn': 'topbar.dirsize',
    'preview-btn': 'topbar.preview',
    'collapse-sidebar-btn': 'topbar.collapse',
    'duplicates-btn': 'topbar.duplicates',
    'graph-btn': 'topbar.graph',
    'theme-btn': 'topbar.theme',
    'tabcolors-btn': 'topbar.tabcolors',
    'lang-btn': 'topbar.lang',
  };
  for (const [id, key] of Object.entries(titles)) {
    const el = document.getElementById(id);
    if (el) el.title = t(key);
  }
  searchInput.placeholder = t('topbar.search.placeholder');
  searchInput.title = t('topbar.search.title');
  const langBtn = document.getElementById('lang-btn');
  if (langBtn) langBtn.textContent = getLang().toUpperCase();
}

// Language change: translate the topbar, then call applyLang() on each
// component. applyLang() updates only the texts in the DOM in place, preserving
// state (open dialogs, selection, graph focus, inputs, etc.) — unlike
// destroy()+init(), which tore down panels and transient state.
// If a component has no applyLang — we skip it (it needs no re-render).
function applyLanguage() {
  syncTopbar();
  for (const c of components) {
    try {
      if (typeof c.applyLang === 'function') c.applyLang();
    } catch (err) {
      console.error('[patina] re-render error on language change:', err);
    }
  }
  store.setState({}); // in case some store subscriber reads texts
}

document.getElementById('lang-btn').addEventListener('click', () => {
  setLang(getLang() === 'ru' ? 'en' : 'ru');
  applyLanguage();
});

syncTopbar();

const collapseBtn = document.getElementById('collapse-sidebar-btn');
collapseBtn.addEventListener('click', () => {
  const on = document.getElementById('app').classList.toggle('sidebar-compact');
  collapseBtn.classList.toggle('is-on', on);
});

const tabColorsBtn = document.getElementById('tabcolors-btn');
tabColorsBtn.addEventListener('click', () => {
  const on = store.getState().tabColors === false; // was off -> turn on
  store.setState({ tabColors: on });
  tabColorsBtn.classList.toggle('is-on', on);
});

function syncLayout(state) {
  const split = getActiveTab(state).split;
  workspace.classList.toggle('is-split', split);
  if (split) {
    const r = getSplitRatio(state);
    workspace.style.gridTemplateColumns = `${r}fr 8px ${1 - r}fr`;
  } else {
    workspace.style.gridTemplateColumns = '1fr';
  }
}
store.subscribe(syncLayout);
syncLayout(store.getState());

const shortcuts = createShortcuts(KEYMAP);
shortcuts.register('new-tab', () => createTab(store));
shortcuts.register('close-tab', () => closeTab(store, store.getState().activeTabId));
shortcuts.register('command-palette', () => bus.emit('palette:open'));
shortcuts.register('duplicates', () => bus.emit('duplicates:open'));
shortcuts.register('relationship-graph', () => bus.emit('graph:open'));
shortcuts.register('reopen-tab', () => reopenTab(store));
shortcuts.register('new-folder', () => bus.emit('folder:create'));
// Delete key: move the active pane's selection to the Recycle Bin.
// file:delete has no active-side fallback, so pass the side explicitly;
// the handler still routes through the confirm dialog before deleting.
shortcuts.register('delete', () => bus.emit('file:delete', { side: getActiveSide(store.getState()) }));

// --- Startup: show content as fast as possible ---
// _homePromise and _cachedHome are already declared above (before sidebar init).
if (_restored) {
  // Restore the previously open tabs: navigate the active tab's pane(s) now;
  // inactive tabs navigate lazily when first activated.
  const tab = getActiveTab(store.getState());
  if (tab.panes.left.path) left.navigate(tab.panes.left.path);
  if (tab.split && tab.panes.right.path) right.navigate(tab.panes.right.path);
} else if (_cachedHome) {
  // Optimistic startup: show content immediately, without waiting for IPC.
  left.navigate(_cachedHome);
}

(async function boot() {
  try {
    const home = await homeDir();
    store.setState({ homePath: home });
    // Only seed the home folder on a fresh start; a restored session keeps its
    // own saved tabs and paths.
    if (!_restored) left.navigate(home);
  } catch (err) {
    console.error('[patina] could not determine the home folder:', err);
  }
})();

// --- Live index: auto-refresh on external file changes ---
let _watchTimer = null;
let _pendingDirs = new Set();
onEvent('fs:external-change', (dirs) => {
  (dirs || []).forEach((d) => _pendingDirs.add(d));
  if (_watchTimer) return;
  _watchTimer = setTimeout(() => {
    const list = [..._pendingDirs];
    _pendingDirs = new Set();
    _watchTimer = null;
    if (list.length) bus.emit('fs:changed', { dirs: list });
  }, 200);
});

let _watchedKey = '';
store.subscribe((state) => {
  const tab = getActiveTab(state);
  if (!tab) return;
  const dirs = [];
  const candidates = [tab.panes.left.path, tab.split ? tab.panes.right.path : ''];
  for (const path of candidates) {
    if (path && !path.startsWith('tag:') && !dirs.includes(path)) dirs.push(path);
  }
  const key = dirs.join('|');
  if (key === _watchedKey) return;
  _watchedKey = key;
  setWatch(dirs).catch(() => {});
});

// --- Persist open tabs across restarts (debounced) ---
let _saveTabsTimer = null;
store.subscribe((state) => {
  clearTimeout(_saveTabsTimer);
  _saveTabsTimer = setTimeout(() => saveTabs(state), 300);
});
// Flush on close so the last navigation isn't lost inside the debounce window.
window.addEventListener('beforeunload', () => saveTabs(store.getState()));
