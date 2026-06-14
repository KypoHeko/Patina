-- Метки версий: v1, v2, v3… Позволяют быстро идентифицировать снимок.
ALTER TABLE versions ADD COLUMN label TEXT NOT NULL DEFAULT '';
