// Application palettes. The theme is the data-theme attribute on <html>; CSS
// tokens (styles/tokens.css) do all the work. The choice is saved in localStorage.
// Palette labels are localized by id via i18n: t('theme.<id>').

const KEY = 'patina:theme';

export const THEMES = [
  { id: 'emerald', label: 'Тёмно-изумрудный', swatch: '#10b981' },
  { id: 'gold', label: 'Тёпло-золотой', swatch: '#c9a85c' },
  { id: 'light', label: 'Светло-голубая', swatch: '#0067c0' },
];

const DEFAULT = 'emerald';

function isKnown(id) {
  return THEMES.some((t) => t.id === id);
}

export function getTheme() {
  try {
    const v = localStorage.getItem(KEY);
    return isKnown(v) ? v : DEFAULT;
  } catch {
    return DEFAULT;
  }
}

export function applyTheme(id) {
  document.documentElement.dataset.theme = isKnown(id) ? id : DEFAULT;
}

export function setTheme(id) {
  applyTheme(id);
  try {
    localStorage.setItem(KEY, id);
  } catch {
    /* private mode / storage disabled — the theme applies without being saved */
  }
}

/** Apply the saved theme as early as possible (before components render). */
export function initTheme() {
  applyTheme(getTheme());
}
