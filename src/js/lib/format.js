import { getLang } from './i18n.js';

/**
 * Human-readable file size.
 * @param {number} bytes
 * @returns {string}
 */
export function formatSize(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '—';
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / 1024 ** i;
  return `${value.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

/**
 * Modification date in a short locale format.
 * The locale comes from i18n — dates and times are shown in the UI language.
 * @param {number|null} ms
 * @returns {string}
 */
export function formatDate(ms) {
  if (!ms) return '';
  const lang = (typeof getLang === 'function') ? getLang() : 'ru';
  return new Date(ms).toLocaleString(lang === 'en' ? 'en-US' : 'ru-RU');
}
