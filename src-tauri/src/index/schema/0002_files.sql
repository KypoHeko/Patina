-- File index. Used as a hash cache for duplicate detection
-- (hash is computed lazily and invalidated when mtime changes).
CREATE TABLE IF NOT EXISTS files (
    path  TEXT PRIMARY KEY,
    size  INTEGER NOT NULL,
    mtime INTEGER NOT NULL,
    hash  TEXT
);
CREATE INDEX IF NOT EXISTS idx_files_size ON files (size);
CREATE INDEX IF NOT EXISTS idx_files_hash ON files (hash);
