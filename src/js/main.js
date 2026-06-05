import { createStore } from './core/store.js';
import { createEventBus } from './core/event-bus.js';
import { createShortcuts } from './core/shortcuts.js';
import { KEYMAP } from './config/keymap.js';
import { initialTabsState, createTab, closeTab, reopenTab, getActiveTab } from './state/tabs.js';
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
import { VersionHistory } from './components/version-history.js';
import { RelationshipGraph } from './components/relationship-graph.js';
import { ConfirmDialog } from './components/confirm-dialog.js';
import { PreviewPanel } from './components/preview-panel.js';
import { Divider } from './components/divider.js';
import { homeDir } from './api/fs.js';

const store = createStore({ ...initialTabsState(), ...initialUiState() });
const bus = createEventBus();

const workspace = document.querySelector('.workspace');

const sidebar = new Sidebar({ mount: document.getElementById('sidebar'), store, bus });
const tabBar = new TabBar({ mount: document.getElementById('tab-bar'), store, bus });
const left = new FilePanel({ mount: document.getElementById('pane-left'), store, bus, side: 'left' });
const right = new FilePanel({ mount: document.getElementById('pane-right'), store, bus, side: 'right' });
const statusBar = new StatusBar({ mount: document.getElementById('statusbar'), store, bus });
const contextMenu = new ContextMenu({ mount: document.getElementById('context-menu-root'), store, bus });
const palette = new CommandPalette({ mount: document.getElementById('palette-root'), store, bus });
const duplicates = new DuplicatePanel({ mount: document.getElementById('duplicate-root'), store, bus });
const versionHistory = new VersionHistory({ mount: document.getElementById('versions-root'), store, bus });
const graph = new RelationshipGraph({ mount: document.getElementById('graph-root'), store, bus });
const confirmDialog = new ConfirmDialog({ mount: document.getElementById('confirm-root'), store, bus });
const preview = new PreviewPanel({ mount: document.getElementById('preview-root'), store, bus });
const divider = new Divider({ mount: document.getElementById('divider'), store, bus, workspace });

sidebar.init();
tabBar.init();
left.init();
right.init();
statusBar.init();
contextMenu.init();
palette.init();
duplicates.init();
versionHistory.init();
graph.init();
confirmDialog.init();
preview.init();
divider.init();

document.getElementById('preview-btn').addEventListener('click', () => bus.emit('preview:toggle'));

const searchInput = document.getElementById('topbar-search');
searchInput.addEventListener('input', () => store.setState({ searchQuery: searchInput.value }));

document.getElementById('duplicates-btn').addEventListener('click', () => bus.emit('duplicates:open'));
document.getElementById('graph-btn').addEventListener('click', () => bus.emit('graph:open'));

const collapseBtn = document.getElementById('collapse-sidebar-btn');
collapseBtn.addEventListener('click', () => {
  const on = document.getElementById('app').classList.toggle('sidebar-compact');
  collapseBtn.classList.toggle('is-on', on);
});

const tabColorsBtn = document.getElementById('tabcolors-btn');
tabColorsBtn.addEventListener('click', () => {
  const on = store.getState().tabColors === false; // было выкл -> включаем
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

(async function boot() {
  try {
    const home = await homeDir();
    store.setState({ homePath: home });
    left.navigate(home);
  } catch (err) {
    console.error('[patina] не удалось определить домашнюю папку:', err);
  }
})();

// --- Живой индекс: авто-обновление при внешних изменениях файлов ---
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
