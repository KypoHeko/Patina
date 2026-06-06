-- USN Journal: хранение позиции чтения по каждому NTFS-тому.

CREATE TABLE IF NOT EXISTS usn_position (
    volume_root TEXT PRIMARY KEY,
    last_usn    INTEGER NOT NULL
);
