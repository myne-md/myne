// SPDX-License-Identifier: AGPL-3.0
//! Shared recursive directory-sweep pipeline for vault destruction and
//! repair.
//!
//! Extracted from `vault_delete` (MYND-105) so that both `vault_delete`
//! and `vault_repair` (MYND-159) drive the **same** post-order unlink
//! walk, DENY-list-clean per-file tracing, and best-effort durability
//! sync. Sharing avoids one plugin reaching into the other's `pub(crate)`
//! internals and avoids a second copy of the security-load-bearing tracing
//! discipline (a second copy would drift).
//!
//! Neutral by construction: returns a plugin-agnostic [`SweepOutcome`],
//! never a plugin error enum. Each caller maps the outcome into its own
//! `error.rs` vocabulary (`VaultDeleteError::PartialDelete` /
//! `VaultRepairError::PartialDelete`), so this layer never has to know who
//! it serves.
//!
//! See: `src-tauri/AGENTS.md` "Secret-handling logging discipline" — the
//! per-file path is on the DENY list and is never emitted; only the closed
//! [`IoFailureKind`] reduction crosses the tracing boundary.

use crate::io_failure_kind::{from_io_error_kind, IoFailureKind};
use std::path::{Path, PathBuf};

/// What to do with the swept root directory itself once its contents are
/// removed.
///
/// This is the one axis on which `vault_delete` and `vault_repair` diverge:
/// the unlink walk is identical, only the fate of the root differs, because
/// their success criteria differ.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RootDisposal {
    /// Remove the root directory itself after emptying it. `vault_delete`'s
    /// posture — destruction is total; success = "everything gone,
    /// including the directory". The parent directory is synced afterward
    /// to commit the removal of the root's directory entry.
    Remove,
    /// Empty the root's contents but leave the directory in place.
    /// `vault_repair`'s posture — the user creates a fresh vault in the
    /// same location immediately after, so success = "no artefact remains
    /// so create can proceed", which does NOT require removing the
    /// (create-able) container. The root itself is synced afterward to
    /// commit the removal of the child entries.
    KeepRoot,
}

/// A single failed unlink, reduced to a DENY-list-safe kind.
///
/// The failing path is deliberately **not** retained — full filesystem
/// paths are on the DENY list (`src-tauri/AGENTS.md`). Only the closed
/// [`IoFailureKind`] survives, which is safe to emit via tracing.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct UnlinkFailure {
    /// Closed categorization of the underlying `std::io::ErrorKind`.
    pub kind: IoFailureKind,
}

/// Plugin-agnostic outcome of a [`sweep`].
#[derive(Debug, Clone, Default)]
pub struct SweepOutcome {
    /// Count of entries (files + directories) successfully removed. Feeds
    /// the "found N → removed N → 0 left" user-facing report (read by
    /// `vault_repair`; `vault_delete` only needs the failure count).
    pub removed: usize,
    /// One entry per failed unlink, in walk order. `failures.len()` is the
    /// `remaining_count` callers surface in their `PartialDelete` variant.
    pub failures: Vec<UnlinkFailure>,
}

impl SweepOutcome {
    /// `true` when every attempted entry was removed (no failures).
    pub fn is_complete(&self) -> bool {
        self.failures.is_empty()
    }

    /// Number of entries that could not be removed — the value callers map
    /// into `PartialDelete { remaining_count }`.
    pub fn remaining_count(&self) -> usize {
        self.failures.len()
    }
}

/// Recursively remove the contents of `dir` (post-order, symlinks not
/// followed), emit DENY-list-clean per-file failure tracing, best-effort
/// flush the containing directory to the OS journal, and return a neutral
/// [`SweepOutcome`].
///
/// `disposal` controls the fate of `dir` itself and the durability-sync
/// target (see [`RootDisposal`]). Per-entry failures do NOT short-circuit
/// the walk — every entry is attempted and the failures aggregated, the
/// partial-fail posture from `decisions.md` 2026-05-26.
///
/// Symlinks: uses `symlink_metadata`, so a symlink is treated as a file
/// (`remove_file` unlinks the link, not its target) — matches
/// `std::fs::remove_dir_all`'s no-follow semantics and preserves the v0.1
/// single-vault single-user assumption (Phase 2 symlink-aware revisit
/// hook).
pub fn sweep(dir: &Path, disposal: RootDisposal) -> SweepOutcome {
    let mut results: Vec<(PathBuf, std::io::Result<()>)> = Vec::new();
    let sync_target: Option<PathBuf> = match disposal {
        RootDisposal::Remove => {
            walk_and_remove(dir, &mut results);
            // Removing `dir` itself changed an entry in `dir`'s parent;
            // sync the parent to commit it.
            dir.parent().map(Path::to_path_buf)
        }
        RootDisposal::KeepRoot => {
            remove_children(dir, &mut results);
            // `dir` survives; its child entries changed — sync `dir`.
            Some(dir.to_path_buf())
        }
    };
    emit_per_unlink_failure_trace(&results);
    if let Some(target) = sync_target {
        try_dir_sync(&target);
    }
    aggregate(&results)
}

/// The same sweep, through the storage seam (phase3-web-client task 72).
///
/// # Why a sibling rather than an edit in place
///
/// [`sweep`] is synchronous and reaches `std::fs` directly, which is correct for
/// every caller it has today — and impossible on `wasm32`, where `std::fs`
/// compiles and then fails at runtime. The web client needs the same erase for
/// "sign out and erase this browser's copy" (owner decision, 2026-07-27), so it
/// needs a [`VaultIo`] version.
///
/// Editing `sweep` in place would drag every other caller onto an async,
/// io-injected signature for a change none of them asked for. So this is a
/// sibling, and the invariants are held in one place instead: the post-order
/// order, the no-short-circuit posture, the per-entry result vector and the
/// aggregation are all the same, and `sweep_outcome_to_delete_result` maps both.
///
/// # What is deliberately NOT here
///
/// * **No directory `fsync`.** [`sweep`]'s `try_dir_sync` commits the parent's
///   journal entry on Unix. OPFS exposes no such primitive — `flush()` is per
///   file handle — and there is nothing to call. Stating it rather than silently
///   omitting it: the durability posture of a web erase is the browser's, and
///   this is where a reader finds that out.
/// * **No symlink handling.** The seam's `DirEntry` has `is_dir` and nothing
///   else, because OPFS has files and directories and no third thing. On the
///   native arm a symlink lands in the `else` branch and is unlinked as a file,
///   which is exactly `sweep`'s `symlink_metadata` behaviour.
pub async fn sweep_via_io(
    io: &dyn crate::vault_io::VaultIo,
    dir: &Path,
    disposal: RootDisposal,
) -> SweepOutcome {
    let mut results: Vec<(PathBuf, Result<(), IoFailureKind>)> = Vec::new();
    match disposal {
        RootDisposal::Remove => walk_and_remove_via_io(io, dir, &mut results).await,
        RootDisposal::KeepRoot => match io.read_dir(dir).await {
            Ok(entries) => {
                for e in entries {
                    walk_and_remove_via_io(io, &dir.join(&e.name), &mut results).await;
                }
            }
            Err(kind) => results.push((dir.to_path_buf(), Err(kind))),
        },
    }
    emit_per_unlink_failure_trace_kinds(&results);
    aggregate_kinds(&results)
}

/// Post-order walker over the seam. Boxed because it recurses in an `async fn`,
/// which otherwise needs an infinitely-sized future.
fn walk_and_remove_via_io<'a>(
    io: &'a dyn crate::vault_io::VaultIo,
    path: &'a Path,
    results: &'a mut Vec<(PathBuf, Result<(), IoFailureKind>)>,
) -> std::pin::Pin<Box<dyn std::future::Future<Output = ()> + 'a>> {
    Box::pin(async move {
        // `is_dir` is the seam's whole type vocabulary. A missing path answers
        // its own error here, which is what `symlink_metadata` did in `sweep`.
        match io.is_dir(path).await {
            Ok(true) => {
                match io.read_dir(path).await {
                    Ok(entries) => {
                        for e in entries {
                            walk_and_remove_via_io(io, &path.join(&e.name), results).await;
                        }
                        // Children first, so the directory is empty by now —
                        // the post-order property `sweep` also relies on.
                        let r = io.remove_dir_all(path).await;
                        results.push((path.to_path_buf(), r));
                    }
                    Err(kind) => results.push((path.to_path_buf(), Err(kind))),
                }
            }
            Ok(false) => {
                let r = io.remove_file(path).await;
                results.push((path.to_path_buf(), r));
            }
            Err(kind) => results.push((path.to_path_buf(), Err(kind))),
        }
    })
}

/// [`emit_per_unlink_failure_trace`] over seam-shaped results. The path is
/// never emitted here either (DENY-list discipline).
pub(crate) fn emit_per_unlink_failure_trace_kinds(
    results: &[(PathBuf, Result<(), IoFailureKind>)],
) {
    for (_path, r) in results {
        if let Err(kind) = r {
            tracing::warn!(
                stage = "unlink_blob",
                io_failure_kind = ?kind,
                "vault sweep: entry unlink failed"
            );
        }
    }
}

/// [`aggregate`] over seam-shaped results — same counting, same neutral
/// `SweepOutcome`, so both sweeps feed the identical error mapping.
pub(crate) fn aggregate_kinds(results: &[(PathBuf, Result<(), IoFailureKind>)]) -> SweepOutcome {
    let mut removed = 0usize;
    let mut failures = Vec::new();
    for (_path, r) in results {
        match r {
            Ok(()) => removed += 1,
            Err(kind) => failures.push(UnlinkFailure { kind: *kind }),
        }
    }
    SweepOutcome { removed, failures }
}

/// Count every entry (file + directory) under `dir`, recursively, **not**
/// counting `dir` itself. Read-only — the read-side mirror of a
/// [`RootDisposal::KeepRoot`] sweep's removal scope, so a scan count equals
/// what a subsequent sweep removes ("found N → removed N → 0 left").
///
/// Symlinks are counted as a single entry and not followed (matching the
/// sweep's `symlink_metadata` no-follow semantics). Returns 0 if `dir`
/// does not exist. Best-effort: an unreadable subdirectory still counts as
/// its own entry, but its children cannot be enumerated and are not counted
/// — acceptable for a UI count, and symmetric with the sweep, which would
/// likewise fail to enumerate that subdirectory.
///
/// Used by `vault_repair`'s read-only residue-scan IPC (MYND-159). It
/// counts **everything** under `dir`, not just recognized artefacts — the
/// honest scope the gate-free sweep will actually remove, so the
/// confirmation count never under-reports (the over-capture safety valve).
pub fn count_residue(dir: &Path) -> usize {
    fn count_children(dir: &Path, acc: &mut usize) {
        let Ok(entries) = std::fs::read_dir(dir) else {
            return;
        };
        for entry in entries.flatten() {
            *acc += 1;
            let path = entry.path();
            if std::fs::symlink_metadata(&path).is_ok_and(|m| m.is_dir()) {
                count_children(&path, acc);
            }
        }
    }
    // No `dir.exists()` guard needed — `count_children` no-ops when
    // `read_dir` fails, which it does on a missing directory.
    let mut acc = 0;
    count_children(dir, &mut acc);
    acc
}

/// Remove every child of `dir` (each child subtree fully), leaving `dir`
/// itself in place. The [`RootDisposal::KeepRoot`] half of [`sweep`].
fn remove_children(dir: &Path, results: &mut Vec<(PathBuf, std::io::Result<()>)>) {
    match std::fs::read_dir(dir) {
        Ok(entries) => {
            for entry_result in entries {
                match entry_result {
                    Ok(entry) => walk_and_remove(&entry.path(), results),
                    Err(e) => results.push((dir.to_path_buf(), Err(e))),
                }
            }
        }
        Err(e) => results.push((dir.to_path_buf(), Err(e))),
    }
}

/// Post-order recursive walker: removes children before their parent so
/// `remove_dir` never sees a non-empty directory. Removes `path` itself
/// (file, symlink, or — after emptying — directory). The
/// [`RootDisposal::Remove`] core, also reused per-child by
/// [`remove_children`].
fn walk_and_remove(path: &Path, results: &mut Vec<(PathBuf, std::io::Result<()>)>) {
    let meta = match std::fs::symlink_metadata(path) {
        Ok(m) => m,
        Err(e) => {
            results.push((path.to_path_buf(), Err(e)));
            return;
        }
    };
    if meta.is_dir() {
        match std::fs::read_dir(path) {
            Ok(entries) => {
                for entry_result in entries {
                    match entry_result {
                        Ok(entry) => walk_and_remove(&entry.path(), results),
                        Err(e) => results.push((path.to_path_buf(), Err(e))),
                    }
                }
                let r = std::fs::remove_dir(path);
                results.push((path.to_path_buf(), r));
            }
            Err(e) => results.push((path.to_path_buf(), Err(e))),
        }
    } else {
        // File or symlink (symlink_metadata did not follow links).
        let r = std::fs::remove_file(path);
        results.push((path.to_path_buf(), r));
    }
}

/// Emit a `tracing::warn!(stage = "unlink_blob", io_failure_kind = ?kind)`
/// event for each failed entry. The path is **never** included (DENY-list
/// discipline). Carved out so the tracing emission is unit-testable with
/// synthetic inputs.
pub(crate) fn emit_per_unlink_failure_trace(results: &[(PathBuf, std::io::Result<()>)]) {
    for (_path, r) in results {
        if let Err(io_err) = r {
            let kind = from_io_error_kind(io_err.kind());
            tracing::warn!(
                stage = "unlink_blob",
                io_failure_kind = ?kind,
                "vault sweep unlink failed"
            );
        }
    }
}

/// Best-effort journal-commit hint: open `dir` and `sync_all()` it to flush
/// the directory-entry change to the OS journal.
///
/// **Unix-only.** On non-Unix targets this is an explicit no-op (matches
/// the `note_delete` / `vault_delete` durability asymmetry precedent — no
/// `windows-sys` parent-handle machinery). **Never propagates errors** —
/// the unlinks already happened; this is a hint, not a safety gate. On
/// failure a `tracing::warn!(stage = "parent_dir_sync", ...)` fires for
/// observability; the path is never formatted (closed-enum reduction).
fn try_dir_sync(dir: &Path) {
    #[cfg(unix)]
    {
        match std::fs::File::open(dir) {
            Ok(file) => match file.sync_all() {
                Ok(()) => {
                    tracing::debug!(
                        stage = "parent_dir_sync",
                        "vault sweep dir journal-commit succeeded"
                    );
                }
                Err(e) => {
                    let kind = from_io_error_kind(e.kind());
                    tracing::warn!(
                        stage = "parent_dir_sync",
                        io_failure_kind = ?kind,
                        "vault sweep dir sync_all failed (best-effort, not propagated)"
                    );
                }
            },
            Err(e) => {
                let kind = from_io_error_kind(e.kind());
                tracing::warn!(
                    stage = "parent_dir_sync",
                    io_failure_kind = ?kind,
                    "vault sweep dir open failed (best-effort, not propagated)"
                );
            }
        }
    }
    #[cfg(not(unix))]
    {
        let _ = dir;
    }
}

/// Aggregate per-entry outcomes into a neutral [`SweepOutcome`]. Pure
/// function — no I/O, no tracing (that is [`emit_per_unlink_failure_trace`]'s
/// job).
fn aggregate(results: &[(PathBuf, std::io::Result<()>)]) -> SweepOutcome {
    let mut removed = 0usize;
    let mut failures = Vec::new();
    for (_path, r) in results {
        match r {
            Ok(()) => removed += 1,
            Err(e) => failures.push(UnlinkFailure {
                kind: from_io_error_kind(e.kind()),
            }),
        }
    }
    SweepOutcome { removed, failures }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::ScopedTempDir;

    // ---- the seam-backed sibling (phase3-web-client task 72) -------------
    //
    // Driven against the REAL native arm (`StdVaultIo`), not a double: the
    // claim is that one erase serves both targets, and a fake would only prove
    // the signature compiles. What these pin is that the sibling AGREES with
    // `sweep` — same removals, same post-order, same no-short-circuit posture —
    // because two erases that disagree is worse than one erase that is slow.

    fn rt() -> tokio::runtime::Runtime {
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("current-thread runtime")
    }

    const IO: crate::vault_io::StdVaultIo = crate::vault_io::StdVaultIo;

    /// A vault-shaped tree: a file at the root, a subdirectory with two files,
    /// and an empty subdirectory.
    fn seed(root: &Path) {
        std::fs::write(root.join("vault.meta"), b"meta").unwrap();
        std::fs::create_dir_all(root.join("notes")).unwrap();
        std::fs::write(root.join("notes").join("a.myn"), b"a").unwrap();
        std::fs::write(root.join("notes").join("b.myn"), b"b").unwrap();
        std::fs::create_dir_all(root.join("attachments")).unwrap();
    }

    #[test]
    fn via_io_removes_the_whole_tree_including_the_root() {
        let tmp = ScopedTempDir::new("sweep-io-remove").expect("tempdir");
        let root = tmp.path().join("vaults").join("v1");
        std::fs::create_dir_all(&root).unwrap();
        seed(&root);

        let outcome = rt().block_on(sweep_via_io(&IO, &root, RootDisposal::Remove));

        assert!(
            outcome.failures.is_empty(),
            "failures: {:?}",
            outcome.failures
        );
        // 3 files + 2 dirs + the root itself.
        assert_eq!(outcome.removed, 6);
        assert!(!root.exists());
    }

    #[test]
    fn via_io_keeps_the_root_when_asked() {
        let tmp = ScopedTempDir::new("sweep-io-keep").expect("tempdir");
        let root = tmp.path().join("v2");
        std::fs::create_dir_all(&root).unwrap();
        seed(&root);

        let outcome = rt().block_on(sweep_via_io(&IO, &root, RootDisposal::KeepRoot));

        assert!(outcome.failures.is_empty());
        assert_eq!(outcome.removed, 5); // everything under the root, not the root
        assert!(root.is_dir());
        assert_eq!(std::fs::read_dir(&root).unwrap().count(), 0);
    }

    #[test]
    fn via_io_agrees_with_the_sync_sweep_on_the_same_tree() {
        // The property that makes a sibling safe: two identical trees, one
        // swept each way, must report the same counts. A divergence here is a
        // web client erasing a different set of bytes than a desktop one.
        let tmp = ScopedTempDir::new("sweep-io-agree").expect("tempdir");
        let a = tmp.path().join("a");
        let b = tmp.path().join("b");
        std::fs::create_dir_all(&a).unwrap();
        std::fs::create_dir_all(&b).unwrap();
        seed(&a);
        seed(&b);

        let sync_outcome = sweep(&a, RootDisposal::Remove);
        let io_outcome = rt().block_on(sweep_via_io(&IO, &b, RootDisposal::Remove));

        assert_eq!(io_outcome.removed, sync_outcome.removed);
        assert_eq!(io_outcome.failures.len(), sync_outcome.failures.len());
        assert!(!a.exists() && !b.exists());
    }

    #[test]
    fn via_io_reports_a_missing_root_as_one_failure_and_does_not_panic() {
        // `sweep`'s `symlink_metadata` error path. The erase must degrade to a
        // reported failure, never a trap — on wasm32 a panic aborts the whole
        // instance, so "returns an outcome" is the load-bearing half.
        let tmp = ScopedTempDir::new("sweep-io-missing").expect("tempdir");
        let missing = tmp.path().join("nope");

        let outcome = rt().block_on(sweep_via_io(&IO, &missing, RootDisposal::Remove));

        assert_eq!(outcome.removed, 0);
        assert_eq!(outcome.failures.len(), 1);
        assert_eq!(outcome.failures[0].kind, IoFailureKind::NotFound);
    }

    #[test]
    fn aggregate_kinds_counts_the_same_way_aggregate_does() {
        let results = vec![
            (PathBuf::from("x"), Ok(())),
            (PathBuf::from("y"), Err(IoFailureKind::PermissionDenied)),
            (PathBuf::from("z"), Ok(())),
        ];
        let o = aggregate_kinds(&results);
        assert_eq!(o.removed, 2);
        assert_eq!(o.failures.len(), 1);
        assert_eq!(o.failures[0].kind, IoFailureKind::PermissionDenied);
    }

    // ---- synthetic-input helpers ----------------------------------------

    fn ok(p: &str) -> (PathBuf, std::io::Result<()>) {
        (PathBuf::from(p), Ok(()))
    }

    fn err(p: &str, kind: std::io::ErrorKind) -> (PathBuf, std::io::Result<()>) {
        (PathBuf::from(p), Err(std::io::Error::from(kind)))
    }

    // ---- aggregate: neutral SweepOutcome --------------------------------

    #[test]
    fn aggregate_empty_input_is_complete_zero_removed() {
        let results: Vec<(PathBuf, std::io::Result<()>)> = vec![];
        let o = aggregate(&results);
        assert!(o.is_complete());
        assert_eq!(o.removed, 0);
        assert_eq!(o.remaining_count(), 0);
    }

    #[test]
    fn aggregate_all_ok_counts_removed_and_is_complete() {
        let results = vec![ok("a"), ok("b"), ok("c")];
        let o = aggregate(&results);
        assert!(o.is_complete());
        assert_eq!(o.removed, 3);
        assert_eq!(o.remaining_count(), 0);
    }

    #[test]
    fn aggregate_single_fail_counts_one_failure() {
        let results = vec![
            ok("a"),
            err("b", std::io::ErrorKind::PermissionDenied),
            ok("c"),
        ];
        let o = aggregate(&results);
        assert!(!o.is_complete());
        assert_eq!(o.removed, 2);
        assert_eq!(o.remaining_count(), 1);
        assert_eq!(o.failures[0].kind, IoFailureKind::PermissionDenied);
    }

    #[test]
    fn aggregate_all_fail_counts_all_failures_zero_removed() {
        let results = vec![
            err("a", std::io::ErrorKind::PermissionDenied),
            err("b", std::io::ErrorKind::NotFound),
            err("c", std::io::ErrorKind::Other),
        ];
        let o = aggregate(&results);
        assert_eq!(o.removed, 0);
        assert_eq!(o.remaining_count(), 3);
    }

    #[test]
    fn aggregate_mixed_partitions_removed_and_failures() {
        let results = vec![
            ok("a"),
            err("b", std::io::ErrorKind::PermissionDenied),
            ok("c"),
            err("d", std::io::ErrorKind::Other),
            ok("e"),
        ];
        let o = aggregate(&results);
        assert_eq!(o.removed, 3);
        assert_eq!(o.remaining_count(), 2);
    }

    // ---- emit_per_unlink_failure_trace ----------------------------------

    #[test]
    #[tracing_test::traced_test]
    fn emit_trace_emits_permission_denied_kind_without_path() {
        let results = vec![err(
            "any/path/should/not/appear",
            std::io::ErrorKind::PermissionDenied,
        )];
        emit_per_unlink_failure_trace(&results);
        assert!(logs_contain("stage=\"unlink_blob\""));
        assert!(logs_contain("PermissionDenied"));
        assert!(
            !logs_contain("any/path/should/not/appear"),
            "path leaked into tracing payload (DENY-list violation)"
        );
    }

    #[test]
    #[tracing_test::traced_test]
    fn emit_trace_silent_on_all_ok() {
        let results = vec![ok("a"), ok("b")];
        emit_per_unlink_failure_trace(&results);
        assert!(
            !logs_contain("unlink_blob"),
            "no events should fire for all-Ok input"
        );
    }

    // ---- try_dir_sync (Unix) --------------------------------------------

    #[cfg(unix)]
    #[test]
    #[tracing_test::traced_test]
    fn try_dir_sync_emits_debug_on_success() {
        let tmp = ScopedTempDir::new("vs-sync-ok").unwrap();
        try_dir_sync(tmp.path());
        assert!(logs_contain("stage=\"parent_dir_sync\""));
    }

    #[cfg(unix)]
    #[test]
    #[tracing_test::traced_test]
    fn try_dir_sync_warns_on_missing_dir_without_panic() {
        let missing =
            std::path::PathBuf::from("/this/path/intentionally/does/not/exist/for/myne/sweep");
        try_dir_sync(&missing);
        assert!(logs_contain("stage=\"parent_dir_sync\""));
        assert!(logs_contain("NotFound"));
    }

    // ---- sweep: RootDisposal::Remove ------------------------------------

    #[test]
    fn sweep_remove_deletes_dir_and_counts_removed() {
        let tmp = ScopedTempDir::new("vs-remove").unwrap();
        std::fs::write(tmp.path().join("vault.meta"), b"meta").unwrap();
        let notes = tmp.path().join("notes");
        std::fs::create_dir_all(&notes).unwrap();
        std::fs::write(notes.join("a.myn"), b"x").unwrap();

        let o = sweep(tmp.path(), RootDisposal::Remove);
        assert!(o.is_complete(), "clean tree should sweep fully: {o:?}");
        // vault.meta + a.myn + notes/ + vault_dir = 4 entries removed.
        assert_eq!(o.removed, 4);
        assert!(!tmp.path().exists(), "Remove must delete the root dir");
    }

    #[test]
    fn sweep_remove_also_clears_snapshots_dir() {
        // MYND-96 SYNC-7: the generic recursive walk covers `snapshots/` too, so
        // a whole-vault delete leaves no orphan snapshot ciphertext on disk.
        let tmp = ScopedTempDir::new("vs-snapshots").unwrap();
        std::fs::write(tmp.path().join("vault.meta"), b"meta").unwrap();
        let snapshots = tmp.path().join("snapshots");
        std::fs::create_dir_all(&snapshots).unwrap();
        std::fs::write(snapshots.join("n__s.myn"), b"snap").unwrap();

        let o = sweep(tmp.path(), RootDisposal::Remove);
        assert!(
            o.is_complete(),
            "tree with snapshots/ should sweep fully: {o:?}"
        );
        // vault.meta + n__s.myn + snapshots/ + vault_dir = 4 entries removed.
        assert_eq!(o.removed, 4);
        assert!(
            !tmp.path().exists(),
            "Remove must delete the root incl. snapshots/"
        );
    }

    // ---- sweep: RootDisposal::KeepRoot ----------------------------------

    #[test]
    fn sweep_keep_root_empties_contents_but_leaves_dir() {
        let tmp = ScopedTempDir::new("vs-keep").unwrap();
        let notes = tmp.path().join("notes");
        std::fs::create_dir_all(&notes).unwrap();
        std::fs::write(notes.join("orphan.myn"), b"junk").unwrap();

        let o = sweep(tmp.path(), RootDisposal::KeepRoot);
        assert!(o.is_complete(), "clean residue should sweep fully: {o:?}");
        // orphan.myn + notes/ = 2 entries removed; vault_dir kept.
        assert_eq!(o.removed, 2);
        assert!(
            tmp.path().exists() && tmp.path().is_dir(),
            "KeepRoot must leave the container in place"
        );
        assert_eq!(
            std::fs::read_dir(tmp.path()).unwrap().count(),
            0,
            "KeepRoot must leave the container empty"
        );
    }

    // ---- count_residue: read-only scan == KeepRoot sweep scope ----------

    #[test]
    fn count_residue_zero_on_missing_or_empty_dir() {
        let tmp = ScopedTempDir::new("vs-count-empty").unwrap();
        let missing = tmp.path().join("does-not-exist");
        assert_eq!(count_residue(&missing), 0, "missing dir counts 0");
        assert_eq!(count_residue(tmp.path()), 0, "empty dir counts 0");
    }

    #[test]
    fn count_residue_equals_keep_root_sweep_removed_count() {
        // Seed residue, count it, then sweep it and assert the scan count
        // matched what the sweep actually removed ("found N → removed N").
        let tmp = ScopedTempDir::new("vs-count-eq").unwrap();
        let notes = tmp.path().join("notes");
        std::fs::create_dir_all(&notes).unwrap();
        std::fs::write(notes.join("a.myn"), b"x").unwrap();
        std::fs::write(notes.join("b.myn"), b"y").unwrap();
        std::fs::write(tmp.path().join("vault.meta.tmp"), b"orphan").unwrap();

        // Entries under vault_dir: notes/, notes/a.myn, notes/b.myn,
        // vault.meta.tmp = 4.
        let scanned = count_residue(tmp.path());
        assert_eq!(scanned, 4, "scan should count every entry under the dir");

        let outcome = sweep(tmp.path(), RootDisposal::KeepRoot);
        assert!(outcome.is_complete());
        assert_eq!(
            outcome.removed, scanned,
            "scan count must equal what the KeepRoot sweep removes"
        );
    }

    #[cfg(unix)]
    #[test]
    fn sweep_keep_root_partial_fail_leaves_dir_and_reports_failures() {
        use std::os::unix::fs::PermissionsExt;

        let tmp = ScopedTempDir::new("vs-keep-partial").unwrap();
        let notes = tmp.path().join("notes");
        std::fs::create_dir_all(&notes).unwrap();
        std::fs::write(notes.join("orphan.myn"), b"x").unwrap();
        // chmod 0o555 on notes/ blocks the .myn unlink → cascade.
        let mut perms = std::fs::metadata(&notes).unwrap().permissions();
        perms.set_mode(0o555);
        std::fs::set_permissions(&notes, perms).unwrap();

        let o = sweep(tmp.path(), RootDisposal::KeepRoot);

        // Restore perms so tempdir teardown succeeds.
        let mut restore = std::fs::metadata(&notes).unwrap().permissions();
        restore.set_mode(0o755);
        let _ = std::fs::set_permissions(&notes, restore);

        assert!(!o.is_complete(), "blocked .myn should fail the sweep");
        assert!(
            o.remaining_count() >= 1,
            "expected at least one failure, got {o:?}"
        );
        assert!(
            tmp.path().exists(),
            "KeepRoot must leave the container even on partial-fail"
        );
    }
}
