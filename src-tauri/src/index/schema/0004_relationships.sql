-- Links between files (undirected, normalized pair a<=b).
CREATE TABLE IF NOT EXISTS relationships (
    a TEXT NOT NULL,
    b TEXT NOT NULL,
    PRIMARY KEY (a, b)
);
