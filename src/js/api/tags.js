import { invoke } from './invoke.js';

/** Назначить тег файлу/папке. */
export function assignTag(path, tagId) {
  return invoke('assign_tag', { path, tagId });
}

/** Снять тег. */
export function removeTag(path, tagId) {
  return invoke('remove_tag', { path, tagId });
}

/** Карта путь -> [tagId] для заданных путей (только помеченные). */
export function tagsForPaths(paths) {
  return invoke('tags_for_paths', { paths });
}

/** Все пути с данным тегом. */
export function pathsForTag(tagId) {
  return invoke('paths_for_tag', { tagId });
}

/** Виртуальный список файлов с данным тегом. */
export function listTag(tagId) {
  return invoke('list_tag', { tagId });
}

/** Кол-во файлов на каждый тег: { tagId: count }. */
export function tagCounts() {
  return invoke('tag_counts');
}
