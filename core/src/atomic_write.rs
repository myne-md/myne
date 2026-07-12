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
//! would. Note the temp holds **ciphertext** for every vault-resident
//! caller — they hand `atomic_write` already-encoded blobs — so a
//! leftover temp inside the vault never exposes plaintext. The
//! user-initiated export commands (MYND-115/211/255) are the plaintext
//! exception: their temp sibling lives at the **user-chosen export
//! destination**, which is plaintext by the user's own intent
//! (threat-model TB3 egress exception), never inside the vault. See
//! `src-tauri/CLAUDE.md` "Atomic file writes" (amended 2026-06-11).
//!
//! ## Export-destination writes: [`atomic_write_unclobbered`]
//!
//! [`atomic_write`]'s fixed `<path>.tmp` temp name is safe inside the
//! vault (the vault namespace is ours; nothing else may live there) but
//! UNSAFE at a user-owned export destination, where (a) a pre-existing
//! user file literally named `<target>.tmp` would be silently truncated
//! and renamed away, and (b) within one attachments-export run a file
//! this very run exported under the name `x.png.tmp` would be destroyed
//! by the later `x.png` write's temp (115-F1). Export callers therefore
//! use [`atomic_write_unclobbered`]: identical durability mechanics
//! (temp `sync_all` → platform rename → parent sync, failure-path temp
//! cleanup), but the temp gets a randomized
//! `<path>.<pid>-<counter>.tmp` name opened `create_new(true)` — a
//! collision with ANY pre-existing file (however named) retries with
//! the next counter instead of truncating. Vault-internal callers stay
//! on [`atomic_write`] (fixed temp name is part of the recognized-
//! artifact vocabulary, e.g. `vault.meta.tmp` recovery detection).
//!
//! ## Interrupted-write recovery test seam (MYND-88)
//!
//! The durability + recovery contract is exercised by a `#[cfg(test)]`
//! fault-injection seam ([`Fault`]): the production [`atomic_write`]
//! wrapper passes [`Fault::None`], so in non-test builds the seam
//! collapses to the straight-line path with byte-identical behavior and
//! zero runtime cost. See `docs/decisions.md` 2026-06-08 "Interrupted-
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
//! - `docs/decisions.md` 2026-05-07 "atomic_write durability hardening +
//!   replace:bool parameter" carries the full design rationale (write-
//!   frequency pressure, dual-helper rejection, Windows primitive
//!   choice, Phase 2 deferral) and the cross-reference list.
//! - `myne-agents/sessions/grill/2026-05-07-mynd-26-note-tauri-commands.md`
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
    atomic_write_inner(path, bytes, replace, Fault::None, None)
}

/// Restricted-permission variant of [`atomic_write`]: identical durability +
/// failure-path cleanup semantics, but the temp file is created with mode
/// `0600` (owner-only) on Unix **from the moment it exists**, so the committed
/// destination is never briefly group/world-readable in the window a
/// create-then-`chmod` would open. Use this for device-local credential files
/// (the per-device sync token, [`crate::plugins::sync::token_store`]). On
/// non-Unix the mode is a no-op — the OS keychain is the production target and
/// the fallback file rides the user-profile ACL (documented as weaker).
pub fn atomic_write_private(path: &Path, bytes: &[u8], replace: bool) -> std::io::Result<()> {
    atomic_write_inner(path, bytes, replace, Fault::None, Some(0o600))
}

/// Export-destination-safe variant of [`atomic_write`] (115-F1): same
/// `replace` semantics and durability story, but the temp sibling gets
/// a randomized `<path>.<pid>-<counter>.tmp` name opened with
/// `create_new(true)`, so the write can never truncate or rename away a
/// pre-existing file at the user-owned destination — a name collision
/// (pathological user file shaped exactly like a candidate temp)
/// retries with the next counter instead. Use this for every write
/// whose parent directory the USER owns (note/attachment/PDF exports,
/// the vault-export staging tree); vault-internal writes stay on
/// [`atomic_write`]. See the module-level "Export-destination writes"
/// section.
pub fn atomic_write_unclobbered(path: &Path, bytes: &[u8], replace: bool) -> std::io::Result<()> {
    if !replace && path.exists() {
        return Err(std::io::ErrorKind::AlreadyExists.into());
    }

    let (tmp, mut f) = open_unclobbered_temp(path, &UNCLOBBERED_TEMP_COUNTER)?;

    // Same failure-path cleanup contract as `atomic_write`: a returned
    // error drops the partial temp on the way out (best-effort; the
    // original error is the one surfaced). The temp is OURS to remove —
    // `create_new(true)` proved no pre-existing file had that name.
    if let Err(e) = f.write_all(bytes).and_then(|()| f.sync_all()) {
        drop(f);
        let _ = std::fs::remove_file(&tmp);
        return Err(e);
    }
    // Release the handle before the rename (Windows requirement).
    drop(f);

    if let Err(e) = finalize_atomic(&tmp, path, replace) {
        let _ = std::fs::remove_file(&tmp);
        return Err(e);
    }

    Ok(())
}

/// Process-global monotonic token for [`atomic_write_unclobbered`] temp
/// names — uniqueness within the process is structural (fetch_add);
/// cross-process uniqueness rides the pid component.
static UNCLOBBERED_TEMP_COUNTER: std::sync::atomic::AtomicU64 =
    std::sync::atomic::AtomicU64::new(0);

/// Bound on candidate-name retries: every attempt consumes a fresh
/// counter value, so a retry only ever happens when a pre-existing
/// user file occupies a `<name>.<pid>-<n>.tmp` shape — more than a
/// handful of those is adversarial, bail closed.
const UNCLOBBERED_TEMP_ATTEMPTS: u32 = 16;

/// Pick a randomized temp sibling of `path` and open it
/// `create_new(true)` (atomic create-or-fail — never truncates a
/// pre-existing file). The counter is injected so tests can drive the
/// collision-retry branch deterministically; production passes the
/// process-global [`UNCLOBBERED_TEMP_COUNTER`].
fn open_unclobbered_temp(
    path: &Path,
    counter: &std::sync::atomic::AtomicU64,
) -> std::io::Result<(std::path::PathBuf, std::fs::File)> {
    for _ in 0..UNCLOBBERED_TEMP_ATTEMPTS {
        let token = counter.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let tmp = unclobbered_tmp_path(path, token);
        match std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&tmp)
        {
            Ok(f) => return Ok((tmp, f)),
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(e) => return Err(e),
        }
    }
    // No path in the message (DENY-list discipline at every layer).
    Err(std::io::Error::new(
        std::io::ErrorKind::AlreadyExists,
        "could not allocate a collision-free temp name at the export destination",
    ))
}

/// `<path>.<pid>-<token>.tmp` — the randomized temp-sibling name shape
/// of [`atomic_write_unclobbered`].
fn unclobbered_tmp_path(path: &Path, token: u64) -> std::path::PathBuf {
    let mut name = path
        .file_name()
        .map(|n| n.to_os_string())
        .unwrap_or_default();
    name.push(format!(".{}-{}.tmp", std::process::id(), token));
    path.with_file_name(name)
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
    mode: Option<u32>,
) -> std::io::Result<()> {
    if !replace && path.exists() {
        return Err(std::io::ErrorKind::AlreadyExists.into());
    }

    let tmp = tmp_path(path);

    // On any returned error, drop the partial temp so a failed write never
    // leaves a stray `<path>.tmp` sibling (best-effort; the original error
    // is the one surfaced). The single deliberate exception is the
    // `StopBeforeRename` crash simulation below.
    if let Err(e) = write_temp(&tmp, bytes, fault, mode) {
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
/// `#[cfg(test)]`; in production it is always [`Fault::None`]. `mode`, when
/// `Some` on Unix, is the create-time permission bits for the temp (used by
/// [`atomic_write_private`] to keep a credential file owner-only from the
/// moment it exists); `None` (ordinary ciphertext writes) uses the umask.
#[cfg_attr(not(test), allow(unused_variables))]
fn write_temp(tmp: &Path, bytes: &[u8], fault: Fault, mode: Option<u32>) -> std::io::Result<()> {
    let mut opts = std::fs::OpenOptions::new();
    opts.write(true).create(true).truncate(true);
    // Restrict the temp's create-time mode BEFORE it exists — never a
    // create-then-chmod window. Platform-split via a helper so `mode` is
    // always consumed (no unused-variable warning on any target).
    apply_temp_mode(&mut opts, mode);
    let mut f = opts.open(tmp)?;

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

/// Apply an optional create-time permission mode to the temp's open options.
/// Unix honors it (owner-only credential files); every other platform is a
/// no-op — mirrors the `set_restricted_perms` unix/no-op split in
/// `plugins::sync::token_store`.
#[cfg(unix)]
fn apply_temp_mode(opts: &mut std::fs::OpenOptions, mode: Option<u32>) {
    use std::os::unix::fs::OpenOptionsExt;
    if let Some(m) = mode {
        opts.mode(m);
    }
}

#[cfg(not(unix))]
fn apply_temp_mode(_opts: &mut std::fs::OpenOptions, _mode: Option<u32>) {}

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
pub fn finalize_atomic(src: &Path, dst: &Path, _replace: bool) -> std::io::Result<()> {
    std::fs::rename(src, dst)?;
    let parent = dst
        .parent()
        .expect("atomic_write paths always have a parent directory");
    std::fs::File::open(parent)?.sync_all()
}

#[cfg(windows)]
pub fn finalize_atomic(src: &Path, dst: &Path, replace: bool) -> std::io::Result<()> {
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

pub fn tmp_path(path: &Path) -> std::path::PathBuf {
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
            None,
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
            None,
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

        let err = atomic_write_inner(&target, b"NEW-VALID", true, Fault::StopBeforeRename, None)
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

        atomic_write_inner(&target, b"NEW-VALID", false, Fault::StopBeforeRename, None)
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

    // ---- atomic_write_private (owner-only credential writes) ------------

    /// The committed destination is `0600` — and, because the temp is created
    /// owner-only from the start, it is never briefly group/world-readable in a
    /// create-then-chmod window. Replacing a pre-existing loose (`0644`) file
    /// still lands `0600` (the new temp's create-mode governs, not inheritance).
    #[cfg(unix)]
    #[test]
    fn private_write_creates_and_replaces_at_0600() {
        use std::os::unix::fs::PermissionsExt;
        let dir = ScopedTempDir::new("aw-private-0600").unwrap();
        let target = dir.path().join("sync-token");

        atomic_write_private(&target, b"deadbeef", false).unwrap();
        let mode = std::fs::metadata(&target).unwrap().permissions().mode();
        assert_eq!(mode & 0o777, 0o600, "fresh private write must be 0600");

        // Loosen it to 0644, then a replace via atomic_write_private must
        // bring it back to 0600 (proves the create-mode governs the new inode).
        std::fs::set_permissions(&target, std::fs::Permissions::from_mode(0o644)).unwrap();
        atomic_write_private(&target, b"cafef00d", true).unwrap();
        let mode = std::fs::metadata(&target).unwrap().permissions().mode();
        assert_eq!(
            mode & 0o777,
            0o600,
            "replace via private write must be 0600"
        );
        assert_eq!(read_file(&target), b"cafef00d");
    }

    // ---- atomic_write_unclobbered (export-destination variant, 115-F1) ----

    #[test]
    fn unclobbered_creates_file_with_expected_contents_and_no_residue() {
        let dir = ScopedTempDir::new("unclob-creates").unwrap();
        let target = dir.path().join("exported.md");

        atomic_write_unclobbered(&target, b"plain markdown", false).unwrap();

        assert_eq!(read_file(&target), b"plain markdown");
        let entries: Vec<_> = std::fs::read_dir(dir.path())
            .unwrap()
            .filter_map(|e| e.ok())
            .map(|e| e.file_name())
            .collect();
        assert_eq!(entries.len(), 1, "entries: {entries:?}");
        assert_eq!(entries[0], "exported.md");
    }

    /// The headline 115-F1 contract: a pre-existing USER file that
    /// happens to carry the fixed-temp name `<target>.tmp` survives
    /// byte-identical through both `replace` modes (the legacy helper
    /// would have truncated it and renamed it over the target).
    #[test]
    fn unclobbered_preserves_preexisting_user_tmp_sibling() {
        let dir = ScopedTempDir::new("unclob-user-tmp").unwrap();
        let target = dir.path().join("exported.md");
        let user_tmp = dir.path().join("exported.md.tmp");
        std::fs::write(&user_tmp, b"user file, not ours").unwrap();

        // replace=false, target absent: write succeeds AROUND the user
        // file.
        atomic_write_unclobbered(&target, b"first", false).unwrap();
        assert_eq!(read_file(&target), b"first");
        assert_eq!(read_file(&user_tmp), b"user file, not ours");

        // replace=true over the existing target: still untouched.
        atomic_write_unclobbered(&target, b"second", true).unwrap();
        assert_eq!(read_file(&target), b"second");
        assert_eq!(read_file(&user_tmp), b"user file, not ours");

        // replace=false against the now-existing target: rejected before
        // any temp is opened; the user file is still untouched.
        let err = atomic_write_unclobbered(&target, b"third", false)
            .expect_err("replace=false must reject an existing destination");
        assert_eq!(err.kind(), std::io::ErrorKind::AlreadyExists);
        assert_eq!(read_file(&target), b"second");
        assert_eq!(read_file(&user_tmp), b"user file, not ours");
    }

    #[test]
    fn unclobbered_replace_false_rejects_existing_destination() {
        let dir = ScopedTempDir::new("unclob-exists").unwrap();
        let target = dir.path().join("file.bin");
        std::fs::write(&target, b"original").unwrap();

        let err = atomic_write_unclobbered(&target, b"replacement", false)
            .expect_err("replace=false must reject when destination exists");

        assert_eq!(err.kind(), std::io::ErrorKind::AlreadyExists);
        assert_eq!(read_file(&target), b"original");
    }

    /// Drive the collision-retry branch deterministically with an
    /// injected counter: candidates `<pid>-0` and `<pid>-1` are occupied
    /// by (sentinel) user files, the third attempt wins, and the
    /// occupied files are byte-untouched — `create_new` never truncates.
    #[test]
    fn unclobbered_temp_collision_retries_without_touching_existing_files() {
        let dir = ScopedTempDir::new("unclob-collide").unwrap();
        let target = dir.path().join("photo.png");
        let occupied_0 = unclobbered_tmp_path(&target, 0);
        let occupied_1 = unclobbered_tmp_path(&target, 1);
        std::fs::write(&occupied_0, b"sentinel zero").unwrap();
        std::fs::write(&occupied_1, b"sentinel one").unwrap();

        let counter = std::sync::atomic::AtomicU64::new(0);
        let (tmp, f) = open_unclobbered_temp(&target, &counter).unwrap();
        drop(f);

        assert_eq!(tmp, unclobbered_tmp_path(&target, 2));
        assert_eq!(read_file(&occupied_0), b"sentinel zero");
        assert_eq!(read_file(&occupied_1), b"sentinel one");
        std::fs::remove_file(&tmp).unwrap();

        // Exhausting every candidate bails closed with AlreadyExists.
        for n in 0..u64::from(UNCLOBBERED_TEMP_ATTEMPTS) {
            std::fs::write(unclobbered_tmp_path(&target, n), b"x").unwrap();
        }
        let counter = std::sync::atomic::AtomicU64::new(0);
        let err = open_unclobbered_temp(&target, &counter)
            .expect_err("a fully-occupied candidate space must bail closed");
        assert_eq!(err.kind(), std::io::ErrorKind::AlreadyExists);
    }

    /// Force the rename step to fail (destination is a non-empty
    /// directory) and assert the randomized temp is cleaned up — the
    /// failure-path contract carries over from `atomic_write`.
    #[cfg(unix)]
    #[test]
    fn unclobbered_finalize_failure_removes_temp() {
        let dir = ScopedTempDir::new("unclob-finalize-fail").unwrap();
        let target = dir.path().join("dest");
        std::fs::create_dir(&target).unwrap();
        std::fs::write(target.join("inner"), b"x").unwrap();

        atomic_write_unclobbered(&target, b"payload", true)
            .expect_err("rename of a file onto a directory must fail");

        let stray: Vec<_> = std::fs::read_dir(dir.path())
            .unwrap()
            .filter_map(|e| e.ok())
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .filter(|n| n.ends_with(".tmp"))
            .collect();
        assert!(stray.is_empty(), "temp must be cleaned up: {stray:?}");
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
