<div align="center">

# 🌿 Patina

**Experimental file manager**

`0.1` · Windows 10 · Rust + Tauri 2 · vanilla HTML/CSS/JS

</div>

---

## Why

Patina is an attempt to build a tool designed **around an index, not around a file list**: search, tags, a relationship graph, duplicate detection, and version history for any files, not just code.

---

## Features

### Navigation
- **Browser-style tabs** with state persistence and reopening of closed tabs (`Ctrl+Shift+T`).
- **Two panes** with independent navigation, breadcrumbs, and a draggable divider.
- **Virtualized list** — smooth performance on directories with tens of thousands of files.
- **Full keyboard navigation** — arrows, `Home`/`End`, `Enter` to open, `Backspace` to go up, `Shift+Arrow` to extend the selection (see [Hotkeys](#hotkeys)).
- **Right-click context menu** — open, show in Explorer, rename, tag (a whole selection at once), find duplicates, delete; the empty-area menu creates a folder.
- **Native file icons** (like in Explorer), loaded lazily and cached on disk.
- Columns: name, type, tags, size, modified date. Folder sizes are computed on demand with the **∑** button in the top bar (with progress), not on every visit.
- **Folder filter** in the top bar, with a `.*` toggle for regular expressions. Reloading a folder (an external change, a rename, a restore) keeps the filter, the selection and the scroll position.

### Search — command palette (`Ctrl+K`)
- Three search scopes: **current folder**, **whole subtree**, **file contents** (SQLite FTS5).
- **Regular expression** mode.
- Tag filter (intersection, AND).
- Results show the real spelling of names even though the index compares paths case-insensitively on Windows; search from a drive root (`C:\`, `/`) works.
- While the index of a large tree is still being built, the palette shows its progress; when the index hits its size cap, the palette says the results are partial.

### Organization
- **Color-coded tags**: Urgent, In progress, Done, Reference, Archive.
- **Tag cloud** in the sidebar with counters (only files that still exist are counted).
- **Quick access** (Home, Desktop, Documents, Downloads) — editable.
- **Storage indicators**: volume labels, media type (SSD/HDD), used/total.

### Smart tools
- **Relationship graph** (`Ctrl+G`) — an interactive canvas graph of dependencies and back-references between files. It reads the edges kept up to date by the live index instead of re-reading every file on open; **Rebuild** forces a full pass. The focus folder's `.gitignore` is honoured (toggle).
- **Duplicate finder** (`Ctrl+D`) — files are grouped by size, then large files by the hash of their first 64 KB, and only the remaining candidates are hashed in full (BLAKE3, several threads, cached in the index). Covers the whole subtree, can be cancelled, and lists the oldest copy first so **Keep first** keeps the likely original.
- **Version history** — from the preview panel: snapshot any file, browse a timeline, restore, and delete versions (with a confirmation). Before a restore a safety copy of the current state is taken automatically; the panel marks which version matches the file on disk, or says the current state is unsaved.
  - Blobs and chunks are written crash-safely (temp file → fsync → rename) and chunk hashes are verified when a file is reassembled; a restore replaces the file atomically and keeps its attributes (`ReplaceFileW` on Windows, permission bits elsewhere).
  - Deleting a file to the Recycle Bin no longer erases its history: the versions are kept for **30 days** and then collected. A background collector at startup also removes unreferenced blobs and chunks and stale temp files.
- **Preview** — image thumbnails and text, plus a file info panel (metadata, tags, versions).

### File operations
- Copy, move, rename (including a case-only rename such as `report.txt` → `Report.txt`), create folders. Tags and history follow moved and renamed files.
- **Drag-and-drop** — drag entries between panes or onto a folder to copy/move them.
- Delete **to the Recycle Bin** (native `IFileOperation` on Windows — UAC, long-path, and UNC-path support). If the user cancels part of the operation, only the files that are really gone are removed from the index.
- Name-conflict detection with a confirmation dialog.
- Open in the default app and "Show in Explorer".

### Appearance and language
- **Themes** — three palettes, switchable from the title bar and remembered between sessions: Dark Emerald (default), Warm Gold, and Light Blue.
- **Interface localization** — English and Russian. The language is auto-detected on first launch (browser locale, Russian by default), can be switched in the UI, and is remembered.

### Live index
- On startup the index catches up through the **NTFS USN Journal** when it can be read (NTFS/ReFS volume and administrator rights): only the paths changed since the saved cursor are re-read. Without the journal, after a journal reset, or on other OSes, a full rescan is done instead. The cursor is stored per root together with the journal ID.
- While the app runs, changes are picked up by the file watcher (`notify`); events are batched (300 ms of quiet, at most 2 s) so a `git checkout` does not trigger thousands of single updates.
- The content index is incremental: only files whose size or mtime changed since their text was indexed are re-read, in batches of 200.
- A newer index build cancels an older one for the same root instead of running in parallel.

---

## Hotkeys

### Global
| Combo | Action |
|---|---|
| `Ctrl+K` | Search / command palette |
| `Ctrl+D` | Duplicate finder |
| `Ctrl+G` | Relationship graph |
| `Ctrl+T` | New tab |
| `Ctrl+W` | Close tab |
| `Ctrl+Shift+T` | Reopen closed tab |
| `Ctrl+Shift+N` | Create folder |
| `Delete` | Delete selection to the Recycle Bin |

### List navigation
| Key | Action |
|---|---|
| `↑` / `↓` | Move the selection |
| `Home` / `End` | Jump to the first / last entry |
| `Shift+↑` / `Shift+↓` | Extend the selection |
| `Enter` | Open the file or enter the folder |
| `Backspace` | Go up to the parent folder |
| `Escape` | Close the palette / menu / dialog |

---

## Technology

| Layer | Stack |
|---|---|
| Backend | Rust, Tauri 2 |
| Index | SQLite (rusqlite, WAL; a separate read-only connection for queries), 16 migrations, FTS5 for contents |
| Hashing | BLAKE3 |
| Versions | content-addressed storage: full / zstd with a dictionary / chunked deduplication |
| Platform | WinAPI (`windows`): native icons, Recycle Bin, volumes, USN Journal, `ReplaceFileW`, `SHOpenFolderAndSelectItems` |
| Frontend | vanilla HTML/CSS/JS, native ES modules (no bundler) |
| i18n | built-in dictionary (English, Russian), no runtime dependencies |
| Tests / lint | Vitest + ESLint `no-unsanitized` (frontend), `cargo test` + `cargo clippy` (backend) |

Architecture: the frontend talks to the backend **only** through a thin layer of `invoke` wrappers (`src/js/api/`). State is a single observable store plus an event bus. The backend is split into layers: commands (IPC) → services (fs/index/indexer) → repositories → models; platform-specific code is isolated behind `cfg` flags.

Security:
- strict CSP, `freezePrototype`, disabled native drag-drop, minimal capabilities (`core:default`), no outbound network;
- the asset protocol only serves the thumbnail cache (`$APPDATA/thumbs/*`); everything else is read through commands;
- all data inserted into the DOM is escaped, and `npm run lint` (ESLint `no-unsanitized`) fails on a new unescaped `innerHTML`;
- names typed for rename / new folder must be one plain component; on Windows `:` (alternate data streams), reserved device names (`CON`, `NUL.txt`, `COM1`…) and trailing dots/spaces are rejected too;
- opening a runnable file (`.exe`, `.bat`, `.ps1`, `.msi`, …) on Windows asks for confirmation in a native dialog, which page scripts cannot answer;
- "Show in Explorer" goes through `SHOpenFolderAndSelectItems`, without building an `explorer.exe` command line;
- thumbnails are decoded with explicit limits (16 384 px per side, 384 MB), so a "decompression bomb" image cannot exhaust memory; SVG previews are capped at 2 MB.

---

## Build and run

**Requires:** Rust ≥ 1.85 (edition 2024), Node.js (only for frontend tests), [Tauri system dependencies](https://tauri.app/start/prerequisites/).

```bash
# Run in development mode
cargo tauri dev

# Release build (installer)
cargo tauri build

# Frontend tests and lint
npm install
npm test
npm run lint

# Backend tests and lint
cd src-tauri && cargo test && cargo clippy --all-targets
```

The Windows-only code (`cfg(windows)`: USN Journal, Recycle Bin, icons, drives, `ReplaceFileW`, shell reveal, the run confirmation) is compiled and tested only on Windows; the CI workflow in `.github/workflows/ci.yml` runs the backend on both Windows and Linux.

### Where data is kept
Everything lives in the app data folder (`%APPDATA%\dev.patina.app` on Windows): the SQLite index, the version store (`versions/`), the thumbnail cache (`thumbs/`) and the icon cache. Caches are pruned at startup (entries older than 30 days, at most 256 MB).

---

## Project structure

```
patina/
├── src/                 # frontend (vanilla)
│   ├── index.html
│   ├── js/
│   │   ├── api/         # the only boundary with Tauri (invoke wrappers)
│   │   ├── core/        # store, event bus, base Component, shortcuts
│   │   ├── components/  # UI components
│   │   ├── state/       # state slices (incl. the shared live-index tracker)
│   │   ├── lib/         # helpers (format, virtualization, regex, icons, i18n, theme)
│   │   ├── config/      # tags, keymap, locale dictionaries
│   │   └── test/        # Vitest tests
│   └── styles/          # theme tokens + per-component CSS
└── src-tauri/           # backend (Rust)
    └── src/
        ├── commands/    # thin IPC command layer
        ├── fs/          # file operations, atomic writes, name validation, caches
        ├── index/       # SQLite index, repositories, migrations (schema/), version store
        ├── indexer/     # background workers (scan, USN, hashes, links)
        ├── platform/    # OS specifics (WinAPI) + OS-independent parsers (USN records, icons)
        └── models/      # domain structs
```

---

## Status

**0.1 — early version.** The priority platform is Windows 10. Cross-platform code is partially in place, but it is not a goal of this release.

### Known limitations
- The "Cloud" storage type is not detected yet (shown as a plain "Disk"). Mapped network drives are listed without label and free space, so a dead server cannot stall the sidebar.
- The duplicate finder and content index work over the subtree of the active root.
- Restoring a version overwrites the live file (the current state is saved to history beforehand).
- Incremental startup through the USN Journal needs administrator rights; without them every start does a full rescan of the root.
- Interface localization covers English and Russian only.

---

## License

Dual-licensed under either of:

- Apache License, Version 2.0 ([LICENSE-APACHE](LICENSE-APACHE))
- MIT License ([LICENSE-MIT](LICENSE-MIT))

at your option.

Unless you explicitly state otherwise, any contribution intentionally submitted
for inclusion in this project, as defined in the Apache-2.0 license, shall be
dual-licensed as above, without any additional terms or conditions.
