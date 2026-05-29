# Patina — Чертёж проекта

Десктопный файловый менеджер для power-users.
**Стек:** Rust + Tauri 2 (v2.10+) + ванильный HTML/CSS/JS (нативные ES-модули, без сборщика).
**Приоритетная платформа:** Windows 10. Кроссплатформенный код изолирован и включается через feature-флаги.

---

## Принципы, на которых держится масштабируемость

1. **Единая граница с Tauri.** Весь `invoke()` живёт в `src/js/api/`. UI-компоненты вызывают только эти обёртки, никогда `window.__TAURI__` напрямую.
2. **Однонаправленное состояние.** Один observable-стор (`core/store.js`) + шина событий (`core/event-bus.js`). Компоненты не держат ссылок друг на друга.
3. **Единый жизненный цикл компонента.** Базовый класс `Component` (mount → render → destroy). `file-panel` инстанцируется дважды — для левой и правой панели.
4. **Индекс — это ядро.** Теги, граф связей, дубликаты и версии живут в SQLite. Файловая система их не хранит. Фронт читает из индекса, а не сканирует диск на каждый чих.
5. **Слои в бэкенде.** `commands` (IPC) → сервисы (`fs` / `index` / `indexer`) → репозитории (`index/*_repo.rs`) → модели. Платформенный код вынесен в `platform/` и закрыт `#[cfg(...)]`.

---

## Дерево проекта

```
patina/
├── .gitignore
├── README.md
├── package.json                 # ТОЛЬКО для Tauri CLI (@tauri-apps/cli). Фреймворков нет.
│
├── src/                         # ФРОНТЕНД — ванильный HTML/CSS/JS, без сборки
│   ├── index.html               # единственная точка входа; <div id="app"> + <script type="module" src="js/main.js">
│   │
│   ├── assets/
│   │   ├── fonts/
│   │   └── icons/               # svg-иконки (или один спрайт)
│   │
│   ├── styles/
│   │   ├── tokens.css           # ДИЗАЙН-ТОКЕНЫ: палитра #0a0a0f→#12121a→#1a1a28, emerald #10b981 / teal #14b8a6, отступы, радиусы. Тема меняется здесь и только здесь.
│   │   ├── base.css             # reset, типографика, кастомные скроллбары, overflow
│   │   ├── layout.css           # сетка приложения: topbar / tab-bar / sidebar / split-panes / status-bar
│   │   └── components/          # по одному файлу на компонент
│   │       ├── command-palette.css
│   │       ├── tab-bar.css
│   │       ├── sidebar.css
│   │       ├── file-panel.css
│   │       ├── context-menu.css
│   │       ├── relationship-graph.css
│   │       ├── duplicate-panel.css
│   │       ├── version-history.css
│   │       └── status-bar.css
│   │
│   └── js/
│       ├── main.js              # БУТСТРАП: создаёт стор, монтирует компоненты, поднимает шорткаты и подписку на события бэкенда
│       │
│       ├── core/                # инфраструктура, не знает о конкретных фичах
│       │   ├── store.js         # центральный observable-стор: getState / setState / subscribe
│       │   ├── event-bus.js     # pub/sub для меж-компонентных событий (open-context-menu, file-selected, ...)
│       │   ├── component.js     # базовый класс Component (mount/render/destroy, ссылка на стор и шину)
│       │   ├── dom.js           # мини-хелперы: el(tag, props, children), mount(), clear()
│       │   ├── view-state.js    # активная вкладка, какие панели открыты (без URL-роутинга)
│       │   └── shortcuts.js     # центральный менеджер клавиатуры (регистрация/разбор Ctrl+K/D/G и т.д.)
│       │
│       ├── api/                 # ЕДИНСТВЕННОЕ место, общающееся с Tauri (обёртки над invoke)
│       │   ├── invoke.js        # обёртка над window.__TAURI__.core.invoke + единая обработка ошибок
│       │   ├── fs.js            # listDir(path), getMetadata(), copy/move/delete
│       │   ├── tags.js          # listTags(), assignTag(), removeTag(), createTag()
│       │   ├── search.js        # query({ text, regex, filters })
│       │   ├── duplicates.js    # scanDuplicates(), listGroups(), resolve(action, fileId)
│       │   ├── versions.js      # listVersions(fileId), restore(versionId), snapshot()
│       │   ├── relationships.js # getGraph(rootId) -> { nodes, edges }
│       │   ├── system.js        # listDrives(), specialFolders(), nativeIcon(path)
│       │   └── events.js        # подписка на события из Rust (watcher изменил папку, прогресс индексатора)
│       │
│       ├── state/               # срезы состояния + селекторы (читаются компонентами)
│       │   ├── tabs.js          # модель вкладок (Projects, Documents, ...)
│       │   ├── panes.js         # пути левой/правой панели, сортировка
│       │   ├── selection.js     # выделенные файлы по панелям
│       │   └── ui.js            # флаги открытых панелей (graph/duplicates/versions), коллапс сайдбара
│       │
│       ├── components/          # UI — по одному модулю на компонент
│       │   ├── command-palette.js   # Ctrl+K, режим regex, фильтры по типу/тегам, мгновенные результаты
│       │   ├── tab-bar.js           # вкладки браузерного типа: close + "+"
│       │   ├── sidebar.js           # быстрый доступ, облако тегов, индикаторы хранилища (SSD/Cloud)
│       │   ├── file-panel.js        # ИНСТАНЦИРУЕМЫЙ: левая и правая панели = два экземпляра
│       │   ├── breadcrumbs.js       # хлебные крошки внутри панели
│       │   ├── context-menu.js      # ПКМ: Open / Tag / Rename / Find Duplicates / Show Versions / Delete
│       │   ├── relationship-graph.js# Ctrl+G, canvas-граф: узлы по типам, рёбра-зависимости, подсветка
│       │   ├── duplicate-panel.js   # Ctrl+D, группы дубликатов, схожесть, Keep/Delete
│       │   ├── version-history.js   # таймлайн версий, индикаторы Δразмера, Restore
│       │   └── status-bar.js        # путь, кол-во файлов, размер выделения, подсказки шорткатов
│       │
│       ├── lib/                 # чистые помощники, без состояния
│       │   ├── format.js        # formatFileSize, форматирование дат
│       │   ├── virtual-list.js  # ВИРТУАЛИЗАЦИЯ: рендер только видимых строк (папки на 100k+ файлов)
│       │   ├── regex.js         # безопасная компиляция regex для палитры
│       │   └── icons.js         # расширение → иконка
│       │
│       └── config/
│           ├── tags.js          # 5 тегов: urgent(red) / in-progress(amber) / done(green) / reference(cyan) / archive(gray)
│           └── keymap.js        # определения горячих клавиш
│
└── src-tauri/                   # БЭКЕНД — Rust
    ├── Cargo.toml
    ├── build.rs
    ├── tauri.conf.json          # конфиг Tauri (см. ниже)
    ├── capabilities/
    │   └── default.json         # разрешения Tauri 2 (модель capabilities)
    ├── icons/                   # иконки приложения (генерит `tauri icon`)
    │
    └── src/
        ├── main.rs              # точка входа: tauri::Builder, .manage(state), регистрация команд
        ├── lib.rs               # общая сборка приложения (удобно для тестов/будущего mobile)
        ├── state.rs             # AppState: пул соединений с БД, кэши — отдаётся через .manage()
        ├── error.rs             # единый тип Error + serde-сериализация для фронта
        │
        ├── commands/            # ТОНКИЕ обработчики IPC — только парсинг/делегирование в сервисы
        │   ├── mod.rs
        │   ├── fs.rs            # list_dir, read_metadata, файловые операции
        │   ├── tags.rs
        │   ├── search.rs
        │   ├── duplicates.rs
        │   ├── versions.rs
        │   ├── relationships.rs
        │   └── system.rs        # диски, спец-папки, нативные иконки
        │
        ├── fs/                  # СЛОЙ ФС (не зависит от Tauri)
        │   ├── mod.rs
        │   ├── lister.rs        # потоковая выдача содержимого директории
        │   ├── operations.rs    # copy / move / удаление в Корзину
        │   ├── metadata.rs      # stat, маппинг расширений
        │   └── watcher.rs       # слежка через crate `notify` → события во фронт
        │
        ├── index/               # СЛОЙ ИНДЕКСА — ядро масштабируемости (SQLite)
        │   ├── mod.rs
        │   ├── db.rs            # пул соединений, запуск миграций
        │   ├── schema/          # SQL-миграции (применяются по порядку)
        │   │   ├── 0001_init.sql           # files: id, path, name, ext, size, mtime, parent_id, hash
        │   │   ├── 0002_tags.sql           # tags, file_tags (M:N)
        │   │   ├── 0003_relationships.sql  # relationships: source_id, target_id, kind
        │   │   ├── 0004_versions.sql       # versions: file_id, ts, size, size_delta, blob_ref
        │   │   └── 0005_duplicates.sql     # duplicate_groups, group_members, similarity
        │   ├── files_repo.rs    # запросы к таблице files
        │   ├── tags_repo.rs
        │   ├── relationships_repo.rs
        │   ├── versions_repo.rs
        │   └── duplicates_repo.rs
        │
        ├── indexer/             # ФОНОВЫЕ воркеры, наполняющие индекс
        │   ├── mod.rs
        │   ├── scanner.rs       # первичный/полный обход дерева
        │   ├── usn_journal.rs   # Windows NTFS USN Journal: инкрементальная синхронизация без пересканов
        │   ├── hasher.rs        # очередь хеширования содержимого (для дубликатов)
        │   └── thumbnails.rs    # асинхронная генерация миниатюр + дисковый кэш
        │
        ├── platform/            # ОС-специфика, под feature-флагами
        │   ├── mod.rs
        │   └── windows.rs       # WinAPI (crate `windows`): SHGetFileInfo (иконки), IFileOperation (Корзина), диски, known folders
        │
        └── models/              # доменные структуры (serde), пересекающие IPC-границу
            ├── mod.rs
            ├── file.rs
            ├── tag.rs
            ├── relationship.rs
            ├── version.rs
            └── duplicate.rs
```

---

## Ключевые поля `src-tauri/tauri.conf.json`

Для ванили без сборщика важны три вещи: `withGlobalTauri` (чтобы во фронте был доступен `window.__TAURI__` без импортов npm), и указание на статическую папку фронта.

```jsonc
{
  "productName": "Patina",
  "identifier": "dev.patina.app",
  "build": {
    // без сборщика: фронт — это просто папка ../src
    "frontendDist": "../src",
    "devUrl": null,
    "beforeDevCommand": "",
    "beforeBuildCommand": ""
  },
  "app": {
    "withGlobalTauri": true,        // ← даёт window.__TAURI__ во фронте без импорта @tauri-apps/api
    "windows": [
      {
        "title": "Patina",
        "width": 1280,
        "height": 800,
        "minWidth": 900,
        "minHeight": 600,
        "decorations": true,
        "backgroundColor": "#0a0a0f"
      }
    ]
  }
}
```

> Замечание о dev-режиме: без сборщика «живой перезагрузки» из коробки нет. На старте это не нужно — `tauri dev` подхватит статику. Если позже захочешь HMR, можно поставить лёгкий статический сервер и указать его в `devUrl`; на архитектуру это не влияет.

---

## Стартовые зависимости `src-tauri/Cargo.toml`

```toml
[dependencies]
tauri = { version = "2", features = [] }
serde = { version = "1", features = ["derive"] }
serde_json = "1"
thiserror = "2"                      # удобные типы ошибок -> error.rs

# Индекс (выбери ОДНО):
rusqlite = { version = "0.32", features = ["bundled"] }   # синхронный, простой
# или
# sqlx = { version = "0.8", features = ["runtime-tokio", "sqlite"] }  # async

# Файловая система
notify = "7"                         # watcher.rs
walkdir = "2"                        # scanner.rs
blake3 = "1"                         # hasher.rs (быстрый хеш для дубликатов)

# Асинхронность для фоновых воркеров
tokio = { version = "1", features = ["rt-multi-thread", "sync", "fs"] }

[target.'cfg(windows)'.dependencies]
windows = { version = "0.58", features = [
  "Win32_UI_Shell",                  # SHGetFileInfo, IFileOperation
  "Win32_Storage_FileSystem",        # USN Journal, drives
  "Win32_Foundation",
] }
```

> Версии указаны как ориентир под начало 2026 — перед `cargo build` сверься с актуальными на crates.io, они часто обновляются.

---

## Рекомендуемый порядок реализации (после создания файлов)

1. **Скелет + один реальный вызов.** `index.html` → `main.js` → `api/fs.js` → команда `list_dir` в Rust. Цель: одна панель показывает содержимое настоящей папки вместо mock-data.
2. **Инфраструктура фронта.** `store.js`, `event-bus.js`, `component.js`, `shortcuts.js` — каркас, на который вешаются компоненты.
3. **Базовый UI.** `file-panel` (две панели через split), `breadcrumbs`, `status-bar`, `tab-bar`, `sidebar`.
4. **Индекс.** SQLite + миграции + `scanner.rs`. С этого момента появляется реальная основа для «умных» фич.
5. **Фичи поверх индекса:** теги → поиск/палитра → версии → дубликаты → граф связей.
6. **Windows-нативность:** иконки, Корзина, USN Journal для инкрементальной синхронизации индекса.
7. **Производительность:** виртуализация списка, кэш миниатюр.

Сначала всё на mock-данных из существующего прототипа — потом по одному источнику подменяем на реальные команды Rust.
```
