-- Направленные рёбра между файлами: зависимости (src -> dst) и обратные ссылки
-- (in-edges по dst). kind: 'import' | 'link' | 'mention' | 'manual'.
-- 'manual' создаётся пользователем и не перетирается переиндексацией.
CREATE TABLE IF NOT EXISTS file_edges (
    src  TEXT NOT NULL,
    dst  TEXT NOT NULL,
    kind TEXT NOT NULL,
    PRIMARY KEY (src, dst, kind)
);
CREATE INDEX IF NOT EXISTS idx_file_edges_src ON file_edges (src);
CREATE INDEX IF NOT EXISTS idx_file_edges_dst ON file_edges (dst);

-- Переносим существующие ручные связи (неориентированные пары) в новую таблицу.
INSERT OR IGNORE INTO file_edges (src, dst, kind)
    SELECT a, b, 'manual' FROM relationships;
