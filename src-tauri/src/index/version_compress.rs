//! Сжатие версий zstd с обучаемым словарём.
//!
//! Для файлов < 15 MB: сжимаем с зоновым словарём (если он уже обучен),
//! иначе — обычное zstd-сжатие. Словарь обучается по накопленным блобам
//! после каждых N новых сжатых версий.

use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};

use crate::error::{Error, Result};

/// Уровень сжатия zstd (1–22). 3 — быстрый и хороший компромисс.
const ZSTD_LEVEL: i32 = 3;

/// Минимальное число сжатых блобов для обучения словаря.
const DICT_MIN_SAMPLES: usize = 4;

/// Обучать словарь заново после каждых N новых сжатых версий.
const DICT_RETRAIN_INTERVAL: usize = 8;

/// Сжать данные с zstd-словарём (если доступен) или без него.
/// Возвращает сжатые байты и id использованного словаря (None = без словаря).
pub fn compress(
    data: &[u8],
    dicts_dir: &Path,
    current_dict_id: Option<i64>,
) -> Result<(Vec<u8>, Option<i64>)> {
    if let Some(dict_id) = current_dict_id {
        let dict_path = dict_file(dicts_dir, dict_id);
        if dict_path.exists() {
            let dict_data = fs::read(&dict_path).map_err(Error::Io)?;
            let mut compressed = Vec::new();
            {
                let mut encoder =
                    zstd::Encoder::with_dictionary(&mut compressed, ZSTD_LEVEL, &dict_data)
                        .map_err(|e| Error::Operation(format!("zstd encoder: {e}")))?;
                std::io::Write::write_all(&mut encoder, data)
                    .map_err(|e| Error::Operation(format!("zstd write: {e}")))?;
                encoder
                    .finish()
                    .map_err(|e| Error::Operation(format!("zstd finish: {e}")))?;
            }
            return Ok((compressed, Some(dict_id)));
        }
    }

    // Без словаря — обычное сжатие
    let compressed = zstd::encode_all(data, ZSTD_LEVEL)
        .map_err(|e| Error::Operation(format!("zstd encode: {e}")))?;
    Ok((compressed, None))
}

/// Распаковать данные, сжатые zstd. Если версия сжата со словарём —
/// загружаем нужный словарь и используем его.
pub fn decompress(data: &[u8], dicts_dir: &Path, dict_id: Option<i64>) -> Result<Vec<u8>> {
    if let Some(id) = dict_id {
        let dict_path = dict_file(dicts_dir, id);
        if dict_path.exists() {
            let dict_data = fs::read(&dict_path).map_err(Error::Io)?;
            let mut decoder = zstd::Decoder::with_dictionary(data, &dict_data)
                .map_err(|e| Error::Operation(format!("zstd decoder with dict: {e}")))?;
            let mut decompressed = Vec::new();
            Read::read_to_end(&mut decoder, &mut decompressed)
                .map_err(|e| Error::Operation(format!("zstd decompress: {e}")))?;
            return Ok(decompressed);
        }
    }

    // Без словаря
    let decompressed =
        zstd::decode_all(data).map_err(|e| Error::Operation(format!("zstd decode: {e}")))?;
    Ok(decompressed)
}

/// Обучить новый словарь из существующих сжатых блобов.
/// `samples` — пути к файлам-образцам (несжатые оригиналы или уже сжатые блобы).
/// zstd dict::from_samples работает на несжатых данных — передаём сэмплы из кэша.
///
/// Возвращает id нового словаря (он же записывается в БД).
pub fn train_dict(dicts_dir: &Path, samples: &[Vec<u8>], new_dict_id: i64) -> Result<PathBuf> {
    if samples.len() < DICT_MIN_SAMPLES {
        return Err(Error::Operation(format!(
            "нужно минимум {} сэмплов для обучения словаря, есть {}",
            DICT_MIN_SAMPLES,
            samples.len()
        )));
    }

    fs::create_dir_all(dicts_dir).map_err(Error::Io)?;

    // zstd::dict::from_samples обучает словарь на наборе сэмплов.
    // Каждый сэмпл — несжатые данные одного файла.
    let dict_data = zstd::dict::from_samples(samples, 0)
        .map_err(|e| Error::Operation(format!("zstd dict train: {e}")))?;

    let path = dict_file(dicts_dir, new_dict_id);
    fs::write(&path, &dict_data).map_err(Error::Io)?;
    Ok(path)
}

/// Путь к файлу словаря по id.
pub fn dict_file(dicts_dir: &Path, id: i64) -> PathBuf {
    dicts_dir.join(format!("dict-{id}.zstd"))
}

/// Каталог словарей внутри versions_dir.
pub fn dicts_dir(versions_dir: &Path) -> PathBuf {
    versions_dir.join("dicts")
}

/// Нужно ли переобучить словарь?
///
/// `zstd_count` — сколько версий со strategy='zstd' уже хранится сейчас.
/// `trained_at` — сколько zstd-версий было на момент обучения текущего словаря
/// (None, если словаря ещё нет).
///
/// Переобучение запускается, если:
/// - словаря ещё нет и накопилось минимум DICT_MIN_SAMPLES сэмплов;
/// - словарь есть, но с момента обучения появилось DICT_RETRAIN_INTERVAL
///   новых zstd-версий.
pub fn should_retrain(zstd_count: usize, trained_at: Option<usize>) -> bool {
    match trained_at {
        None => zstd_count >= DICT_MIN_SAMPLES,
        Some(at) => zstd_count.saturating_sub(at) >= DICT_RETRAIN_INTERVAL,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[test]
    fn compress_decompress_without_dict() {
        let dir = TempDir::new().unwrap();
        let dicts = dir.path().join("dicts");
        fs::create_dir_all(&dicts).unwrap();

        let data = b"Hello, zstd world! ".repeat(100);
        let (compressed, dict_id) = compress(&data, &dicts, None).unwrap();
        assert!(dict_id.is_none());
        assert!(compressed.len() < data.len());

        let decompressed = decompress(&compressed, &dicts, None).unwrap();
        assert_eq!(decompressed, data);
    }

    #[test]
    fn train_and_use_dict() {
        let dir = TempDir::new().unwrap();
        let dicts = dir.path().join("dicts");
        fs::create_dir_all(&dicts).unwrap();

        // Генерируем сэмплы для обучения
        let samples: Vec<Vec<u8>> = (0..5)
            .map(|i| {
                format!("Sample document content #{i} with some common text pattern. ")
                    .repeat(50)
                    .into_bytes()
            })
            .collect();

        let dict_path = train_dict(&dicts, &samples, 1).unwrap();
        assert!(dict_path.exists());

        let data = b"Sample document content with some common text pattern. ".repeat(80);
        let (compressed, used_dict) = compress(&data, &dicts, Some(1)).unwrap();
        assert_eq!(used_dict, Some(1));

        let decompressed = decompress(&compressed, &dicts, Some(1)).unwrap();
        assert_eq!(decompressed, data);
    }

    #[test]
    fn should_retrain_logic() {
        // Словаря ещё нет
        assert!(!should_retrain(3, None)); // ещё мало сэмплов
        assert!(should_retrain(4, None)); // минимум достигнут

        // Словарь обучен при 4 zstd-версиях
        assert!(!should_retrain(5, Some(4))); // прошло 1 — рано
        assert!(!should_retrain(11, Some(4))); // прошло 7 — ещё не достигли интервала (8)
        assert!(should_retrain(12, Some(4))); // прошло 8 — переобучаем

        // Словарь обучен при 0 zstd-версиях (граничный случай)
        assert!(!should_retrain(7, Some(0))); // 7 < 8
        assert!(should_retrain(8, Some(0))); // 8 == интервал
    }
}
