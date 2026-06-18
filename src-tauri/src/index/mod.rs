//! Слой индекса (SQLite).

pub mod chunker;
pub mod content_index;
pub mod db;
pub mod dir_agg_repo;
pub mod edges_repo;
pub mod file_index;
pub mod files_repo;
pub mod path_bounds;
pub mod path_key;
pub mod quick_access_repo;
pub mod tags_repo;
pub mod usn_position_repo;
pub mod version_compress;
pub mod versions_repo;
