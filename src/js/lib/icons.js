// File icons based on Lucide (inline SVG — the project has no bundler).
// Each extension is mapped to a Lucide icon and a color (hex).

// The inner SVG contents of the needed Lucide icons (viewBox 0 0 24 24).
// Exported for the integrity test (every EXT glyph must exist here).
export const GLYPHS = {
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
  presentation:
    '<path d="M2 3h20"/><path d="M21 3v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V3"/><path d="m7 21 5-5 5 5"/>',
  book: '<path d="M4 19.5v-15A2.5 2.5 0 0 1 6.5 2H20v20H6.5a2.5 2.5 0 0 1 0-5H20"/>',
  archive:
    '<rect width="20" height="5" x="2" y="3" rx="1"/><path d="M4 8v11a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8"/><path d="M10 12h4"/>',
  music: '<path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/>',
  film:
    '<rect width="18" height="18" x="3" y="3" rx="2"/><path d="M7 3v18"/><path d="M3 7.5h4"/><path d="M3 12h18"/><path d="M3 16.5h4"/><path d="M17 3v18"/><path d="M17 7.5h4"/><path d="M17 16.5h4"/>',
  package:
    '<path d="m7.5 4.27 9 5.15"/><path d="M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z"/><path d="m3.3 7 8.7 5 8.7-5"/><path d="M12 22V12"/>',
  database:
    '<ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M3 5V19A9 3 0 0 0 21 19V5"/><path d="M3 12A9 3 0 0 0 21 12"/>',
  terminal: '<path d="m4 17 6-6-6-6"/><path d="M12 19h8"/>',
};

// Extension -> [glyph, color hex]
export const EXT = {
  // ── code ──────────────────────────────────────────
  ts: ['fileCode2', '#3b82f6'],
  tsx: ['fileCode2', '#3b82f6'],
  js: ['fileCode2', '#f7df1e'],
  mjs: ['fileCode2', '#f7df1e'],
  cjs: ['fileCode2', '#f7df1e'],
  jsx: ['fileCode2', '#38bdf8'],
  css: ['fileCode2', '#38bdf8'],
  scss: ['fileCode2', '#c6538c'],
  sass: ['fileCode2', '#c6538c'],
  less: ['fileCode2', '#2b5797'],
  html: ['fileCode2', '#e34c26'],
  htm: ['fileCode2', '#e34c26'],
  xhtml: ['fileCode2', '#e34c26'],
  xml: ['fileCode2', '#f59e0b'],
  vue: ['fileCode2', '#41b883'],
  svelte: ['fileCode2', '#ff3e00'],
  astro: ['fileCode2', '#ff5d01'],
  rs: ['fileCode2', '#f74c00'],
  py: ['fileCode2', '#3776ab'],
  pyw: ['fileCode2', '#3776ab'],
  go: ['fileCode2', '#00add8'],
  java: ['fileCode2', '#ea2d2e'],
  kt: ['fileCode2', '#a97bff'],
  kts: ['fileCode2', '#a97bff'],
  c: ['fileCode2', '#5c6bc0'],
  h: ['fileCode2', '#5c6bc0'],
  cpp: ['fileCode2', '#5c6bc0'],
  cc: ['fileCode2', '#5c6bc0'],
  cxx: ['fileCode2', '#5c6bc0'],
  hpp: ['fileCode2', '#5c6bc0'],
  hh: ['fileCode2', '#5c6bc0'],
  cs: ['fileCode2', '#178600'],
  fs: ['fileCode2', '#378bba'],
  fsx: ['fileCode2', '#378bba'],
  swift: ['fileCode2', '#f05138'],
  dart: ['fileCode2', '#00b4ab'],
  scala: ['fileCode2', '#c22d40'],
  rb: ['fileCode2', '#cc342d'],
  php: ['fileCode2', '#777bb4'],
  pl: ['fileCode2', '#0298c3'],
  pm: ['fileCode2', '#0298c3'],
  lua: ['fileCode2', '#2c2d72'],
  r: ['fileCode2', '#276dc3'],
  jl: ['fileCode2', '#9558b2'],
  ex: ['fileCode2', '#6e4a7e'],
  exs: ['fileCode2', '#6e4a7e'],
  erl: ['fileCode2', '#a90533'],
  hrl: ['fileCode2', '#a90533'],
  hs: ['fileCode2', '#5e5086'],
  clj: ['fileCode2', '#5881d8'],
  cljs: ['fileCode2', '#5881d8'],
  cljc: ['fileCode2', '#5881d8'],
  groovy: ['fileCode2', '#4298b8'],
  gradle: ['fileCode2', '#02303a'],
  vb: ['fileCode2', '#945db7'],
  vbs: ['fileCode2', '#945db7'],
  asm: ['fileCode2', '#6e4c13'],
  s: ['fileCode2', '#6e4c13'],
  wasm: ['fileCode2', '#654ff0'],
  wat: ['fileCode2', '#654ff0'],
  proto: ['fileCode2', '#94a3b8'],
  graphql: ['fileCode2', '#e10098'],
  gql: ['fileCode2', '#e10098'],
  xaml: ['fileCode2', '#0c54c2'],
  gd: ['fileCode2', '#478cbf'],
  dockerfile: ['fileCode2', '#2496ed'],
  makefile: ['fileCode2', '#94a3b8'],
  mk: ['fileCode2', '#94a3b8'],
  cmake: ['fileCode2', '#94a3b8'],
  ninja: ['fileCode2', '#94a3b8'],

  // ── shell / scripts ───────────────────────────────
  sh: ['terminal', '#4eaa25'],
  bash: ['terminal', '#4eaa25'],
  zsh: ['terminal', '#4eaa25'],
  fish: ['terminal', '#4eaa25'],
  bat: ['terminal', '#4eaa25'],
  cmd: ['terminal', '#4eaa25'],
  ps1: ['terminal', '#4eaa25'],

  // ── data / config ─────────────────────────────────
  json: ['braces', '#f59e0b'],
  json5: ['braces', '#f59e0b'],
  jsonl: ['braces', '#f59e0b'],
  ndjson: ['braces', '#f59e0b'], 
  sql: ['fileCode2', '#0ea5e9'],
  yaml: ['fileCode2', '#94a3b8'],
  yml: ['fileCode2', '#94a3b8'],
  toml: ['fileCode2', '#94a3b8'],
  ini: ['fileCode2', '#94a3b8'],
  cfg: ['fileCode2', '#94a3b8'],
  conf: ['fileCode2', '#94a3b8'],
  env: ['fileCode2', '#94a3b8'],
  properties: ['fileCode2', '#94a3b8'],
  editorconfig: ['fileCode2', '#94a3b8'],
  lock: ['fileCode2', '#94a3b8'],

  // ── databases ─────────────────────────────────────
  db: ['database', '#0ea5e9'],
  sqlite: ['database', '#0ea5e9'],
  sqlite3: ['database', '#0ea5e9'],
  mdb: ['database', '#0ea5e9'],
  accdb: ['database', '#0ea5e9'],
  dbf: ['database', '#0ea5e9'],

  // ── documents ─────────────────────────────────────
  md: ['fileText', '#64748b'],
  markdown: ['fileText', '#64748b'],
  mdx: ['fileText', '#64748b'],
  pdf: ['fileText', '#ef4444'],
  doc: ['fileText', '#2563eb'],
  docx: ['fileText', '#2563eb'],
  odt: ['fileText', '#2563eb'],
  pages: ['fileText', '#2563eb'],
  rtf: ['fileText', '#94a3b8'],
  txt: ['fileText', '#94a3b8'],
  log: ['fileText', '#94a3b8'],
  tex: ['fileText', '#3d6117'],
  rst: ['fileText', '#64748b'],
  adoc: ['fileText', '#64748b'],
  asciidoc: ['fileText', '#64748b'],
  org: ['fileText', '#64748b'],

  // ── presentations ─────────────────────────────────
  ppt: ['presentation', '#ea580c'],
  pptx: ['presentation', '#ea580c'],
  pps: ['presentation', '#ea580c'],
  ppsx: ['presentation', '#ea580c'],
  odp: ['presentation', '#ea580c'],
  key: ['presentation', '#ea580c'],

  // ── spreadsheets ──────────────────────────────────
  xls: ['table', '#22c55e'],
  xlsx: ['table', '#22c55e'],
  xlsm: ['table', '#22c55e'],
  xlsb: ['table', '#22c55e'],
  ods: ['table', '#22c55e'],
  numbers: ['table', '#22c55e'],
  csv: ['table', '#22c55e'],
  tsv: ['table', '#22c55e'],

  // ── ebooks ────────────────────────────────────────
  epub: ['book', '#14b8a6'],
  mobi: ['book', '#14b8a6'],
  azw: ['book', '#14b8a6'],
  azw3: ['book', '#14b8a6'],
  fb2: ['book', '#14b8a6'],
  djvu: ['book', '#14b8a6'],

  // ── images ────────────────────────────────────────
  svg: ['image', '#f97316'],
  png: ['image', '#a855f7'],
  jpg: ['image', '#a855f7'],
  jpeg: ['image', '#a855f7'],
  jfif: ['image', '#a855f7'],
  gif: ['image', '#a855f7'],
  webp: ['image', '#a855f7'],
  bmp: ['image', '#a855f7'],
  ico: ['image', '#a855f7'],
  avif: ['image', '#a855f7'],
  heic: ['image', '#a855f7'],
  heif: ['image', '#a855f7'],
  tiff: ['image', '#a855f7'],
  tif: ['image', '#a855f7'],
  tga: ['image', '#a855f7'],
  raw: ['image', '#a855f7'],
  cr2: ['image', '#a855f7'],
  nef: ['image', '#a855f7'],
  arw: ['image', '#a855f7'],
  dng: ['image', '#a855f7'],

  // ── design ────────────────────────────────────────
  psd: ['palette', '#0ea5e9'],
  ai: ['penTool', '#f97316'],
  eps: ['penTool', '#f97316'],
  fig: ['palette', '#a259ff'],
  sketch: ['palette', '#fdb300'],
  xd: ['palette', '#ff61f6'],
  indd: ['palette', '#ff3366'],
  xcf: ['palette', '#5c5543'],

  // ── fonts ─────────────────────────────────────────
  ttf: ['type', '#8b5cf6'],
  otf: ['type', '#8b5cf6'],
  woff: ['type', '#8b5cf6'],
  woff2: ['type', '#8b5cf6'],
  eot: ['type', '#8b5cf6'],

  // ── archives ──────────────────────────────────────
  zip: ['archive', '#eab308'],
  rar: ['archive', '#eab308'],
  '7z': ['archive', '#eab308'],
  tar: ['archive', '#eab308'],
  gz: ['archive', '#eab308'],
  tgz: ['archive', '#eab308'],
  bz2: ['archive', '#eab308'],
  tbz: ['archive', '#eab308'],
  xz: ['archive', '#eab308'],
  zst: ['archive', '#eab308'],
  lz: ['archive', '#eab308'],
  lzma: ['archive', '#eab308'],
  lz4: ['archive', '#eab308'],
  z: ['archive', '#eab308'],
  cab: ['archive', '#eab308'],
  arj: ['archive', '#eab308'],

  // ── packages / installers / disk images ───────────
  apk: ['package', '#8b5cf6'],
  deb: ['package', '#8b5cf6'],
  rpm: ['package', '#8b5cf6'],
  dmg: ['package', '#8b5cf6'],
  appimage: ['package', '#8b5cf6'],
  pkg: ['package', '#8b5cf6'],
  snap: ['package', '#8b5cf6'],
  flatpak: ['package', '#8b5cf6'],
  jar: ['package', '#8b5cf6'],
  war: ['package', '#8b5cf6'],
  nupkg: ['package', '#8b5cf6'],
  gem: ['package', '#8b5cf6'],
  whl: ['package', '#8b5cf6'],
  crx: ['package', '#8b5cf6'],
  xpi: ['package', '#8b5cf6'],
  iso: ['package', '#8b5cf6'],
  img: ['package', '#8b5cf6'],
  vhd: ['package', '#8b5cf6'],
  vhdx: ['package', '#8b5cf6'],

  // ── audio ─────────────────────────────────────────
  mp3: ['music', '#ec4899'],
  wav: ['music', '#ec4899'],
  flac: ['music', '#ec4899'],
  ogg: ['music', '#ec4899'],
  oga: ['music', '#ec4899'],
  m4a: ['music', '#ec4899'],
  aac: ['music', '#ec4899'],
  wma: ['music', '#ec4899'],
  opus: ['music', '#ec4899'],
  aiff: ['music', '#ec4899'],
  aif: ['music', '#ec4899'],
  mid: ['music', '#ec4899'],
  midi: ['music', '#ec4899'],
  ape: ['music', '#ec4899'],

  // ── video ─────────────────────────────────────────
  mp4: ['film', '#f43f5e'],
  mkv: ['film', '#f43f5e'],
  mov: ['film', '#f43f5e'],
  avi: ['film', '#f43f5e'],
  webm: ['film', '#f43f5e'],
  wmv: ['film', '#f43f5e'],
  flv: ['film', '#f43f5e'],
  m4v: ['film', '#f43f5e'],
  mpg: ['film', '#f43f5e'],
  mpeg: ['film', '#f43f5e'],
  '3gp': ['film', '#f43f5e'],
  '3g2': ['film', '#f43f5e'],
  ogv: ['film', '#f43f5e'],
  vob: ['film', '#f43f5e'],
  mts: ['film', '#f43f5e'],
  m2ts: ['film', '#f43f5e'],

  // ── system / binaries (our generic file, kept "ours") ─
  exe: ['file', '#64748b'],
  msi: ['file', '#64748b'],
  dll: ['file', '#64748b'],
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

/**
 * True when we have a deliberate icon for this entry: a folder, or a file whose
 * extension is in our curated map. When false the caller should fall back to the
 * OS/native icon (we have nothing better than the generic placeholder).
 */
export function hasOwnIcon(entry) {
  if (entry.kind === 'folder') return true;
  return Object.prototype.hasOwnProperty.call(EXT, (entry.extension || '').toLowerCase());
}
