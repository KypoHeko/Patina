CREATE TABLE IF NOT EXISTS file_index (
  path       TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  name_lower TEXT NOT NULL,
  is_dir     INTEGER NOT NULL,
  size       INTEGER NOT NULL,
  mtime      INTEGER,
  ext        TEXT
);
CREATE INDEX IF NOT EXISTS idx_file_index_name ON file_index(name_lower);
