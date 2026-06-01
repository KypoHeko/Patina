-- Привязка тегов к файлам по пути. Набор тегов фиксированный и описан
-- на фронте (config/tags.js); здесь храним только назначения.
CREATE TABLE IF NOT EXISTS file_tags (
    path   TEXT NOT NULL,
    tag_id TEXT NOT NULL,
    PRIMARY KEY (path, tag_id)
);
CREATE INDEX IF NOT EXISTS idx_file_tags_tag ON file_tags (tag_id);
