// Интернационализация. Аналог lib/theme.js, но язык требует перерисовки
// компонентов (текст живёт в DOM, а не в CSS) — за это отвечает main.js.
//
// Использование:
//   import { t } from '../lib/i18n.js';
//   t('panel.empty')                       -> «Папка пуста» / «Folder is empty»
//   t('status.selected', { n: 3 })         -> подстановка {n}

import { STRINGS } from '../config/locales.js';

const KEY = 'patina:lang';
const LANGS = ['ru', 'en'];
const DEFAULT = 'ru';

let _lang = DEFAULT;

/** Определить стартовый язык: сохранённый выбор → язык браузера → дефолт. */
function detect() {
  try {
    const saved = localStorage.getItem(KEY);
    if (LANGS.includes(saved)) return saved;
  } catch {
    /* приватный режим — идём дальше */
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

/** Список поддерживаемых языков (для переключателя). */
export function languages() {
  return LANGS.slice();
}

export function setLang(lang) {
  _lang = LANGS.includes(lang) ? lang : DEFAULT;
  document.documentElement.lang = _lang;
  try {
    localStorage.setItem(KEY, _lang);
  } catch {
    /* язык применится без сохранения */
  }
}

/** Применить сохранённый язык как можно раньше (до монтажа компонентов). */
export function initLang() {
  setLang(detect());
}

/**
 * Перевести ключ. Если ключа нет в активном языке — откат на русский,
 * затем на сам ключ (чтобы пропуск был заметен, а не пустым).
 * @param {string} key
 * @param {Object<string, string|number>} [vars] подстановки вида {name}
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

/** Локализованная подпись предопределённого тега по его id. */
export function tagLabel(id) {
  return t(`tag.${id}`);
}
