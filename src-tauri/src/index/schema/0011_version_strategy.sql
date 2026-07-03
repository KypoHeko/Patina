-- Version storage strategy: 'full' (old format, full blob),
-- 'zstd' (zstd dictionary compression, < 15 MB), 'chunked' (chunk splitting, >= 15 MB).
ALTER TABLE versions ADD COLUMN strategy TEXT NOT NULL DEFAULT 'full';
-- Id of the zstd dictionary the version was compressed with (NULL for full/chunked).
ALTER TABLE versions ADD COLUMN dict_id INTEGER;
