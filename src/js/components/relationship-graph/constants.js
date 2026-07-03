// Relationship graph — shared constants and the small ext→color helper.
// Single source of truth imported by the graph's mixin modules.

export const MAX_DEPTH = 10; // scan safety caps (shown in the corner)
export const MAX_NODES = 10000;

// Heavy build / VCS / dependency directories pruned whenever the .gitignore
// toggle is on, regardless of whether a .gitignore could be read. Keeps a huge
// tree (e.g. Rust `target/`) from stalling the scan with thousands of listDir
// round-trips. Toggle the button off to include everything.
export const ALWAYS_IGNORE_DIRS = new Set([
  '.git', 'node_modules', 'target', 'dist', '.next', '.nuxt', '.svelte-kit',
  '.cache', '.turbo', '.parcel-cache', '__pycache__', '.venv', 'venv',
  'vendor', '.gradle', '.idea', '.vs', 'coverage',
]);

export const C_CENTER = '#10b981'; // focus (emerald)
export const C_FOLDER = '#eab308'; // folder rings (amber)
export const C_FILE = '#7aa2c4'; // default file dot
export const C_DEP = '#a78bfa'; // dependency edges (violet)
export const C_RING = 'rgba(255,255,255,0.05)';
export const C_SPOKE = 'rgba(255,255,255,0.07)';

const EXT_COLOR = {
  ts: '#3b82f6', tsx: '#3b82f6', js: '#f7df1e', mjs: '#f7df1e', jsx: '#38bdf8',
  css: '#38bdf8', html: '#e34c26', htm: '#e34c26', json: '#f59e0b', rs: '#f74c00',
  py: '#3776ab', go: '#00add8', java: '#ea2d2e', c: '#5c6bc0', h: '#5c6bc0',
  cpp: '#5c6bc0', rb: '#cc342d', php: '#777bb4', sh: '#4eaa25', sql: '#0ea5e9',
  yaml: '#94a3b8', yml: '#94a3b8', toml: '#9c8c6e', ini: '#94a3b8',
  md: '#64748b', markdown: '#64748b', svg: '#f97316', xml: '#f59e0b',
};

export const DEFAULT_W = 900;
export const DEFAULT_H = 600;
export const ZOOM_MAX = 4;
export const DEP_SEED_CAP = 600; // cap fileGraph seeds so the dependency fetch stays cheap

// spring "unfold"
export const SPRING_K = 0.10;
export const DAMPING = 0.80;
export const SETTLE = 0.05;

export function extColor(name) {
  const i = name.lastIndexOf('.');
  const ext = i >= 0 ? name.slice(i + 1).toLowerCase() : '';
  return EXT_COLOR[ext] || C_FILE;
}
