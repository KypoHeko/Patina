// Палитры приложения. Тема — это атрибут data-theme на <html>; CSS-токены
// (styles/tokens.css) делают всю работу. Выбор сохраняется в localStorage.

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
    /* приватный режим / запрет хранилища — тема применится без сохранения */
  }
}

/** Применить сохранённую тему как можно раньше (до отрисовки компонентов). */
export function initTheme() {
  applyTheme(getTheme());
}
