import { Component } from '../core/component.js';
import { escapeHtml } from '../core/dom.js';
import { readPreview } from '../api/fs.js';
import { snapshotVersion, listVersions, restoreVersion, deleteVersion } from '../api/versions.js';
import { tagsForPaths } from '../api/tags.js';
import { TAGS } from '../config/tags.js';
import { formatSize, formatDate } from '../lib/format.js';
import { getPane } from '../state/panes.js';
import { getActiveSide } from '../state/tabs.js';
import { parentPath } from '../lib/paths.js';
import { t, tagLabel } from '../lib/i18n.js';

/**
 * Превью выбранного файла + информация + история версий.
 *
 * Секции (сверху вниз):
 *  1. Превью — миниатюра / текст / «нет превью»
 *  2. FILE INFO — имя, размер, дата изменения, дата создания
 *  3. VERSION HISTORY — список версий v1…vN с бейджем «текущая»
 *  4. Кнопки: Добавить / Сменить / Удалить*
 */
export class PreviewPanel extends Component {
  init() {
    this._open = false;
    this._path = null;
    this._preview = null;   // данные readPreview
    this._versions = [];    // список версий
    this._tags = [];        // id тегов выбранного файла
    this._verBusy = false;  // загрузка версий
    this._snapBusy = false; // создание снимка
    this._selectedVer = null; // id версии для восстановления/удаления
    this._currentVerId = null; // id версии, соответствующей текущему файлу
    this.mainEl = document.querySelector('.main');

    this.listen('preview:toggle', () => (this._open ? this.close() : this.openNow()));
    this.listen('tags:changed', () => {
      if (this._open) this.refreshTags();
    });
    // Внешние изменения файла (внешний редактор, restore из другого места,
    // и т.д.) — перечитываем превью целиком: текст, метаданные, версии, теги.
    // Без этого превью показывает устаревший контент после save во внешнем
    // редакторе или после restore из соседней панели.
    this.listen('fs:changed', ({ dirs }) => {
      if (!this._open || !this._path) return;
      const parent = parentPath(this._path);
      if (parent && dirs.includes(parent)) this.refreshPreview();
    });
    this.subscribe(() => {
      if (this._open) this.maybeLoad();
    });
    this.on(this.mount, 'click', (e) => this.onClick(e));
  }

  openNow() {
    this._open = true;
    this._path = null;
    this._preview = null;
    this._versions = [];
    this._tags = [];
    this._currentVerId = null;
    if (this.mainEl) this.mainEl.classList.add('has-dock');
    this.renderFrame();
    this.maybeLoad();
  }

  close() {
    this._open = false;
    this._path = null;
    this._preview = null;
    this._versions = [];
    this._tags = [];
    this._currentVerId = null;
    if (this.mainEl) this.mainEl.classList.remove('has-dock');
    this.mount.innerHTML = '';
  }

  selectedPath() {
    const s = this.store.getState();
    const sel = getPane(s, getActiveSide(s)).selected || [];
    return sel.length === 1 ? sel[0] : null;
  }

  async maybeLoad() {
    const path = this.selectedPath();
    if (path === this._path) return;
    this._path = path;
    this._preview = null;
    this._versions = [];
    this._tags = [];
    this._selectedVer = null;
    this._currentVerId = null; // сброс: для нового файла ещё не знаем «текущую»
    if (!path) {
      this.renderFrame();
      return;
    }
    // Показываем спиннер
    this.renderFrame();
    try {
      const [preview, versions, tagMap] = await Promise.all([
        readPreview(path),
        listVersions(path).catch(() => []),
        tagsForPaths([path]).catch(() => ({})),
      ]);
      if (this._path !== path) return; // выбор сменился
      this._preview = preview;
      this._versions = versions || [];
      this._tags = (tagMap && tagMap[path]) || [];
      this._selectedVer = null;
      // По умолчанию «текущая» — новейшая версия (предполагаем, что файл
      // соответствует ей, если только что открыли превью). После restore
      // _currentVerId будет переопределён в doRestore.
      this._currentVerId = this._versions[0]?.id || null;
      this.renderFrame();
    } catch (err) {
      if (this._path !== path) return;
      this._preview = null;
      this._versions = [];
      this._tags = [];
      this._currentVerId = null;
      this.renderFrame();
    }
  }
  
    /**
     * Перечитать превью, версии, теги и «текущую» версию для уже открытого файла.
     *
     * Используется:
     *  - после doSnapshot (файл не изменился, но добавилась новая версия, и
     *    возможно изменился mtime / размер — превью должно быть свежим);
     *  - после doRestore (файл перезаписан, контент и метаданные изменились);
     *  - по событию fs:changed (внешний редактор сохранил файл).
     *
     * Сохраняет _path и _selectedVer; обновляет всё остальное.
     */
    async refreshPreview() {
      if (!this._path) return;
      const path = this._path;
      // Сохраняем selectedVer — пользователь мог выделить строку версии.
      const savedSel = this._selectedVer;
      try {
        const [preview, versions, tagMap] = await Promise.all([
          readPreview(path),
          listVersions(path).catch(() => []),
          tagsForPaths([path]).catch(() => ({})),
        ]);
        if (this._path !== path) return; // выбор сменился за время запроса
        this._preview = preview;
        this._versions = versions || [];
        this._tags = (tagMap && tagMap[path]) || [];
        this._selectedVer = savedSel;
        // «Текущая» версия — та, что соответствует файлу. Если мы только что
        // сделали restore или snapshot, caller уже выставил _currentVerId явно
        // до вызова refreshPreview; иначе предполагаем новейшую (по умолчанию).
        if (!this._versions.some(v => v.id === this._currentVerId)) {
          this._currentVerId = this._versions[0]?.id || null;
        }
        this.renderFrame();
      } catch {
        if (this._path !== path) return;
        // Не удалось перечитать — оставляем прежнее состояние, чтобы пользователь
        // не увидел пустую панель из-за транзиентной ошибки.
      }
    }

  onClick(e) {
    if (e.target.closest('[data-close]')) return this.close();

    // Добавить версию (снимок)
    if (e.target.closest('[data-snap]')) {
      this.doSnapshot();
      return;
    }

    // Восстановить выбранную версию
    if (e.target.closest('[data-restore]')) {
      const btn = e.target.closest('[data-restore]');
      const id = +btn.dataset.restore;
      if (id) this.doRestore(id);
      return;
    }

    // Удалить версию
    if (e.target.closest('[data-del]')) {
      const btn = e.target.closest('[data-del]');
      const id = +btn.dataset.del;
      if (id) this.doDelete(id);
      return;
    }

    // Клик по строке версии — выделить
    const verRow = e.target.closest('[data-ver]');
    if (verRow) {
      this._selectedVer = +verRow.dataset.ver;
      this.renderFrame();
    }
  }

  async doSnapshot() {
    if (!this._path || this._snapBusy) return;
    this._snapBusy = true;
    this.renderFrame();
    try {
      this._versions = (await snapshotVersion(this._path)) || [];
      // Новый снимок становится «текущей» версией — файл не менялся, только
      // что сохранили его состояние.
      this._currentVerId = this._versions[0]?.id || null;
      this.bus.emit('shortcut:hint', t('pv.snapshotCreated'));
      // Перечитываем превью целиком: после snapshot файл мог получить новый
      // mtime/size (хотя контент тот же), и превью должно показать свежие
      // метаданные + актуальный текст (если он изменился между открытием
      // превью и кликом на «Добавить версию»).
      await this.refreshPreview();
    } catch (err) {
      this.bus.emit('shortcut:hint', err.message || t('pv.snapshotError'));
    }
    this._snapBusy = false;
    this.renderFrame();
  }

  async doRestore(id) {
    try {
      await restoreVersion(id);
      // После restore файл соответствует выбранной версии — отмечаем её как
      // «текущую» в UI. do_snapshot в бэкенде проверил has_hash_for_path и не
      // создал дубликат, если состояние уже было сохранено.
      this._currentVerId = id;
      this.bus.emit('fs:changed', { dirs: [parentPath(this._path)].filter(Boolean) });
      this.bus.emit('shortcut:hint', t('pv.versionRestored'));
      // Перечитываем превью: контент файла изменился (его перезаписал restore),
      // mtime обновился, размер мог измениться. refreshPreview покажет свежий
      // текст и метаданные. fs:changed выше тоже триггернет refreshPreview
      // (через подписку), но это дёшево — Promise.all параллелит запросы.
      await this.refreshPreview();
    } catch (err) {
      this.bus.emit('shortcut:hint', err.message || t('pv.restoreError'));
    }
  }

  async doDelete(id) {
    try {
      this._versions = (await deleteVersion(id)) || [];
      this.bus.emit('shortcut:hint', t('pv.versionDeleted'));
      this._selectedVer = null;
      // Если удалили «текущую» версию — сбрасываем к новейшей из оставшихся.
      if (this._currentVerId === id || !this._versions.some(v => v.id === this._currentVerId)) {
        this._currentVerId = this._versions[0]?.id || null;
      }
      this.renderFrame();
    } catch (err) {
      this.bus.emit('shortcut:hint', err.message || t('pv.deleteError'));
    }
  }

  async refreshVersions() {
    if (!this._path) return;
    try {
      this._versions = (await listVersions(this._path)) || [];
      // Если _currentVerId больше нет в списке (удалили?) — сброс к новейшей.
      if (this._currentVerId && !this._versions.some(v => v.id === this._currentVerId)) {
        this._currentVerId = this._versions[0]?.id || null;
      }
    } catch { this._versions = []; }
    this.renderFrame();
  }
  
    async refreshTags() {
      if (!this._path) {
        this._tags = [];
        return;
      }
      try {
        const map = await tagsForPaths([this._path]);
        this._tags = (map && map[this._path]) || [];
      } catch { this._tags = []; }
      this.renderFrame();
    }

  // ── Рендер ──────────────────────────────────────────────────
  
  /** Строка «Теги» для секции ИНФОРМАЦИЯ: цветные чипы. Если тегов нет — строка не выводится. */
  tagsRowHtml() {
    const ids = this._tags || [];
    if (!ids.length) return '';

      const chips = ids.map((id) => {
        const label = escapeHtml(tagLabel(id));
        const color = TAGS.find((x) => x.id === id)?.color || 'var(--tag-archive)';
        return `<span style="display:inline-flex;align-items:center;gap:4px">`
          + `<span class="tag-dot" style="background:${color}"></span>${label}</span>`;
      }).join('');
    const valHtml = `<span class="pv__info-val" style="white-space:normal;display:flex;flex-wrap:wrap;gap:4px 10px;justify-content:flex-end">${chips}</span>`;
    
    return `<div class="pv__info-row">
            <span class="pv__info-key">${escapeHtml(t('pv.info.tags'))}</span>
            ${valHtml}
          </div>`;
  }

  renderFrame() {
    if (!this._open) return;

    const p = this._preview;
    const path = this._path;
    const vers = this._versions;
    // Текущая версия — та, что соответствует файлу на диске. По умолчанию —
    // новейшая; после restore или snapshot _currentVerId указывает явно.
    const currentVersion = vers.find(v => v.id === this._currentVerId) || vers[0];

    // ── Превью ──
    let previewHtml;
    if (!path) {
      previewHtml = `<div class="pv__msg">${escapeHtml(t('pv.selectFile'))}</div>`;
    } else if (!p) {
      previewHtml = `<div class="pv__msg">${escapeHtml(t('common.loading'))}</div>`;
    } else if (p.kind === 'image') {
      previewHtml = `<div class="pv__imgwrap"><img class="pv__img" src="${escapeHtml(p.dataUrl || '')}" alt=""></div>`;
    } else if (p.kind === 'text') {
      previewHtml = `<pre class="pv__text">${escapeHtml(p.text || '')}</pre>`;
    } else {
      previewHtml = `<div class="pv__msg">${escapeHtml(t('pv.noPreview'))}</div>`;
    }

    // ── FILE INFO ──
    let infoHtml = '';
    if (p) {
      const modifiedStr = p.modified ? formatDate(p.modified) : '—';
      const createdStr = p.created ? formatDate(p.created) : '—';
      infoHtml = `
        <div class="pv__section">${escapeHtml(t('pv.infoSection'))}</div>
        <div class="pv__info">
          <div class="pv__info-row">
            <span class="pv__info-key">${escapeHtml(t('pv.info.name'))}</span>
            <span class="pv__info-val" title="${escapeHtml(p.name)}">${escapeHtml(p.name)}</span>
          </div>
          <div class="pv__info-row">
            <span class="pv__info-key">${escapeHtml(t('pv.info.size'))}</span>
            <span class="pv__info-val">${formatSize(p.size)}</span>
          </div>
          <div class="pv__info-row">
            <span class="pv__info-key">${escapeHtml(t('pv.info.modified'))}</span>
            <span class="pv__info-val pv__info-val--accent">${escapeHtml(modifiedStr)}</span>
          </div>
          <div class="pv__info-row">
            <span class="pv__info-key">${escapeHtml(t('pv.info.created'))}</span>
            <span class="pv__info-val">${escapeHtml(createdStr)}</span>
          </div>
          ${this.tagsRowHtml()}
          ${vers.length ? `<div class="pv__info-row">
            <span class="pv__info-key">${escapeHtml(t('pv.info.version'))}</span>
            <span class="pv__info-val pv__info-val--teal">${escapeHtml(currentVersion?.label || '—')} · ${escapeHtml(t('pv.info.current'))}</span>
          </div>` : ''}
        </div>`;
    }

    // ── VERSION HISTORY ──
    let verHtml = '';
    if (p) {
      let verListHtml;
      if (this._verBusy) {
        verListHtml = `<div class="pv__msg">${escapeHtml(t('common.loading'))}</div>`;
      } else if (vers.length === 0) {
        verListHtml = `<div class="pv__msg">${escapeHtml(t('pv.versions.empty'))}</div>`;
      } else {
        verListHtml = vers.map((v, i) => {
          const isCurrent = v.id === currentVersion?.id;
          const isSelected = v.id === this._selectedVer;
          return `<div class="pv__ver-row${isCurrent ? ' pv__ver-row--current' : ''}${isSelected ? ' pv__ver-row--selected' : ''}" data-ver="${v.id}">
            <span class="pv__ver-label${isCurrent ? ' pv__ver-label--current' : ''}">${escapeHtml(v.label)}</span>
            <span class="pv__ver-date">${escapeHtml(formatDate(v.ts))}</span>
            ${isCurrent ? `<span class="pv__ver-badge">${escapeHtml(t('pv.info.current'))}</span>` : ''}
          </div>`;
        }).join('');
      }

      verHtml = `
        <div class="pv__section">${escapeHtml(t('pv.versionsSection'))}</div>
        <div class="pv__ver-list">${verListHtml}</div>
        <div class="pv__ver-actions">
          <button class="pv__btn pv__btn--accent" data-snap ${this._snapBusy ? 'disabled' : ''}>
            ${this._snapBusy ? '…' : escapeHtml(t('pv.btn.add'))}
          </button>
          <button class="pv__btn" data-restore="${this._selectedVer || ''}" ${!this._selectedVer ? 'disabled' : ''}>
            ${escapeHtml(t('pv.btn.restore'))}
          </button>
          <button class="pv__btn pv__btn--danger" data-del="${this._selectedVer || ''}" ${!this._selectedVer ? 'disabled' : ''}>
            ${escapeHtml(t('pv.btn.delete'))}
          </button>
        </div>`;
    }

    // ── Сборка ──
    this.mount.innerHTML = `
      <div class="pv">
        <div class="pv__head">
          <div class="pv__title" title="${escapeHtml(p?.name || '')}">${escapeHtml(p?.name || t('pv.title'))}</div>
          <button class="pv__close" data-close title="${escapeHtml(t('common.close'))}">×</button>
        </div>
        <div class="pv__body">
          ${previewHtml}
          ${infoHtml}
          ${verHtml}
        </div>
      </div>`;
  }

  /** Перерисовка при смене языка. Сохраняет путь, версии, теги. */
  applyLang() {
    if (!this._open) return;
    this.renderFrame();
  }
}
