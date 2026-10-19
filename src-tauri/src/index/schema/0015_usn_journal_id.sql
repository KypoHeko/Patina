-- The journal instance a saved USN belongs to. A USN is meaningful only within
-- one journal: after the journal is recreated the position must be discarded.
-- `volume_root` holds the canonical key of the indexed ROOT (the position marks
-- how far that root's index is in sync), not just the volume letter.
ALTER TABLE usn_position ADD COLUMN journal_id INTEGER NOT NULL DEFAULT 0;
