// Единственная точка соприкосновения с Tauri.
// Ни один другой модуль не должен трогать window.__TAURI__ напрямую.

const tauri = window.__TAURI__;

if (!tauri) {
  console.warn('[patina] window.__TAURI__ недоступен — страница открыта вне Tauri-окна.');
}

/**
 * Вызов Rust-команды с единой обработкой ошибок.
 * @param {string} cmd  Имя команды (как в generate_handler!)
 * @param {Record<string, unknown>} [args]
 * @returns {Promise<*>}
 */
export async function invoke(cmd, args = {}) {
  if (!tauri?.core?.invoke) {
    throw new Error('Tauri API недоступен. Запусти приложение через `cargo tauri dev`.');
  }
  try {
    return await tauri.core.invoke(cmd, args);
  } catch (err) {
    // Rust сериализует ошибку в строку (см. error.rs).
    const message = typeof err === 'string' ? err : err?.message ?? String(err);
    throw new Error(`[${cmd}] ${message}`);
  }
}
