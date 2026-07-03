-- Directed edges between files: dependencies (src -> dst) and back-references
-- (in-edges by dst). kind: 'import' | 'link' | 'mention' | 'manual'.
-- 'manual' is created by the user and is not overwritten by reindexing.
CREATE TABLE IF NOT EXISTS file_edges (
    src  TEXT NOT NULL,
    dst  TEXT NOT NULL,
    kind TEXT NOT NULL,
    PRIMARY KEY (src, dst, kind)
);
CREATE INDEX IF NOT EXISTS idx_file_edges_src ON file_edges (src);
CREATE INDEX IF NOT EXISTS idx_file_edges_dst ON file_edges (dst);

-- Migrate existing manual links (undirected pairs) into the new table.
INSERT OR IGNORE INTO file_edges (src, dst, kind)
    SELECT a, b, 'manual' FROM relationships;
