CREATE TABLE IF NOT EXISTS quick_access (
    position INTEGER NOT NULL,
    path     TEXT    NOT NULL PRIMARY KEY,
    label    TEXT    NOT NULL,
    kind     TEXT    NOT NULL
);