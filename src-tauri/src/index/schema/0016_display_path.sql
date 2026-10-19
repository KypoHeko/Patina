-- Keys (`path`) are case-folded on Windows (path_key::normalize) so lookups
-- match however a path is spelled. They must not be shown or used as real
-- paths, though: tag views and search results showed lower-case names, and a
-- version restore rewrote the file under a lower-case name. Keep the original
-- spelling next to the key; NULL for rows written before this migration.
ALTER TABLE file_index ADD COLUMN display_path TEXT;
ALTER TABLE file_tags  ADD COLUMN display_path TEXT;
ALTER TABLE versions   ADD COLUMN display_path TEXT;
