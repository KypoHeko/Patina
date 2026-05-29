// Шаг 1: оживляем одну панель — показываем содержимое реальной папки.
// Это временный, намеренно простой bootstrap. На шаге 2 он переедет
// на стор + компоненты, а пока проверяем сквозной путь invoke -> Rust -> UI.

import { listDir, homeDir } from './api/fs.js';
import { formatSize, formatDate } from './lib/format.js';

const pathEl = document.getElementById('current-path');
const panelEl = document.getElementById('panel');
const statusEl = document.getElementById('statusbar');

let currentPath = '';

async function navigate(path) {
  try {
    const entries = await listDir(path);
    currentPath = path;
    render(entries);
  } catch (err) {
    showError(err);
  }
}

function render(entries) {
  pathEl.textContent = currentPath;

  const rows = entries
    .map((e) => {
      const icon = e.kind === 'folder' ? '📁' : '📄';
      const size = e.kind === 'folder' ? '' : formatSize(e.size);
      return `
        <div class="row" data-path="${esc(e.path)}" data-kind="${e.kind}">
          <span class="row__icon">${icon}</span>
          <span class="row__name">${esc(e.name)}</span>
          <span class="row__size">${size}</span>
          <span class="row__modified">${esc(formatDate(e.modified))}</span>
        </div>`;
    })
    .join('');

  panelEl.innerHTML = `
    <div class="panel__head">
      <button class="panel__up" id="go-up">↑ Вверх</button>
    </div>
    <div class="panel__list">${rows || '<div class="panel__empty">Папка пуста</div>'}</div>`;

  const folders = entries.filter((e) => e.kind === 'folder').length;
  statusEl.textContent = `${folders} папок · ${entries.length - folders} файлов`;

  panelEl
    .querySelectorAll('.row[data-kind="folder"]')
    .forEach((row) => row.addEventListener('dblclick', () => navigate(row.dataset.path)));

  document.getElementById('go-up').addEventListener('click', goUp);
}

function goUp() {
  const trimmed = currentPath.replace(/[\\/]+$/, '');
  const idx = Math.max(trimmed.lastIndexOf('\\'), trimmed.lastIndexOf('/'));
  if (idx <= 0) return;
  let parent = trimmed.slice(0, idx);
  if (/^[A-Za-z]:$/.test(parent)) parent += '\\';  // C: -> C:\
  navigate(parent);
}

function showError(err) {
  panelEl.innerHTML = `<div class="panel__error">${esc(err.message)}</div>`;
}

function esc(s) {
  return String(s ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );
}

(async function boot() {
  try {
    const start = await homeDir();
    await navigate(start);
  } catch (err) {
    showError(err);
  }
})();
