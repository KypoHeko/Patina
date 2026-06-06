import { Component } from '../core/component.js';
import { el, escapeHtml } from '../core/dom.js';
import { tagsForPaths, pathsForTag } from '../api/tags.js';
import { searchFiles } from '../api/fs.js';
import { searchContent } from '../api/content.js';
import { startIndex } from '../api/indexing.js';
import { onEvent } from '../api/events.js';
import { TAGS } from '../config/tags.js';
import { fileIcon } from '../lib/icons.js';
import { getPane } from '../state/panes.js';
import { getActiveSide } from '../state/tabs.js';
import { safeRegExp } from '../lib/regex.js';

const TAG_COLOR = Object.fromEntries(TAGS.map((t) => [t.id, t.color]));
const DISPLAY_CAP = 300; // сколько строк показываем разом
const TREE_LIMIT = 20000; // потолок обхода поддерева

// Палитра поиска: имя (или regex) + теги, с выбором области —
// текущая папка либо всё поддерево (кросс-папочный поиск через бэкенд).
export class CommandPalette extends Component {
  init() {
    this._open = false;
    this._side = 'left';
    this._root = '';
    this._scope = 'folder';
    this._loading = false;
    this._entries = [];
    this._folderEntries = [];
    this._tags = {}; // path -> [tagId] (точки, лениво)
    this._tagFilter = null; // Set<path> | null — фильтр по активным тегам
    this._activeTags = new Set();
    this._regex = false;
    this._query = '';
    this._sel = 0;
    this._results = [];
    this._resultsCount = 0;
    this._dotSeq = 0;
    this._tagSeq = 0;
    this._scanSeq = 0;
    this._indexing = false;
    this._indexedRoots = new Set();
    this._treeBase = null;
    this._treeTimer = null;
    this._contentIndexed = new Set();
    this._contentTimer = null;
    this._idxTimer = null;
    this._lastSig = '';

    this.listen('palette:open', () => (this._open ? this.close() : this.open()));
    // Свежесть индексов теперь держит бэкенд (рекурсивный вотчер); по событию
    // лишь переспрашиваем текущий запрос.
    onEvent('index:ready', () => this.onIndexEvent());
    onEvent('index:changed', () => this.onIndexEvent());
    this.on(document, 'keydown', (e) => {
      if (this._open) this.onKey(e);
    });
  }

  open() {
    const state = this.store.getState();
    this._side = getActiveSide(state);
    const pane = getPane(state, this._side);
    this._root = pane.path || '';
    this._folderEntries = pane.entries || [];
    this._scope = 'folder';
    this._entries = this._folderEntries;
    this._tags = {};
    this._tagFilter = null;
    this._activeTags = new Set();
    this._regex = false;
    this._query = '';
    this._sel = 0;
    this._loading = false;
    this._open = true;
    this.render();
    this._input.focus();
  }

  close() {
    if (!this._open) return;
    this._open = false;
    clearTimeout(this._treeTimer);
    clearTimeout(this._contentTimer);
    clearTimeout(this._idxTimer);
    this.mount.innerHTML = '';
  }

  get treeAllowed() {
    return !!this._root && !this._root.startsWith('tag:');
  }

  setScope(scope) {
    if (scope === this._scope) return;
    if (scope === 'tree' && !this.treeAllowed) return;
    this._scope = scope;
    this._sel = 0;
    this._syncScopeUI();

    if (scope === 'folder') {
      this._loading = false;
      this._entries = this._folderEntries;
      this.update();
      return;
    }

    if (scope === 'content') {
      this.runContentQuery();
      return;
    }

    // поддерево — из персистентного индекса; запрос уходит на сервер по вводу
    this._treeBase = null;
    this.runTreeQuery();
  }

  onTreeInput() {
    if (this._regex) {
      this.runTreeQuery(); // regex фильтруется на фронте по кешу базы
    } else {
      clearTimeout(this._treeTimer);
      this._treeTimer = setTimeout(() => this.runTreeQuery(), 150);
    }
  }

  ensureIndexed(root) {
    if (this._indexedRoots.has(root)) return Promise.resolve();
    this._indexedRoots.add(root);
    return startIndex(root, false).catch(() => {});
  }

  showHint(text) {
    this._entries = [];
    this._results = [];
    this._resultsCount = 0;
    this._loading = false;
    this._lastSig = '';
    if (this._resultsEl)
      this._resultsEl.innerHTML = `<div class="palette__empty">${text}</div>`;
  }

  // Обычный режим — серверный подстрочный поиск (мало данных через IPC).
  // Regex — один раз тянем базовый набор корня и фильтруем на фронте.
  runTreeQuery(silent = false) {
    const root = this._root;
    const q = this._query.trim();
    const seq = ++this._scanSeq;

    if (!q) {
      this.showHint('Введите запрос для поиска по поддереву');
      return;
    }

    if (!silent) this._lastSig = '';

    if (this._regex && this._treeBase) {
      this.commitResults(this._treeBase, seq);
      return;
    }

    if (!silent) {
      this._loading = true;
      this.renderResults();
    }
    const fetchQuery = this._regex ? '' : q;
    this.ensureIndexed(root)
      .then(() => searchFiles(root, fetchQuery, TREE_LIMIT))
      .then((list) => {
        const arr = list || [];
        if (this._regex) this._treeBase = arr;
        this.commitResults(arr, seq);
      })
      .catch(() => {
        if (seq !== this._scanSeq || !this._open || silent) return;
        this._loading = false;
        this._entries = [];
        this._lastSig = this._resultsSig([]);
        this.update();
      });
  }

  forceReindex() {
    const root = this._root;
    if (this._scope === 'content') {
      startIndex(root, true, true).catch(() => {});
      this._contentIndexed.add(root);
      this.runContentQuery();
      return;
    }
    if (this._scope !== 'tree') return;
    this._treeBase = null;
    startIndex(root, false, true).catch(() => {});
    this._indexedRoots.add(root);
    this.runTreeQuery();
  }

  onContentInput() {
    clearTimeout(this._contentTimer);
    this._contentTimer = setTimeout(() => this.runContentQuery(), 220);
  }

  ensureContentIndexed(root) {
    if (this._contentIndexed.has(root)) return Promise.resolve();
    this._contentIndexed.add(root);
    return startIndex(root, true).catch(() => {});
  }

  // Подпись набора результатов: пути + сниппеты. Если не изменилась —
  // повторную перерисовку пропускаем (убирает мелькание при событиях индекса).
  _resultsSig(list) {
    let out = '';
    for (const e of list) out += `${e.path}\u0000${e.snippet || ''}\u0001`;
    return out;
  }

  // Зафиксировать результаты запроса с учётом устаревания и без лишних ререндеров.
  commitResults(entries, seq) {
    if (seq !== this._scanSeq || !this._open) return;
    this._loading = false;
    const sig = this._resultsSig(entries);
    this._entries = entries;
    if (sig === this._lastSig) return; // ничего не поменялось — не перерисовываем
    this._lastSig = sig;
    this.update();
  }

  // Полнотекстовый поиск по содержимому: сервер уже отобрал совпадения,
  // на фронте только показываем путь и сниппет.
  runContentQuery(silent = false) {
    const root = this._root;
    const q = this._query.trim();
    const seq = ++this._scanSeq;
    if (!q) {
      this.showHint('Введите запрос для поиска по содержимому');
      return;
    }
    if (!silent) {
      this._lastSig = '';
      this._loading = true;
      this.renderResults();
    }
    this.ensureContentIndexed(root)
      .then(() => searchContent(root, q, 200))
      .then((hits) => this.commitResults((hits || []).map((h) => ({ ...h, kind: 'file' })), seq))
      .catch(() => {
        if (seq !== this._scanSeq || !this._open || silent) return;
        this._loading = false;
        this._entries = [];
        this._lastSig = this._resultsSig([]);
        this.update();
      });
  }

  filtered() {
    if (this._scope === 'content') {
      let list = this._entries;
      if (this._tagFilter) list = list.filter((e) => this._tagFilter.has(e.path));
      return list;
    }
    let list = this._entries;
    if (this._tagFilter) list = list.filter((e) => this._tagFilter.has(e.path));
    const q = this._query.trim();
    if (q) {
      if (this._regex) {
        const { ok, re } = safeRegExp(q, 'i');
        if (!ok) return list;           // небезопасный/битый паттерн — не фильтруем, как и раньше
        list = list.filter((e) => re.test(e.name));
      } else {
        const ql = q.toLowerCase();
        list = list.filter((e) => e.name.toLowerCase().includes(ql));
      }
    }
    return list;
  }

  update() {
    this.renderResults();
    this.loadDots();
  }

  // Лениво подгружаем теги только для видимых строк (ограниченный набор).
  loadDots() {
    if (this._scope === 'content') return;
    const missing = this._results.map((e) => e.path).filter((p) => !(p in this._tags));
    if (!missing.length) return;
    const seq = ++this._dotSeq;
    tagsForPaths(missing)
      .then((m) => {
        if (seq !== this._dotSeq || !this._open) return;
        for (const p of missing) this._tags[p] = m && m[p] ? m[p] : [];
        this.paintDots();
      })
      .catch(() => {});
  }

  paintDots() {
    if (!this._resultsEl) return;
    this._resultsEl.querySelectorAll('.palette__item').forEach((it) => {
      const e = this._results[+it.dataset.i];
      const rt = it.querySelector('.palette__rtags');
      if (e && rt) rt.innerHTML = this.dotsHtml(e.path);
    });
  }

  dotsHtml(path) {
    return (this._tags[path] || [])
      .map((id) => `<span class="tag-dot" style="background:${TAG_COLOR[id] || '#888'}"></span>`)
      .join('');
  }

  // Фильтр по тегам — глобальные множества путей из БД, пересечение (AND).
  rebuildTagFilter() {
    if (!this._activeTags.size) {
      this._tagFilter = null;
      this.update();
      return;
    }
    const tags = [...this._activeTags];
    const seq = ++this._tagSeq;
    Promise.all(tags.map((t) => pathsForTag(t)))
      .then((lists) => {
        if (seq !== this._tagSeq || !this._open) return;
        let set = new Set(lists[0] || []);
        for (let i = 1; i < lists.length; i++) {
          const s = new Set(lists[i] || []);
          set = new Set([...set].filter((p) => s.has(p)));
        }
        this._tagFilter = set;
        this.update();
      })
      .catch(() => {
        if (seq !== this._tagSeq) return;
        this._tagFilter = new Set();
        this.update();
      });
  }

  relParent(path) {
    let rel = path;
    if (this._root && path.startsWith(this._root)) rel = path.slice(this._root.length);
    rel = rel.replace(/^[\\/]+/, '');
    const idx = Math.max(rel.lastIndexOf('/'), rel.lastIndexOf('\\'));
    return idx > 0 ? rel.slice(0, idx) : '';
  }

  render() {
    this.mount.innerHTML = '';
    const backdrop = el('div', { class: 'palette__backdrop', onClick: () => this.close() });
    const panel = el('div', { class: 'palette' });

    const head = el('div', { class: 'palette__head' });
    this._input = el('input', {
      class: 'palette__input',
      type: 'text',
      placeholder: 'Поиск в текущей папке…',
      spellcheck: 'false',
      onInput: (e) => {
        this._query = e.target.value;
        this._sel = 0;
        if (this._scope === 'tree') this.onTreeInput();
        else if (this._scope === 'content') this.onContentInput();
        else this.update();
      },
    });
    this._regexBtn = el(
      'button',
      {
        class: 'palette__regex',
        title: 'Режим регулярного выражения',
        onClick: () => {
          this._regex = !this._regex;
          this._regexBtn.classList.toggle('is-on', this._regex);
          this._input.focus();
          if (this._scope === 'tree') this.runTreeQuery();
          else if (this._scope !== 'content') this.update();
        },
      },
      '.*',
    );
    head.append(this._input, this._regexBtn);

    // Переключатель области поиска
    const scope = el('div', { class: 'palette__scope' });
    this._scopeFolderBtn = el(
      'button',
      { class: 'palette__scopebtn is-on', onClick: () => this.setScope('folder') },
      'Эта папка',
    );
    this._scopeTreeBtn = el(
      'button',
      {
        class: 'palette__scopebtn' + (this.treeAllowed ? '' : ' is-disabled'),
        onClick: () => this.setScope('tree'),
        title: this.treeAllowed ? 'Искать во всех вложенных папках' : 'Недоступно для тег-папки',
      },
      'Всё поддерево',
    );
    this._reindexBtn = el(
      'button',
      {
        class: 'palette__scopebtn palette__reindex',
        title: 'Переиндексировать поддерево',
        onClick: () => this.forceReindex(),
      },
      '↻',
    );
    this._scopeContentBtn = el(
      'button',
      {
        class: 'palette__scopebtn' + (this.treeAllowed ? '' : ' is-disabled'),
        onClick: () => this.setScope('content'),
        title: this.treeAllowed ? 'Поиск по содержимому файлов' : 'Недоступно для тег-папки',
      },
      'Содержимое',
    );
    scope.append(this._scopeFolderBtn, this._scopeTreeBtn, this._scopeContentBtn, this._reindexBtn);

    const chips = el('div', { class: 'palette__tags' });
    for (const t of TAGS) {
      chips.append(
        el(
          'button',
          {
            class: 'palette__chip',
            dataset: { tag: t.id },
            onClick: (e) => {
              if (this._activeTags.has(t.id)) this._activeTags.delete(t.id);
              else this._activeTags.add(t.id);
              e.currentTarget.classList.toggle('is-on');
              this._sel = 0;
              this.rebuildTagFilter();
            },
          },
          el('span', { class: 'palette__dot', style: `background:${t.color}` }),
          t.label,
        ),
      );
    }

    this._resultsEl = el('div', { class: 'palette__results' });
    panel.append(head, scope, chips, this._resultsEl);
    this.mount.append(backdrop, panel);
    this.update();
  }

  _syncScopeUI() {
    if (this._scopeFolderBtn) this._scopeFolderBtn.classList.toggle('is-on', this._scope === 'folder');
    if (this._scopeTreeBtn) this._scopeTreeBtn.classList.toggle('is-on', this._scope === 'tree');
    if (this._scopeContentBtn) this._scopeContentBtn.classList.toggle('is-on', this._scope === 'content');
    const ph = {
      folder: 'Поиск в текущей папке…',
      tree: 'Поиск по всему поддереву…',
      content: 'Поиск по содержимому файлов…',
    };
    if (this._input) this._input.placeholder = ph[this._scope] || ph.folder;
  }

  renderResults() {
    if (this._loading) {
      this._results = [];
      this._resultsCount = 0;
      this._resultsEl.innerHTML = `<div class="palette__empty">${this._indexing ? 'Индексирование…' : 'Загрузка…'}</div>`;
      return;
    }
    const all = this.filtered();
    this._resultsCount = all.length;
    const shown = all.slice(0, DISPLAY_CAP);
    this._results = shown;
    if (this._sel >= shown.length) this._sel = Math.max(0, shown.length - 1);

    if (!shown.length) {
      this._resultsEl.innerHTML = '<div class="palette__empty">Ничего не найдено</div>';
      return;
    }

    const content = this._scope === 'content';
    let html = shown
      .map((e, i) => {
        const sel = i === this._sel ? ' is-sel' : '';
        const sub = this._scope === 'tree' || content ? this.relParent(e.path) : '';
        const subHtml = sub ? `<span class="palette__path">${escapeHtml(sub)}</span>` : '';
        if (content) {
          return `<div class="palette__item palette__item--content${sel}" data-i="${i}">
              <div class="palette__crow"><span class="palette__ico">${fileIcon(e)}</span>` +
            `<span class="palette__main"><span class="palette__name">${escapeHtml(e.name)}</span>${subHtml}</span></div>` +
            `<div class="palette__snippet">${escapeHtml(e.snippet || '')}</div>
            </div>`;
        }
        return `<div class="palette__item${sel}" data-i="${i}">
            <span class="palette__ico">${fileIcon(e)}</span>
            <span class="palette__main"><span class="palette__name">${escapeHtml(e.name)}</span>${subHtml}</span>
            <span class="palette__rtags">${this.dotsHtml(e.path)}</span>
          </div>`;
      })
      .join('');
    if (all.length > shown.length) {
      html += `<div class="palette__more">Показаны первые ${shown.length} из ${all.length}</div>`;
    }
    this._resultsEl.innerHTML = html;

    this._resultsEl.querySelectorAll('.palette__item').forEach((it) => {
      it.addEventListener('click', () => this.activate(this._results[+it.dataset.i]));
    });
  }

  onKey(e) {
    if (e.key === 'Escape') {
      e.preventDefault();
      this.close();
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      this._sel = Math.min(this._sel + 1, (this._results?.length || 1) - 1);
      this.renderResults();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      this._sel = Math.max(this._sel - 1, 0);
      this.renderResults();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const entry = this._results?.[this._sel];
      if (entry) this.activate(entry);
    }
  }

  // Сброс кэшей индексов имён/содержимого для затронутых внешними изменениями корней.
  onIndexEvent() {
    if (!this._open) return;
    if (this._scope !== 'tree' && this._scope !== 'content') return;
    clearTimeout(this._idxTimer);
    this._idxTimer = setTimeout(() => {
      if (this._scope === 'tree') {
        this._treeBase = null;
        this.runTreeQuery(true);
      } else if (this._scope === 'content') {
        this.runContentQuery(true);
      }
    }, 200);
  }

  activate(entry) {
    if (!entry) return;
    this.bus.emit('file:activate', { side: this._side, entry });
    this.close();
  }
}
