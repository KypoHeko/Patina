import { Component } from '../core/component.js';
import { el } from '../core/dom.js';
import { revealInExplorer } from '../api/system.js';
import { assignTag, removeTag, tagsForPaths } from '../api/tags.js';
import { TAGS } from '../config/tags.js';
import { t, tagLabel } from '../lib/i18n.js';

function buildItems() {
  return [
    { label: t('ctx.open'), action: 'open' },
    { label: t('ctx.newFolder'), action: 'new-folder' },
    { label: t('ctx.reveal'), action: 'reveal' },
    { label: t('ctx.rename'), action: 'rename' },
    { sep: true },
    { label: t('ctx.duplicates'), action: 'duplicates' },
    { sep: true },
    { label: t('ctx.delete'), action: 'delete', danger: true },
  ];
}

export class ContextMenu extends Component {
  init() {
    this._open = false;
    this._ctx = null;
    this._entryTags = new Set();

    this.on(document, 'contextmenu', (e) => {
      const t = e.target;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      e.preventDefault();
    });
    this.listen('contextmenu:open', (payload) => this.openAt(payload));

    this.on(document, 'click', () => this.close());
    this.on(document, 'keydown', (e) => {
      if (e.key === 'Escape') this.close();
    });
    this.on(window, 'blur', () => this.close());
    this.on(window, 'resize', () => this.close());
    this.on(document, 'wheel', () => this.close(), { passive: true });
  }

  openAt({ x, y, entry, side }) {
    this._ctx = { entry, side };
    this._entryTags = new Set();
    this.render();

    const menu = this.mount.firstElementChild;
    const rect = menu.getBoundingClientRect();
    const px = x + rect.width > window.innerWidth ? x - rect.width : x;
    const py = y + rect.height > window.innerHeight ? y - rect.height : y;
    menu.style.left = `${Math.max(4, px)}px`;
    menu.style.top = `${Math.max(4, py)}px`;
    this._open = true;

    // Подтянуть текущие теги и подсветить активные точки.
    tagsForPaths([entry.path])
      .then((map) => {
        this._entryTags = new Set((map && map[entry.path]) || []);
        this.mount.querySelectorAll('.ctx-tag').forEach((d) => {
          d.classList.toggle('is-on', this._entryTags.has(d.dataset.tag));
        });
      })
      .catch(() => {});
  }

  close() {
    if (!this._open) return;
    this._open = false;
    this._ctx = null;
    this.mount.innerHTML = '';
  }

  /** Перерисовка при смене языка (если меню открыто). Сохраняет цель и позицию. */
  applyLang() {
    if (!this._open || !this._ctx) return;
    const menu = this.mount.firstElementChild;
    const prevLeft = menu && menu.style.left;
    const prevTop = menu && menu.style.top;
    this.render();
    const newMenu = this.mount.firstElementChild;
    if (newMenu) {
      if (prevLeft) newMenu.style.left = prevLeft;
      if (prevTop) newMenu.style.top = prevTop;
    }
    // Восстанавливаем подсветку активных тегов.
    this.mount.querySelectorAll('.ctx-tag').forEach((d) => {
      d.classList.toggle('is-on', this._entryTags.has(d.dataset.tag));
    });
  }

  render() {
    this.mount.innerHTML = '';
    const menu = el('div', { class: 'ctx-menu', onClick: (e) => e.stopPropagation() });

    // Полоска тегов
    const strip = el('div', { class: 'ctx-menu__tags' });
    for (const tag of TAGS) {
      strip.append(
        el('button', {
          class: 'ctx-tag',
          dataset: { tag: tag.id },
          title: tagLabel(tag.id),
          style: `background:${tag.color}`,
          onClick: (e) => {
            e.stopPropagation(); // не закрывать меню — можно навесить несколько
            this.toggleTag(tag.id, e.currentTarget);
          },
        }),
      );
    }
    menu.append(strip, el('div', { class: 'ctx-menu__sep' }));

    for (const item of buildItems()) {
      if (item.sep) {
        menu.append(el('div', { class: 'ctx-menu__sep' }));
        continue;
      }
      menu.append(
        el(
          'button',
          {
            class: 'ctx-menu__item' + (item.danger ? ' is-danger' : ''),
            onClick: () => this.run(item),
          },
          item.label,
        ),
      );
    }
    this.mount.append(menu);
  }

  async toggleTag(id, dotEl) {
    const entry = this._ctx?.entry;
    if (!entry) return;
    const on = this._entryTags.has(id);
    try {
      if (on) {
        await removeTag(entry.path, id);
        this._entryTags.delete(id);
      } else {
        await assignTag(entry.path, id);
        this._entryTags.add(id);
      }
      dotEl.classList.toggle('is-on', !on);
      this.bus.emit('tags:changed', { paths: [entry.path] });
    } catch (err) {
      this.bus.emit('shortcut:hint', err.message);
    }
  }

  run(item) {
    const ctx = this._ctx;
    this.close();
    if (!ctx) return;
    switch (item.action) {
      case 'open':
        this.bus.emit('file:activate', { side: ctx.side, entry: ctx.entry });
        break;
      case 'new-folder':
        this.bus.emit('folder:create', { side: ctx.side });
        break;
      case 'reveal':
        revealInExplorer(ctx.entry.path).catch((err) =>
          this.bus.emit('shortcut:hint', err.message),
        );
        break;
      case 'rename':
        this.bus.emit('file:rename', { side: ctx.side, entry: ctx.entry });
        break;
      case 'duplicates':
        this.bus.emit('duplicates:open');
        break;
      case 'delete':
        this.bus.emit('file:delete', { side: ctx.side });
        break;
      case 'hint':
        this.bus.emit('shortcut:hint', item.hint);
        break;
    }
  }
}
