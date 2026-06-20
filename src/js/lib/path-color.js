// Deterministic color from a path string + text color chosen by brightness.

export function pathToColor(path) {
  // djb2-like hash — deterministic, fast
  let hash = 0;
  for (let i = 0; i < path.length; i++) {
    hash = (Math.imul(31, hash) + path.charCodeAt(i)) | 0;
  }
  const r = (hash >> 16) & 0xff;
  const g = (hash >> 8) & 0xff;
  const b = hash & 0xff;
  // mix with gray [60..225] — avoids too-dark and blinding colors
  const mix = (c) => Math.floor(c * 0.65 + 60);
  return (
    '#' +
    [mix(r), mix(g), mix(b)].map((v) => v.toString(16).padStart(2, '0')).join('')
  );
}

function luminance(hex) {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return 0.299 * r + 0.587 * g + 0.114 * b;
}

// Black or white text based on the average background brightness (one or more colors).
export function textColorFor(...colors) {
  const avg = colors.reduce((s, c) => s + luminance(c), 0) / colors.length;
  return avg > 150 ? '#0a0a0f' : '#f5f5f5';
}
