// Path handling. Accounts for Windows (C:\...) and POSIX (/...).
// "C:" means "the current folder on drive C", while the drive root is "C:\"
// with a slash, so going up to the drive letter adds a slash.

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

/** Display name of a folder: the last segment; for a drive root — "C:". */
export function folderName(path) {
  const raw = String(path);
  if (/^[\\/]+$/.test(raw)) return '/'; // POSIX root
  const trimmed = raw.replace(/[\\/]+$/, '');
  if (!trimmed) return '';
  const drive = trimmed.match(/^[A-Za-z]:$/);
  if (drive) return drive[0]; // C:\ -> (after trim) C:
  const seg = trimmed.split(/[\\/]+/).filter(Boolean).pop();
  return seg || trimmed;
}

/** Split a path into breadcrumbs: [{ label, path }, ...]. */
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
