-- When the versioned file was moved to the Recycle Bin (Unix ms), NULL while
-- it exists. History is kept on delete so a file restored from the Bin gets
-- it back; rows deleted longer than the retention period are garbage-collected.
ALTER TABLE versions ADD COLUMN deleted_at INTEGER;
CREATE INDEX IF NOT EXISTS idx_versions_deleted ON versions (deleted_at);
