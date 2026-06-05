import { invoke } from './invoke.js';

/** Запустить/обновить живой индекс корня: фоновое построение + рекурсивное
 *  слежение с инкрементальными апдейтами. Идемпотентно.
 *  content=true — поддерживать и индекс содержимого; force=true — перестроить. */
export function startIndex(root, content = false, force = false) {
  return invoke('start_index', { root, content, force });
}
