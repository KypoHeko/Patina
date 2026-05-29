//! Единый тип ошибки приложения.
//! Сериализуется в строку, чтобы фронт получал читаемое сообщение в catch().

use serde::{Serialize, Serializer};

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("ошибка ввода-вывода: {0}")]
    Io(#[from] std::io::Error),

    #[error("путь не является директорией: {0}")]
    NotADirectory(String),

    #[error("некорректный путь: {0}")]
    InvalidPath(String),
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
