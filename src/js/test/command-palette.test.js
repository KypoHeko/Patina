import { describe, it, expect, beforeEach, vi } from 'vitest';
import { CommandPalette } from '../components/command-palette.js';
import { createStore } from '../core/store.js';
import { createEventBus } from '../core/event-bus.js';
import { initialTabsState } from '../state/tabs.js';
import { updatePane, recordHistory } from '../state/panes.js';

// Мокаем все API-вызовы
vi.mock('../api/fs.js', () => ({
  searchFiles: vi.fn().mockResolvedValue([
    { name: 'main.rs', path: '/home/src/main.rs', kind: 'file', extension: 'rs' },
    { name: 'mod.rs', path: '/home/src/mod.rs', kind: 'file', extension: 'rs' },
  ]),
  listDir: vi.fn().mockResolvedValue([]),
}));

vi.mock('../api/content.js', () => ({
  searchContent: vi.fn().mockResolvedValue([
    { name: 'main.rs', path: '/home/src/main.rs', snippet: 'fn main() {}' },
  ]),
}));

vi.mock('../api/tags.js', () => ({
  tagsForPaths: vi.fn().mockResolvedValue({}),
  pathsForTag: vi.fn().mockResolvedValue(['/home/src/main.rs']),
}));

vi.mock('../api/indexing.js', () => ({
  startIndex: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../api/events.js', () => ({
  onEvent: vi.fn().mockResolvedValue(() => {}),
}));

const folderEntries = [
  { name: 'readme.md', kind: 'file', path: '/home/readme.md', extension: 'md' },
  { name: 'main.rs', kind: 'file', path: '/home/main.rs', extension: 'rs' },
  { name: 'config.toml', kind: 'file', path: '/home/config.toml', extension: 'toml' },
  { name: 'src', kind: 'folder', path: '/home/src', extension: '' },
];

function makeStore() {
  const store = createStore({ ...initialTabsState(), homePath: '/home' });
  updatePane(store, 'left', { path: '/home', entries: folderEntries, loading: false });
  recordHistory(store, 'left', '/home');
  return store;
}

function makePalette() {
  const mount = document.createElement('div');
  mount.id = 'palette-root';
  document.body.appendChild(mount);
  const store = makeStore();
  const bus = createEventBus();
  const palette = new CommandPalette({ mount, store, bus });
  palette.init();
  return { palette, mount, store, bus };
}

// ─── filtered() ────────────────────────────────────

describe('CommandPalette — filtered', () => {
  let palette;

  beforeEach(() => {
    const ctx = makePalette();
    palette = ctx.palette;
    palette._scope = 'folder';
    palette._entries = folderEntries;
    palette._tagFilter = null;
    palette._regex = false;
    palette._query = '';
  });

  it('без запроса — все записи', () => {
    palette._query = '';
    expect(palette.filtered()).toHaveLength(folderEntries.length);
  });

  it('подстрока фильтрует по имени (нечувствительно)', () => {
    palette._query = 'main';
    const result = palette.filtered();
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('main.rs');
  });

  it('regex-режим фильтрует по имени', () => {
    palette._regex = true;
    palette._query = '\\.(rs|md)$';
    const result = palette.filtered();
    expect(result).toHaveLength(2);
    expect(result.map((e) => e.name).sort()).toEqual(['main.rs', 'readme.md']);
  });

  it('опасный regex деградирует — показывает все записи', () => {
    palette._regex = true;
    palette._query = '(a+)+';
    const result = palette.filtered();
    // (a+)+ — вложенный квантификатор, safeRegExp отклонит → не фильтруем
    expect(result).toHaveLength(folderEntries.length);
  });

  it('тег-фильтр пересекает результаты', () => {
    palette._tagFilter = new Set(['/home/readme.md', '/home/main.rs']);
    palette._query = '';
    const result = palette.filtered();
    expect(result).toHaveLength(2);
  });

  it('тег-фильтр + подстрока = двойная фильтрация', () => {
    palette._tagFilter = new Set(['/home/readme.md', '/home/main.rs']);
    palette._query = 'read';
    const result = palette.filtered();
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('readme.md');
  });

  it('content scope — тег-фильтр применяется', () => {
    palette._scope = 'content';
    palette._entries = [
      { name: 'main.rs', path: '/home/main.rs', kind: 'file', snippet: 'fn main()' },
      { name: 'lib.rs', path: '/home/lib.rs', kind: 'file', snippet: 'pub fn' },
    ];
    palette._tagFilter = new Set(['/home/main.rs']);
    palette._query = '';
    const result = palette.filtered();
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('main.rs');
  });
});

// ─── setScope ──────────────────────────────────────

describe('CommandPalette — setScope', () => {
  let palette;

  beforeEach(() => {
    const ctx = makePalette();
    palette = ctx.palette;
    palette._open = true;
    palette._scope = 'folder';
    palette._entries = folderEntries;
    palette._folderEntries = folderEntries;
    palette._root = '/home';
    palette._query = '';
    palette._sel = 0;
    palette._tagFilter = null;
    palette._activeTags = new Set();
    palette._regex = false;
    palette._tags = {};
    // Мокаем DOM-элементы
    palette._scopeFolderBtn = { classList: { toggle: vi.fn() } };
    palette._scopeTreeBtn = { classList: { toggle: vi.fn() } };
    palette._scopeContentBtn = { classList: { toggle: vi.fn() } };
    palette._input = { placeholder: '', focus: vi.fn() };
    palette._resultsEl = { innerHTML: '', querySelectorAll: vi.fn().mockReturnValue([]) };
  });

  it('переключение на folder — entries = folderEntries', () => {
    palette._scope = 'tree';
    palette._entries = [];
    palette.setScope('folder');
    expect(palette._scope).toBe('folder');
    expect(palette._entries).toBe(folderEntries);
  });

  it('переключение на tree — не доступно для tag-папки', () => {
    palette._root = 'tag:urgent';
    palette.setScope('tree');
    expect(palette._scope).toBe('folder');
  });

  it('переключение на content доступно для tag-папки (поиск по содержимому)', () => {
    palette._root = 'tag:urgent';
    palette.setScope('content');
    // Content search is allowed even for tag-folders
    expect(palette._scope).toBe('content');
  });

  it('повторная установка той же области — без изменений', () => {
    const prevScope = palette._scope;
    palette.setScope('folder');
    expect(palette._scope).toBe(prevScope);
  });
});

// ─── relParent ─────────────────────────────────────

describe('CommandPalette — relParent', () => {
  let palette;

  beforeEach(() => {
    const ctx = makePalette();
    palette = ctx.palette;
    palette._root = '/home';
  });

  it('путь внутри root — возвращает относительную папку', () => {
    expect(palette.relParent('/home/src/main.rs')).toBe('src');
  });

  it('глубокая вложенность', () => {
    expect(palette.relParent('/home/src/core/store.js')).toBe('src/core');
  });

  it('файл в корне — пустая строка', () => {
    expect(palette.relParent('/home/readme.md')).toBe('');
  });

  it('путь вне root — относительный путь от корня', () => {
    // relParent для путей вне _root всё равно удаляет префикс,
    // но если путь не начинается с _root, то rel = path целиком
    expect(palette.relParent('/other/file.txt')).toBe('other');
  });
});

// ─── _resultsSig ───────────────────────────────────

describe('CommandPalette — _resultsSig', () => {
  let palette;

  beforeEach(() => {
    const ctx = makePalette();
    palette = ctx.palette;
  });

  it('одинаковые списки дают одинаковую сигнатуру', () => {
    const list = [
      { path: '/a', snippet: 'hello' },
      { path: '/b', snippet: 'world' },
    ];
    expect(palette._resultsSig(list)).toBe(palette._resultsSig(list));
  });

  it('разные списки дают разные сигнатуры', () => {
    const a = [{ path: '/a', snippet: 'x' }];
    const b = [{ path: '/b', snippet: 'x' }];
    expect(palette._resultsSig(a)).not.toBe(palette._resultsSig(b));
  });

  it('разные сниппеты — разные сигнатуры', () => {
    const a = [{ path: '/a', snippet: 'x' }];
    const b = [{ path: '/a', snippet: 'y' }];
    expect(palette._resultsSig(a)).not.toBe(palette._resultsSig(b));
  });
});

// ─── onKey ─────────────────────────────────────────

describe('CommandPalette — onKey', () => {
  let palette;

  beforeEach(() => {
    const ctx = makePalette();
    palette = ctx.palette;
    palette._open = true;
    palette._results = folderEntries;
    palette._sel = 0;
    // Мокаем renderResults (зависит от DOM-геометрии/innerHTML)
    palette.renderResults = vi.fn();
  });

  it('ArrowDown сдвигает выделение', () => {
    const prevSel = palette._sel;
    palette.onKey({ key: 'ArrowDown', preventDefault: vi.fn() });
    expect(palette._sel).toBe(prevSel + 1);
  });

  it('ArrowDown не выходит за пределы', () => {
    palette._sel = folderEntries.length - 1;
    palette.onKey({ key: 'ArrowDown', preventDefault: vi.fn() });
    expect(palette._sel).toBe(folderEntries.length - 1);
  });

  it('ArrowUp сдвигает выделение вверх', () => {
    palette._sel = 2;
    palette.onKey({ key: 'ArrowUp', preventDefault: vi.fn() });
    expect(palette._sel).toBe(1);
  });

  it('ArrowUp не уходит ниже нуля', () => {
    palette._sel = 0;
    palette.onKey({ key: 'ArrowUp', preventDefault: vi.fn() });
    expect(palette._sel).toBe(0);
  });

  it('Escape закрывает палитру', () => {
    const e = { key: 'Escape', preventDefault: vi.fn() };
    palette.onKey(e);
    expect(palette._open).toBe(false);
  });

  it('Enter вызывает activate и закрывает', () => {
    const spy = vi.fn();
    palette.bus.on('file:activate', spy);
    palette.onKey({ key: 'Enter', preventDefault: vi.fn() });
    expect(palette._open).toBe(false);
    expect(spy).toHaveBeenCalledWith({ side: 'left', entry: folderEntries[0] });
  });
});

// ─── treeAllowed ───────────────────────────────────

describe('CommandPalette — treeAllowed', () => {
  let palette;

  beforeEach(() => {
    const ctx = makePalette();
    palette = ctx.palette;
  });

  it('обычный путь — разрешено', () => {
    palette._root = '/home/user';
    expect(palette.treeAllowed).toBe(true);
  });

  it('tag-путь — запрещено', () => {
    palette._root = 'tag:urgent';
    expect(palette.treeAllowed).toBe(false);
  });

  it('пустой путь — запрещено', () => {
    palette._root = '';
    expect(palette.treeAllowed).toBe(false);
  });
});

// ─── dotsHtml ───────────────────────────────────────

describe('CommandPalette — dotsHtml', () => {
  let palette;

  beforeEach(() => {
    const ctx = makePalette();
    palette = ctx.palette;
    palette._tags = {
      '/a': ['urgent'],
      '/b': ['in-progress', 'done'],
    };
  });

  it('путь с тегами — рендерит точки', () => {
    const html = palette.dotsHtml('/b');
    expect(html).toContain('tag-dot');
    // Два тега — два span с tag-dot
    const count = (html.match(/tag-dot/g) || []).length;
    expect(count).toBe(2);
  });

  it('путь без тегов — пустая строка', () => {
    expect(palette.dotsHtml('/c')).toBe('');
  });
});
