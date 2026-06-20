import { invoke } from './invoke.js';

/** Assign a tag to a file/folder. */
export function assignTag(path, tagId) {
  return invoke('assign_tag', { path, tagId });
}

/** Remove a tag. */
export function removeTag(path, tagId) {
  return invoke('remove_tag', { path, tagId });
}

/** Map path -> [tagId] for the given paths (tagged ones only). */
export function tagsForPaths(paths) {
  return invoke('tags_for_paths', { paths });
}

/** All paths with the given tag. */
export function pathsForTag(tagId) {
  return invoke('paths_for_tag', { tagId });
}

/** Virtual list of files with the given tag. */
export function listTag(tagId) {
  return invoke('list_tag', { tagId });
}

/** Number of files per tag: { tagId: count }. */
export function tagCounts() {
  return invoke('tag_counts');
}
