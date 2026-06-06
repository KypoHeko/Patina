// Глобальная настройка тестов: моки для Tauri IPC и ResizeObserver,
// которые отсутствуют в jsdom.

// Мокаем window.__TAURI__ — единая граница IPC; все вызовы идут через api/invoke.js
window.__TAURI__ = {
  core: {
    invoke: vi.fn().mockResolvedValue(undefined),
  },
  event: {
    listen: vi.fn().mockResolvedValue(() => {}),
  },
};

// ResizeObserver отсутствует в jsdom
global.ResizeObserver = class ResizeObserver {
  constructor() {}
  observe() {}
  unobserve() {}
  disconnect() {}
};

// getComputedStyle в jsdom возвращает пустые значения; подменяем
// только для --row-h, который нужен FilePanel
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
