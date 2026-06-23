import { Component } from '../core/component.js';
import { el } from '../core/dom.js';
import { pathCrumbs } from '../lib/paths.js';
import { TAGS } from '../config/tags.js';
import { t, tagLabel } from '../lib/i18n.js';

const TAG_BY_ID = Object.fromEntries(TAGS.map((t) => [t.id, t]));
import { getPane } from '../state/panes.js';

// Panel header: a "Back" button (through history) + breadcrumbs.
// Going up a level is now done by clicking a breadcrumb segment or via the
// address bar (clicking the empty area of the header).
export class Breadcrumbs extends Component {
  constructor(ctx) {
    super(ctx);
    this.side = ctx.side;
    this.onNavigate = ctx.onNavigate; // navigate to a path
    this.onBack = ctx.onBack; // step back through history
    this._path = null;
    this._canBack = false;
    this._editing = false;
  }

  init() {
    this.on(this.mount, 'click', (e) => this.onClick(e));

    this.subscribe((state) => {
      const pane = getPane(state, this.side);
      const canBack = pane.historyIndex > 0;
      if (pane.path === this._path && canBack === this._canBack) return;
      this._path = pane.path;
      this._canBack = canBack;
      if (!this._editing) this.render();
    });

    const pane = getPane(this.store.getState(), this.side);
    this._path = pane.path;
    this._canBack = pane.historyIndex > 0;
    this.render();
  }

  onClick(e) {
    if (this._editing) return;
    if (e.target.closest('[data-back]')) return this.onBack();
    const crumb = e.target.closest('[data-crumb]');
    if (crumb) return this.onNavigate(crumb.dataset.crumb);
    if ((this._path || '').startsWith('tag:')) return; // in a tag folder the address is not editable
    this.enterEdit(); // click on empty space — address bar
  }

  enterEdit() {
    if (this._editing) return;
    this._editing = true;
    this.render();
  }

  exitEdit() {
    if (!this._editing) return;
    this._editing = false;
    this.render();
  }

  onEditKey(e) {
    if (e.key === 'Enter') {
      const value = this._input.value.trim();
      this.exitEdit();
      if (value) this.onNavigate(value);
    } else if (e.key === 'Escape') {
      this.exitEdit();
    }
  }

  /** Re-render on language change (updates the "Back" button title and the tag label). */
  applyLang() {
    if (this._editing) return;
    this.render();
  }

  render() {
    this.mount.innerHTML = '';

    if (this._editing) {
      this._input = el('input', {
        class: 'crumbs__edit',
        type: 'text',
        spellcheck: 'false',
        onKeydown: (e) => this.onEditKey(e),
        onBlur: () => this.exitEdit(),
      });
      this.mount.append(this._input);
      this._input.value = this._path || '';
      this._input.focus();
      this._input.select();
      return;
    }

    const backProps = { class: 'crumbs__back', 'data-back': '', title: t('crumbs.back') };
    if (!this._canBack) backProps.disabled = '';
    this.mount.append(el('button', backProps, '←'));

    if ((this._path || '').startsWith('tag:')) {
      const tag = TAG_BY_ID[this._path.slice(4)];
      const wrap = el('span', { class: 'crumbs__tag' });
      if (tag) {
        wrap.append(
          el('span', {
            class: 'crumbs__tagdot',
            style: `background:${tag.color}`,
          }),
        );
      }
      wrap.append(document.createTextNode(tag ? tagLabel(tag.id) : this._path.slice(4)));
      this.mount.append(wrap);
      return;
    }

    const crumbs = pathCrumbs(this._path);
    crumbs.forEach((c, i) => {
      this.mount.append(
        el('button', { class: 'crumbs__item', dataset: { crumb: c.path } }, c.label),
      );
      if (i < crumbs.length - 1) this.mount.append(el('span', { class: 'crumbs__sep' }, '›'));
    });
  }
}
