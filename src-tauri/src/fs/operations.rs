//! File operations: copy, move, delete to Trash, rename.

use fs_extra::dir::CopyOptions;

use crate::error::{Error, Result};

fn opts(overwrite: bool) -> CopyOptions {
    let mut o = CopyOptions::new();
    o.overwrite = overwrite;
    o
}

pub fn copy_entries(sources: &[String], dest_dir: &str, overwrite: bool) -> Result<()> {
    fs_extra::copy_items(sources, dest_dir, &opts(overwrite))
        .map_err(|e| Error::Operation(e.to_string()))?;
    Ok(())
}

pub fn move_entries(sources: &[String], dest_dir: &str, overwrite: bool) -> Result<()> {
    fs_extra::move_items(sources, dest_dir, &opts(overwrite))
        .map_err(|e| Error::Operation(e.to_string()))?;
    Ok(())
}

pub fn delete_entries(paths: &[String]) -> Result<()> {
    // Windows — native IFileOperation (UAC, long and UNC paths);
    // other OSes — the `trash` crate (fallback inside platform).
    crate::platform::delete_to_recycle_bin(paths)
}

pub fn rename_entry(path: &str, new_name: &str) -> Result<String> {
    if new_name.is_empty() || new_name.contains('/') || new_name.contains('\\') {
        return Err(Error::InvalidPath(format!("invalid name: {new_name}")));
    }
    let src = std::path::Path::new(path);
    let parent = src
        .parent()
        .ok_or_else(|| Error::InvalidPath(path.to_string()))?;
    let dest = parent.join(new_name);
    if dest.exists() {
        return Err(Error::Operation(format!("already exists: {new_name}")));
    }
    std::fs::rename(src, &dest)?;
    Ok(dest.to_string_lossy().into_owned())
}
