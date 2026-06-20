// Subscribe to native Tauri events (withGlobalTauri).
export function onEvent(name, handler) {
  const t = typeof window !== 'undefined' ? window.__TAURI__ : null;
  if (!t || !t.event) return Promise.resolve(() => {});
  return t.event.listen(name, (e) => handler(e.payload));
}
