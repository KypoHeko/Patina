import { Component } from '../core/component.js';
import { escapeHtml } from '../core/dom.js';
import { fileGraph, hashGraphFiles } from '../api/relationships.js';
import { searchFiles } from '../api/fs.js';
import { startIndex } from '../api/indexing.js';
import { onEvent } from '../api/events.js';
import { getPane } from '../state/panes.js';
import { getActiveSide } from '../state/tabs.js';
import { pathToColor } from '../lib/path-color.js';

const NODE_H = 28; // высота панели узла
const NODE_PAD_X = 12; // горизонтальный паддинг внутри панели
const NODE_PAD_Y = 6; // вертикальный паддинг
const NODE_MIN_W = 64; // минимальная ширина панели
const NODE_MAX_W = 180; // максимальная ширина панели
const NODE_RADIUS = 6; // скругление углов панели
const NODE_FONT = '11px system-ui, -apple-system, "Segoe UI", sans-serif';
const OVERVIEW_CAP = 80; // не строим полотно из тысяч узлов
const OVERVIEW_INDEX_CAP = 300; // потолок узлов обзора с учётом вложенных файлов из индекса
const BUSY_DELAY = 350; // мс: спиннер показываем только если операция длится дольше — иначе не мелькаем
const DEFAULT_W = 900; // ориентир до первой раскладки полотна
const DEFAULT_H = 600;

// Физика (подобрана под десятки узлов, увеличена под панели)
const REPULSION = 18000; // кулоновское отталкивание (больше — узлы-панели шире)
const SPRING_LEN = 240; // длина покоя ребра (больше — длиннее связи)
const SPRING_K = 0.010; // жёсткость пружины
const GRAVITY = 0.008; // притяжение к центру (держит отвязанные узлы)
const DAMPING = 0.86;
const ALPHA_MIN = 0.02;
const ZOOM_MIN = 0.2;
const ZOOM_MAX = 3;

// Прогрессивная сборка: количество узлов, появляющихся за один тик
const APPEAR_BATCH = 4;
const APPEAR_INTERVAL = 60; // мс между батчами

// Цвета стрелок (легенда)
const C_DEP = '#10b981'; // зависимости (зелёный — emerald)
const C_BACK = '#f59e0b'; // обратные ссылки (жёлтый — amber)
const C_MANUAL = 'rgba(150,158,176,0.75)';
const C_CTX = 'rgba(120,130,150,0.5)';
const C_MENTION = 'rgba(120,130,150,0.3)';

// Цвета расширений (из icons.js — та же палитра, что в файловой панели)
const EXT_COLOR = {
  ts: '#3b82f6', tsx: '#3b82f6',
  js: '#f7df1e', mjs: '#f7df1e',
  jsx: '#38bdf8', css: '#38bdf8',
  html: '#e34c26', htm: '#e34c26',
  xml: '#f59e0b', rs: '#f74c00',
  py: '#3776ab', go: '#00add8',
  java: '#ea2d2e',
  c: '#5c6bc0', h: '#5c6bc0', cpp: '#5c6bc0',
  rb: '#cc342d', php: '#777bb4',
  sh: '#4eaa25', sql: '#0ea5e9',
  yaml: '#94a3b8', yml: '#94a3b8', toml: '#94a3b8', ini: '#94a3b8',
  json: '#f59e0b',
  md: '#64748b', markdown: '#64748b',
  pdf: '#ef4444', doc: '#2563eb', docx: '#2563eb', odt: '#2563eb',
  txt: '#94a3b8', log: '#94a3b8', rtf: '#94a3b8',
  svg: '#f97316',
  png: '#a855f7', jpg: '#a855f7', jpeg: '#a855f7', gif: '#a855f7',
  webp: '#a855f7', bmp: '#a855f7', ico: '#a855f7', avif: '#a855f7',
  psd: '#0ea5e9', ai: '#f97316', fig: '#a259ff', sketch: '#fdb300',
  xlsx: '#22c55e', xls: '#22c55e', ods: '#22c55e', csv: '#22c55e', tsv: '#22c55e',
  ttf: '#8b5cf6', otf: '#8b5cf6', woff: '#8b5cf6', woff2: '#8b5cf6',
  zip: '#eab308', rar: '#eab308', '7z': '#eab308', tar: '#eab308',
  gz: '#eab308', bz2: '#eab308', xz: '#eab308', zst: '#eab308',
  mp3: '#ec4899', wav: '#ec4899', flac: '#ec4899', ogg: '#ec4899',
  m4a: '#ec4899', aac: '#ec4899',
  mp4: '#f43f5e', mkv: '#f43f5e', mov: '#f43f5e', avi: '#f43f5e',
  webm: '#f43f5e', wmv: '#f43f5e',
  exe: '#64748b', msi: '#64748b', dll: '#64748b', iso: '#64748b',
};
const DEFAULT_NODE_COLOR = '#94a3b8';

/** Получить цвет узла по расширению файла. */
/** Родительская папка пути (для цвета рамки = цвета вкладки этой папки). */
function parentDir(p) {
  const i = Math.max(p.lastIndexOf('\\'), p.lastIndexOf('/'));
  return i > 0 ? p.slice(0, i) : p;
}

function nodeColor(name) {
  const dot = name.lastIndexOf('.');
  if (dot < 0) return DEFAULT_NODE_COLOR;
  const ext = name.slice(dot + 1).toLowerCase();
  return EXT_COLOR[ext] || DEFAULT_NODE_COLOR;
}

/** Подпись узла: только собственное имя файла/папки (без родительской папки —
 *  иначе у всех узлов из одной папки в подписи дублируется её название). */
function shortLabel(name, fullPath) {
  const label = name || fullPath.split(/[/\\]/).pop() || fullPath;
  return label.length > 28 ? label.slice(0, 27) + '…' : label;
}

/** Измерить ширину текста метки узла на полотне. */
function measureLabelWidth(ctx, name, fullPath) {
  ctx.font = NODE_FONT;
  const text = shortLabel(name, fullPath || name);
  const w = ctx.measureText(text).width;
  return Math.min(NODE_MAX_W, Math.max(NODE_MIN_W, Math.ceil(w) + NODE_PAD_X * 2));
}

// Граф связей (Ctrl+G) — плавающее окно: его можно перетаскивать за заголовок и
// менять размер за угол. Полотно занимает всё окно; узлы не привязаны к его
// границам (могут уходить за край), фон можно панорамировать перетаскиванием и
// масштабировать колесом. Один клик по узлу — сделать его фокусом; двойной —
// показать файл в панели; двойной по пустому месту — сбросить вид.
export class RelationshipGraph extends Component {
  init() {
    console.log('%c[RelationshipGraph]', 'color:#10b981;font-weight:700', 'build: empty-load-guard (если этой строки нет в консоли — у тебя старый файл)');
    this._open = false;
    this._side = 'left';
    this._root = '';
    this._mode = 'overview'; // 'focus' | 'overview'
    this._focus = null;
    this._connectedPaths = null; // Set<path> — узлы со связями к фокусу
    this._nodes = new Map();
    this._edges = [];
    this._curSeeds = [];
    this._curHops = 1;

    this._raf = null;
    this._alpha = 0;
    this._fetchSeq = 0;

    // Состояние фонового построения индекса (для живого статуса вместо «висящей»
    // плашки): прогресс приходит событиями index:progress, конец — index:ready.
    this._loading = false;
    this._indexing = false;
    this._indexCount = 0;
    this._indexTotal = 0;
    this._indexPhase = '';
    this._showBusy = false; // спиннер показываем с задержкой BUSY_DELAY (анти-мелькание на быстрых операциях)
    this._busyTimer = null;
    this._selfRebuild = false; // true, пока идёт пересборка, запущенная самим графом («Обновить»)

    // Прогрессивная сборка
    this._appeared = new Set(); // пути уже появившихся узлов
    this._appearQueue = []; // узлы, ожидающие появления
    this._appearTimer = null;

    // Фаза хеширования
    this._hashing = false;
    this._hashSeq = 0; // серийный номер — чтобы отличить устаревшие вызовы
    this._hashProgress = 0;
    this._hashTotal = 0;
    this._hashes = new Map(); // path → hash

    // Размер полотна (обновляется ResizeObserver), вид (пан/зум), перетаскивания.
    this._w = DEFAULT_W;
    this._h = DEFAULT_H;
    this._ox = 0;
    this._oy = 0;
    this._zoom = 1;
    this._pan = null; // активное панорамирование фона
    this._winDrag = null; // активное перетаскивание окна
    this._moved = false; // был ли drag — чтобы не путать с кликом
    this._ro = null;

    this._colors = this.readColors();
    this.listen('theme:changed', () => {
      this._colors = this.readColors();
      if (!this._open) return;
      this.draw();
      const dots = this.mount.querySelectorAll('.graph__dot');
      if (dots[0]) dots[0].style.background = C_DEP;
      if (dots[1]) dots[1].style.background = C_BACK;
    });

    this.listen('graph:open', () => (this._open ? this.close() : this.open()));
    this.on(document, 'keydown', (e) => {
      if (!this._open) return;
      if (e.key === 'Escape') this.close();
      if (e.key === 'Backspace' && this._mode === 'focus') {
        e.preventDefault();
        this.backToOverview();
      }
    });
    // Перетаскивания обрабатываем на уровне документа (постоянно, с защитой),
    // чтобы курсор можно было увести за пределы окна и не терять захват.
    this.on(document, 'mousemove', (e) => this.onDocMove(e));
    this.on(document, 'mouseup', () => this.onDocUp());

    onEvent('index:ready', (root) => {
      if (!this._open) return;
      if (root && this._root && root !== this._root) return;
      // Свою пересборку («Обновить») сопровождаем плашкой; чужую, фоновую —
      // обновляем тихо, чтобы только что показанное «Загружено!» не сменялось
      // снова «Загрузкой».
      const wasSelf = this._selfRebuild;
      this._selfRebuild = false;
      this._indexing = false;
      this.updateRebuildButton();
      // Данные обновляем ВСЕГДА тихо (без мелькания «Загрузка…»). Если это была
      // своя пересборка («Обновить») — показываем «Загружено!»; фоновую сборку
      // не афишируем.
      this.refetch({ silent: true });
      if (wasSelf) this.markLoaded();
      else this.updateLoadingState();
    }).then((un) => this._cleanups.push(un));

    // Живой прогресс фонового построения индекса — чтобы было видно, что идёт
    // работа, а не «висит». Узлы появятся по index:ready (refetch выше).
    onEvent('index:progress', (p) => {
      if (!this._open) return;
      if (p && p.root && this._root && p.root !== this._root) return;
      // Прогресс показываем ТОЛЬКО для сборки, запущенной из самого графа
      // («Обновить» → rebuild() выставляет _indexing). Фоновую индексацию
      // (например, из палитры) не латчим — иначе плашка «Загрузка» зависала бы,
      // не дождавшись своего index:ready.
      if (!this._indexing) return;
      this._indexCount = (p && p.count) || 0;
      this._indexTotal = (p && p.total) || 0;
      this._indexPhase = (p && p.phase) || 'scan';
      this.updateLoadingState();
      this.updateRebuildButton();
    }).then((un) => this._cleanups.push(un));
  }

  /* ── Открытие / закрытие ─────────────────── */

  open() {
    const state = this.store.getState();
    this._side = getActiveSide(state);
    const pane = getPane(state, this._side);
    this._root = pane.path || '';
    const selected = (pane.selected || []).filter(Boolean);
    const entries = pane.entries || [];

    let seeds;
    if (selected.length) {
      this._mode = 'focus';
      this._focus = selected[0];
      seeds = selected;
    } else {
      this._mode = 'overview';
      this._focus = null;
      seeds = null; // обзорные сиды собираем асинхронно ниже (текущая папка + индекс)
    }

    this._ox = 0;
    this._oy = 0;
    this._zoom = 1;
    // При открытии — чистый старт
    this._nodes.clear();
    this._edges = [];
    this._appeared.clear();
    this._appearQueue = [];
    this._hashes.clear();
    this._hashing = false;
    this._hashSeq++;
    this._indexing = false;
    this._indexCount = 0;
    this._selfRebuild = false;
    this._loaded = false;
    if (this._loadedTimer) {
      clearTimeout(this._loadedTimer);
      this._loadedTimer = null;
    }
    this._showBusy = false;
    if (this._busyTimer) {
      clearTimeout(this._busyTimer);
      this._busyTimer = null;
    }
    this.render();

    // Авто-сборку при открытии НЕ запускаем — только читаем уже готовый индекс
    // (если он есть, граф покажется мгновенно). Полная (пере)сборка — по кнопке
    // «Обновить» (rebuild()).
        if (this._mode === 'focus') {
          this.fetch(seeds, 1);
        } else {
          // Обзор: файлы текущей папки + проиндексированные файлы поддерева
          // (вложенные, напр. src/main.rs).
          this.overviewSeeds(this._root, entries).then((s) => {
            if (this._open) this.fetch(s, 1);
          });
        }
      }
    
      /** Сиды обзора: файлы текущей папки (всегда) + проиндексированные файлы
       *  поддерева из индекса (вложенные). Если индекс ещё не построен — останутся
       *  только файлы текущей папки. */
      async overviewSeeds(root, entries) {
        const key = (p) => (p || '').toLowerCase();
        const seen = new Set();
        const seeds = [];
        for (const e of entries.slice(0, OVERVIEW_CAP)) {
          if (e.path && !seen.has(key(e.path))) {
            seen.add(key(e.path));
            seeds.push(e.path);
          }
        }
        try {
          const files = await searchFiles(root, '', OVERVIEW_INDEX_CAP); // '' → все файлы поддерева
          for (const f of files || []) {
            if (seeds.length >= OVERVIEW_INDEX_CAP) break;
            if (f.path && !seen.has(key(f.path))) {
              seen.add(key(f.path));
              seeds.push(f.path);
            }
          }
        } catch {
          /* индекс недоступен — покажем только файлы текущей папки */
        }
        return seeds;
      }

  close() {
    if (!this._open) return;
    this._open = false;
    this.stopSim();
    if (this._appearTimer) {
      clearInterval(this._appearTimer);
      this._appearTimer = null;
    }
    if (this._ro) {
      this._ro.disconnect();
      this._ro = null;
    }
    this._pan = null;
    this._winDrag = null;
    this._loading = false;
    this._indexing = false;
    this._selfRebuild = false;
    this._loaded = false;
    if (this._loadedTimer) {
      clearTimeout(this._loadedTimer);
      this._loadedTimer = null;
    }
    this._showBusy = false;
    if (this._busyTimer) {
      clearTimeout(this._busyTimer);
      this._busyTimer = null;
    }
    this._hashing = false;
    this._hashSeq++;
    this._hashes.clear();
    this._appeared.clear();
    this._appearQueue = [];
    this.mount.innerHTML = '';
  }

  destroy() {
    this.stopSim();
    if (this._ro) this._ro.disconnect();
    super.destroy();
  }

  /* ── Загрузка данных ─────────────────────── */

  refetch({ silent = false } = {}) {
    this.fetch(this._curSeeds, this._curHops, { silent });
  }

  /** Принудительная (пере)сборка индекса связей — ТОЛЬКО по кнопке «Обновить».
   *  Авто-запуска при открытии графа нет. Узлы обновятся по событию index:ready. */
  rebuild() {
    if (this._indexing) return;
    if (!this._root) {
      this.bus.emit('shortcut:hint', 'Граф: сначала откройте папку');
      return;
    }
    this._indexing = true;
    this._selfRebuild = true; // эту сборку запускает сам граф → её index:ready не «тихий»
    this._indexCount = 0;
    this._indexTotal = 0;
    this._indexPhase = 'scan';
    this.updateLoadingState();
    this.updateRebuildButton();
    // content=true, force=true → полная пересборка в фоне с прогрессом.
    startIndex(this._root, true, true).catch(() => {
      this._indexing = false;
      this._selfRebuild = false;
      this.updateLoadingState();
      this.updateRebuildButton();
    });
  }

  /** Кнопка «Обновить»: заблокирована и подписана «Строю…» во время сборки. */
  updateRebuildButton() {
    if (!this._rebuildBtn) return;
    this._rebuildBtn.disabled = this._indexing;
    this._rebuildBtn.textContent = this._indexing ? 'Строю…' : 'Обновить';
  }

  async fetch(seeds, hops, { silent = false } = {}) {
    this._curSeeds = seeds;
    this._curHops = hops;
    const seq = ++this._fetchSeq;
    // silent=true — фоновое обновление (по чужому index:ready): данные графа
    // обновляем, но плашку «Загрузка…»/«Загружено!» не трогаем, иначе она бы
    // мигала с галочки обратно на спиннер.
    if (!silent) {
      this._loading = true;
      this.updateLoadingState();
    }
    let data;
    try {
      data = await fileGraph(seeds, hops);
    } catch (err) {
      if (seq === this._fetchSeq) {
        this._loading = false;
        this.updateLoadingState();
        this.bus.emit('shortcut:hint', `Граф: ${err.message}`);
      }
      return;
    }
    if (seq !== this._fetchSeq || !this._open) {
      // Стали старым запросом — сбрасываем _loading, иначе плашка «Загрузка…»
      // может залипнуть (старый fetch не сбрасывает флаг, а новый уже работает).
      if (this._loading && !silent) {
        this._loading = false;
        this.updateLoadingState();
      }
      return;
    }
    this.ingest(data, seeds);
    if (this._mode === 'focus' && this._focus) {
      this._connectedPaths = this.computeConnectedPaths(this._focus);
    }
    this.renderAside();
    // Кнопка хеширования доступна сразу, как только появились узлы (запуск —
    // только по клику, автоматически хеширование не стартует).
    this.updateHashButton();
    this._loading = false;
    // «Загружено!» показываем только для видимой загрузки (первичной или своей
    // пересборки), но не для фонового тихого обновления по чужому index:ready.
    if (!silent && !this._indexing) this.markLoaded();
    this.updateLoadingState();
    // Прогрессивная сборка: добавляем только новые узлы
    this.startProgressiveAppear();
  }

  ingest(data, seeds) {
    const rawNodes = (data && data.nodes) || [];
    const rawEdges = (data && data.edges) || [];
    const cx = this._w / 2;
    const cy = this._h / 2;

    // Фильтруем папки: они не отображаются как узлы графа
    const folderPaths = new Set();
    const fileNodes = rawNodes.filter((n) => {
      if (n.isDir) {
        folderPaths.add(n.path);
        return false;
      }
      return true;
    });

    // Убираем рёбра, ссылающиеся на папки (они не будут отображаться)
    const edges = rawEdges.filter((e) => !folderPaths.has(e.src) && !folderPaths.has(e.dst));

    // Инкрементальное слияние: старые узлы остаются, новые добавляются.
    // Позиции существующих узлов сохраняются — нет «прыжков» при refetch.
    fileNodes.forEach((n, i) => {
      if (this._nodes.has(n.path)) {
        // Обновляем мета-данные, но сохраняем позицию и скорость
        const prev = this._nodes.get(n.path);
        prev.name = n.name;
        prev.isDir = false;
      } else {
        const ang = (i / Math.max(fileNodes.length, 1)) * Math.PI * 2;
        const r = 80 + (i % 5) * 32;
        this._nodes.set(n.path, {
          path: n.path,
          name: n.name,
          isDir: false,
          x: cx + r * Math.cos(ang),
          y: cy + r * Math.sin(ang),
          vx: 0,
          vy: 0,
          w: NODE_MIN_W,
        });
      }
    });
    // Удаляем узлы, которых больше нет в данных (кроме seeds)
    const validPaths = new Set(fileNodes.map((n) => n.path));
    for (const s of seeds) {
      if (!folderPaths.has(s)) validPaths.add(s);
    }
    for (const path of [...this._nodes.keys()]) {
      if (!validPaths.has(path)) this._nodes.delete(path);
    }
    // Добавляем seed-пути, если их не оказалось в данных (только файлы, не папки)
    for (const s of seeds) {
      if (folderPaths.has(s)) continue;
      if (!this._nodes.has(s)) {
        this._nodes.set(s, {
          path: s,
          name: s.split(/[\\/]/).pop() || s,
          isDir: false,
          x: cx + (Math.random() - 0.5) * 40,
          y: cy + (Math.random() - 0.5) * 40,
          vx: 0,
          vy: 0,
          w: NODE_MIN_W,
        });
      }
    }
    this._edges = edges;
    if (this._mode === 'focus' && !this._nodes.has(this._focus)) {
      this._focus = seeds[0] || null;
    }
  }

  /* ── Прогрессивная сборка ─────────────────── */

  /** Запускает постепенное появление узлов на полотне.
   *  Уже появившиеся узлы остаются видимыми — не перезапускаем анимацию. */
  startProgressiveAppear() {
    // Только новые узлы (ещё не появившиеся) добавляем в очередь
    this._appearQueue = [...this._nodes.keys()].filter((p) => !this._appeared.has(p));
    if (this._appearTimer) clearInterval(this._appearTimer);
    if (this._appearQueue.length === 0) {
      // Все узлы уже видны — сразу запускаем физику
      this.onProgressiveDone();
      return;
    }
    this._appearTimer = setInterval(() => {
      for (let i = 0; i < APPEAR_BATCH && this._appearQueue.length > 0; i++) {
        this._appeared.add(this._appearQueue.shift());
      }
      this.draw();
      if (this._appearQueue.length === 0) {
        clearInterval(this._appearTimer);
        this._appearTimer = null;
        this.onProgressiveDone();
      }
    }, APPEAR_INTERVAL);
  }

  /** Все узлы появились — запускаем физику. Хеширование запускается кнопкой. */
  onProgressiveDone() {
    this.startSim();
    // Показываем кнопку хеширования
    this.updateHashButton();
  }

  /* ── Хеширование файлов графа ────────────── */

  async startHashing() {
    // Не перезапускаем если уже идёт
    if (this._hashing) return;

    const paths = [...this._nodes.keys()];
    // Хешируем только те файлы, которые ещё не прохешированы
    const unhashed = paths.filter((p) => !this._hashes.has(p));
    if (unhashed.length === 0) {
      this.updateHashButton();
      return;
    }

    this._hashing = true;
    this._hashSeq++;
    const mySeq = this._hashSeq;
    this._hashProgress = 0;
    this._hashTotal = unhashed.length;
    this.updateHashButton();
    try {
      const result = await hashGraphFiles(unhashed);
      // Проверяем что это не устаревший вызов и окно всё ещё открыто
      if (mySeq !== this._hashSeq || !this._open) {
        this._hashing = false;
        this.updateHashButton();
        return;
      }
      for (const h of result) {
        if (h.hash) this._hashes.set(h.path, h.hash);
      }
    } catch (err) {
      // хеширование не критично — молча глотаем
    }
    this._hashing = false;
    this.updateHashButton();
    this.draw();
  }

  /* ── Физика ──────────────────────────────── */

  startSim() {
    this._alpha = 1;
    if (this._raf) return;
    const tick = () => {
      this.step();
      this.draw();
      this._alpha *= 0.985;
      if (this._alpha > ALPHA_MIN && this._open) {
        this._raf = requestAnimationFrame(tick);
      } else {
        this._raf = null;
        this.draw();
      }
    };
    this._raf = requestAnimationFrame(tick);
  }

  stopSim() {
    if (this._raf) cancelAnimationFrame(this._raf);
    this._raf = null;
  }

  step() {
    const nodes = [...this._nodes.values()];
    const cx = this._w / 2;
    const cy = this._h / 2;
    const a = this._alpha;

    for (let i = 0; i < nodes.length; i++) {
      for (let j = i + 1; j < nodes.length; j++) {
        const p = nodes[i];
        const q = nodes[j];
        let dx = p.x - q.x;
        let dy = p.y - q.y;
        let d2 = dx * dx + dy * dy;
        if (d2 < 0.01) {
          dx = Math.random() - 0.5;
          dy = Math.random() - 0.5;
          d2 = 0.01;
        }
        const f = (REPULSION / d2) * a;
        const d = Math.sqrt(d2);
        const fx = (dx / d) * f;
        const fy = (dy / d) * f;
        p.vx += fx;
        p.vy += fy;
        q.vx -= fx;
        q.vy -= fy;
      }
    }

    for (const e of this._edges) {
      const p = this._nodes.get(e.src);
      const q = this._nodes.get(e.dst);
      if (!p || !q) continue;
      const dx = q.x - p.x;
      const dy = q.y - p.y;
      const d = Math.hypot(dx, dy) || 0.01;
      const f = SPRING_K * (d - SPRING_LEN) * a;
      const fx = (dx / d) * f;
      const fy = (dy / d) * f;
      p.vx += fx;
      p.vy += fy;
      q.vx -= fx;
      q.vy -= fy;
    }

    // гравитация к центру + интегрирование. Границами НЕ ограничиваем —
    // узлы свободно расходятся, за край видно панорамированием/зумом.
    for (const p of nodes) {
      p.vx += (cx - p.x) * GRAVITY * a;
      p.vy += (cy - p.y) * GRAVITY * a;
      p.vx *= DAMPING;
      p.vy *= DAMPING;
      if (this._mode === 'focus' && p.path === this._focus) {
        p.x = cx;
        p.y = cy;
        p.vx = 0;
        p.vy = 0;
        continue;
      }
      p.x += p.vx;
      p.y += p.vy;
    }
  }

  /* ── Отрисовка полотна ───────────────────── */

  draw() {
    const c = this.ctx;
    if (!c) return;
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.clearRect(0, 0, this._w, this._h);

    if (!this._nodes.size) {
      c.fillStyle = this._colors.labelDim;
      c.font = '14px sans-serif';
      c.textAlign = 'center';
      c.fillText('Связей не найдено', this._w / 2, this._h / 2);
      return;
    }

    // Применяем пан/зум: рисуем в «мировых» координатах.
    c.setTransform(this._zoom, 0, 0, this._zoom, this._ox, this._oy);
    for (const e of this._edges) {
      const p = this._nodes.get(e.src);
      const q = this._nodes.get(e.dst);
      if (!p || !q) continue;
      // Рисуем ребро только если оба узла уже появились
      if (!this._appeared.has(p.path) || !this._appeared.has(q.path)) continue;
      this.drawEdge(c, p, q, e);
    }
    for (const n of this._nodes.values()) this.drawNode(c, n);
    c.setTransform(1, 0, 0, 1, 0, 0);
  }

  readColors() {
    const cs = getComputedStyle(document.documentElement);
    const v = (name, fb) => cs.getPropertyValue(name).trim() || fb;
    return {
      dep: v('--accent', C_DEP),
      back: v('--tag-progress', C_BACK),
      folder: v('--accent-2', '#14b8a6'),
      file: v('--text-faint', '#5b6478'),
      // Текст на полотне — из токенов, чтобы читался и в светлой теме
      // (раньше был захардкожен «светлым под тёмное» и пропадал на светлом фоне).
      label: v('--text', '#e5e7eb'),
      labelDim: v('--text-dim', '#9ca3af'),
    };
  }

  /** Определяет цвет и стиль стрелки по типу ребра.
   *  Зелёный — зависимость (src→dst), жёлтый — обратная ссылка (dst→seed).
   *  В режиме фокуса: исходящие от фокуса = зелёный, входящие в фокус = жёлтый.
   *  В режиме обзора: по kind ребра. */
  edgeStyle(e) {
    // Ручные связи — пунктир, нейтральный цвет
    if (e.kind === 'manual') return { color: C_MANUAL, dash: [5, 4], arrow: false, strong: false };
    // В режиме фокуса — исходящие зелёные, входящие жёлтые
    if (this._focus) {
      if (e.src === this._focus) return { color: C_DEP, dash: [], arrow: true, strong: true };
      if (e.dst === this._focus) return { color: C_BACK, dash: [], arrow: true, strong: true };
    }
    // В режиме обзора или для транзитных рёбер:
    // зависимости (import/include) — зелёный, упоминания — тусклый
    if (e.kind === 'mention') return { color: C_MENTION, dash: [2, 4], arrow: true, strong: false };
    // Остальные рёбра (контекстные) — зелёный по умолчанию (зависимость)
    return { color: C_DEP, dash: [], arrow: true, strong: false };
  }

  drawEdge(c, p, q, e) {
    const st = this.edgeStyle(e);
    // В режиме фокуса: рёбра без прямой связи с фокусом — полупрозрачные
    const isRelated = !this._focus || !this._connectedPaths ||
      (this._connectedPaths.has(e.src) && this._connectedPaths.has(e.dst));
    if (!isRelated) c.globalAlpha = 0.35;
    c.strokeStyle = st.color;
    c.fillStyle = st.color;
    c.lineWidth = st.strong ? 2 : 1.2;
    c.setLineDash(st.dash);
    c.beginPath();
    // Стрелка от края панели p к краю панели q
    const dx = q.x - p.x;
    const dy = q.y - p.y;
    const ang = Math.atan2(dy, dx);
    // Точка на границе панели p
    const pEdge = this.edgePoint(p, ang, p.w || NODE_MIN_W, NODE_H);
    // Точка на границе панели q
    const qEdge = this.edgePoint(q, ang + Math.PI, q.w || NODE_MIN_W, NODE_H);
    c.moveTo(pEdge.x, pEdge.y);
    c.lineTo(qEdge.x, qEdge.y);
    c.stroke();
    c.setLineDash([]);
    if (st.arrow) {
      const a1 = ang + Math.PI - 0.4;
      const a2 = ang + Math.PI + 0.4;
      c.beginPath();
      c.moveTo(qEdge.x, qEdge.y);
      c.lineTo(qEdge.x + Math.cos(a1) * 8, qEdge.y + Math.sin(a1) * 8);
      c.lineTo(qEdge.x + Math.cos(a2) * 8, qEdge.y + Math.sin(a2) * 8);
      c.closePath();
      c.fill();
    }
    // Восстанавливаем прозрачность после несвязанного ребра
    if (!isRelated) c.globalAlpha = 1;
  }

  /** Точка на границе прямоугольной панели узла по углу от центра. */
  edgePoint(n, angle, w, h) {
    const hw = w / 2;
    const hh = h / 2;
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    // Пересечение луча с прямоугольником
    let t;
    if (Math.abs(cos) * hh > Math.abs(sin) * hw) {
      t = hw / Math.abs(cos);
    } else {
      t = hh / Math.abs(sin);
    }
    return { x: n.x + cos * t, y: n.y + sin * t };
  }

  drawNode(c, n) {
    if (!this._appeared.has(n.path)) return; // ещё не появился

    // В режиме фокуса: не связанные с фокусом узлы — полупрозрачные
    const isRelated = !this._focus || !this._connectedPaths || this._connectedPaths.has(n.path);
    if (!isRelated) c.globalAlpha = 0.35;

    const isFocus = n.path === this._focus;
    const hasHash = this._hashes.has(n.path);

    // Вычисляем ширину панели по тексту
    c.font = NODE_FONT;
    const text = shortLabel(n.name, n.path);
    const textW = c.measureText(text).width;
    const nw = Math.min(NODE_MAX_W, Math.max(NODE_MIN_W, Math.ceil(textW) + NODE_PAD_X * 2));
    n.w = nw;
    const nh = NODE_H;
    const x = n.x - nw / 2;
    const y = n.y - nh / 2;

    // Цвет узла по расширению (как в файловой панели)
    const extCol = nodeColor(n.name);

    // Фон панели — тонированный цветом расширения
    c.beginPath();
    this.roundRect(c, x, y, nw, nh, NODE_RADIUS);
    const bgColor = extCol + (isFocus ? '30' : '18');
    c.fillStyle = bgColor;
    c.fill();

    // Рамка — цвет ПАПКИ узла (тот же, что у вкладки этой папки): файлы одной
    // папки визуально группируются. Заливка остаётся по расширению файла.
    const folderCol = pathToColor(parentDir(n.path));
    c.lineWidth = isFocus ? 2.5 : 1.5;
    c.strokeStyle = isFocus ? folderCol : folderCol + 'cc';
    c.stroke();

    // Текст внутри панели — показываем путь (папка/файл) вместо просто имени
    const labelText = shortLabel(n.name, n.path);
    c.fillStyle = this._colors.label;
    c.font = isFocus ? 'bold ' + NODE_FONT : NODE_FONT;
    c.textAlign = 'center';
    c.textBaseline = 'middle';
    c.fillText(labelText, n.x, n.y);
    c.textBaseline = 'alphabetic';

    // Иконка хеширования (маленький кружок-спиннер в правом верхнем углу)
    if (this._hashing) {
      const ix = x + nw - 6;
      const iy = y + 6;
      c.beginPath();
      c.arc(ix, iy, 3.5, 0, Math.PI * 2);
      c.fillStyle = extCol + '66';
      c.fill();
      // Вращающаяся дуга
      const angle = (Date.now() / 200) % (Math.PI * 2);
      c.beginPath();
      c.arc(ix, iy, 3.5, angle, angle + Math.PI * 0.8);
      c.strokeStyle = extCol;
      c.lineWidth = 1.5;
      c.stroke();
    } else if (hasHash) {
      // Галочка — файл прохеширован
      const ix = x + nw - 8;
      const iy = y + 6;
      c.beginPath();
      c.arc(ix, iy, 4, 0, Math.PI * 2);
      c.fillStyle = extCol + '44';
      c.fill();
      c.beginPath();
      c.moveTo(ix - 2, iy);
      c.lineTo(ix - 0.5, iy + 2);
      c.lineTo(ix + 2.5, iy - 2);
      c.strokeStyle = extCol;
      c.lineWidth = 1.2;
      c.stroke();
    }

    // Восстанавливаем прозрачность после несвязанного узла
    if (!isRelated) c.globalAlpha = 1;
  }

  /** Скруглённый прямоугольник (canvas path). */
  roundRect(c, x, y, w, h, r) {
    c.moveTo(x + r, y);
    c.lineTo(x + w - r, y);
    c.quadraticCurveTo(x + w, y, x + w, y + r);
    c.lineTo(x + w, y + h - r);
    c.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
    c.lineTo(x + r, y + h);
    c.quadraticCurveTo(x, y + h, x, y + h - r);
    c.lineTo(x, y + r);
    c.quadraticCurveTo(x, y, x + r, y);
    c.closePath();
  }

  /* ── Боковые списки ──────────────────────── */

  renderAside() {
    if (!this.aside) return;
    const focus = this._focus;
    if (!focus) {
      this.aside.innerHTML = `<div class="graph__empty">Кликните узел, чтобы увидеть его зависимости и обратные ссылки.</div>`;
      return;
    }
    const fnode = this._nodes.get(focus);
    const deps = [];
    const backs = [];
    const manual = [];
    for (const e of this._edges) {
      if (e.kind === 'manual') {
        if (e.src === focus) manual.push(e.dst);
        else if (e.dst === focus) manual.push(e.src);
        continue;
      }
      if (e.src === focus) deps.push(e.dst);
      else if (e.dst === focus) backs.push(e.src);
    }
    const title = fnode ? shortLabel(fnode.name, fnode.path) : focus.split(/[\\/]/).pop();
    this.aside.innerHTML = `
      <div class="graph__focus" title="${escapeHtml(focus)}">${escapeHtml(title)}</div>
      ${this.listBlock('Зависимости', deps, 'dep')}
      ${this.listBlock('Обратные ссылки', backs, 'back')}
      ${manual.length ? this.listBlock('Ручные связи', manual, 'manual') : ''}
    `;
    this.aside.querySelectorAll('[data-reveal]').forEach((el) =>
      el.addEventListener('click', () => this.bus.emit('graph:reveal', { path: el.dataset.reveal })),
    );
  }

  listBlock(title, paths, cls) {
    const uniq = [...new Set(paths)];
    const items = uniq.length
      ? uniq
        .map((p) => {
          const node = this._nodes.get(p);
          const name = node ? shortLabel(node.name, node.path) : p.split(/[\\/]/).pop() || p;
          return `<li class="graph__item graph__item--${cls}" data-reveal="${escapeHtml(p)}" title="${escapeHtml(p)}">${escapeHtml(name)}</li>`;
        })
        .join('')
      : `<li class="graph__item graph__item--empty">—</li>`;
    return `<div class="graph__group"><div class="graph__group-title">${escapeHtml(title)} <span class="graph__count">${uniq.length}</span></div><ul class="graph__list">${items}</ul></div>`;
  }

  /* ── Разметка окна + события ─────────────── */

  render() {
    this._open = true;
    this.mount.innerHTML = `
      <div class="graph graph--window">
        <div class="graph__head" data-drag>
          <div class="graph__title">Граф связей</div>
          <div class="graph__legend">
            <span class="graph__dot" style="background:${C_DEP}"></span>зависимости
            <span class="graph__dot" style="background:${C_BACK}"></span>обратные ссылки
          </div>
          <button class="graph__rebuild" data-rebuild title="Построить / обновить граф связей">Обновить</button>
          <button class="graph__close" data-close title="Закрыть">×</button>
        </div>
        <div class="graph__body">
          <div class="graph__canvas-wrap">
            <canvas class="graph__canvas"></canvas>
            <div class="graph__loading" hidden>
              <div class="graph__spinner"></div>
              <span class="graph__loading-text">Загрузка…</span>
            </div>
            <button class="graph__hash-btn" hidden data-hash-btn>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 2l-2 2m-7.61 7.61a5.5 5.5 0 1 1-7.778 7.778 5.5 5.5 0 0 1 7.777-7.777zm0 0L15.5 7.5m0 0l3 3L22 7l-3-3m-3.5 3.5l3 3"/></svg>
              <span class="graph__hash-btn-text">Хешировать</span>
            </button>
          </div>
          <aside class="graph__aside"></aside>
        </div>
      </div>`;
    this.win = this.mount.querySelector('.graph');
    this.canvas = this.mount.querySelector('.graph__canvas');
    this.ctx = this.canvas.getContext('2d');
    this.aside = this.mount.querySelector('.graph__aside');
    this._loadingEl = this.mount.querySelector('.graph__loading');
    this._hashBtn = this.mount.querySelector('[data-hash-btn]');
    this._rebuildBtn = this.mount.querySelector('[data-rebuild]');

    this.mount
      .querySelectorAll('[data-close]')
      .forEach((el) => el.addEventListener('click', () => this.close()));
    if (this._hashBtn) {
      this._hashBtn.addEventListener('click', () => this.startHashing());
    }
    if (this._rebuildBtn) {
      this._rebuildBtn.addEventListener('click', () => this.rebuild());
    }

    const head = this.mount.querySelector('[data-drag]');
    head.addEventListener('mousedown', (e) => this.onHeadDown(e));

    this.canvas.addEventListener('mousedown', (e) => this.onCanvasDown(e));
    this.canvas.addEventListener('click', (e) => this.onClick(e));
    this.canvas.addEventListener('dblclick', (e) => this.onDblClick(e));
    this.canvas.addEventListener('wheel', (e) => this.onWheel(e), { passive: false });

    // Центрируем окно и подгоняем полотно под его размер.
    this.centerWindow();
    this.resizeCanvas();
    if (typeof ResizeObserver !== 'undefined') {
      this._ro = new ResizeObserver(() => this.resizeCanvas());
      this._ro.observe(this.canvas.parentElement);
    }
  }

  centerWindow() {
    const r = this.win.getBoundingClientRect();
    const left = Math.max(8, Math.round((window.innerWidth - r.width) / 2));
    const top = Math.max(8, Math.round((window.innerHeight - r.height) / 2));
    this.win.style.left = `${left}px`;
    this.win.style.top = `${top}px`;
  }

  resizeCanvas() {
    if (!this.canvas) return;
    const wrap = this.canvas.parentElement;
    const w = Math.max(50, wrap.clientWidth | 0);
    const h = Math.max(50, wrap.clientHeight | 0);
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
      this._w = w;
      this._h = h;
    }
    this.draw();
  }

  /** Показать плашку «Загружено!» — держится до следующей загрузки. */
  markLoaded() {
    if (this._loadedTimer) clearTimeout(this._loadedTimer);
    this._loadedTimer = null;
    this._loaded = true;
    this.updateLoadingState();
  }

  /** «Занят» для целей плашки. КЛЮЧЕВОЕ правило: спиннер «Загрузка…» показываем
   *  только на ПУСТОМ графе (первая отрисовка). Как только узлы есть, любые
   *  до-загрузки/refetch — фоновые и плашку НЕ поднимают; даже если флаг
   *  _loading из-за гонки залип true, спиннер поверх данных не появится.
   *  Пересборка (_indexing, кнопка «Обновить») показывается всегда. Это и
   *  устраняет «галочка → снова Загрузка» при уже отрисованном графе. */
  _isBusy() {
    return (this._loading && this._nodes.size === 0) || this._indexing;
  }

  /** Обновить индикатор: «Загрузка…»/«Индексирую…» при работе, «Загружено!»
   *  кратко по завершении, иначе скрыт. */
  updateLoadingState() {
    // Спиннер показываем не сразу, а через BUSY_DELAY: быстрые операции (мелкие
    // папки) не должны давать мелькающий индикатор. Если за время задержки работа
    // успела закончиться — спиннер вообще не появится, сразу «Загружено!».
    if (this._isBusy()) {
      if (!this._showBusy && !this._busyTimer) {
        this._busyTimer = setTimeout(() => {
          this._busyTimer = null;
          if (this._isBusy()) {
            this._showBusy = true;
            this.applyPlate();
          }
        }, BUSY_DELAY);
      }
    } else {
      if (this._busyTimer) {
        clearTimeout(this._busyTimer);
        this._busyTimer = null;
      }
      this._showBusy = false;
    }
    this.applyPlate();
  }

  /** Применить состояние к плашке. busyVisible — спиннер уже разрешён к показу
   *  (после задержки); «Загружено!» показывается мгновенно, без задержки. */
  applyPlate() {
    const busyVisible = this._showBusy && this._isBusy();
    const loadingVisible = busyVisible && this._loading && this._nodes.size === 0;
    const show = busyVisible || this._loaded;
    if (this._loadingEl) {
      this._loadingEl.hidden = !show;
      const done = !busyVisible && this._loaded;
      // Состояние «готово»: текст акцентный + галочка (CSS). Спиннер прячем
      // прямо здесь, из JS, чтобы не зависеть от того, обновлён ли CSS-файл.
      this._loadingEl.classList.toggle('is-done', done);
      const spin = this._loadingEl.querySelector('.graph__spinner');
      // Спиннер скрыт в двух случаях: «готово» (done=true, видна галочка) И
      // «простой» (!show, плашка целиком скрыта). При !done && show показываем
      // спиннер (идёт загрузка). Раньше при done→false спиннер всегда получал
      // display='', что вызывало его появление даже когда плашка была hidden.
      if (spin) spin.style.display = (done || !show) ? 'none' : '';
    }
    const txt = this.mount && this.mount.querySelector('.graph__loading-text');
    if (txt) {
      if (busyVisible && this._indexing) {
        if (this._indexPhase === 'relations') {
          txt.textContent = this._indexTotal
            ? `Строю связи… ${this._indexCount}/${this._indexTotal}`
            : 'Строю связи…';
        } else {
          txt.textContent = `Индексирую… ${this._indexCount} файлов`;
        }
      } else if (loadingVisible) {
        txt.textContent = 'Загрузка…';
      } else if (this._loaded) {
        txt.textContent = 'Загружено!';
      }
    }
  }

  /** Обновить состояние кнопки хеширования. */
  updateHashButton() {
    if (!this._hashBtn) return;
    if (this._hashing) {
      this._hashBtn.hidden = false;
      this._hashBtn.classList.add('is-hashing');
      this._hashBtn.querySelector('.graph__hash-btn-text').textContent = 'Хеширование…';
      this._hashBtn.disabled = true;
    } else {
      const paths = [...this._nodes.keys()];
      const unhashed = paths.filter((p) => !this._hashes.has(p));
      if (unhashed.length === 0) {
        this._hashBtn.hidden = true;
      } else {
        this._hashBtn.hidden = false;
        this._hashBtn.classList.remove('is-hashing');
        this._hashBtn.querySelector('.graph__hash-btn-text').textContent = `Хешировать (${unhashed.length})`;
        this._hashBtn.disabled = false;
      }
    }
  }

  /** Вернуться из фокусного режима к обзору графа. */
  backToOverview() {
    if (this._mode !== 'focus') return;
    this._mode = 'overview';
    this._focus = null;
    // Заново загружаем обзор для текущего корня
    const state = this.store.getState();
    const pane = getPane(state, this._side);
    const entries = pane.entries || [];
    this.overviewSeeds(this._root, entries).then((seeds) => {
      if (this._open) this.fetch(seeds, 1);
    });
  }

  /* ── Перетаскивание окна / панорамирование / зум ── */

  onHeadDown(e) {
    if (e.target.closest('button')) return; // клики по кнопкам — не drag
    this._winDrag = { x: e.clientX, y: e.clientY, left: this.win.offsetLeft, top: this.win.offsetTop };
    e.preventDefault();
  }

  onCanvasDown(e) {
    this._pan = { x: e.clientX, y: e.clientY, ox: this._ox, oy: this._oy };
    this._moved = false;
  }

  onDocMove(e) {
    if (this._winDrag) {
      const d = this._winDrag;
      this.win.style.left = `${d.left + (e.clientX - d.x)}px`;
      this.win.style.top = `${d.top + (e.clientY - d.y)}px`;
      return;
    }
    if (this._pan) {
      const dx = e.clientX - this._pan.x;
      const dy = e.clientY - this._pan.y;
      if (Math.abs(dx) + Math.abs(dy) > 3) this._moved = true;
      this._ox = this._pan.ox + dx;
      this._oy = this._pan.oy + dy;
      this.draw();
    }
  }

  onDocUp() {
    this._winDrag = null;
    this._pan = null;
  }

  onWheel(e) {
    e.preventDefault();
    const [sx, sy] = this.canvasPoint(e);
    const wx = (sx - this._ox) / this._zoom;
    const wy = (sy - this._oy) / this._zoom;
    const factor = e.deltaY < 0 ? 1.12 : 1 / 1.12;
    const z = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, this._zoom * factor));
    this._zoom = z;
    this._ox = sx - wx * z; // точка под курсором остаётся на месте
    this._oy = sy - wy * z;
    this.draw();
  }

  /* ── Координаты и попадание ──────────────── */

  // Координаты события в пикселях полотна (с учётом возможного масштаба CSS).
  canvasPoint(e) {
    const rect = this.canvas.getBoundingClientRect();
    const sx = ((e.clientX - rect.left) / rect.width) * this._w;
    const sy = ((e.clientY - rect.top) / rect.height) * this._h;
    return [sx, sy];
  }

  nodeAt(e) {
    const [sx, sy] = this.canvasPoint(e);
    const wx = (sx - this._ox) / this._zoom; // экран -> мир
    const wy = (sy - this._oy) / this._zoom;
    let best = null;
    let bestDist = Infinity;
    for (const n of this._nodes.values()) {
      if (!this._appeared.has(n.path)) continue;
      const nw = n.w || NODE_MIN_W;
      const nh = NODE_H;
      // Попадание в прямоугольник
      if (wx >= n.x - nw / 2 && wx <= n.x + nw / 2 && wy >= n.y - nh / 2 && wy <= n.y + nh / 2) {
        const d = Math.hypot(n.x - wx, n.y - wy);
        if (d < bestDist) {
          bestDist = d;
          best = n;
        }
      }
    }
    return best;
  }

  async onClick(e) {
    if (this._moved) {
      this._moved = false; // это было панорамирование, не клик
      return;
    }
    const node = this.nodeAt(e);
    if (!node) {
      // Клик по пустому месту — снимаем выделение, все узлы снова видны
      if (this._focus) {
        this._focus = null;
        this._connectedPaths = null;
        this._mode = 'overview';
        this.renderAside();
        this.draw();
      }
      return;
    }
    // Переключаем фокус без подгрузки новых данных:
    // все узлы остаются, несвязанные — полупрозрачными
    this._mode = 'focus';
    this._focus = node.path;
    this._connectedPaths = this.computeConnectedPaths(node.path);
    this.renderAside();
    this.draw();
  }

  /** Собрать множество путей узлов, связанных с фокусом (прямые связи обоих направлений). */
  computeConnectedPaths(focusPath) {
    const connected = new Set([focusPath]);
    for (const e of this._edges) {
      if (e.src === focusPath) connected.add(e.dst);
      if (e.dst === focusPath) connected.add(e.src);
    }
    return connected;
  }

  onDblClick(e) {
    const node = this.nodeAt(e);
    if (node) {
      this.bus.emit('graph:reveal', { path: node.path });
      this.close();
    } else {
      // двойной клик по пустому месту — сброс вида
      this._ox = 0;
      this._oy = 0;
      this._zoom = 1;
      this.draw();
    }
  }
}