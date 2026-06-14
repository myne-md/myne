//! Transactional multi-note write — the §8.3 rollback primitive for wikilink
//! auto-update on rename (MYND-85 / WL-7).
//!
//! A title rename rewrites the renamed note's own blob PLUS every inbound
//! `[[…]]`-bearing note, and §8.3 requires this to be **all-or-nothing**: any
//! write failure leaves the vault in its pre-rename state. A partial commit
//! genuinely breaks links (an un-rewritten `[[Old Title]]` resolves to no note),
//! so per-blob [`crate::atomic_write::atomic_write`] is insufficient.
//!
//! ## Two-phase journal + roll-forward WAL
//!
//! 1. **Stage** every blob to `<uuid>.myn.tmp` (write + `sync_all`). Any stage
//!    failure (disk-full / permission / encryption — the failures §8.3 lists)
//!    deletes all staged `.tmp` and aborts; the live `.myn` files are untouched.
//! 2. **Commit.** Once all stages are durable, write an **empty** marker
//!    (`.rename-journal`, fsync'd) → atomically rename every `.tmp`→`.myn`
//!    (each via [`finalize_atomic`]) → delete the marker.
//!
//! ## Crash recovery ([`recover_pending_rename`], run on vault-open)
//!
//! - **Marker present** → a commit was in progress and every staged blob is
//!   durable → **roll forward**: rename every orphan `<uuid>.myn.tmp`→`.myn`.
//! - **Marker absent** → a stage crashed (or a single-note `atomic_write`
//!   crashed before its rename) → **roll back**: delete orphan `*.myn.tmp`.
//!
//! Safe under v0.1's single-writer-per-vault invariant: no `*.myn.tmp` exists
//! except as transaction residue. The marker carries NO data (no UUIDs/titles),
//! so it adds no metadata surface; rolled-forward blobs are still AEAD/CTX
//! verified on read, so a disk-write attacker cannot inject content.
//!
//! Secret-handling: callers pass ALREADY-ENCODED (encrypted) ciphertext blobs;
//! this module never sees plaintext and logs nothing (no paths, no ids).

use std::io::Write;
use std::path::{Path, PathBuf};

use crate::atomic_write::{finalize_atomic, tmp_path};

/// The empty roll-forward marker, written in the notes directory between the
/// stage and commit phases. Content-free — its mere existence is the signal.
const RENAME_JOURNAL: &str = ".rename-journal";

/// One blob in a transaction: its final `<uuid>.myn` path + the encoded
/// (encrypted) bytes to write there.
///
/// Built by the `note_write_batch_transactional` command (MYND-85 task
/// 3b) — one per rewritten note (the renamed note's own body + each
/// inbound `[[…]]`-bearing note).
pub struct TxnBlob {
    pub path: PathBuf,
    pub bytes: Vec<u8>,
}

/// Test-only fault-injection points for the crash-safety contract. In non-test
/// builds the enum has only [`TxnFault::None`], so the matches compile out and
/// the production path is byte-identical to a seam-free implementation.
#[derive(Clone, Copy)]
enum TxnFault {
    None,
    /// Fail during the stage of blob index `usize` (disk-full / encryption).
    #[cfg(test)]
    FailStage(usize),
    /// All staged, before the marker — a crash where the batch never reached
    /// commit. Recovery must ROLL BACK.
    #[cfg(test)]
    StopAfterStage,
    /// Marker written, before any rename — recovery must ROLL FORWARD all.
    #[cfg(test)]
    StopAfterMarker,
    /// Marker + the first rename committed, before the rest — recovery must
    /// ROLL FORWARD the remaining `.tmp`.
    #[cfg(test)]
    StopMidCommit,
}

/// Write all blobs in one all-or-nothing transaction (§8.3). Stages every blob,
/// then commits the renames; roll-forward-recoverable via the marker. Returns an
/// error (vault untouched) if any stage fails.
pub fn write_batch_transactional(notes_dir: &Path, blobs: &[TxnBlob]) -> std::io::Result<()> {
    write_batch_inner(notes_dir, blobs, TxnFault::None)
}

// `idx` in the commit loop is read only under the `#[cfg(test)]` crash hook.
#[cfg_attr(not(test), allow(unused_variables))]
fn write_batch_inner(notes_dir: &Path, blobs: &[TxnBlob], fault: TxnFault) -> std::io::Result<()> {
    if blobs.is_empty() {
        return Ok(());
    }

    // Phase 1 — stage all to `.tmp`. On ANY failure, delete every staged temp
    // (including the one that failed) and abort with the vault untouched.
    let mut staged: Vec<(PathBuf, PathBuf)> = Vec::with_capacity(blobs.len()); // (tmp, dst)
    for (i, b) in blobs.iter().enumerate() {
        let tmp = tmp_path(&b.path);
        let stage_result = stage_write(&tmp, &b.bytes, fault, i);
        if let Err(e) = stage_result {
            let _ = std::fs::remove_file(&tmp);
            for (t, _) in &staged {
                let _ = std::fs::remove_file(t);
            }
            return Err(e);
        }
        staged.push((tmp, b.path.clone()));
    }

    #[cfg(test)]
    if let TxnFault::StopAfterStage = fault {
        // Crash after staging, before the marker. Leaves `.tmp` + NO marker.
        return Err(std::io::ErrorKind::Interrupted.into());
    }

    // Phase 2 — write the empty commit marker (durable).
    let marker = notes_dir.join(RENAME_JOURNAL);
    write_marker(&marker)?;

    #[cfg(test)]
    if let TxnFault::StopAfterMarker = fault {
        // Crash after the marker, before any rename. Marker + all `.tmp` present.
        return Err(std::io::ErrorKind::Interrupted.into());
    }

    // Phase 3 — commit every rename atomically.
    for (idx, (tmp, dst)) in staged.iter().enumerate() {
        finalize_atomic(tmp, dst, /* replace = */ true)?;
        #[cfg(test)]
        if let TxnFault::StopMidCommit = fault {
            if idx == 0 {
                // One renamed, the rest still `.tmp`, marker present.
                return Err(std::io::ErrorKind::Interrupted.into());
            }
        }
    }

    // Phase 4 — clear the marker (the transaction is fully committed).
    let _ = std::fs::remove_file(&marker);
    if let Some(parent) = marker.parent() {
        let _ = std::fs::File::open(parent).and_then(|f| f.sync_all());
    }
    Ok(())
}

/// Stage one blob: write `<uuid>.myn.tmp` + `sync_all` so it is durable before
/// the commit phase. `fault`/`index` are read only under `#[cfg(test)]`.
#[cfg_attr(not(test), allow(unused_variables))]
fn stage_write(tmp: &Path, bytes: &[u8], fault: TxnFault, index: usize) -> std::io::Result<()> {
    #[cfg(test)]
    if let TxnFault::FailStage(fail_at) = fault {
        if fail_at == index {
            return Err(std::io::ErrorKind::Other.into());
        }
    }
    let mut f = std::fs::OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .open(tmp)?;
    f.write_all(bytes)?;
    f.sync_all()
}

/// Write the empty marker durably (file fsync + parent-dir fsync) so its
/// existence survives a power loss into the recovery pass.
fn write_marker(marker: &Path) -> std::io::Result<()> {
    let f = std::fs::OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .open(marker)?;
    f.sync_all()?;
    drop(f);
    if let Some(parent) = marker.parent() {
        std::fs::File::open(parent)?.sync_all()?;
    }
    Ok(())
}

/// Recover a pending rename transaction on vault-open (call BEFORE the index
/// rebuild). Idempotent; a no-op when there is nothing to recover. Wired into
/// the unlock path via
/// `plugins::vault_unlock::commands::recover_pending_rename_on_unlock`
/// (MYND-85 task 3c).
pub fn recover_pending_rename(notes_dir: &Path) -> std::io::Result<()> {
    let marker = notes_dir.join(RENAME_JOURNAL);
    let roll_forward = marker.exists();

    let entries = match std::fs::read_dir(notes_dir) {
        Ok(e) => e,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(e) => return Err(e),
    };
    let mut tmp_files: Vec<PathBuf> = Vec::new();
    for entry in entries {
        let path = entry?.path();
        if is_myn_tmp(&path) {
            tmp_files.push(path);
        }
    }

    for tmp in &tmp_files {
        if roll_forward {
            finalize_atomic(tmp, &myn_from_tmp(tmp), /* replace = */ true)?;
        } else {
            let _ = std::fs::remove_file(tmp);
        }
    }
    if roll_forward {
        let _ = std::fs::remove_file(&marker);
        if let Some(parent) = marker.parent() {
            let _ = std::fs::File::open(parent).and_then(|f| f.sync_all());
        }
    }
    Ok(())
}

fn is_myn_tmp(path: &Path) -> bool {
    path.file_name()
        .and_then(|n| n.to_str())
        .map(|n| n.ends_with(".myn.tmp"))
        .unwrap_or(false)
}

/// `<uuid>.myn.tmp` → `<uuid>.myn` (strip exactly one trailing `.tmp`).
fn myn_from_tmp(tmp: &Path) -> PathBuf {
    let name = tmp.file_name().and_then(|n| n.to_str()).unwrap_or("");
    let stripped = name.strip_suffix(".tmp").unwrap_or(name);
    tmp.with_file_name(stripped)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::ScopedTempDir;

    fn blob(dir: &Path, uuid: &str, body: &[u8]) -> TxnBlob {
        TxnBlob {
            path: dir.join(format!("{uuid}.myn")),
            bytes: body.to_vec(),
        }
    }

    fn read(p: &Path) -> Option<Vec<u8>> {
        std::fs::read(p).ok()
    }

    fn myn_tmp_count(dir: &Path) -> usize {
        std::fs::read_dir(dir)
            .unwrap()
            .filter_map(|e| e.ok())
            .filter(|e| is_myn_tmp(&e.path()))
            .count()
    }

    fn marker_exists(dir: &Path) -> bool {
        dir.join(RENAME_JOURNAL).exists()
    }

    #[test]
    fn happy_path_commits_all_and_leaves_no_residue() {
        let d = ScopedTempDir::new("txn-ok").unwrap();
        let dir = d.path();
        let blobs = vec![
            blob(dir, "a", b"AAA"),
            blob(dir, "b", b"BBB"),
            blob(dir, "c", b"CCC"),
        ];
        write_batch_transactional(dir, &blobs).unwrap();
        assert_eq!(read(&dir.join("a.myn")).as_deref(), Some(&b"AAA"[..]));
        assert_eq!(read(&dir.join("b.myn")).as_deref(), Some(&b"BBB"[..]));
        assert_eq!(read(&dir.join("c.myn")).as_deref(), Some(&b"CCC"[..]));
        assert_eq!(myn_tmp_count(dir), 0, "no leftover .tmp");
        assert!(!marker_exists(dir), "marker cleared");
    }

    #[test]
    fn stage_failure_aborts_with_vault_untouched() {
        let d = ScopedTempDir::new("txn-abort").unwrap();
        let dir = d.path();
        // Pre-existing committed content that MUST survive the aborted txn.
        std::fs::write(dir.join("a.myn"), b"OLD-A").unwrap();
        let blobs = vec![blob(dir, "a", b"NEW-A"), blob(dir, "b", b"NEW-B")];
        // Fail staging the 2nd blob.
        let err = write_batch_inner(dir, &blobs, TxnFault::FailStage(1)).unwrap_err();
        assert_eq!(err.kind(), std::io::ErrorKind::Other);
        assert_eq!(
            read(&dir.join("a.myn")).as_deref(),
            Some(&b"OLD-A"[..]),
            "a unchanged"
        );
        assert!(read(&dir.join("b.myn")).is_none(), "b never created");
        assert_eq!(myn_tmp_count(dir), 0, "all staged .tmp cleaned up on abort");
        assert!(!marker_exists(dir));
    }

    #[test]
    fn crash_after_stage_rolls_back() {
        let d = ScopedTempDir::new("txn-stagecrash").unwrap();
        let dir = d.path();
        std::fs::write(dir.join("a.myn"), b"OLD-A").unwrap();
        let blobs = vec![blob(dir, "a", b"NEW-A"), blob(dir, "b", b"NEW-B")];
        // Crash after staging both, before the marker.
        write_batch_inner(dir, &blobs, TxnFault::StopAfterStage).unwrap_err();
        assert_eq!(myn_tmp_count(dir), 2, "both staged .tmp present");
        assert!(!marker_exists(dir), "no marker → roll back");
        // Recover.
        recover_pending_rename(dir).unwrap();
        assert_eq!(
            read(&dir.join("a.myn")).as_deref(),
            Some(&b"OLD-A"[..]),
            "a kept old"
        );
        assert!(read(&dir.join("b.myn")).is_none(), "b never committed");
        assert_eq!(myn_tmp_count(dir), 0, ".tmp swept");
    }

    #[test]
    fn crash_after_marker_rolls_forward_all() {
        let d = ScopedTempDir::new("txn-markercrash").unwrap();
        let dir = d.path();
        std::fs::write(dir.join("a.myn"), b"OLD-A").unwrap();
        let blobs = vec![blob(dir, "a", b"NEW-A"), blob(dir, "b", b"NEW-B")];
        write_batch_inner(dir, &blobs, TxnFault::StopAfterMarker).unwrap_err();
        assert!(marker_exists(dir), "marker present → roll forward");
        assert_eq!(myn_tmp_count(dir), 2);
        recover_pending_rename(dir).unwrap();
        assert_eq!(
            read(&dir.join("a.myn")).as_deref(),
            Some(&b"NEW-A"[..]),
            "a committed"
        );
        assert_eq!(
            read(&dir.join("b.myn")).as_deref(),
            Some(&b"NEW-B"[..]),
            "b committed"
        );
        assert_eq!(myn_tmp_count(dir), 0);
        assert!(!marker_exists(dir), "marker cleared after recovery");
    }

    #[test]
    fn crash_mid_commit_rolls_forward_remainder() {
        let d = ScopedTempDir::new("txn-midcommit").unwrap();
        let dir = d.path();
        let blobs = vec![
            blob(dir, "a", b"NEW-A"),
            blob(dir, "b", b"NEW-B"),
            blob(dir, "c", b"NEW-C"),
        ];
        write_batch_inner(dir, &blobs, TxnFault::StopMidCommit).unwrap_err();
        // First renamed; the rest are still .tmp; marker present.
        assert!(marker_exists(dir));
        assert_eq!(
            read(&dir.join("a.myn")).as_deref(),
            Some(&b"NEW-A"[..]),
            "first committed"
        );
        assert!(read(&dir.join("b.myn")).is_none());
        recover_pending_rename(dir).unwrap();
        assert_eq!(read(&dir.join("b.myn")).as_deref(), Some(&b"NEW-B"[..]));
        assert_eq!(read(&dir.join("c.myn")).as_deref(), Some(&b"NEW-C"[..]));
        assert_eq!(myn_tmp_count(dir), 0);
        assert!(!marker_exists(dir));
    }

    #[test]
    fn recovery_is_a_noop_on_a_clean_dir() {
        let d = ScopedTempDir::new("txn-clean").unwrap();
        std::fs::write(d.path().join("a.myn"), b"AAA").unwrap();
        recover_pending_rename(d.path()).unwrap();
        assert_eq!(read(&d.path().join("a.myn")).as_deref(), Some(&b"AAA"[..]));
    }
}
