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
    // On a case-insensitive file system (Windows) `report.txt` → `Report.txt`
    // finds the source itself under the new name: that is a case-only rename
    // of the same entry, not a conflict.
    let case_only = crate::index::path_key::normalize(&dest.to_string_lossy())
        == crate::index::path_key::normalize(path);
    if dest.exists() && !case_only {
        return Err(Error::Operation(format!("already exists: {new_name}")));
    }
    std::fs::rename(src, &dest)?;
    Ok(dest.to_string_lossy().into_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rename_refuses_an_existing_target() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("a.txt"), "a").unwrap();
        std::fs::write(dir.path().join("b.txt"), "b").unwrap();
        let src = dir.path().join("a.txt").to_string_lossy().into_owned();
        assert!(rename_entry(&src, "b.txt").is_err());
        assert_eq!(std::fs::read_to_string(dir.path().join("b.txt")).unwrap(), "b");
    }

    #[test]
    fn rename_changes_letter_case() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("report.txt"), "x").unwrap();
        let src = dir.path().join("report.txt").to_string_lossy().into_owned();
        let new = rename_entry(&src, "Report.txt").unwrap();
        assert!(new.ends_with("Report.txt"));
        let names: Vec<String> = std::fs::read_dir(dir.path())
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        assert_eq!(names, vec!["Report.txt".to_string()]);
    }
}
