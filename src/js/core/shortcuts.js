// Менеджер горячих клавиш. Один глобальный обработчик keydown.
// Сами комбинации описаны декларативно в config/keymap.js,
// а обработчики действий регистрируются через register(action, fn).

const MODIFIERS = ['ctrl', 'shift', 'alt'];

/** Привести комбинацию к каноничному виду: ctrl+shift+key. */
function normalize(combo) {
  const parts = combo.toLowerCase().split('+').map((s) => s.trim());
  const mods = MODIFIERS.filter((m) => parts.includes(m));
  const key = parts.find((p) => ![...MODIFIERS, 'meta', 'cmd'].includes(p)) || '';
  return [...mods, key].join('+');
}

/** Построить комбинацию из события клавиатуры. */
function comboFromEvent(e) {
  const parts = [];
  if (e.ctrlKey || e.metaKey) parts.push('ctrl'); // metaKey — для Cmd на macOS
  if (e.shiftKey) parts.push('shift');
  if (e.altKey) parts.push('alt');
  const key = e.key.toLowerCase();
  if (!['control', 'shift', 'alt', 'meta'].includes(key)) parts.push(key);
  return parts.join('+');
}

/** Не перехватывать клавиши, когда пользователь печатает в поле ввода. */
function isTyping(e) {
  const t = e.target;
  return t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable);
}

/**
 * @param {Array<{combo:string, action:string}>} bindings  из keymap.js
 */
export function createShortcuts(bindings) {
  const comboToAction = new Map(bindings.map((b) => [normalize(b.combo), b.action]));
  const actions = new Map(); // action -> handler

  function register(action, handler) {
    actions.set(action, handler);
  }

  function handle(e) {
    if (isTyping(e)) return;
    const action = comboToAction.get(comboFromEvent(e));
    const handler = action && actions.get(action);
    if (!handler) return;
    e.preventDefault();
    handler(e);
  }

  window.addEventListener('keydown', handle);

  return {
    register,
    destroy: () => window.removeEventListener('keydown', handle),
  };
}
