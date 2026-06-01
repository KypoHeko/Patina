//! Единый тип ошибки приложения. Сериализуется в строку для фронта.

use serde::{Serialize, Serializer};

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("ошибка ввода-вывода: {0}")]
    Io(#[from] std::io::Error),

    #[error("ошибка БД: {0}")]
    Db(#[from] rusqlite::Error),

    #[error("путь не является директорией: {0}")]
    NotADirectory(String),

    #[error("некорректный путь: {0}")]
    InvalidPath(String),

    #[error("операция не удалась: {0}")]
    Operation(String),
}

impl Serialize for Error {
    fn serialize<S>(&self, serializer: S) -> std::result::Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        serializer.serialize_str(&self.to_string())
    }
}

pub type Result<T> = std::result::Result<T, Error>;
