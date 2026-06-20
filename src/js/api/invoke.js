// The single point of contact with Tauri.
// No other module should touch window.__TAURI__ directly.

const tauri = window.__TAURI__;

if (!tauri) {
  console.warn('[patina] window.__TAURI__ is unavailable — the page is open outside a Tauri window.');
}

/**
 * Call a Rust command with unified error handling.
 * @param {string} cmd  Command name (as in generate_handler!)
 * @param {Record<string, unknown>} [args]
 * @returns {Promise<*>}
 */
export async function invoke(cmd, args = {}) {
  if (!tauri?.core?.invoke) {
    throw new Error('Tauri API unavailable. Run the app via `cargo tauri dev`.');
  }
  try {
    return await tauri.core.invoke(cmd, args);
  } catch (err) {
    // Rust serializes the error into a string (see error.rs).
    const message = typeof err === 'string' ? err : err?.message ?? String(err);
    throw new Error(`[${cmd}] ${message}`);
  }
}
