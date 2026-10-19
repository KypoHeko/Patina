// CommandPalette — DOM: building the palette shell, rendering result rows,
// syncing the scope buttons, and re-rendering on language change.
// Mixed into CommandPalette.prototype.

import { el, escapeHtml } from '../../core/dom.js';
import { t, tagLabel } from '../../lib/i18n.js';
import { fileIcon } from '../../lib/icons.js';
import { TAGS } from '../../config/tags.js';

const DISPLAY_CAP = 300; // how many rows we show at once

export const RenderMixin = {
  render() {
    this.mount.innerHTML = '';
    const backdrop = el('div', { class: 'palette__backdrop', onClick: () => this.close() });
    const panel = el('div', { class: 'palette' });

    const head = el('div', { class: 'palette__head' });
    this._input = el('input', {
      class: 'palette__input',
      type: 'text',
      placeholder: t('palette.placeholder.folder'),
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
        title: t('palette.regex.title'),
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

    // Search scope switcher
    const scope = el('div', { class: 'palette__scope' });
    this._scopeFolderBtn = el(
      'button',
      { class: 'palette__scopebtn is-on', onClick: () => this.setScope('folder') },
      t('palette.scope.folder'),
    );
    this._scopeTreeBtn = el(
      'button',
      {
        class: 'palette__scopebtn' + (this.treeAllowed ? '' : ' is-disabled'),
        onClick: () => this.setScope('tree'),
        title: this.treeAllowed ? t('palette.scope.treeHint') : t('palette.scope.disabledTag'),
      },
      t('palette.scope.tree'),
    );
    this._reindexBtn = el(
      'button',
      {
        class: 'palette__scopebtn palette__reindex',
        title: t('palette.reindex.title'),
        onClick: () => this.forceReindex(),
      },
      '↻',
    );
    this._scopeContentBtn = el(
      'button',
      {
        class: 'palette__scopebtn' + (this.treeAllowed ? '' : ' is-disabled'),
        onClick: () => this.setScope('content'),
        title: this.treeAllowed ? t('palette.scope.contentHint') : t('palette.scope.disabledTag'),
      },
      t('palette.scope.content'),
    );
    scope.append(this._scopeFolderBtn, this._scopeTreeBtn, this._scopeContentBtn, this._reindexBtn);

    const chips = el('div', { class: 'palette__tags' });
    for (const tag of TAGS) {
      chips.append(
        el(
          'button',
          {
            class: 'palette__chip',
            dataset: { tag: tag.id },
            onClick: (e) => {
              if (this._activeTags.has(tag.id)) this._activeTags.delete(tag.id);
              else this._activeTags.add(tag.id);
              e.currentTarget.classList.toggle('is-on');
              this._sel = 0;
              this.rebuildTagFilter();
            },
          },
          el('span', { class: 'palette__dot', style: `background:${tag.color}` }),
          tagLabel(tag.id),
        ),
      );
    }

    this._resultsEl = el('div', { class: 'palette__results' });
    panel.append(head, scope, chips, this._resultsEl);
    this.mount.append(backdrop, panel);
    this.update();
  },

  _syncScopeUI() {
    if (this._scopeFolderBtn) this._scopeFolderBtn.classList.toggle('is-on', this._scope === 'folder');
    if (this._scopeTreeBtn) this._scopeTreeBtn.classList.toggle('is-on', this._scope === 'tree');
    if (this._scopeContentBtn) this._scopeContentBtn.classList.toggle('is-on', this._scope === 'content');
    if (this._input) this._input.placeholder = t(`palette.placeholder.${this._scope}`);
    // Update the scope buttons' titles — they depend on treeAllowed.
    if (this._scopeTreeBtn) this._scopeTreeBtn.title = this.treeAllowed ? t('palette.scope.treeHint') : t('palette.scope.disabledTag');
    if (this._scopeContentBtn) this._scopeContentBtn.title = this.treeAllowed ? t('palette.scope.contentHint') : t('palette.scope.disabledTag');
    if (this._reindexBtn) this._reindexBtn.title = t('palette.reindex.title');
    if (this._regexBtn) this._regexBtn.title = t('palette.regex.title');
  },

  renderResults() {
    if (this._loading) {
      this._results = [];
      this._resultsCount = 0;
      this._resultsEl.innerHTML = `<div class="palette__empty">${escapeHtml(this._indexing ? t('palette.indexing') : t('common.loading'))}</div>`;
      return;
    }
    const all = this.filtered();
    this._resultsCount = all.length;
    const shown = all.slice(0, DISPLAY_CAP);
    this._results = shown;
    if (this._sel >= shown.length) this._sel = Math.max(0, shown.length - 1);

    if (!shown.length) {
      this._resultsEl.innerHTML = `<div class="palette__empty">${escapeHtml(t('palette.empty'))}</div>`;
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
      html += `<div class="palette__more">${escapeHtml(t('palette.more', { shown: shown.length, all: all.length }))}</div>`;
    }
    this._resultsEl.innerHTML = html;

    this._resultsEl.querySelectorAll('.palette__item').forEach((it) => {
      it.addEventListener('click', () => this.activate(this._results[+it.dataset.i]));
    });
  },

  /** Re-render on language change. Preserves the open palette, query, scope, tags. */
  applyLang() {
    if (!this._open) return;
    this._syncScopeUI();
    // Tag chip buttons: the last child is the text label, we update it.
    const chips = this.mount.querySelectorAll('.palette__chip');
    chips.forEach((chip, i) => {
      const tag = TAGS[i];
      if (!tag) return;
      const last = chip.lastChild;
      if (last && last.nodeType === 3) last.textContent = tagLabel(tag.id);
    });
    this.update();
  },
};
