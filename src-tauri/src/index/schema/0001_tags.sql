-- Tag-to-file assignments keyed by path. The tag set is fixed and described
-- on the front end (config/tags.js); here we store only the assignments.
CREATE TABLE IF NOT EXISTS file_tags (
    path   TEXT NOT NULL,
    tag_id TEXT NOT NULL,
    PRIMARY KEY (path, tag_id)
);
CREATE INDEX IF NOT EXISTS idx_file_tags_tag ON file_tags (tag_id);
