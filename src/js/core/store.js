// Central state store. Our replacement for a framework's state.
// Three operations: read, change, subscribe to changes.

/**
 * @param {object} initialState
 * @returns {{ getState: function, setState: function, subscribe: function }}
 */
/** Object.is, or element-wise Object.is for two arrays. */
function sameSelection(a, b) {
  if (Object.is(a, b)) return true;
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
  return a.every((v, i) => Object.is(v, b[i]));
}

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

  /**
   * Subscribe. Returns an unsubscribe function.
   *
   * With a `selector`, `fn` runs only when the selected value changes
   * (Object.is, element-wise for arrays). Without one, every setState reaches
   * every subscriber — that re-rendered the status bar, the tab strip and the
   * sidebar on each arrow-key press and on each mousemove of the divider.
   */
  function subscribe(fn, selector) {
    let wrapped = fn;
    if (selector) {
      let last = selector(state);
      wrapped = (s) => {
        const next = selector(s);
        if (sameSelection(last, next)) return;
        last = next;
        fn(s);
      };
    }
    subscribers.add(wrapped);
    return () => subscribers.delete(wrapped);
  }

  return { getState, setState, subscribe };
}
