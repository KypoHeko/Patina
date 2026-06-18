//! Команды истории версий.
//!
//! Гибридная стратегия хранения:
//! - < 15 MB: zstd-сжатие с обучаемым словарём
//! - >= 15 MB: чанковое разбиение (content-defined chunking)
//! - 'full': старый формат (обратная совместимость)
//!
//! Согласованность контент-адресного хранилища (баг C4)
//! --------------------------------------------------------------------
//! Блобы (`versions/<hash>.zst`) и чанки (`chunks/<hash>`) адресуются по
//! содержимому и шарятся между версиями, поэтому удалять их можно только когда
//! на хеш не осталось ссылок (refcount == 0). Чтобы сборка мусора не снесла
//! живые данные, действует один инвариант:
//!
//!   *Строка-ссылка в БД всегда появляется РАНЬШЕ, чем контент ложится на диск,
//!    а сборщик мусора проверяет refcount и удаляет файл под одним и тем же
//!    захватом `state.db()`.*
//!
//! Тогда к моменту, когда блоб/чанк материализуется на диске, refcount по его
//! хешу уже ненулевой, и GC (`delete_version`), работающий под тем же локом,
//! не может счесть его осиротевшим. Тяжёлая запись контента при этом идёт ВНЕ
//! лока — держать БД заблокированной на время многомегабайтного IO нельзя.

use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

use tauri::{AppHandle, Manager};

use crate::error::{Error, Result};
use crate::index::versions_repo::{self, Version};
use crate::index::chunker;
use crate::index::version_compress;
use crate::indexer::hasher;
use crate::state::AppState;

/// Порог: файлы >= этого размера чанкуются.
const CHUNK_THRESHOLD: u64 = 15 * 1024 * 1024; // 15 MB

fn now_secs() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

/// Снимок, если содержимое изменилось.
/// Выбирает стратегию по размеру файла:
/// - < 15 MB: zstd-сжатие (со словарём, если обучен)
/// - >= 15 MB: чанковое разбиение
///
/// Порядок операций задаётся инвариантом согласованности (см. заголовок модуля):
/// сначала под локом вставляется строка версии (а для chunked — и её chunk-строки),
/// и только потом контент пишется на диск вне лока. Если запись контента упала —
/// строка откатывается, чтобы не осталось версии без блоба/чанков.
fn do_snapshot(db: &std::sync::Mutex<rusqlite::Connection>, versions_dir: &Path, path: &str) -> Result<()> {
    let meta = std::fs::metadata(path).map_err(Error::Io)?;
    if !meta.is_file() {
        return Ok(());
    }

    let file_size = meta.len();
    let chunks_dir = versions_dir.join("chunks");
    let dicts_dir = version_compress::dicts_dir(versions_dir);

    if file_size < CHUNK_THRESHOLD {
        // ── Стратегия zstd ──
        // Один проход по диску: получаем и хеш (для CAS-адресации и проверки
        // «изменился ли файл»), и байты (для сжатия) за одно чтение.
        let (hash, file_data) = hasher::hash_and_read(path).map_err(Error::Io)?;

        // Короткий лок: проверка «не изменилось» + текущий словарь.
        let dict_id = {
            let conn = db.lock().map_err(|_| Error::Operation("БД заблокирована (poisoned)".into()))?;
            if versions_repo::latest_hash(&conn, path)?.as_deref() == Some(hash.as_str()) {
                return Ok(());
            }
            versions_repo::current_dict_id(&conn)?
        };

        // Сжатие — вне лока (это CPU-работа, не нужно держать БД).
        let (compressed, used_dict) = version_compress::compress(&file_data, &dicts_dir, dict_id)?;

        let blob = versions_dir.join(format!("{hash}.zst"));

        // C4: строку-ссылку вставляем ДО записи блоба. Повторная проверка
        // latest_hash под локом отсекает гонку с параллельным снимком той же
        // версии, который мог вставиться, пока мы сжимали.
        let new_id = {
            let conn = db.lock().map_err(|_| Error::Operation("БД заблокирована (poisoned)".into()))?;
            if versions_repo::latest_hash(&conn, path)?.as_deref() == Some(hash.as_str()) {
                return Ok(());
            }
            let label = versions_repo::next_label(&conn, path)?;
            versions_repo::insert(&conn, path, now_secs(), file_size as i64, &hash, &label, "zstd", used_dict)?
        };

        // Материализуем блоб вне лока. Если файла ещё нет — пишем; если запись
        // упала, откатываем только что вставленную строку, чтобы не осталось
        // версии, ссылающейся на несуществующий блоб.
        if !blob.exists() {
            if let Err(e) = std::fs::write(&blob, &compressed).map_err(Error::Io) {
                let conn = db.lock().map_err(|_| Error::Operation("БД заблокирована (poisoned)".into()))?;
                let _ = versions_repo::delete(&conn, new_id);
                return Err(e);
            }
        }

        // NOTE: Обучение/переобучение словаря выполняется в одном месте —
        // в `snapshot_version` после `do_snapshot`.
    } else {
        // ── Стратегия chunked ──
        // Хеш нужен для проверки «изменился ли файл»; chunker стримит содержимое.
        // Это второй проход по файлу (см. отложенные баги #5–#7 про chunker).
        let hash = hasher::hash_file(path).map_err(Error::Io)?;

        // Если содержимое не изменилось — пропускаем (короткий лок).
        {
            let conn = db.lock().map_err(|_| Error::Operation("БД заблокирована (poisoned)".into()))?;
            if versions_repo::latest_hash(&conn, path)?.as_deref() == Some(hash.as_str()) {
                return Ok(());
            }
        }

        // Границы чанков считаем вне лока (читает файл потоково).
        let chunks = chunker::chunk_file(path)?;

        // C4: версия и её chunk-строки вставляются ДО записи чанков на диск.
        // Так refcount каждого чанка ненулевой к моменту, когда чанк появится
        // на диске, и параллельный GC не удалит его как осиротевший. Сами чанки
        // (потенциально гигабайты) пишутся ниже, ВНЕ лока.
        let new_id = {
            let conn = db.lock().map_err(|_| Error::Operation("БД заблокирована (poisoned)".into()))?;
            if versions_repo::latest_hash(&conn, path)?.as_deref() == Some(hash.as_str()) {
                return Ok(());
            }
            let label = versions_repo::next_label(&conn, path)?;
            let vid = versions_repo::insert(&conn, path, now_secs(), file_size as i64, &hash, &label, "chunked", None)?;
            versions_repo::insert_chunks(&conn, vid, &chunks)?;
            vid
        };

        // Материализуем чанки вне лока. При ошибке откатываем строку версии
        // (delete также удалит её version_chunks).
        if let Err(e) = chunker::store_chunks(&chunks_dir, path, &chunks) {
            let conn = db.lock().map_err(|_| Error::Operation("БД заблокирована (poisoned)".into()))?;
            let _ = versions_repo::delete(&conn, new_id);
            return Err(e);
        }
    }

    Ok(())
}

/// Обучить или переобучить zstd-словарь (с путём к versions_dir).
fn maybe_train_dict_with_dir(
    db: &std::sync::Mutex<rusqlite::Connection>,
    versions_dir: &Path,
) -> Result<()> {
    let dicts_dir = version_compress::dicts_dir(versions_dir);

    // Текущее состояние: сколько zstd-версий накопилось, при каком их числе
    // обучался последний словарь, и id этого словаря (для генерации имени файла
    // нового словаря: dict-<id>.zstd).
    let (zstd_count, trained_at, current_dict_id) = {
        let conn = db.lock().map_err(|_| Error::Operation("БД заблокирована (poisoned)".into()))?;
        let count = versions_repo::zstd_count(&conn)? as usize;
        let at = versions_repo::current_dict_zstd_count_at_train(&conn)?
            .map(|v| v as usize);
        let dict_id = versions_repo::current_dict_id(&conn)?;
        (count, at, dict_id)
    };

    if !version_compress::should_retrain(zstd_count, trained_at) {
        return Ok(());
    }

    let max_samples = 20;
    let max_sample_size = 1 * 1024 * 1024;

    let rows: Vec<(String, Option<i64>)> = {
        let conn = db.lock().map_err(|_| Error::Operation("БД заблокирована (poisoned)".into()))?;
        conn
            .prepare("SELECT hash, dict_id FROM versions WHERE strategy = 'zstd' ORDER BY ts DESC LIMIT ?1")?
            .query_map([max_samples as i64], |r| {
                Ok((r.get::<_, String>(0)?, r.get::<_, Option<i64>>(1)?))
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?
    };

    let mut samples = Vec::new();
    for (hash, dict_id) in &rows {
        let blob = versions_dir.join(format!("{hash}.zst"));
        if !blob.exists() {
            // Блоб ещё не материализован (в т.ч. снимок «в полёте») — пропускаем.
            continue;
        }
        let compressed = std::fs::read(&blob).map_err(Error::Io)?;
        match version_compress::decompress(&compressed, &dicts_dir, *dict_id) {
            Ok(data) => {
                // Ограничиваем размер сэмпла
                if data.len() <= max_sample_size {
                    samples.push(data);
                } else {
                    samples.push(data[..max_sample_size].to_vec());
                }
            }
            Err(_) => continue, // не удалось распаковать — пропускаем
        }
        if samples.len() >= max_samples {
            break;
        }
    }

    if samples.len() < 4 {
        return Ok(()); // слишком мало для обучения
    }

    // Новый id словаря = max существующий + 1 (или 1, если нет).
    // id нужен только для имени файла dict-<id>.zstd; логику переобучения
    // он больше не определяет — для этого есть zstd_count_at_train.
    let new_id = current_dict_id.unwrap_or(0) + 1;

    let dict_path = version_compress::train_dict(&dicts_dir, &samples, new_id)?;
    let dict_data = std::fs::read(&dict_path).map_err(Error::Io)?;

    {
        let conn = db.lock().map_err(|_| Error::Operation("БД заблокирована (poisoned)".into()))?;
        // Запоминаем, при каком числе zstd-версий обучили словарь —
        // от этого значения будущий should_retrain будет отсчитывать интервал.
        versions_repo::insert_dict(&conn, now_secs(), dict_data.len() as i64, zstd_count as i64)?;
    }

    Ok(())
}

/// Восстановить версию: сделать снимок текущего состояния, затем
/// заменить содержимое файла данными версии.
fn do_restore(
    db: &std::sync::Mutex<rusqlite::Connection>,
    versions_dir: &Path,
    id: i64,
) -> Result<()> {
    let v = {
        let conn = db.lock().map_err(|_| Error::Operation("БД заблокирована (poisoned)".into()))?;
        versions_repo::get(&conn, id)?
            .ok_or_else(|| Error::Operation("версия не найдена".into()))?
    };

    // C3: предохранительный снимок текущего состояния — иначе restore затрёт
    // несохранённые изменения. Ошибку снимка глотать нельзя:
    //   Ok           — снято (или снимок не требовался, т.к. файл не менялся) → продолжаем;
    //   файла нет     — терять нечего, restore его воссоздаст → продолжаем;
    //   любая другая  — текущее состояние НЕ сохранено → прерываем restore.
    match do_snapshot(db, versions_dir, &v.path) {
        Ok(()) => {}
        Err(Error::Io(e)) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => return Err(e),
    }

    match v.strategy.as_str() {
        "full" => {
            let blob = versions_dir.join(&v.hash);
            std::fs::copy(&blob, &v.path).map_err(Error::Io)?;
        }
        "zstd" => {
            let blob = versions_dir.join(format!("{}.zst", &v.hash));
            let compressed = std::fs::read(&blob).map_err(Error::Io)?;
            let dicts_dir = version_compress::dicts_dir(versions_dir);
            let data = version_compress::decompress(&compressed, &dicts_dir, v.dict_id)?;
            std::fs::write(&v.path, &data).map_err(Error::Io)?;
        }
        "chunked" => {
            let chunks_dir = versions_dir.join("chunks");
            let chunk_list = {
                let conn = db.lock().map_err(|_| Error::Operation("БД заблокирована (poisoned)".into()))?;
                versions_repo::get_chunks(&conn, id)?
            };
            let hashes: Vec<String> = chunk_list.iter().map(|(h, _)| h.clone()).collect();
            let data = chunker::reassemble(&chunks_dir, &hashes)?;
            std::fs::write(&v.path, &data).map_err(Error::Io)?;
        }
        _ => {
            return Err(Error::Operation(format!("неизвестная стратегия: {}", v.strategy)));
        }
    }
    Ok(())
}

#[tauri::command]
pub async fn snapshot_version(app: AppHandle, path: String) -> Result<Vec<Version>> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        do_snapshot(&state.db, &state.versions_dir, &path)?;
        // Обучаем/переобучаем словарь (для zstd-стратегии)
        let _ = maybe_train_dict_with_dir(&state.db, &state.versions_dir);
        let conn = state.db_read()?;
        versions_repo::list_for(&conn, &path)
    })
    .await
    .map_err(|e| Error::Operation(format!("snapshot_version прерван: {e}")))?
}

#[tauri::command]
pub async fn list_versions(app: AppHandle, path: String) -> Result<Vec<Version>> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        let conn = state.db_read()?;
        versions_repo::list_for(&conn, &path)
    })
    .await
    .map_err(|e| Error::Operation(format!("list_versions прерван: {e}")))?
}

#[tauri::command]
pub async fn restore_version(app: AppHandle, id: i64) -> Result<()> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        do_restore(&state.db, &state.versions_dir, id)
    })
    .await
    .map_err(|e| Error::Operation(format!("restore_version прерван: {e}")))?
}

/// Удалить версию файла по id. Если на блоб/чанк больше нет ссылок —
/// они тоже удаляются с диска. Нельзя удалить единственную версию.
#[tauri::command]
pub async fn delete_version(app: AppHandle, id: i64) -> Result<Vec<Version>> {
    tauri::async_runtime::spawn_blocking(move || -> Result<Vec<Version>> {
        let state = app.state::<AppState>();

        // C4: весь критический участок — под одним захватом state.db().
        // Тогда между проверкой refcount и физическим remove_file не может
        // вклиниться параллельный снимок и сослаться на тот же контент-адресный
        // объект. Держать мьютекс БД на время unlink здесь осознанно: операции
        // версий и так сериализованы на одном соединении, а сам unlink короткий
        // и в БД не реентрит.
        let versions = {
            let conn = state.db()?;

            // Метаданные удаляемой версии + защита от удаления единственной.
            let v = versions_repo::get(&conn, id)?
                .ok_or_else(|| Error::Operation("версия не найдена".into()))?;
            if versions_repo::count_for(&conn, &v.path)? <= 1 {
                return Err(Error::Operation("нельзя удалить единственную версию".into()));
            }

        // Хеши чанков собираем ДО delete (он удалит version_chunks).
        let chunk_hashes: Vec<String> = if v.strategy == "chunked" {
            versions_repo::get_chunks(&conn, id)?
                .into_iter()
                .map(|(h, _)| h)
                .collect()
        } else {
            Vec::new()
        };

        // Удаляем строку версии (и её version_chunks).
        versions_repo::delete(&conn, id)?
                .ok_or_else(|| Error::Operation("версия не найдена".into()))?;

            let versions_dir = &state.versions_dir;

            // Блоб (full/zstd) — только если на хеш больше нет ссылок.
            if versions_repo::hash_refcount(&conn, &v.hash)? == 0 {
            match v.strategy.as_str() {
                "full" => {
                    let _ = std::fs::remove_file(versions_dir.join(&v.hash));
                }
                "zstd" => {
                    let _ = std::fs::remove_file(versions_dir.join(format!("{}.zst", &v.hash)));
                }
                _ => {}
            }
        }

        // Осиротевшие чанки.
        if !chunk_hashes.is_empty() {
            let chunks_dir = versions_dir.join("chunks");
            for ch in &chunk_hashes {
                if versions_repo::chunk_refcount(&conn, ch)? == 0 {
                    let _ = std::fs::remove_file(chunks_dir.join(ch));
                }
            }
        }

        // Обновлённый список — пока держим тот же conn.
        versions_repo::list_for(&conn, &v.path)?
        };

        Ok(versions)
    })
    .await
    .map_err(|e| Error::Operation(format!("delete_version прерван: {e}")))?
}
