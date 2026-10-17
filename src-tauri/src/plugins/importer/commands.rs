// SPDX-License-Identifier: AGPL-3.0
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
/// walk uses `is_dir` to decide recursion vs file classification, and `link` to
/// decide what to do with a symbolic link.
#[derive(Debug, Serialize)]
pub struct ImportDirEntry {
    pub name: String,
    pub is_dir: bool,
    /// `None` for an ordinary file or directory; `Some` when the entry is a
    /// symbolic link. See [`EntryLink`].
    pub link: Option<EntryLink>,
}

/// What the walk may do with a symbolic link, decided here because only this
/// side can resolve one.
///
/// A symlinked directory used to report `is_dir: false` (`DirEntry::file_type`
/// does not follow links), so the TS walk classified it by NAME, filed it under
/// "other files skipped", and never visited the subtree underneath it — a
/// silent omission of arbitrary size behind a count that reads like a stray
/// `.png` (myne-md/myne#223). Following it is the Obsidian-compatible answer;
/// the three refusal variants are the cases where following is wrong, and each
/// one is reported by name instead of being folded into a skip count.
#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(tag = "status", rename_all = "kebab-case")]
pub enum EntryLink {
    /// Resolves inside the picked root; walk or read it like any other entry.
    ///
    /// `target_key` is an **opaque, non-reversible** identity for the resolved
    /// target — the walk keeps a visited set of these to terminate on a cycle
    /// that this side cannot see (`a/x -> b`, `b/y -> a`), which needs equality
    /// and nothing else. It is a hash rather than the path because a full
    /// filesystem path may not cross this boundary in any payload
    /// (`src-tauri/AGENTS.md` "Secret-handling logging discipline").
    Followable { target_key: String },
    /// Resolves outside the picked root — refused (TB6), same rule the
    /// read-seam validator applies, decided here so the walk can say so.
    Outside,
    /// Points at the directory being listed, or one of its ancestors. Following
    /// it would re-enter a tree the walk is already inside.
    Loop,
    /// Does not resolve at all (dangling link).
    Broken,
}

/// Opaque identity for a canonical path: the first 16 bytes of its SHA-256,
/// hex-encoded. Not a path, not reversible, stable within and across runs —
/// the walk only ever compares two of these for equality.
fn target_key(canonical: &Path) -> String {
    use sha2::{Digest, Sha256};
    let digest = Sha256::digest(canonical.as_os_str().as_encoded_bytes());
    let mut out = String::with_capacity(32);
    for byte in &digest[..16] {
        use std::fmt::Write as _;
        let _ = write!(out, "{byte:02x}");
    }
    out
}

/// Validate that `path` is an absolute location inside the canonical `root`,
/// resolving `..` and symlinks first. The component-wise `starts_with` (not a
/// string prefix) means `…/vault-evil` does not pass as a child of `…/vault`.
/// A symlink whose target escapes the root canonicalizes outside it and is
/// rejected. canonicalize requires the path to exist (these commands only read
/// real entries); a non-existent / unreadable path is rejected opaquely so the
/// boundary leaks no existence information.
fn validate_within_root(root: &str, path: &str) -> Result<PathBuf, ImportReadError> {
    validate_within_root_pair(root, path).map(|(_, target)| target)
}

/// As [`validate_within_root`], also returning the canonical root — the walk
/// needs it to decide whether a symlink inside the listed directory resolves
/// back inside the picked tree.
fn validate_within_root_pair(
    root: &str,
    path: &str,
) -> Result<(PathBuf, PathBuf), ImportReadError> {
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
    Ok((canon_root, canon_target))
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

/// Resolve one symbolic link into `(is_dir, EntryLink)`.
///
/// `canon_dir` is the canonical path of the directory being listed and
/// `canon_root` the canonical picked root; both are already resolved by
/// [`validate_within_root_pair`], so the ancestor test below costs nothing.
fn classify_link(
    link_path: &Path,
    canon_dir: &Path,
    canon_root: &Path,
) -> (bool, Option<EntryLink>) {
    let Ok(canonical) = link_path.canonicalize() else {
        return (false, Some(EntryLink::Broken));
    };
    if !canonical.starts_with(canon_root) {
        return (false, Some(EntryLink::Outside));
    }
    // The link points AT the directory being listed, or above it — following
    // it re-enters a tree the walk is already inside. This catches the two
    // shapes that happen by accident (`vault/everything -> vault`,
    // `notes/here -> .`) with no cross-call state; the walk's visited set
    // covers the rest.
    if canon_dir.starts_with(&canonical) {
        return (false, Some(EntryLink::Loop));
    }
    let is_dir = canonical
        .metadata()
        .map(|meta| meta.is_dir())
        .unwrap_or(false);
    (
        is_dir,
        Some(EntryLink::Followable {
            target_key: target_key(&canonical),
        }),
    )
}

/// List a directory's entries (name + is_dir, no content) so the TS walk can
/// recurse. Validated within the picked root.
#[tauri::command]
pub async fn import_read_dir(
    root: String,
    path: String,
) -> Result<Vec<ImportDirEntry>, ImportReadError> {
    let (canon_root, dir) = validate_within_root_pair(&root, &path)?;
    tauri::async_runtime::spawn_blocking(move || {
        let mut entries = Vec::new();
        for entry in std::fs::read_dir(&dir).map_err(io)? {
            let entry = entry.map_err(io)?;
            let name = entry.file_name().to_string_lossy().into_owned();
            // `file_type` does NOT follow symlinks, which is what we want at
            // this step: it tells us whether the entry IS a link. Neither does
            // `DirEntry::metadata` — resolving one takes `canonicalize`, below.
            let file_type = entry.file_type().ok();
            let is_symlink = file_type.as_ref().is_some_and(|t| t.is_symlink());
            if !is_symlink {
                entries.push(ImportDirEntry {
                    name,
                    is_dir: file_type.as_ref().is_some_and(|t| t.is_dir()),
                    link: None,
                });
                continue;
            }
            let (is_dir, link) = classify_link(&entry.path(), &dir, &canon_root);
            entries.push(ImportDirEntry { name, is_dir, link });
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
        // read-side discipline, src-tauri/AGENTS.md); the result String leaves via
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

    // --- symlink classification (myne-md/myne#223 defect 1) ------------------
    //
    // The bug was `DirEntry::file_type()` reporting a symlinked directory as
    // `is_dir: false`, so the walk never entered it and the whole subtree
    // vanished behind an "other files skipped" count. `DirEntry::metadata()`
    // does NOT fix that — it does not follow links either; only resolving the
    // path does. These pin both halves: that a followable link reports as the
    // directory it is, and that the three refusals are each named rather than
    // folded into a skip count.

    #[cfg(unix)]
    fn link(target: &Path, at: &Path) {
        std::os::unix::fs::symlink(target, at).unwrap();
    }

    #[cfg(unix)]
    fn classify_in(root: &Path, dir: &Path, name: &str) -> (bool, Option<EntryLink>) {
        let canon_root = root.canonicalize().unwrap();
        let canon_dir = dir.canonicalize().unwrap();
        classify_link(&canon_dir.join(name), &canon_dir, &canon_root)
    }

    #[cfg(unix)]
    #[test]
    fn a_symlinked_directory_inside_the_root_is_followable_and_reports_as_a_directory() {
        let t = TempTree::new("link-dir");
        let real = t.root.join("real");
        std::fs::create_dir_all(&real).unwrap();
        std::fs::write(real.join("note.md"), "hi").unwrap();
        link(&real, &t.root.join("External"));

        let (is_dir, entry_link) = classify_in(&t.root, &t.root, "External");
        assert!(is_dir, "a symlink to a directory must walk as a directory");
        assert!(matches!(entry_link, Some(EntryLink::Followable { .. })));
    }

    #[cfg(unix)]
    #[test]
    fn a_symlinked_file_inside_the_root_is_followable_but_not_a_directory() {
        let t = TempTree::new("link-file");
        let real = t.root.join("real.md");
        std::fs::write(&real, "hi").unwrap();
        link(&real, &t.root.join("alias.md"));

        let (is_dir, entry_link) = classify_in(&t.root, &t.root, "alias.md");
        assert!(!is_dir);
        assert!(matches!(entry_link, Some(EntryLink::Followable { .. })));
    }

    #[cfg(unix)]
    #[test]
    fn a_symlink_escaping_the_root_is_refused_by_name() {
        let parent = TempTree::new("link-outside");
        let root = parent.root.join("vault");
        let outside = parent.root.join("elsewhere");
        std::fs::create_dir_all(&root).unwrap();
        std::fs::create_dir_all(&outside).unwrap();
        link(&outside, &root.join("escape"));

        let (is_dir, entry_link) = classify_in(&root, &root, "escape");
        assert!(!is_dir);
        assert_eq!(entry_link, Some(EntryLink::Outside));
    }

    #[cfg(unix)]
    #[test]
    fn a_symlink_to_an_ancestor_is_a_loop() {
        let t = TempTree::new("link-loop");
        let deep = t.root.join("a").join("b");
        std::fs::create_dir_all(&deep).unwrap();
        link(&t.root, &deep.join("everything")); // b/everything -> <root>
        link(&t.root.join("a"), &deep.join("up")); // b/up        -> a

        assert_eq!(
            classify_in(&t.root, &deep, "everything").1,
            Some(EntryLink::Loop)
        );
        assert_eq!(classify_in(&t.root, &deep, "up").1, Some(EntryLink::Loop));
    }

    #[cfg(unix)]
    #[test]
    fn a_dangling_symlink_is_broken() {
        let t = TempTree::new("link-broken");
        link(Path::new("/definitely/not/here"), &t.root.join("dangling"));

        let (is_dir, entry_link) = classify_in(&t.root, &t.root, "dangling");
        assert!(!is_dir);
        assert_eq!(entry_link, Some(EntryLink::Broken));
    }

    #[cfg(unix)]
    #[test]
    fn two_links_to_the_same_directory_share_a_target_key_and_differ_from_a_third() {
        // The walk's cycle guard is equality on this key and nothing else.
        let t = TempTree::new("link-key");
        let a = t.root.join("a");
        let b = t.root.join("b");
        std::fs::create_dir_all(&a).unwrap();
        std::fs::create_dir_all(&b).unwrap();
        link(&a, &t.root.join("first"));
        link(&a, &t.root.join("second"));
        link(&b, &t.root.join("third"));

        let key = |name: &str| match classify_in(&t.root, &t.root, name).1 {
            Some(EntryLink::Followable { target_key }) => target_key,
            other => panic!("expected a followable link, got {other:?}"),
        };
        assert_eq!(key("first"), key("second"));
        assert_ne!(key("first"), key("third"));
        // Opaque: never the path itself, and no path substring survives.
        assert_eq!(key("first").len(), 32);
        assert!(!key("first").contains('/'));
    }
}
