// Срез состояния интерфейса (не привязан к конкретной панели/вкладке).

export function initialUiState() {
  return {
    splitRatio: 0.5, // доля ширины левой панели при расколе (0..1) — для 4b-2
    homePath: '', // домашняя папка; подставляется в boot, нужна новым вкладкам
    searchQuery: '', // строка фильтра из верхнего поиска
  };
}

export function getSplitRatio(state) {
  return state.splitRatio;
}

export function setSplitRatio(store, ratio) {
  store.setState({ splitRatio: ratio });
}
