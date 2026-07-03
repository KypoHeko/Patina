// Event bus: "publish / subscribe".
// Unlike the store (which holds DATA — what to render), the bus carries
// ONE-OFF events (what happened). This way components do not know about each other.

/**
 * @returns {{ on: function, off: function, emit: function }}
 */
export function createEventBus() {
  /** @type {Map<string, Set<function>>} */
  const handlers = new Map();

  /** Subscribe to an event. Returns an unsubscribe function. */
  function on(event, fn) {
    if (!handlers.has(event)) handlers.set(event, new Set());
    handlers.get(event).add(fn);
    return () => off(event, fn);
  }

  function off(event, fn) {
    handlers.get(event)?.delete(fn);
  }

  /** Publish an event with arbitrary data. */
  function emit(event, payload) {
    handlers.get(event)?.forEach((fn) => fn(payload));
  }

  return { on, off, emit };
}
