-- Version labels: v1, v2, v3… Let you quickly identify a snapshot.
ALTER TABLE versions ADD COLUMN label TEXT NOT NULL DEFAULT '';
