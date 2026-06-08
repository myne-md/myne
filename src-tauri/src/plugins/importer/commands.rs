//! Host-side commands for the `importer` read-seam (MYND-53, SYNC-1).
//!
//! `import_read_dir` and `import_read_file` are the ONLY path by which the
//! WebView reads an external (Obsidian vault) directory. No general
//! `fs:allow-read-text-file` / `read-dir` is granted to the WebView — this
//! narrow, path-validating seam replaces it (least-privilege, TB6; SYNC-1
//! ratified 2026-06-08). The TS side picks the import root via the already-
//! granted `dialog:allow-open` and passes it as `root`; every read is validated
//! to live within that canonical root before any I/O.
//!
//! Reading the user's own external files does NOT require an unlocked vault, so
//! there is no `Slot::Unlocked` gate here; the later `note_create` ingest IS
//! slot-gated. File bytes are note-class plaintext → the Plaintext-IPC pattern
//! (wrap in `Zeroizing`, do the work in `spawn_blocking`, drop on exit; write no
//! temp/scratch plaintext, ever — only `note_create` writes, encrypted).

use crate::io_failure_kind::{from_io_error_kind, IoFailureKind};
use crate::plugins::importer::error::ImportReadError;
use serde::Serialize;
use std::path::{Path, PathBuf};
use zeroize::Zeroizing;

/// One directory entry — name + is-directory, never any file content. The TS
/// walk uses `is_dir` to decide recursion vs file classification.
#[derive(Debug, Serialize)]
pub struct ImportDirEntry {
    pub name: String,
    pub is_dir: bool,
}

/// Validate that `path` is an absolute location inside the canonical `root`,
/// resolving `..` and symlinks first. The component-wise `starts_with` (not a
/// string prefix) means `…/vault-evil` does not pass as a child of `…/vault`.
/// A symlink whose target escapes the root canonicalizes outside it and is
/// rejected. canonicalize requires the path to exist (these commands only read
/// real entries); a non-existent / unreadable path is rejected opaquely so the
/// boundary leaks no existence information.
fn validate_within_root(root: &str, path: &str) -> Result<PathBuf, ImportReadError> {
    let root_path = Path::new(root);
    let target = Path::new(path);
    if !root_path.is_absolute() || !target.is_absolute() {
        return Err(ImportReadError::PathRejected);
    }
    let canon_root = root_path
        .canonicalize()
        .map_err(|_| ImportReadError::PathRejected)?;
    let canon_target = target
        .canonicalize()
        .map_err(|_| ImportReadError::PathRejected)?;
    if !canon_target.starts_with(&canon_root) {
        return Err(ImportReadError::PathRejected);
    }
    Ok(canon_target)
}

fn io(e: std::io::Error) -> ImportReadError {
    ImportReadError::Io {
        io_error_kind: from_io_error_kind(e.kind()),
    }
}

fn join_err() -> ImportReadError {
    ImportReadError::Io {
        io_error_kind: IoFailureKind::Other,
    }
}

/// List a directory's entries (name + is_dir, no content) so the TS walk can
/// recurse. Validated within the picked root.
#[tauri::command]
pub async fn import_read_dir(
    root: String,
    path: String,
) -> Result<Vec<ImportDirEntry>, ImportReadError> {
    let dir = validate_within_root(&root, &path)?;
    tauri::async_runtime::spawn_blocking(move || {
        let mut entries = Vec::new();
        for entry in std::fs::read_dir(&dir).map_err(io)? {
            let entry = entry.map_err(io)?;
            // `file_type` does NOT follow symlinks — a symlink reports as a
            // symlink (is_dir=false), so the walk will not recurse through it;
            // a file read through it would still be re-validated within-root.
            let is_dir = entry.file_type().map(|t| t.is_dir()).unwrap_or(false);
            entries.push(ImportDirEntry {
                name: entry.file_name().to_string_lossy().into_owned(),
                is_dir,
            });
        }
        Ok(entries)
    })
    .await
    .map_err(|_| join_err())?
}

/// Read a file's UTF-8 source bytes. Validated within the picked root; plaintext
/// is wrapped in `Zeroizing` and dropped at closure exit (only the IPC-return
/// copy survives, which Tauri owns). Never writes plaintext to disk.
#[tauri::command]
pub async fn import_read_file(root: String, path: String) -> Result<String, ImportReadError> {
    let file = validate_within_root(&root, &path)?;
    tauri::async_runtime::spawn_blocking(move || {
        let bytes = Zeroizing::new(std::fs::read(&file).map_err(io)?);
        // `bytes.to_vec()` is the accepted microsecond intermediate (Plaintext-IPC
        // read-side discipline, src-tauri/CLAUDE.md); the result String leaves via
        // IPC and the `Zeroizing<Vec<u8>>` zeroes on drop.
        String::from_utf8(bytes.to_vec()).map_err(|_| ImportReadError::NotUtf8)
    })
    .await
    .map_err(|_| join_err())?
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A unique temp directory tree for one test; cleaned up on drop.
    struct TempTree {
        root: PathBuf,
    }
    impl TempTree {
        fn new(tag: &str) -> Self {
            let root = std::env::temp_dir().join(format!("myne-importer-test-{tag}"));
            let _ = std::fs::remove_dir_all(&root);
            std::fs::create_dir_all(&root).unwrap();
            Self { root }
        }
    }
    impl Drop for TempTree {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.root);
        }
    }

    #[test]
    fn accepts_a_file_within_root() {
        let t = TempTree::new("accept");
        let f = t.root.join("note.md");
        std::fs::write(&f, "hi").unwrap();
        let v = validate_within_root(t.root.to_str().unwrap(), f.to_str().unwrap());
        assert!(v.is_ok());
    }

    #[test]
    fn rejects_traversal_outside_root() {
        let t = TempTree::new("traversal");
        let sub = t.root.join("sub");
        std::fs::create_dir_all(&sub).unwrap();
        // sub/../../<temp> escapes the root via `..`
        let escape = sub.join("..").join("..");
        let res = validate_within_root(sub.to_str().unwrap(), escape.to_str().unwrap());
        assert!(matches!(res, Err(ImportReadError::PathRejected)));
    }

    #[test]
    fn rejects_sibling_prefix_lookalike() {
        let parent = TempTree::new("sibling");
        let root = parent.root.join("vault");
        let evil = parent.root.join("vault-evil");
        std::fs::create_dir_all(&root).unwrap();
        std::fs::create_dir_all(&evil).unwrap();
        let f = evil.join("x.md");
        std::fs::write(&f, "x").unwrap();
        // `vault-evil/x.md` must NOT count as a child of `vault/`
        let res = validate_within_root(root.to_str().unwrap(), f.to_str().unwrap());
        assert!(matches!(res, Err(ImportReadError::PathRejected)));
    }

    #[test]
    fn rejects_relative_path() {
        let t = TempTree::new("relative");
        let res = validate_within_root(t.root.to_str().unwrap(), "relative/path.md");
        assert!(matches!(res, Err(ImportReadError::PathRejected)));
    }

    #[test]
    fn rejects_nonexistent_path() {
        let t = TempTree::new("nonexistent");
        let res = validate_within_root(
            t.root.to_str().unwrap(),
            t.root.join("does-not-exist.md").to_str().unwrap(),
        );
        assert!(matches!(res, Err(ImportReadError::PathRejected)));
    }
}
