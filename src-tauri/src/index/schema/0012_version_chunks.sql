-- Version chunks for strategy='chunked'. Each chunk is stored in chunks/<hash>.
-- Chunk order matters for reassembling the file.
CREATE TABLE IF NOT EXISTS version_chunks (
    version_id  INTEGER NOT NULL,
    chunk_order INTEGER NOT NULL,
    chunk_hash  TEXT NOT NULL,
    chunk_size  INTEGER NOT NULL,
    PRIMARY KEY (version_id, chunk_order),
    FOREIGN KEY (version_id) REFERENCES versions(id)
);
CREATE INDEX IF NOT EXISTS idx_vchunks_hash ON version_chunks (chunk_hash);

-- zstd dictionaries for strategy='zstd'. Stored as versions/dicts/dict-{id}.zstd.
CREATE TABLE IF NOT EXISTS zstd_dicts (
    id   INTEGER PRIMARY KEY AUTOINCREMENT,
    ts   INTEGER NOT NULL,
    size INTEGER NOT NULL
);
