-- Агрегаты по каталогам: рекурсивный размер поддерева и число файлов.
-- Заполняется обходом по кнопке (Фаза 1). `path` — канонический ключ (path_key:
-- нижний регистр + '\' на Windows), чтобы лукап из панели совпадал с file_index.
-- Поля hash/hash_dirty зарезервированы под будущий меркловский роллап (дедуп):
-- размеры живут на метаданных, хеши — отдельная opt-in фича.
CREATE TABLE IF NOT EXISTS dir_agg (
  path       TEXT PRIMARY KEY,
  total_size INTEGER NOT NULL,
  file_count INTEGER NOT NULL,
  mtime_max  INTEGER,
  hash       TEXT,
  hash_dirty INTEGER NOT NULL DEFAULT 1
);
