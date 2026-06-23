import { Component } from '../core/component.js';
import { THEMES, getTheme, setTheme } from '../lib/theme.js';
import { t } from '../lib/i18n.js';

// Palette selection menu. Opened from the topbar button (the 'theme:open' event),
// rendered as a popover beneath it. The choice applies instantly and is saved.
export class ThemeMenu extends Component {
  init() {
    this._open = false;
    this.listen('theme:open', () => (this._open ? this.close() : this.open()));
    this.on(document, 'keydown', (e) => {
      if (this._open && e.key === 'Escape') this.close();
    });
    this.on(document, 'mousedown', (e) => {
      if (!this._open) return;
      if (this.mount.contains(e.target) || e.target.closest('#theme-btn')) return;
      this.close();
    });
  }

  open() {
    this._open = true;
    this.render();
    const btn = document.getElementById('theme-btn');
    const pop = this.mount.querySelector('.theme-menu');
    if (btn && pop) {
      const r = btn.getBoundingClientRect();
      pop.style.top = `${Math.round(r.bottom + 6)}px`;
      pop.style.right = `${Math.round(window.innerWidth - r.right)}px`;
    }
    btn?.classList.add('is-on');
  }

  close() {
    if (!this._open) return;
    this._open = false;
    this.mount.innerHTML = '';
    document.getElementById('theme-btn')?.classList.remove('is-on');
  }

  select(id) {
    setTheme(id);
    this.bus.emit('theme:changed', id);
    this.close();
  }

  /** Re-render on language change (if the menu is open). */
  applyLang() {
    if (!this._open) return;
    this.render();
  }

  render() {
    const active = getTheme();
    const rows = THEMES.map(
      (th) => `
      <button class="theme-menu__row${th.id === active ? ' is-active' : ''}" data-theme-id="${th.id}">
        <span class="theme-menu__swatch" style="background:${th.swatch}"></span>
        <span class="theme-menu__label">${t('theme.' + th.id)}</span>
        <span class="theme-menu__check" aria-hidden="true">${th.id === active ? '✓' : ''}</span>
      </button>`,
    ).join('');
    this.mount.innerHTML = `
      <div class="theme-menu__backdrop"></div>
      <div class="theme-menu" role="menu" aria-label="${t('theme.title')}">
        <div class="theme-menu__title">${t('theme.title')}</div>
        ${rows}
      </div>`;
    this.mount.querySelectorAll('[data-theme-id]').forEach((el) =>
      el.addEventListener('click', () => this.select(el.dataset.themeId)),
    );
  }
}
