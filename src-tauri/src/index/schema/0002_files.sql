-- Индекс файлов. Используется как кэш хешей для поиска дубликатов
-- (hash вычисляется лениво и инвалидируется при изменении mtime).
CREATE TABLE IF NOT EXISTS files (
    path  TEXT PRIMARY KEY,
    size  INTEGER NOT NULL,
    mtime INTEGER NOT NULL,
    hash  TEXT
);
CREATE INDEX IF NOT EXISTS idx_files_size ON files (size);
CREATE INDEX IF NOT EXISTS idx_files_hash ON files (hash);
