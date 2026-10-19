// Global test setup: mocks for Tauri IPC and ResizeObserver,
// which are absent in jsdom.

// Mock window.__TAURI__ — the single IPC boundary; all calls go through api/invoke.js
window.__TAURI__ = {
  core: {
    invoke: vi.fn().mockResolvedValue(undefined),
  },
  event: {
    listen: vi.fn().mockResolvedValue(() => {}),
  },
};

// ResizeObserver is absent in jsdom
global.ResizeObserver = class ResizeObserver {
  constructor() {}
  observe() {}
  unobserve() {}
  disconnect() {}
};

// getComputedStyle returns empty values in jsdom; we override it
// only for --row-h, which FilePanel needs
const origGetComputedStyle = window.getComputedStyle;
window.getComputedStyle = function (el, ...rest) {
  const style = origGetComputedStyle.call(this, el, ...rest);
  if (el === document.documentElement) {
    const origGetProp = style.getPropertyValue.bind(style);
    style.getPropertyValue = function (prop) {
      if (prop === '--row-h') return '28';
      return origGetProp(prop);
    };
  }
  return style;
};

// CSS.escape is absent in jsdom (the virtualized list uses it in selectors).
if (!globalThis.CSS?.escape) {
  globalThis.CSS = { ...(globalThis.CSS || {}), escape: (s) => String(s).replace(/[^a-zA-Z0-9_ -￿-]/g, '\\$&') };
}
