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
import { RelationshipGraph } from './components/relationship-graph.js';
import { ConfirmDialog } from './components/confirm-dialog.js';
import { PreviewPanel } from './components/preview-panel.js';
import { Divider } from './components/divider.js';
import { ThemeMenu } from './components/theme-menu.js';
import { homeDir } from './api/fs.js';
import { initTheme } from './lib/theme.js';
import { initLang, getLang, setLang, t } from './lib/i18n.js';

const store = createStore({ ...initialTabsState(), ...initialUiState() });
const bus = createEventBus();

// Применяем сохранённую палитру до монтажа компонентов (без мигания темы).
initTheme();
// Язык тоже выбираем до монтажа — компоненты сразу отрисуются на нужном языке.
initLang();

// Стартуем homeDir() IPC ДО инициализации сайдбара — чтобы быстрый вызов
// встал в очередь первым, до медленного listStorage() / sysinfo.
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

// Инициализируем устойчиво: сбой одного компонента не должен срывать
// подключение обработчиков кнопок ниже по файлу.
const components = [
  sidebar, tabBar, left, right, statusBar, contextMenu, palette,
  duplicates, graph, confirmDialog, preview, divider, themeMenu,
];
for (const c of components) {
  try {
    c.init();
  } catch (err) {
    console.error('[patina] ошибка инициализации компонента:', err);
  }
}

document.getElementById('preview-btn').addEventListener('click', () => bus.emit('preview:toggle'));

const searchInput = document.getElementById('topbar-search');
searchInput.addEventListener('input', () => store.setState({ searchQuery: searchInput.value }));
// При навигации searchQuery сбрасывается программно — синхронизируем input.
store.subscribe((state) => {
  if (document.activeElement !== searchInput && searchInput.value !== (state.searchQuery || '')) {
    searchInput.value = state.searchQuery || '';
  }
});

document.getElementById('dirsize-btn').addEventListener('click', () => bus.emit('dirsize:recalc'));
document.getElementById('duplicates-btn').addEventListener('click', () => bus.emit('duplicates:open'));
document.getElementById('graph-btn').addEventListener('click', () => bus.emit('graph:open'));
document.getElementById('theme-btn').addEventListener('click', () => bus.emit('theme:open'));

// --- Язык интерфейса ---
// Подсказки кнопок топбара и плейсхолдер поиска живут в статичном index.html,
// поэтому переводим их из JS (на старте и при каждой смене языка).
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

// Смена языка: переводим топбар, затем вызываем applyLang() у каждого
// компонента. applyLang() точечно обновляет только тексты в DOM, сохраняя
// состояние (открытые диалоги, выделение, фокус графа, инпуты и т.д.) —
// в отличие от destroy()+init(), который сносил панели и transient-состояние.
// Если у компонента нет applyLang — пропускаем (он не нуждается в перерисовке).
function applyLanguage() {
  syncTopbar();
  for (const c of components) {
    try {
      if (typeof c.applyLang === 'function') c.applyLang();
    } catch (err) {
      console.error('[patina] ошибка перерисовки при смене языка:', err);
    }
  }
  store.setState({}); // на случай, если кто-то из подписчиков store считает тексты
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

// --- Запуск: показываем контент максимально быстро ---
// _homePromise и _cachedHome уже объявлены выше (до init сайдбара).
if (_cachedHome) {
  // Оптимистичный запуск: показываем контент сразу, не дожидаясь IPC.
  left.navigate(_cachedHome);
}

(async function boot() {
  try {
    const home = await homeDir();
    store.setState({ homePath: home });
    left.navigate(home);
    if (!_cachedHome) {
      // Первый запуск — навигируем только сейчас.
      left.navigate(home);
    } else if (_cachedHome !== home) {
      // Путь изменился (маловероятно, но безопасно).
      left.navigate(home);
    }
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
