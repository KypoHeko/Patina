-- Стратегия хранения версии: 'full' (старый формат, полный блоб),
-- 'zstd' (сжатие zstd-словарём, < 15 MB), 'chunked' (чанковое разбиение, >= 15 MB).
ALTER TABLE versions ADD COLUMN strategy TEXT NOT NULL DEFAULT 'full';
-- Идентификатор словаря zstd, которым была сжата версия (NULL для full/chunked).
ALTER TABLE versions ADD COLUMN dict_id INTEGER;
