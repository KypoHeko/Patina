// Central state store. Our replacement for a framework's state.
// Three operations: read, change, subscribe to changes.

/**
 * @param {object} initialState
 * @returns {{ getState: function, setState: function, subscribe: function }}
 */
export function createStore(initialState) {
  let state = initialState;
  const subscribers = new Set();

  function getState() {
    return state;
  }

  /**
   * Change the state. patch is either an object (shallow-merged),
   * or a function (state) => partial to compute changes from the current state.
   */
  function setState(patch) {
    const partial = typeof patch === 'function' ? patch(state) : patch;
    state = { ...state, ...partial };
    subscribers.forEach((fn) => fn(state));
  }

  /** Subscribe. Returns an unsubscribe function. */
  function subscribe(fn) {
    subscribers.add(fn);
    return () => subscribers.delete(fn);
  }

  return { getState, setState, subscribe };
}
