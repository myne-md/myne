//! Atomic file-write helper.
//!
//! Writes `bytes` to a temp file alongside `path`, `fsync`s it, then
//! atomically commits the rename with durability:
//!
//! - **Unix:** `rename` + `File::open(parent)?.sync_all()` so POSIX
//!   directory metadata (the rename's new entry) flushes to the
//!   journal.
//! - **Windows:** `MoveFileExW(MOVEFILE_WRITE_THROUGH [|
//!   MOVEFILE_REPLACE_EXISTING])` — rename + USN journal commit in a
//!   single syscall.
//!
//! A crash mid-write leaves either the previous file (or no file when
//! `replace=false` and the destination was missing) — never a half-
//! written one.
//!
//! ## Failure-path cleanup
//!
//! A *returned error* (temp open/write/`sync_all` failure, or a
//! `finalize_atomic` rename failure) drops the partial `<path>.tmp` on
//! the way out (best-effort; the original error is the one surfaced), so
//! a failed write never leaves a stray temp sibling. The one deliberate
//! exception is the `StopBeforeRename` crash *simulation* (test-only,
//! below), which leaves the temp on disk exactly as a real power loss
//! would. Note the temp always holds **ciphertext** — callers hand
//! `atomic_write` already-encoded blobs — so even a leftover temp never
//! exposes plaintext.
//!
//! ## Interrupted-write recovery test seam (MYND-88)
//!
//! The durability + recovery contract is exercised by a `#[cfg(test)]`
//! fault-injection seam ([`Fault`]): the production [`atomic_write`]
//! wrapper passes [`Fault::None`], so in non-test builds the seam
//! collapses to the straight-line path with byte-identical behavior and
//! zero runtime cost. See `design-notes.md` 2026-06-08 "Interrupted-
//! write recovery test gate + atomic_write failure-path `.tmp` cleanup".
//!
//! ## `replace` parameter
//!
//! - `replace=true` — vault.meta rewrite (post-recovery commit, future
//!   change-password), `.myn` update (future MYND-27). Standard
//!   create-or-replace semantics.
//! - `replace=false` — `.myn` create (MYND-26), vault.meta initial
//!   create (`vault_creation::commit_with_vault_path`). Pre-rename
//!   `Path::exists()` returns [`std::io::ErrorKind::AlreadyExists`]; the
//!   caller maps it to a plugin-specific `<X>AlreadyExists` variant.
//!
//! TOCTOU window for `replace=false` is benign under Phase 1 single-
//! writer assumption (Slot is singleton per process; OS-level
//! `app_data_dir` locking prevents two clients sharing the same vault
//! path). `RENAME_NOREPLACE` / `renamex_np` / Win32 atomic-create-only
//! is deferred to Phase 2 multi-writer prep.
//!
//! ## Anchors
//!
//! - `design-notes.md` 2026-05-07 "atomic_write durability hardening +
//!   replace:bool parameter" carries the full design rationale (write-
//!   frequency pressure, dual-helper rejection, Windows primitive
//!   choice, Phase 2 deferral) and the cross-reference list.
//! - `agent-tooling/sessions/grill/2026-05-07-mynd-26-note-tauri-commands.md`
//!   Q5 and Q6 sub-decision 1 are the grilling that produced this
//!   design.
//! - MYND-132 is the implementing work item; it blocks MYND-26.

use std::io::Write;
use std::path::Path;

/// Write `bytes` to `path` atomically with durability + create-vs-rewrite intent.
///
/// See the module-level docs for the `replace` semantic and durability
/// story. Caller responsibilities:
///
/// - The parent directory must already exist (helpers like
///   [`crate::paths::vault_dir`] / `notes_dir` `create_dir_all` before
///   handing a path here).
/// - Temp file lives at `<path>.tmp`; concurrent writers to the same
///   `path` are not handled (v0.1 has at most one writer per vault path
///   — Slot is singleton, OS-level locking enforces single-process per
///   vault).
pub fn atomic_write(path: &Path, bytes: &[u8], replace: bool) -> std::io::Result<()> {
    atomic_write_inner(path, bytes, replace, Fault::None)
}

/// Test-only fault-injection points for the [`atomic_write`] durability +
/// interrupted-write recovery contract (MYND-88).
///
/// In non-test builds the enum has only the [`Fault::None`] variant, so
/// the matches in [`atomic_write_inner`] / [`write_temp`] are compiled out
/// and the production write path is byte-identical to a seam-free
/// implementation (zero runtime cost).
#[derive(Clone, Copy)]
enum Fault {
    /// Production path: no injected failure.
    None,
    /// Open the temp, write only the first half of `bytes`, best-effort
    /// `sync_all`, then return this error kind — simulates a short write
    /// / disk-full partway through the write.
    #[cfg(test)]
    FailDuringWrite(std::io::ErrorKind),
    /// Fully write + `sync_all` the temp, then return `Interrupted`
    /// **before** the rename without removing the temp — simulates a
    /// power-loss crash after the temp is durable but before the atomic
    /// commit. The destination must be left untouched.
    #[cfg(test)]
    StopBeforeRename,
}

fn atomic_write_inner(
    path: &Path,
    bytes: &[u8],
    replace: bool,
    fault: Fault,
) -> std::io::Result<()> {
    if !replace && path.exists() {
        return Err(std::io::ErrorKind::AlreadyExists.into());
    }

    let tmp = tmp_path(path);

    // On any returned error, drop the partial temp so a failed write never
    // leaves a stray `<path>.tmp` sibling (best-effort; the original error
    // is the one surfaced). The single deliberate exception is the
    // `StopBeforeRename` crash simulation below.
    if let Err(e) = write_temp(&tmp, bytes, fault) {
        let _ = std::fs::remove_file(&tmp);
        return Err(e);
    }

    #[cfg(test)]
    if let Fault::StopBeforeRename = fault {
        // Model a crash before the rename commit: leave the temp on disk
        // exactly as a power loss would. The destination stays untouched.
        return Err(std::io::ErrorKind::Interrupted.into());
    }

    if let Err(e) = finalize_atomic(&tmp, path, replace) {
        let _ = std::fs::remove_file(&tmp);
        return Err(e);
    }

    Ok(())
}

/// Open `<tmp>`, write `bytes`, and `sync_all` so the bytes are durable
/// before the caller commits the rename. `fault` is read only under
/// `#[cfg(test)]`; in production it is always [`Fault::None`].
#[cfg_attr(not(test), allow(unused_variables))]
fn write_temp(tmp: &Path, bytes: &[u8], fault: Fault) -> std::io::Result<()> {
    let mut f = std::fs::OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .open(tmp)?;

    #[cfg(test)]
    if let Fault::FailDuringWrite(kind) = fault {
        // Partial prefix on disk, then fail — exercises the caller's
        // failure-path temp cleanup and the destination-intact invariant.
        let half = bytes.len() / 2;
        f.write_all(&bytes[..half])?;
        let _ = f.sync_all();
        return Err(kind.into());
    }

    f.write_all(bytes)?;
    f.sync_all()
    // f drops here, releasing the file handle so the rename can proceed
    // on Windows.
}

/// Commit the temp file to its destination atomically + durably.
///
/// Unix: POSIX `rename` (always replace-on-exists; the `replace=false`
/// case was caught by [`atomic_write`]'s upstream `Path::exists` guard)
/// followed by a parent-directory `sync_all` so the rename metadata
/// reaches the journal.
///
/// Windows: a single `MoveFileExW(MOVEFILE_WRITE_THROUGH [|
/// MOVEFILE_REPLACE_EXISTING when replace])` call. `MOVEFILE_WRITE_THROUGH`
/// guarantees the rename metadata is committed to the NTFS USN journal
/// before the call returns, so a power loss between this call and the
/// next sync cannot lose the new directory entry. The directory-handle
/// `FlushFileBuffers` shape used on Unix is **not** portable on Windows
/// (Microsoft docs: returns `ERROR_INVALID_HANDLE` on some
/// filesystems); `MoveFileExW(WRITE_THROUGH)` is the canonical Windows
/// durability primitive.
#[cfg(unix)]
fn finalize_atomic(src: &Path, dst: &Path, _replace: bool) -> std::io::Result<()> {
    std::fs::rename(src, dst)?;
    let parent = dst
        .parent()
        .expect("atomic_write paths always have a parent directory");
    std::fs::File::open(parent)?.sync_all()
}

#[cfg(windows)]
fn finalize_atomic(src: &Path, dst: &Path, replace: bool) -> std::io::Result<()> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::{
        MoveFileExW, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH,
    };

    let mut flags = MOVEFILE_WRITE_THROUGH;
    if replace {
        flags |= MOVEFILE_REPLACE_EXISTING;
    }

    // UTF-16 + null-terminated; both buffers must outlive the syscall.
    let src_w: Vec<u16> = src
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();
    let dst_w: Vec<u16> = dst
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();

    // SAFETY: `src_w` and `dst_w` are owned, null-terminated UTF-16
    // strings valid for the duration of the call. `flags` is a valid
    // combination of documented `MOVEFILE_*` constants per the
    // `MoveFileExW` MSDN reference. The function neither retains nor
    // dereferences either buffer past return.
    let result = unsafe { MoveFileExW(src_w.as_ptr(), dst_w.as_ptr(), flags) };
    if result == 0 {
        return Err(std::io::Error::last_os_error());
    }
    Ok(())
}

fn tmp_path(path: &Path) -> std::path::PathBuf {
    let mut p = path.to_path_buf();
    let name = p.file_name().map(|n| n.to_os_string()).unwrap_or_default();
    let mut tmp_name = name;
    tmp_name.push(".tmp");
    p.set_file_name(tmp_name);
    p
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::ScopedTempDir;
    use std::io::Read;

    fn read_file(path: &Path) -> Vec<u8> {
        let mut buf = Vec::new();
        std::fs::File::open(path)
            .unwrap()
            .read_to_end(&mut buf)
            .unwrap();
        buf
    }

    // ---- replace=true (status-quo overwrite path) -----------------------

    #[test]
    fn replace_true_creates_file_with_expected_contents() {
        let dir = ScopedTempDir::new("replace-true-creates").unwrap();
        let target = dir.path().join("file.bin");
        let payload = b"hello vault.meta";

        atomic_write(&target, payload, true).unwrap();

        assert_eq!(read_file(&target), payload);
    }

    #[test]
    fn replace_true_overwrites_existing_file() {
        let dir = ScopedTempDir::new("replace-true-overwrites").unwrap();
        let target = dir.path().join("file.bin");
        std::fs::write(&target, b"old").unwrap();

        atomic_write(&target, b"new", true).unwrap();

        assert_eq!(read_file(&target), b"new");
    }

    #[test]
    fn replace_true_cleans_up_temp_on_success() {
        let dir = ScopedTempDir::new("replace-true-cleans-tmp").unwrap();
        let target = dir.path().join("file.bin");

        atomic_write(&target, b"x", true).unwrap();

        let entries: Vec<_> = std::fs::read_dir(dir.path())
            .unwrap()
            .filter_map(|e| e.ok())
            .map(|e| e.file_name())
            .collect();
        assert_eq!(entries.len(), 1, "entries: {entries:?}");
        assert_eq!(entries[0], "file.bin");
    }

    // ---- replace=false (create-only path; defensive guard) --------------

    #[test]
    fn replace_false_creates_when_dest_missing() {
        let dir = ScopedTempDir::new("replace-false-creates").unwrap();
        let target = dir.path().join("file.bin");

        atomic_write(&target, b"fresh", false).unwrap();

        assert_eq!(read_file(&target), b"fresh");
    }

    #[test]
    fn replace_false_returns_already_exists_when_dest_present() {
        let dir = ScopedTempDir::new("replace-false-exists").unwrap();
        let target = dir.path().join("file.bin");
        std::fs::write(&target, b"original").unwrap();

        let err = atomic_write(&target, b"replacement", false)
            .expect_err("replace=false must reject when destination exists");

        assert_eq!(err.kind(), std::io::ErrorKind::AlreadyExists);
        // Original bytes untouched — the helper rejected before the
        // temp-file path was even opened.
        assert_eq!(read_file(&target), b"original");
    }

    #[test]
    fn replace_false_does_not_leave_temp_on_already_exists_reject() {
        let dir = ScopedTempDir::new("replace-false-no-temp").unwrap();
        let target = dir.path().join("file.bin");
        std::fs::write(&target, b"x").unwrap();

        let _ = atomic_write(&target, b"y", false);

        let entries: Vec<_> = std::fs::read_dir(dir.path())
            .unwrap()
            .filter_map(|e| e.ok())
            .map(|e| e.file_name())
            .collect();
        // Only the original; no `.tmp` sibling.
        assert_eq!(entries.len(), 1, "entries: {entries:?}");
        assert_eq!(entries[0], "file.bin");
    }

    // ---- fault injection: interrupted-write recovery (MYND-88) ----------

    #[test]
    fn write_failure_removes_temp_and_returns_error() {
        let dir = ScopedTempDir::new("aw-write-fail-clean").unwrap();
        let target = dir.path().join("file.bin");

        let err = atomic_write_inner(
            &target,
            b"abcdefgh",
            true,
            Fault::FailDuringWrite(std::io::ErrorKind::StorageFull),
        )
        .expect_err("injected write failure must surface as Err");
        assert_eq!(err.kind(), std::io::ErrorKind::StorageFull);

        // Neither the destination nor a `.tmp` sibling survives a failed
        // write — the failure-path cleanup removed the partial temp.
        let entries: Vec<_> = std::fs::read_dir(dir.path())
            .unwrap()
            .filter_map(|e| e.ok())
            .map(|e| e.file_name())
            .collect();
        assert!(entries.is_empty(), "expected empty dir, got {entries:?}");
    }

    #[test]
    fn write_failure_leaves_existing_destination_intact() {
        let dir = ScopedTempDir::new("aw-write-fail-keep-old").unwrap();
        let target = dir.path().join("file.bin");
        atomic_write(&target, b"OLD-VALID", true).unwrap();

        let err = atomic_write_inner(
            &target,
            b"NEW-PARTIAL-BYTES",
            true,
            Fault::FailDuringWrite(std::io::ErrorKind::WriteZero),
        )
        .expect_err("injected write failure must surface as Err");
        assert_eq!(err.kind(), std::io::ErrorKind::WriteZero);

        // The committed destination is the old, fully-valid content; the
        // failed write left no `.tmp` sibling.
        assert_eq!(read_file(&target), b"OLD-VALID");
        let entries: Vec<_> = std::fs::read_dir(dir.path())
            .unwrap()
            .filter_map(|e| e.ok())
            .map(|e| e.file_name())
            .collect();
        assert_eq!(entries.len(), 1, "entries: {entries:?}");
        assert_eq!(entries[0], "file.bin");
    }

    #[test]
    fn interrupted_before_rename_leaves_destination_intact() {
        let dir = ScopedTempDir::new("aw-interrupt-keep-old").unwrap();
        let target = dir.path().join("file.bin");
        atomic_write(&target, b"OLD-VALID", true).unwrap();

        let err = atomic_write_inner(&target, b"NEW-VALID", true, Fault::StopBeforeRename)
            .expect_err("crash-before-rename simulation must surface as Err");
        assert_eq!(err.kind(), std::io::ErrorKind::Interrupted);

        // The committed file is still the old, fully-valid content — an
        // interrupt before the atomic rename never replaces it. This is
        // the "old or new, never partial" recovery invariant.
        assert_eq!(read_file(&target), b"OLD-VALID");
    }

    #[test]
    fn interrupted_before_rename_temp_holds_exactly_written_bytes() {
        let dir = ScopedTempDir::new("aw-interrupt-temp-bytes").unwrap();
        let target = dir.path().join("file.bin");

        atomic_write_inner(&target, b"NEW-VALID", false, Fault::StopBeforeRename)
            .expect_err("crash-before-rename simulation must surface as Err");

        // The leftover temp (the crash artifact a real power loss would
        // leave) holds exactly the bytes we asked to write — no truncation,
        // no invented content; callers only ever pass ciphertext blobs.
        let tmp = tmp_path(&target);
        assert_eq!(read_file(&tmp), b"NEW-VALID");
        // The destination was never created (create-only, dest missing).
        assert!(!target.exists(), "destination must not exist pre-commit");
    }

    /// Force the rename step to fail (destination is a non-empty
    /// directory; POSIX `rename(file, dir)` → `EISDIR`) and assert the
    /// temp is cleaned up. Unix-only: the failure shape is POSIX-specific.
    #[cfg(unix)]
    #[test]
    fn finalize_failure_removes_temp() {
        let dir = ScopedTempDir::new("aw-finalize-fail-clean").unwrap();
        let target = dir.path().join("dest");
        std::fs::create_dir(&target).unwrap();
        std::fs::write(target.join("inner"), b"x").unwrap();

        atomic_write(&target, b"payload", true)
            .expect_err("rename of a file onto a directory must fail");

        let tmp = tmp_path(&target);
        assert!(
            !tmp.exists(),
            "temp must be cleaned up after finalize failure"
        );
        assert!(target.is_dir(), "destination directory must be untouched");
    }

    // ---- durability: parent-dir fsync (Unix smoke) -----------------------

    /// Exercise the Unix parent-directory `sync_all` code path. A direct
    /// assertion that the syscall ran would require kernel-level
    /// instrumentation; this smoke test confirms the path completes
    /// without an IO error on a real temp directory, which is the
    /// strongest assertion possible without mocks.
    #[cfg(unix)]
    #[test]
    fn unix_parent_dir_fsync_succeeds() {
        let dir = ScopedTempDir::new("unix-parent-fsync").unwrap();
        let target = dir.path().join("nested.bin");

        atomic_write(&target, b"durable", true).unwrap();
        atomic_write(&target, b"durable-replaced", true).unwrap();

        assert_eq!(read_file(&target), b"durable-replaced");
    }

    // ---- durability: Windows MoveFileExW(WRITE_THROUGH) (smoke) ---------

    /// Exercise the Windows `MoveFileExW(MOVEFILE_WRITE_THROUGH)` code
    /// path. `MOVEFILE_REPLACE_EXISTING` is added when `replace=true`;
    /// the second call below replaces the file from the first. The
    /// only stronger assertion would require Windows-kernel
    /// instrumentation; the smoke confirms the syscall succeeds for
    /// both create-new and replace-existing flows.
    ///
    /// `cfg(windows)` excludes this from the macOS / Linux runner; the
    /// Linux CI gap is documented (`decisions.md` 2026-05-01 "Linux
    /// runner only") and covered by manual pre-release smoke. To
    /// type-check this test on a developer's Linux/macOS machine
    /// before pushing, run
    /// `cargo check --target x86_64-pc-windows-gnu --tests -p myne-desktop`
    /// with the matching toolchain target installed.
    #[cfg(windows)]
    #[test]
    fn windows_movefileexw_smoke_create_then_replace() {
        let dir = ScopedTempDir::new("windows-movefileexw-smoke").unwrap();
        let target = dir.path().join("file.bin");

        atomic_write(&target, b"created", false).unwrap();
        atomic_write(&target, b"replaced", true).unwrap();

        assert_eq!(read_file(&target), b"replaced");
    }
}
