/**
 * Человекочитаемый размер файла.
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
 * Дата изменения в коротком локальном формате.
 * @param {number|null} ms
 * @returns {string}
 */
export function formatDate(ms) {
  if (!ms) return '';
  return new Date(ms).toLocaleString();
}
