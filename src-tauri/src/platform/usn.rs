//! Platform-independent part of the NTFS USN Journal support: the cursor type,
//! the result of a read, and a safe parser of `USN_RECORD_V2` / `USN_RECORD_V3`
//! buffers. Kept free of WinAPI so it is unit-tested on every OS.
//!
//! A USN record carries only the file NAME and the file reference number of
//! its PARENT directory — never a full path. The Windows layer resolves the
//! parent reference to a path (`OpenFileById` + `GetFinalPathNameByHandleW`).

// Only the Windows reader uses the parser outside of tests.
#![cfg_attr(not(windows), allow(dead_code))]

use std::collections::HashSet;

/// Position in a volume's journal: the journal instance and the next USN to
/// read. A different `journal_id` means the journal was recreated and every
/// saved position is meaningless.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct UsnCursor {
    pub journal_id: u64,
    pub next_usn: i64,
}

/// Outcome of reading the journal since a cursor.
#[derive(Debug)]
#[cfg_attr(not(windows), allow(dead_code))] // only the Windows reader produces Reset/Changes
pub enum UsnRead {
    /// No journal for this root (not NTFS, no rights, not Windows, UNC path):
    /// the caller falls back to a full scan.
    Unavailable,
    /// The journal was recreated or the saved position was already purged
    /// from it: changes may have been lost, a full scan is required.
    Reset,
    /// Paths whose state changed since the cursor (their current state must be
    /// re-read from disk) and the cursor to save for next time.
    Changes { paths: Vec<String>, cursor: UsnCursor },
}

/// File reference number of a record's parent directory (64-bit in V2 records,
/// 128-bit in V3 records, used on ReFS and on NTFS volumes with large IDs).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum FileRef {
    V2(u64),
    V3([u8; 16]),
}

/// One journal record reduced to what the index needs.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct UsnEntry {
    pub parent: FileRef,
    pub name: String,
}

fn u16_at(b: &[u8], off: usize) -> Option<u16> {
    Some(u16::from_le_bytes(b.get(off..off + 2)?.try_into().ok()?))
}

fn u32_at(b: &[u8], off: usize) -> Option<u32> {
    Some(u32::from_le_bytes(b.get(off..off + 4)?.try_into().ok()?))
}

fn u64_at(b: &[u8], off: usize) -> Option<u64> {
    Some(u64::from_le_bytes(b.get(off..off + 8)?.try_into().ok()?))
}

/// Parse the records that follow the leading 8-byte "next USN" of a
/// `FSCTL_READ_USN_JOURNAL` output buffer, adding them to `out` (deduplicated:
/// a file saved 500 times since the last run is one entry).
///
/// All reads are bounds-checked and byte-wise (no pointer casts), so a short
/// or malformed buffer simply ends parsing instead of reading out of bounds or
/// through a misaligned `u16` pointer. Records of unknown versions (V4 range
/// records carry no name) are skipped.
pub fn parse_records(buf: &[u8], out: &mut HashSet<UsnEntry>) {
    let mut off = 0usize;
    while off + 8 <= buf.len() {
        let Some(len) = u32_at(buf, off).map(|v| v as usize) else { break };
        if len < 8 || off + len > buf.len() {
            break;
        }
        let rec = &buf[off..off + len];
        let major = u16_at(rec, 4).unwrap_or(0);
        let parsed = match major {
            // USN_RECORD_V2: ParentFileReferenceNumber @16 (u64),
            // FileNameLength @56, FileNameOffset @58.
            2 => u64_at(rec, 16)
                .zip(u16_at(rec, 56).zip(u16_at(rec, 58)))
                .map(|(p, (l, o))| (FileRef::V2(p), l as usize, o as usize)),
            // USN_RECORD_V3: ParentFileReferenceNumber @24 (FILE_ID_128),
            // FileNameLength @72, FileNameOffset @74.
            3 => rec
                .get(24..40)
                .and_then(|p| <[u8; 16]>::try_from(p).ok())
                .zip(u16_at(rec, 72).zip(u16_at(rec, 74)))
                .map(|(p, (l, o))| (FileRef::V3(p), l as usize, o as usize)),
            _ => None,
        };
        if let Some((parent, name_len, name_off)) = parsed
            && name_len > 0
            && name_len % 2 == 0
            && let Some(raw) = rec.get(name_off..name_off + name_len)
        {
            let units: Vec<u16> = raw.chunks_exact(2).map(|c| u16::from_le_bytes([c[0], c[1]])).collect();
            out.insert(UsnEntry { parent, name: String::from_utf16_lossy(&units) });
        }
        off += len;
    }
}

/// `\\?\C:\dir` → `C:\dir`, `\\?\UNC\srv\share` → `\\srv\share` (the form
/// `GetFinalPathNameByHandleW` returns vs. the form the index stores).
pub fn strip_verbatim(path: &str) -> String {
    if let Some(rest) = path.strip_prefix(r"\\?\UNC\") {
        format!(r"\\{rest}")
    } else if let Some(rest) = path.strip_prefix(r"\\?\") {
        rest.to_string()
    } else {
        path.to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn name_bytes(s: &str) -> Vec<u8> {
        s.encode_utf16().flat_map(|u| u.to_le_bytes()).collect()
    }

    fn v2(parent: u64, name: &str) -> Vec<u8> {
        let n = name_bytes(name);
        let len = (60 + n.len()).div_ceil(8) * 8;
        let mut r = vec![0u8; len];
        r[0..4].copy_from_slice(&(len as u32).to_le_bytes());
        r[4..6].copy_from_slice(&2u16.to_le_bytes());
        r[16..24].copy_from_slice(&parent.to_le_bytes());
        r[56..58].copy_from_slice(&(n.len() as u16).to_le_bytes());
        r[58..60].copy_from_slice(&60u16.to_le_bytes());
        r[60..60 + n.len()].copy_from_slice(&n);
        r
    }

    fn v3(parent: [u8; 16], name: &str) -> Vec<u8> {
        let n = name_bytes(name);
        let len = (76 + n.len()).div_ceil(8) * 8;
        let mut r = vec![0u8; len];
        r[0..4].copy_from_slice(&(len as u32).to_le_bytes());
        r[4..6].copy_from_slice(&3u16.to_le_bytes());
        r[24..40].copy_from_slice(&parent);
        r[72..74].copy_from_slice(&(n.len() as u16).to_le_bytes());
        r[74..76].copy_from_slice(&76u16.to_le_bytes());
        r[76..76 + n.len()].copy_from_slice(&n);
        r
    }

    #[test]
    fn parses_v2_and_v3_and_deduplicates() {
        let mut buf = Vec::new();
        buf.extend(v2(5, "отчёт.txt"));
        buf.extend(v3([7; 16], "b.md"));
        buf.extend(v2(5, "отчёт.txt")); // the same file touched again
        let mut out = HashSet::new();
        parse_records(&buf, &mut out);
        assert_eq!(out.len(), 2);
        assert!(out.contains(&UsnEntry { parent: FileRef::V2(5), name: "отчёт.txt".into() }));
        assert!(out.contains(&UsnEntry { parent: FileRef::V3([7; 16]), name: "b.md".into() }));
    }

    #[test]
    fn odd_offsets_are_read_safely() {
        // A record starting at an odd address inside the buffer (the old code
        // built a &[u16] from such a pointer — undefined behaviour).
        let mut buf = vec![0u8; 1];
        buf.extend(v2(9, "x"));
        let mut out = HashSet::new();
        parse_records(&buf[1..], &mut out);
        assert_eq!(out.len(), 1);
    }

    #[test]
    fn truncated_or_garbage_buffers_stop_cleanly() {
        let rec = v2(1, "file.txt");
        let mut out = HashSet::new();
        parse_records(&rec[..rec.len() - 4], &mut out); // length points past the end
        parse_records(&[0xFF; 7], &mut out);
        parse_records(&[0u8; 64], &mut out); // RecordLength 0
        assert!(out.is_empty());
    }

    #[test]
    fn strips_verbatim_prefixes() {
        assert_eq!(strip_verbatim(r"\\?\C:\Users"), r"C:\Users");
        assert_eq!(strip_verbatim(r"\\?\UNC\srv\share\x"), r"\\srv\share\x");
        assert_eq!(strip_verbatim(r"C:\a"), r"C:\a");
    }
}
