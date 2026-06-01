// Центральное хранилище состояния. Заменяет нам стейт фреймворка.
// Три операции: прочитать, изменить, подписаться на изменения.

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
   * Изменить состояние. patch — либо объект (поверхностно сливается),
   * либо функция (state) => partial для вычисления изменений от текущего.
   */
  function setState(patch) {
    const partial = typeof patch === 'function' ? patch(state) : patch;
    state = { ...state, ...partial };
    subscribers.forEach((fn) => fn(state));
  }

  /** Подписаться. Возвращает функцию отписки. */
  function subscribe(fn) {
    subscribers.add(fn);
    return () => subscribers.delete(fn);
  }

  return { getState, setState, subscribe };
}
