// Работа с путями. Учитывает Windows (C:\...) и POSIX (/...).
// "C:" — это «текущая папка на диске C», а корень диска — "C:\" со слешем,
// поэтому подъём до буквы диска добавляет слеш.

export function parentPath(path) {
  const trimmed = String(path).replace(/[\\/]+$/, '');
  const idx = Math.max(trimmed.lastIndexOf('\\'), trimmed.lastIndexOf('/'));
  if (idx <= 0) return null;
  let parent = trimmed.slice(0, idx);
  if (/^[A-Za-z]:$/.test(parent)) parent += '\\'; // C: -> C:\
  return parent;
}

export function isRoot(path) {
  return /^[A-Za-z]:[\\/]?$/.test(path) || path === '/';
}

/** Отображаемое имя папки: последний сегмент; для корня диска — «C:». */
export function folderName(path) {
  const raw = String(path);
  if (/^[\\/]+$/.test(raw)) return '/'; // POSIX-корень
  const trimmed = raw.replace(/[\\/]+$/, '');
  if (!trimmed) return '';
  const drive = trimmed.match(/^[A-Za-z]:$/);
  if (drive) return drive[0]; // C:\ -> (после trim) C:
  const seg = trimmed.split(/[\\/]+/).filter(Boolean).pop();
  return seg || trimmed;
}

/** Разбить путь на хлебные крошки: [{ label, path }, ...]. */
export function pathCrumbs(path) {
  const trimmed = String(path).replace(/[\\/]+$/, '');
  if (!trimmed) return [];

  const drive = trimmed.match(/^[A-Za-z]:/);
  if (drive) {
    const root = drive[0];
    const rest = trimmed.slice(root.length).replace(/^[\\/]+/, '');
    const crumbs = [{ label: root, path: root + '\\' }];
    let acc = root + '\\';
    rest
      .split(/[\\/]+/)
      .filter(Boolean)
      .forEach((seg) => {
        acc = acc.endsWith('\\') ? acc + seg : acc + '\\' + seg;
        crumbs.push({ label: seg, path: acc });
      });
    return crumbs;
  }

  const crumbs = [{ label: '/', path: '/' }];
  let acc = '';
  trimmed
    .split(/[\\/]+/)
    .filter(Boolean)
    .forEach((seg) => {
      acc += '/' + seg;
      crumbs.push({ label: seg, path: acc });
    });
  return crumbs;
}
