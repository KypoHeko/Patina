// Keyboard shortcut manager. One global keydown handler.
// The combinations themselves are declared in config/keymap.js,
// and action handlers are registered via register(action, fn).

const MODIFIERS = ['ctrl', 'shift', 'alt'];

/** Bring a combination to canonical form: ctrl+shift+key. */
function normalize(combo) {
  const parts = combo.toLowerCase().split('+').map((s) => s.trim());
  const mods = MODIFIERS.filter((m) => parts.includes(m));
  const key = parts.find((p) => ![...MODIFIERS, 'meta', 'cmd'].includes(p)) || '';
  return [...mods, key].join('+');
}

/** Build a combination from a keyboard event. */
function comboFromEvent(e) {
  const parts = [];
  if (e.ctrlKey || e.metaKey) parts.push('ctrl'); // metaKey — for Cmd on macOS
  if (e.shiftKey) parts.push('shift');
  if (e.altKey) parts.push('alt');
  const key = e.key.toLowerCase();
  if (!['control', 'shift', 'alt', 'meta'].includes(key)) parts.push(key);
  return parts.join('+');
}

/** Do not intercept keys while the user is typing in an input field. */
function isTyping(e) {
  const t = e.target;
  return t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable);
}

/**
 * @param {Array<{combo:string, action:string}>} bindings  from keymap.js
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
