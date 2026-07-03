-- Remember how many zstd versions existed when the dictionary was trained.
-- should_retrain used to use dict_id as a proxy for this value, but dict_id is
-- an autoincrement row id in zstd_dicts and is unrelated to the number of zstd
-- versions: if a dictionary was trained with id=1 at 4 versions and then 8 more
-- were added, the 12-1=11>=8 logic fired by accident. An explicit column makes
-- the decision exact.
ALTER TABLE zstd_dicts ADD COLUMN zstd_count_at_train INTEGER NOT NULL DEFAULT 0;
