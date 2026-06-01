// Шина событий: «опубликовать / подписаться».
// В отличие от стора (хранит ДАННЫЕ — что рисовать), шина передаёт
// РАЗОВЫЕ события (что произошло). Так компоненты не знают друг о друге.

/**
 * @returns {{ on: function, off: function, emit: function }}
 */
export function createEventBus() {
  /** @type {Map<string, Set<function>>} */
  const handlers = new Map();

  /** Подписаться на событие. Возвращает функцию отписки. */
  function on(event, fn) {
    if (!handlers.has(event)) handlers.set(event, new Set());
    handlers.get(event).add(fn);
    return () => off(event, fn);
  }

  function off(event, fn) {
    handlers.get(event)?.delete(fn);
  }

  /** Опубликовать событие с произвольными данными. */
  function emit(event, payload) {
    handlers.get(event)?.forEach((fn) => fn(payload));
  }

  return { on, off, emit };
}
