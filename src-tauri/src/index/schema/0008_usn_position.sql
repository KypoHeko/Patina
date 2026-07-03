-- USN Journal: stores the read position per NTFS volume.

CREATE TABLE IF NOT EXISTS usn_position (
    volume_root TEXT PRIMARY KEY,
    last_usn    INTEGER NOT NULL
);
