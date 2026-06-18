-- Чанки версий для strategy='chunked'. Каждый чанк хранится в chunks/<hash>.
-- Порядок чанков важен для восстановления файла.
CREATE TABLE IF NOT EXISTS version_chunks (
    version_id  INTEGER NOT NULL,
    chunk_order INTEGER NOT NULL,
    chunk_hash  TEXT NOT NULL,
    chunk_size  INTEGER NOT NULL,
    PRIMARY KEY (version_id, chunk_order),
    FOREIGN KEY (version_id) REFERENCES versions(id)
);
CREATE INDEX IF NOT EXISTS idx_vchunks_hash ON version_chunks (chunk_hash);

-- Словари zstd для strategy='zstd'. Хранятся как versions/dicts/dict-{id}.zstd.
CREATE TABLE IF NOT EXISTS zstd_dicts (
    id   INTEGER PRIMARY KEY AUTOINCREMENT,
    ts   INTEGER NOT NULL,
    size INTEGER NOT NULL
);
