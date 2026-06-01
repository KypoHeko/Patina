-- Связи между файлами (неориентированные, нормализованная пара a<=b).
CREATE TABLE IF NOT EXISTS relationships (
    a TEXT NOT NULL,
    b TEXT NOT NULL,
    PRIMARY KEY (a, b)
);
