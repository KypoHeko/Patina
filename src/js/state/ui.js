// UI state slice (not tied to a specific panel/tab).

export function initialUiState() {
  return {
    splitRatio: 0.5, // left panel's width fraction when split (0..1) — for 4b-2
    homePath: '', // home folder; filled in at boot, needed by new tabs
    searchQuery: '', // filter string from the top search
  };
}

export function getSplitRatio(state) {
  return state.splitRatio;
}

export function setSplitRatio(store, ratio) {
  store.setState({ splitRatio: ratio });
}
