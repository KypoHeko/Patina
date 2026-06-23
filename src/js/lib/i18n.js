// Internationalization. Analogous to lib/theme.js, but language requires
// re-rendering components (text lives in the DOM, not in CSS) — main.js handles that.
//
// Usage:
//   import { t } from '../lib/i18n.js';
//   t('panel.empty')                       -> "Folder is empty" (localized per current language)
//   t('status.selected', { n: 3 })         -> substitutes {n}

import { STRINGS } from '../config/locales.js';

const KEY = 'patina:lang';
const LANGS = ['ru', 'en'];
const DEFAULT = 'ru';

let _lang = DEFAULT;

/** Determine the starting language: saved choice → browser language → default. */
function detect() {
  try {
    const saved = localStorage.getItem(KEY);
    if (LANGS.includes(saved)) return saved;
  } catch {
    /* private mode — carry on */
  }
  try {
    if ((navigator.language || '').toLowerCase().startsWith('ru')) return 'ru';
    return 'en';
  } catch {
    return DEFAULT;
  }
}

export function getLang() {
  return _lang;
}

/** List of supported languages (for the switcher). */
export function languages() {
  return LANGS.slice();
}

export function setLang(lang) {
  _lang = LANGS.includes(lang) ? lang : DEFAULT;
  document.documentElement.lang = _lang;
  try {
    localStorage.setItem(KEY, _lang);
  } catch {
    /* the language applies without being saved */
  }
}

/** Apply the saved language as early as possible (before components mount). */
export function initLang() {
  setLang(detect());
}

/**
 * Translate a key. If the key is missing in the active language — fall back to
 * Russian, then to the key itself (so a gap is visible, not empty).
 * @param {string} key
 * @param {Object<string, string|number>} [vars] substitutions of the form {name}
 */
export function t(key, vars) {
  const table = STRINGS[_lang] || STRINGS[DEFAULT];
  let s = table[key];
  if (s === undefined) s = STRINGS[DEFAULT][key];
  if (s === undefined) return key;
  if (vars) {
    for (const k in vars) s = s.split(`{${k}}`).join(String(vars[k]));
  }
  return s;
}

/** Localized label of a predefined tag by its id. */
export function tagLabel(id) {
  return t(`tag.${id}`);
}
