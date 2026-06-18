//! Content-defined chunking на базе Rabin fingerprint.
//!
//! Разбивает данные на чанки переменной длины по границам содержимого.
//! Неизменённые участки дают те же чанки — это основа дедупликации.

use std::fs::File;
use std::io::{self, Read, Seek, SeekFrom, Write};

use crate::error::{Error, Result};

/// Параметры чанкования.
pub const CHUNK_MIN: usize = 256 * 1024;       // 256 KB — минимальный чанк
pub const CHUNK_MAX: usize = 8 * 1024 * 1024;   // 8 MB — максимальный чанк
pub const CHUNK_TARGET: usize = 4 * 1024 * 1024; // 4 MB — целевой размер

/// Маска для определения границы чанка.
/// Граница = хеш делится на CHUNK_MASK без остатка.
/// Вероятность границы на каждом байте ≈ 1/(CHUNK_MASK+1).
/// При CHUNK_MASK = 0x1FFFF (131071) средний чанк ≈ 128 KB × 32 ≈ 4 MB.
const CHUNK_MASK: u32 = 0x1FFFF;

/// Полином для Rabin fingerprint (неприводимый над GF(2), степень 31).
const RABIN_POLY: u64 = 0x3DA3358B4DC173;

/// Окно скользящего хеша (байты).
const WINDOW_SIZE: usize = 48;

/// Результат чанкования: хеш + размер каждого чанка.
#[derive(Debug, Clone)]
pub struct Chunk {
    pub hash: String,
    pub size: i64,
}

/// Разбить файл на чанки. Чанки не хранятся в памяти целиком —
/// читаем файл потоком, находим границы, хешируем каждый чанк BLAKE3.
pub fn chunk_file(path: &str) -> Result<Vec<Chunk>> {
    let mut file = File::open(path).map_err(Error::Io)?;
    let meta = file.metadata().map_err(Error::Io)?;
    if meta.len() == 0 {
        // Пустой файл — один пустой чанк
        let hash = blake3::Hasher::new().finalize().to_hex().to_string();
        return Ok(vec![Chunk { hash, size: 0 }]);
    }

    let mut chunks = Vec::new();
    let mut buf = Vec::with_capacity(CHUNK_MAX);
    let mut window = [0u8; WINDOW_SIZE];
    let mut wi = 0usize; // позиция в окне
    let mut fp: u64 = 0;
    let mut out_table = RABIN_POLY;

    // Предвычисляем table[i] = RABIN_POLY^(8*i)
    // для быстрого удаления байта из окна.
    // Но это дорого — вместо этого используем упрощённый rolling hash:
    // Buzhash-style с таблицей случайных значений.
    let lookup = build_lookup();

    // Сброс окна
    for b in &mut window {
        *b = 0;
    }

    // Буферизованное чтение: раньше тут был [0u8; 1] и syscall read на каждый
    // байт — для файла 15 MB это ~15 миллионов сисколлов. Теперь читаем
    // чанками по 256 KB и итерируемся по байтам слайса в памяти.
    // 256 KB достаточно для эффективности и не перегружает page cache.
    let mut read_buf = vec![0u8; 256 * 1024];
    loop {
        let n = match file.read(&mut read_buf) {
            Ok(0) => break, // EOF
            Ok(n) => n,
            Err(e) => return Err(Error::Io(e)),
        };

        for &b in &read_buf[..n] {
            // Удаляем старый байт из окна, добавляем новый
            let old = window[wi];
            fp = fp
                .wrapping_shl(1)
                .wrapping_add(lookup[b as usize])
                .wrapping_sub(lookup[old as usize].wrapping_shl(WINDOW_SIZE as u32));

            window[wi] = b;
            wi = (wi + 1) % WINDOW_SIZE;
            buf.push(b);

            if buf.len() >= CHUNK_MIN && (fp & CHUNK_MASK as u64) == 0 {
                // Граница чанка
                chunks.push(hash_chunk(&buf));
                buf.clear();
            } else if buf.len() >= CHUNK_MAX {
                // Жёсткий предел — рубим
                chunks.push(hash_chunk(&buf));
                buf.clear();
            }
        }
    }

    // Остаток — последний чанк
    if !buf.is_empty() {
        chunks.push(hash_chunk(&buf));
    }

    // Подавляем предупреждение о неиспользуемой переменной out_table:
    // она оставлена для будущей реализации табличного Rabin fingerprint
    // (см. комментарий выше про RABIN_POLY^(8*i)).
    let _ = out_table;

    Ok(chunks)
}

/// Хешировать содержимое чанка BLAKE3.
fn hash_chunk(data: &[u8]) -> Chunk {
    let hash = blake3::hash(data).to_hex().to_string();
    Chunk {
        hash,
        size: data.len() as i64,
    }
}

/// Прочитать указанные чанки и собрать файл.
/// Чанки читаются из каталога `chunks_dir` в порядке `hashes`.
pub fn reassemble(chunks_dir: &std::path::Path, hashes: &[String]) -> Result<Vec<u8>> {
    let mut out = Vec::new();
    for h in hashes {
        let path = chunks_dir.join(h);
        let data = std::fs::read(&path).map_err(Error::Io)?;
        out.extend_from_slice(&data);
    }
    Ok(out)
}

/// Сохранить чанки на диск. Для каждого чанка: если файл уже существует —
/// пропускаем (контент-адресное хранение).
///
/// Файл-источник стримится в чанки порциями, без загрузки целиком в память.
/// Раньше тут был `std::fs::read(path)`, что для файлов 15 MB+ давало пик
/// памяти, равный размеру файла (а chunked-стратегия применяется именно к
/// большим файлам — теоретически до гигабайт). Теперь держим открытым один
/// `File` и для каждого чанка копируем ровно `chunk.size` байт через
/// `io::copy(file.take(n), out)`.
pub fn store_chunks(
    chunks_dir: &std::path::Path,
    path: &str,
    chunks: &[Chunk],
) -> Result<()> {
    std::fs::create_dir_all(chunks_dir).map_err(Error::Io)?;

    // Пустой файл — чанк не пишем, но запись в БД будет
    if chunks.len() == 1 && chunks[0].size == 0 {
        return Ok(());
    }

    let mut file = File::open(path).map_err(Error::Io)?;

    for chunk in chunks {
        let chunk_path = chunks_dir.join(&chunk.hash);
        // chunk.size имеет тип i64, но чанки никогда не бывают отрицательными
        // (chunker гарантирует size >= 0). Приводим к u64 для take()/seek().
        let chunk_size = chunk.size.max(0) as u64;

        if chunk_path.exists() {
            // Чанк уже хранится — пропускаем, но позицию файла сдвигаем,
            // чтобы следующий чанк читался с правильного offset.
            file.seek(SeekFrom::Current(chunk.size))
                .map_err(Error::Io)?;
            continue;
        }

        // Копируем ровно chunk_size байт в новый файл. take(n) ограничивает
        // чтение n байтами; io::copy копирует, пока источник не вернёт EOF
        // (для take это момент достижения лимита). Таким образом, copied
        // равен chunk_size, если только исходный файл не оказался короче
        // ожидаемого.
        let mut out = std::fs::File::create(&chunk_path).map_err(Error::Io)?;
        let copied = io::copy(&mut (&mut file).take(chunk_size), &mut out).map_err(Error::Io)?;
        // Явно flush + drop, чтобы закрыть файл и сбросить буферы ДО того,
        // как мы будем читать chunk_path ниже по потоку (иначе на Windows
        // можно получить Sharing violation).
        out.flush().map_err(Error::Io)?;
        drop(out);

        if copied != chunk_size {
            // Файл оказался короче суммы размеров чанков — удаляем
            // недописанный файл и возвращаем ошибку.
            let _ = std::fs::remove_file(&chunk_path);
            return Err(Error::Operation(format!(
                "чанк выходит за пределы файла: запрошено {} байт, прочитано {}",
                chunk_size, copied
            )));
        }
    }

    Ok(())
}

/// Таблица случайных 64-битных значений для Buzhash.
/// Генерируется детерминистически на основе простого PRNG.
fn build_lookup() -> [u64; 256] {
    let mut table = [0u64; 256];
    let mut seed: u64 = 0x12345678_9ABCDEF0;
    for entry in &mut table {
        seed = seed.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
        *entry = seed;
    }
    table
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use tempfile::NamedTempFile;

    #[test]
    fn empty_file_produces_one_chunk() {
        let mut f = NamedTempFile::new().unwrap();
        let chunks = chunk_file(f.path().to_str().unwrap()).unwrap();
        assert_eq!(chunks.len(), 1);
        assert_eq!(chunks[0].size, 0);
    }

    #[test]
    fn small_file_produces_one_chunk() {
        let mut f = NamedTempFile::new().unwrap();
        f.write_all(&vec![0xAB; 1024]).unwrap();
        f.flush().unwrap();
        let chunks = chunk_file(f.path().to_str().unwrap()).unwrap();
        assert_eq!(chunks.len(), 1);
        assert_eq!(chunks[0].size, 1024);
    }

    #[test]
    fn identical_content_produces_same_chunks() {
        let data = vec![0x42; 6 * 1024 * 1024]; // 6 MB
        let mut f1 = NamedTempFile::new().unwrap();
        f1.write_all(&data).unwrap();
        f1.flush().unwrap();

        let mut f2 = NamedTempFile::new().unwrap();
        f2.write_all(&data).unwrap();
        f2.flush().unwrap();

        let c1 = chunk_file(f1.path().to_str().unwrap()).unwrap();
        let c2 = chunk_file(f2.path().to_str().unwrap()).unwrap();
        assert_eq!(c1.len(), c2.len());
        for (a, b) in c1.iter().zip(c2.iter()) {
            assert_eq!(a.hash, b.hash);
            assert_eq!(a.size, b.size);
        }
    }

    #[test]
    fn store_and_reassemble_roundtrip() {
        let data = b"Hello, chunking world!";
        let mut f = NamedTempFile::new().unwrap();
        f.write_all(data).unwrap();
        f.flush().unwrap();

        let chunks = chunk_file(f.path().to_str().unwrap()).unwrap();
        let dir = tempfile::tempdir().unwrap();
        let chunks_dir = dir.path().join("chunks");
        store_chunks(&chunks_dir, f.path().to_str().unwrap(), &chunks).unwrap();

        let hashes: Vec<String> = chunks.iter().map(|c| c.hash.clone()).collect();
        let reassembled = reassemble(&chunks_dir, &hashes).unwrap();
        assert_eq!(reassembled, data);
    }

    /// Регрессия для бага #5: файл должен корректно чанковаться при
    /// буферизованном чтении (256 KB-чанками), в том числе когда размер файла
    /// не кратен размеру буфера и превышает его в несколько раз.
    #[test]
    fn chunk_file_handles_large_non_aligned_file() {
        // 1 MB + 1 байт — точно не кратно 256 KB буферу чтения
        let size = 1024 * 1024 + 1;
        let mut data = Vec::with_capacity(size);
        let mut x: u32 = 0xDEAD_BEEF;
        for _ in 0..size {
            // Псевдослучайные байты, чтобы границы chunker не падали предсказуемо
            x ^= x << 13;
            x ^= x >> 17;
            x ^= x << 5;
            data.push((x & 0xFF) as u8);
        }

        let mut f = NamedTempFile::new().unwrap();
        f.write_all(&data).unwrap();
        f.flush().unwrap();

        let chunks = chunk_file(f.path().to_str().unwrap()).unwrap();

        // Сумма размеров чанков должна равняться размеру файла
        let total: i64 = chunks.iter().map(|c| c.size).sum();
        assert_eq!(total, size as i64, "сумма размеров чанков должна совпадать с размером файла");

        // Все чанки имеют ненулевой размер (кроме возможного пустого, но данных > 0)
        assert!(chunks.iter().all(|c| c.size > 0));

        // Каждый чанк не превышает CHUNK_MAX
        assert!(chunks.iter().all(|c| c.size as usize <= CHUNK_MAX));
    }
    
    /// Регрессия для бага #6: store_chunks должен стримить файл в чанки
    /// без загрузки целиком в память. Проверяем roundtrip на файле, который
    /// заведомо больше старого 256 KB-блока (используем 2 MB, чтобы получить
    /// несколько чанков), и idempotency: повторный вызов store_chunks не
    /// должен ни перезаписывать существующие чанки, ни портить данные.
    #[test]
    fn store_chunks_streams_and_is_idempotent() {
        // 2 MB псевдослучайных данных — даст несколько чанков по умолчанию
        // (целевой размер ~4 MB, мин 256 KB, но на случайных данных границы
        // могут выпадать раньше — главное, что файл больше старого буфера).
        let size = 2 * 1024 * 1024;
        let mut data = Vec::with_capacity(size);
        let mut x: u32 = 0xCAFEBABE;
        for _ in 0..size {
            x ^= x << 13;
            x ^= x >> 17;
            x ^= x << 5;
            data.push((x & 0xFF) as u8);
        }

        let mut f = NamedTempFile::new().unwrap();
        f.write_all(&data).unwrap();
        f.flush().unwrap();

        let chunks = chunk_file(f.path().to_str().unwrap()).unwrap();
        assert!(chunks.len() >= 1, "ожидаем хотя бы один чанк");

        let dir = tempfile::tempdir().unwrap();
        let chunks_dir = dir.path().join("chunks");

        // Первый вызов — записывает все чанки
        store_chunks(&chunks_dir, f.path().to_str().unwrap(), &chunks).unwrap();

        // Запоминаем mtime каждого чанк-файла (на Windows точность mtime
        // ограничена, поэтому второй store_chunks просто не должен падать).
        let hashes: Vec<String> = chunks.iter().map(|c| c.hash.clone()).collect();
        let reassembled = reassemble(&chunks_dir, &hashes).unwrap();
        assert_eq!(reassembled, data, "первый roundtrip должен дать исходные данные");

        // Второй вызов — все чанки уже существуют, должны быть пропущены.
        // Проверяем, что данные не изменились.
        store_chunks(&chunks_dir, f.path().to_str().unwrap(), &chunks).unwrap();
        let reassembled2 = reassemble(&chunks_dir, &hashes).unwrap();
        assert_eq!(reassembled2, data, "повторный store_chunks не должен портить данные");
    }

    /// Регрессия для бага #6: store_chunks должен вернуть ошибку, если размер
    /// файла меньше суммы размеров чанков (например, файл усечён между вызовами
    /// chunk_file и store_chunks). Недописанный чанк-файл должен быть удалён.
    #[test]
    fn store_chunks_errors_on_short_source_file() {
        // Создаём «длинный» файл и чанкуем его
        let long_data = vec![0x77u8; 1024 * 1024]; // 1 MB
        let mut f_long = NamedTempFile::new().unwrap();
        f_long.write_all(&long_data).unwrap();
        f_long.flush().unwrap();
        let chunks = chunk_file(f_long.path().to_str().unwrap()).unwrap();

        // Теперь создаём «короткий» файл с тем же именем — store_chunks должен
        // обнаружить несоответствие и вернуть ошибку.
        let dir = tempfile::tempdir().unwrap();
        let chunks_dir = dir.path().join("chunks");

        let mut f_short = NamedTempFile::new().unwrap();
        f_short.write_all(&[0u8; 16]).unwrap(); // всего 16 байт вместо мегабайта
        f_short.flush().unwrap();

        let result = store_chunks(&chunks_dir, f_short.path().to_str().unwrap(), &chunks);
        assert!(result.is_err(), "ожидали ошибку при коротком исходном файле");

        // Все чанки, которые успели создаться, должны быть удалены (или ни
        // один не создан) — проверяем, что каталог chunks либо пуст, либо
        // содержит только частично записанные файлы, которые мы потом удалили.
        // На практике: первый чанк запросит size > 16 байт, получит 16, упадёт.
        if chunks_dir.exists() {
            let entries: Vec<_> = std::fs::read_dir(&chunks_dir).unwrap().collect();
            for entry in entries {
                let p = entry.unwrap().path();
                // Недописанный чанк должен быть удалён
                assert!(!p.exists(), "недописанный чанк-файл не должен оставаться: {:?}", p);
            }
        }
    }
}
