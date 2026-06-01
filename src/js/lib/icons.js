// Иконки файлов на основе Lucide (инлайновые SVG — проект без бандлера).
// Каждому расширению сопоставлены иконка Lucide и цвет (hex).

// Внутреннее содержимое SVG нужных иконок Lucide (viewBox 0 0 24 24).
const GLYPHS = {
  file: '<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/>',
  folder:
    '<path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/>',
  fileText:
    '<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/><path d="M16 13H8"/><path d="M16 17H8"/><path d="M10 9H8"/>',
  fileCode2:
    '<path d="M4 22h14a2 2 0 0 0 2-2V7l-5-5H6a2 2 0 0 0-2 2v4"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/><path d="m5 12-3 3 3 3"/><path d="m9 18 3-3-3-3"/>',
  braces:
    '<path d="M8 3H7a2 2 0 0 0-2 2v5a2 2 0 0 1-2 2 2 2 0 0 1 2 2v5c0 1.1.9 2 2 2h1"/><path d="M16 21h1a2 2 0 0 0 2-2v-5c0-1.1.9-2 2-2a2 2 0 0 1-2-2V5a2 2 0 0 0-2-2h-1"/>',
  image:
    '<rect width="18" height="18" x="3" y="3" rx="2" ry="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21"/>',
  palette:
    '<circle cx="13.5" cy="6.5" r=".5" fill="currentColor"/><circle cx="17.5" cy="10.5" r=".5" fill="currentColor"/><circle cx="8.5" cy="7.5" r=".5" fill="currentColor"/><circle cx="6.5" cy="12.5" r=".5" fill="currentColor"/><path d="M12 2C6.5 2 2 6.5 2 12s4.5 10 10 10c.926 0 1.648-.746 1.648-1.688 0-.437-.18-.835-.437-1.125-.29-.289-.438-.652-.438-1.125a1.64 1.64 0 0 1 1.668-1.668h1.996c3.051 0 5.555-2.503 5.555-5.554C21.965 6.012 17.461 2 12 2Z"/>',
  penTool:
    '<path d="m12 19 7-7 3 3-7 7-3-3z"/><path d="m18 13-1.5-7.5L2 2l3.5 14.5L13 18l5-5z"/><path d="m2 2 7.586 7.586"/><circle cx="11" cy="11" r="2"/>',
  table:
    '<path d="M12 3v18"/><rect width="18" height="18" x="3" y="3" rx="2"/><path d="M3 9h18"/><path d="M3 15h18"/>',
  type: '<polyline points="4 7 4 4 20 4 20 7"/><line x1="9" x2="15" y1="20" y2="20"/><line x1="12" x2="12" y1="4" y2="20"/>',
};

// Расширение -> [иконка, цвет hex]
const EXT = {
  // код
  ts: ['fileCode2', '#3b82f6'],
  tsx: ['fileCode2', '#3b82f6'],
  js: ['fileCode2', '#f7df1e'],
  mjs: ['fileCode2', '#f7df1e'],
  jsx: ['fileCode2', '#38bdf8'],
  css: ['fileCode2', '#38bdf8'],
  html: ['fileCode2', '#e34c26'],
  htm: ['fileCode2', '#e34c26'],
  xml: ['fileCode2', '#f59e0b'],
  rs: ['fileCode2', '#f74c00'],
  py: ['fileCode2', '#3776ab'],
  go: ['fileCode2', '#00add8'],
  java: ['fileCode2', '#ea2d2e'],
  c: ['fileCode2', '#5c6bc0'],
  h: ['fileCode2', '#5c6bc0'],
  cpp: ['fileCode2', '#5c6bc0'],
  rb: ['fileCode2', '#cc342d'],
  php: ['fileCode2', '#777bb4'],
  sh: ['fileCode2', '#4eaa25'],
  sql: ['fileCode2', '#0ea5e9'],
  yaml: ['fileCode2', '#94a3b8'],
  yml: ['fileCode2', '#94a3b8'],
  toml: ['fileCode2', '#94a3b8'],
  ini: ['fileCode2', '#94a3b8'],

  // JSON
  json: ['braces', '#f59e0b'],

  // документы
  md: ['fileText', '#64748b'],
  markdown: ['fileText', '#64748b'],
  pdf: ['fileText', '#ef4444'],
  doc: ['fileText', '#2563eb'],
  docx: ['fileText', '#2563eb'],
  odt: ['fileText', '#2563eb'],
  txt: ['fileText', '#94a3b8'],
  log: ['fileText', '#94a3b8'],
  rtf: ['fileText', '#94a3b8'],

  // изображения
  svg: ['image', '#f97316'],
  png: ['image', '#a855f7'],
  jpg: ['image', '#a855f7'],
  jpeg: ['image', '#a855f7'],
  gif: ['image', '#a855f7'],
  webp: ['image', '#a855f7'],
  bmp: ['image', '#a855f7'],
  ico: ['image', '#a855f7'],
  avif: ['image', '#a855f7'],
  heic: ['image', '#a855f7'],
  tiff: ['image', '#a855f7'],

  // дизайн
  psd: ['palette', '#0ea5e9'],
  ai: ['penTool', '#f97316'],
  fig: ['palette', '#a259ff'],
  sketch: ['palette', '#fdb300'],

  // таблицы
  xlsx: ['table', '#22c55e'],
  xls: ['table', '#22c55e'],
  ods: ['table', '#22c55e'],
  csv: ['table', '#22c55e'],
  tsv: ['table', '#22c55e'],

  // шрифты
  ttf: ['type', '#8b5cf6'],
  otf: ['type', '#8b5cf6'],
  woff: ['type', '#8b5cf6'],
  woff2: ['type', '#8b5cf6'],

  // прочее с цветом, иконка — универсальный File
  zip: ['file', '#eab308'],
  rar: ['file', '#eab308'],
  '7z': ['file', '#eab308'],
  tar: ['file', '#eab308'],
  gz: ['file', '#eab308'],
  bz2: ['file', '#eab308'],
  xz: ['file', '#eab308'],
  zst: ['file', '#eab308'],
  mp3: ['file', '#ec4899'],
  wav: ['file', '#ec4899'],
  flac: ['file', '#ec4899'],
  ogg: ['file', '#ec4899'],
  m4a: ['file', '#ec4899'],
  aac: ['file', '#ec4899'],
  mp4: ['file', '#f43f5e'],
  mkv: ['file', '#f43f5e'],
  mov: ['file', '#f43f5e'],
  avi: ['file', '#f43f5e'],
  webm: ['file', '#f43f5e'],
  wmv: ['file', '#f43f5e'],
  exe: ['file', '#64748b'],
  msi: ['file', '#64748b'],
  dll: ['file', '#64748b'],
  iso: ['file', '#64748b'],
};

const FOLDER_COLOR = '#eab308';
const DEFAULT = ['file', '#94a3b8'];

function svg(name, color) {
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="16" height="16" ` +
    `fill="none" stroke="${color}" color="${color}" stroke-width="2" stroke-linecap="round" ` +
    `stroke-linejoin="round" aria-hidden="true" style="display:block;margin:auto">` +
    `${GLYPHS[name] || GLYPHS.file}</svg>`
  );
}

/** @param {{kind:string, extension:string|null}} entry */
export function fileIcon(entry) {
  if (entry.kind === 'folder') return svg('folder', FOLDER_COLOR);
  const [name, color] = EXT[(entry.extension || '').toLowerCase()] || DEFAULT;
  return svg(name, color);
}
