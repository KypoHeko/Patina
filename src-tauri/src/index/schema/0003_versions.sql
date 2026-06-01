-- Снимки версий файлов. Содержимое хранится в каталоге versions/<hash>
-- (контент-адресно: одинаковые версии не дублируются).
CREATE TABLE IF NOT EXISTS versions (
    id   INTEGER PRIMARY KEY AUTOINCREMENT,
    path TEXT NOT NULL,
    ts   INTEGER NOT NULL,
    size INTEGER NOT NULL,
    hash TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_versions_path ON versions (path);
