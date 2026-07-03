-- Per-directory aggregates: recursive subtree size and file count.
-- Filled by an on-demand traversal (Phase 1). `path` is a canonical key
-- (path_key: lowercase + '\' on Windows) so panel lookups match file_index.
-- The hash/hash_dirty fields are reserved for a future Merkle rollup (dedup):
-- sizes live on metadata, hashes are a separate opt-in feature.
CREATE TABLE IF NOT EXISTS dir_agg (
  path       TEXT PRIMARY KEY,
  total_size INTEGER NOT NULL,
  file_count INTEGER NOT NULL,
  mtime_max  INTEGER,
  hash       TEXT,
  hash_dirty INTEGER NOT NULL DEFAULT 1
);
