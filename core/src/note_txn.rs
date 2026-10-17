// SPDX-License-Identifier: AGPL-3.0
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

use std::path::{Path, PathBuf};

use crate::atomic_write::tmp_path;
use crate::io_failure_kind::IoFailureKind;
use crate::vault_io::{VaultIo, WriteOpts};

/// Publish a staged blob: copy the temp's bytes to the destination, then drop
/// the temp.
///
/// **Replaces `finalize_atomic`'s rename** (phase3-web-client task 86). Rename
/// is the one filesystem operation this product cannot rely on — the Phase 0
/// spike measured Safari implementing no `FileSystemFileHandle.move()` at all —
/// and this was the last one in the note-write path.
///
/// The observable state machine is unchanged, which is what lets the
/// `myne-test-vectors` §8.3 conformance fixture pass unmodified: before the
/// call the destination holds the OLD bytes and the temp holds the new; after
/// it, the destination holds the new bytes and the temp is gone. Only the
/// mechanism between those two states differs.
///
/// The crash window shifts and the new shape is the safe one **because the
/// marker already covers it**: a crash mid-publish leaves both the temp and a
/// destination that is either old or new, and the marker says roll FORWARD — so
/// recovery re-publishes from the temp, which is idempotent. A failed rename had
/// the same recovery; what it did not have was a browser it worked on.
///
/// On the web store the destination is a `SingleLive` container, so the write
/// itself lands in the slot that is not live and retires the old one — the
/// per-blob crash property comes for free on top of the journal's.
async fn publish_staged(io: &dyn VaultIo, tmp: &Path, dst: &Path) -> Result<(), IoFailureKind> {
    let bytes = io.read(tmp).await?;
    if let Err(e) = io.write(dst, &bytes, WriteOpts::default()).await {
        // **Re-stage before returning (myne#300).** On the native arm
        // `io.write(dst, …)` is `atomic_write`, whose temp name is
        // `tmp_path(dst)` — byte-for-byte the staged temp this function was
        // handed. Its failure-path cleanup therefore deletes OUR staged blob,
        // and the roll-forward pass at the next unlock has nothing left to
        // publish for this note: the batch stays half-committed forever, some
        // notes rewritten to the new title and this one still pointing at the
        // old, with no error naming it.
        //
        // The bytes are still in hand, so putting the temp back is free. This
        // write cannot recurse into the same trap: `tmp_path(tmp)` is
        // `<uuid>.myn.tmp.tmp`, a different file. Best-effort — the original
        // error is the one surfaced, and a failure here leaves exactly the
        // state the missing re-stage would have.
        let _ = io.write(tmp, &bytes, WriteOpts::default()).await;
        return Err(e);
    }
    let _ = io.remove_file(tmp).await;
    Ok(())
}

/// Why a transaction failed — specifically, **which side of the commit point**.
///
/// The distinction is the whole reason this type exists rather than a bare
/// [`IoFailureKind`] (myne#300). Before the marker is durable the vault really
/// is untouched and a caller may roll its optimistic UI back. After it, the
/// batch is *committed*: [`recover_pending_rename`] publishes every surviving
/// `<uuid>.myn.tmp` at the next unlock, so the rename the user was told had
/// failed silently completes. A caller that cannot tell the two apart picks one
/// and is wrong half the time — and the half it was picking (roll back, report
/// the whole set as failed, skip the deliberate-folder write and the re-index)
/// is the wrong one for the case where data actually changed.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TxnFailure {
    /// Failed at or before the commit marker. **The vault is unchanged** — no
    /// `.myn` was replaced, no marker survives, and every staged temp was
    /// swept. Roll the caller's optimistic state back.
    Aborted(IoFailureKind),
    /// Failed **after** the commit marker became durable. Some blobs are
    /// published, the rest are still staged, and the marker is deliberately
    /// left on disk — which is what guarantees the remainder lands on the next
    /// vault open. The rename has happened; do not roll it back. The vault is
    /// briefly inconsistent (an inbound note may still read `[[Old Title]]`)
    /// until that recovery pass runs.
    CommittedPendingPublish(IoFailureKind),
}

impl TxnFailure {
    /// The underlying IO cause, whichever side of the commit point it came from.
    pub fn kind(self) -> IoFailureKind {
        match self {
            TxnFailure::Aborted(k) | TxnFailure::CommittedPendingPublish(k) => k,
        }
    }
}

impl core::fmt::Display for TxnFailure {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        match self {
            TxnFailure::Aborted(k) => write!(f, "transaction aborted before commit: {k}"),
            TxnFailure::CommittedPendingPublish(k) => {
                write!(f, "transaction committed, publish incomplete: {k}")
            }
        }
    }
}

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
/// then commits the renames; roll-forward-recoverable via the marker.
///
/// The error tells the caller which side of the commit point it happened on —
/// [`TxnFailure::Aborted`] means the vault is untouched,
/// [`TxnFailure::CommittedPendingPublish`] means it is not. See [`TxnFailure`];
/// treating the second as the first is myne#300.
pub async fn write_batch_transactional(
    io: &dyn VaultIo,
    notes_dir: &Path,
    blobs: &[TxnBlob],
) -> Result<(), TxnFailure> {
    write_batch_inner(io, notes_dir, blobs, TxnFault::None).await
}

// `idx` in the commit loop is read only under the `#[cfg(test)]` crash hook.
#[cfg_attr(not(test), allow(unused_variables))]
async fn write_batch_inner(
    io: &dyn VaultIo,
    notes_dir: &Path,
    blobs: &[TxnBlob],
    fault: TxnFault,
) -> Result<(), TxnFailure> {
    if blobs.is_empty() {
        return Ok(());
    }

    // Phase 1 — stage all to `.tmp`. On ANY failure, delete every staged temp
    // (including the one that failed) and abort with the vault untouched.
    let mut staged: Vec<(PathBuf, PathBuf)> = Vec::with_capacity(blobs.len()); // (tmp, dst)
    for (i, b) in blobs.iter().enumerate() {
        let tmp = tmp_path(&b.path);
        let stage_result = stage_write(io, &tmp, &b.bytes, fault, i).await;
        if let Err(e) = stage_result {
            let _ = io.remove_file(&tmp).await;
            for (t, _) in &staged {
                let _ = io.remove_file(t).await;
            }
            return Err(TxnFailure::Aborted(e));
        }
        staged.push((tmp, b.path.clone()));
    }

    #[cfg(test)]
    if let TxnFault::StopAfterStage = fault {
        // Crash after staging, before the marker. Leaves `.tmp` + NO marker.
        return Err(TxnFailure::Aborted(IoFailureKind::Other));
    }

    // Phase 2 — write the empty commit marker (durable). This is the COMMIT
    // POINT: from the line below, the batch completes whatever happens, because
    // `recover_pending_rename` rolls a marker-present directory forward.
    let marker = notes_dir.join(RENAME_JOURNAL);
    write_marker(io, &marker)
        .await
        .map_err(TxnFailure::Aborted)?;

    #[cfg(test)]
    if let TxnFault::StopAfterMarker = fault {
        // Crash after the marker, before any publish. Marker + all `.tmp` present.
        return Err(TxnFailure::CommittedPendingPublish(IoFailureKind::Other));
    }

    // Phase 3 — publish every staged blob.
    //
    // A failure here does NOT stop the loop (myne#300). One unwritable blob
    // says nothing about the next, the marker means all of them are committed
    // regardless, and the difference between "one note waits for the next
    // unlock" and "all of them do" is the window in which the vault reads
    // inconsistently. So: remember the first error, keep going, and report the
    // committed-not-published outcome at the end — with the marker deliberately
    // left in place, which is what makes the remainder recoverable.
    let mut first_publish_error: Option<IoFailureKind> = None;
    for (idx, (tmp, dst)) in staged.iter().enumerate() {
        if let Err(e) = publish_staged(io, tmp, dst).await {
            first_publish_error.get_or_insert(e);
        }
        #[cfg(test)]
        if let TxnFault::StopMidCommit = fault {
            if idx == 0 {
                // One published, the rest still `.tmp`, marker present.
                return Err(TxnFailure::CommittedPendingPublish(IoFailureKind::Other));
            }
        }
    }
    if let Some(e) = first_publish_error {
        // Marker intentionally NOT cleared — it is the roll-forward promise.
        return Err(TxnFailure::CommittedPendingPublish(e));
    }

    // Phase 4 — clear the marker (the transaction is fully committed).
    let _ = io.remove_file(&marker).await;
    Ok(())
}

/// Stage one blob: write `<uuid>.myn.tmp` + `sync_all` so it is durable before
/// the commit phase. `fault`/`index` are read only under `#[cfg(test)]`.
#[cfg_attr(not(test), allow(unused_variables))]
async fn stage_write(
    io: &dyn VaultIo,
    tmp: &Path,
    bytes: &[u8],
    fault: TxnFault,
    index: usize,
) -> Result<(), IoFailureKind> {
    #[cfg(test)]
    if let TxnFault::FailStage(fail_at) = fault {
        if fail_at == index {
            return Err(IoFailureKind::Other);
        }
    }
    // A `<uuid>.myn.tmp` is `Mode::Plain` on the container store — it does not
    // end in `.myn`, so it is not mistaken for a per-note blob and gets no slot
    // suffix. That is what keeps `recover_pending_rename`'s `*.myn.tmp` scan
    // finding exactly what it found before.
    io.write(tmp, bytes, WriteOpts::default()).await
}

/// Write the empty marker so its existence survives into the recovery pass.
///
/// The fsync + parent-dir fsync it used to do explicitly are now the seam's
/// native arm's job (`atomic_write`'s durability contract: temp → fsync →
/// rename → parent sync). The wasm arm cannot make that promise at all, which
/// is why the marker is a **presence** signal over a content-free file: the
/// weakest thing a store can get wrong, and the only failure it has is "the
/// marker is not there", which recovery already treats as roll-BACK — the
/// conservative direction, since every live `.myn` is still the pre-transaction
/// one at that point.
async fn write_marker(io: &dyn VaultIo, marker: &Path) -> Result<(), IoFailureKind> {
    io.write(marker, &[], WriteOpts::default()).await
}

/// Recover a pending rename transaction on vault-open (call BEFORE the index
/// rebuild). Idempotent; a no-op when there is nothing to recover. Wired into
/// the unlock path via
/// `plugins::vault_unlock::commands::recover_pending_rename_on_unlock`
/// (MYND-85 task 3c).
pub async fn recover_pending_rename(
    io: &dyn VaultIo,
    notes_dir: &Path,
) -> Result<(), IoFailureKind> {
    let marker = notes_dir.join(RENAME_JOURNAL);
    let roll_forward = io.exists(&marker).await.unwrap_or(false);

    let entries = match io.read_dir(notes_dir).await {
        Ok(e) => e,
        Err(IoFailureKind::NotFound) => return Ok(()),
        Err(kind) => return Err(kind),
    };
    // The seam yields NAMES — OPFS has no path API — so the parent is
    // reassembled from the directory the caller already passed in. The
    // `.myn.tmp` predicate is the same one, over the same strings.
    let tmp_files: Vec<PathBuf> = entries
        .into_iter()
        .filter(|e| is_myn_tmp(&e.name))
        .map(|e| notes_dir.join(e.name))
        .collect();

    for tmp in &tmp_files {
        if roll_forward {
            publish_staged(io, tmp, &myn_from_tmp(tmp)).await?;
        } else {
            let _ = io.remove_file(tmp).await;
        }
    }
    if roll_forward {
        let _ = io.remove_file(&marker).await;
    }
    Ok(())
}

fn is_myn_tmp(name: &str) -> bool {
    name.ends_with(".myn.tmp")
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

    // ── the seam, filled in ─────────────────────────────────────────────────
    //
    // Task 86 gave the transaction `io: &dyn VaultIo` and made it async (the
    // seam is, because OPFS handle acquisition is). These shims shadow the two
    // entry points with their old synchronous signatures so every scenario below
    // reads unchanged — and each still drives the REAL transaction against a
    // real temp directory, which is what these tests are for: they pin the
    // observable state machine the `myne-test-vectors` §8.3 fixture also pins.
    const IO: crate::vault_io::StdVaultIo = crate::vault_io::StdVaultIo;

    fn rt<F: std::future::Future>(f: F) -> F::Output {
        crate::test_support::block_on(f)
    }

    fn write_batch_transactional(notes_dir: &Path, blobs: &[TxnBlob]) -> Result<(), TxnFailure> {
        rt(super::write_batch_transactional(&IO, notes_dir, blobs))
    }

    fn write_batch_inner(
        notes_dir: &Path,
        blobs: &[TxnBlob],
        fault: TxnFault,
    ) -> Result<(), TxnFailure> {
        rt(super::write_batch_inner(&IO, notes_dir, blobs, fault))
    }

    fn recover_pending_rename(notes_dir: &Path) -> Result<(), IoFailureKind> {
        rt(super::recover_pending_rename(&IO, notes_dir))
    }

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
            .filter(|e| is_myn_tmp(&e.file_name().to_string_lossy()))
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
        assert_eq!(err, TxnFailure::Aborted(IoFailureKind::Other));
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

    // ── myne#300: a phase-3 failure is not "the vault is unchanged" ─────────
    //
    // The three properties, all of which the single `IoFailureKind` return
    // could not express and the `?` in the publish loop actively broke:
    //
    //   1. the OUTCOME says the batch committed, so a caller keeps its
    //      optimistic rename instead of rolling it back onto a vault that has
    //      already changed;
    //   2. the staged temp of the FAILING blob survives, so the roll-forward
    //      pass has something to publish from — `atomic_write`'s own cleanup
    //      deletes it, because `tmp_path(dst)` IS that temp;
    //   3. one unpublishable blob does not strand the ones after it.
    //
    // Unix-only: the failure is produced with a real filesystem error
    // (`rename(file, non-empty-dir)` → EISDIR), which is POSIX-specific — the
    // same technique `atomic_write`'s `finalize_failure_removes_temp` uses.
    #[cfg(unix)]
    #[test]
    fn publish_failure_reports_committed_and_leaves_the_batch_recoverable() {
        let d = ScopedTempDir::new("txn-publish-fail").unwrap();
        let dir = d.path();
        // `b.myn` is an unwritable destination: a non-empty directory, so the
        // publishing rename fails with EISDIR.
        std::fs::create_dir(dir.join("b.myn")).unwrap();
        std::fs::write(dir.join("b.myn").join("inner"), b"x").unwrap();
        let blobs = vec![
            blob(dir, "a", b"NEW-A"),
            blob(dir, "b", b"NEW-B"),
            blob(dir, "c", b"NEW-C"),
        ];

        let err = write_batch_transactional(dir, &blobs).unwrap_err();

        // (1) The outcome names the side of the commit point it happened on.
        assert!(
            matches!(err, TxnFailure::CommittedPendingPublish(_)),
            "a post-marker failure must not report Aborted: {err:?}"
        );

        // (3) The blob after the failing one was still published.
        assert_eq!(read(&dir.join("a.myn")).as_deref(), Some(&b"NEW-A"[..]));
        assert_eq!(
            read(&dir.join("c.myn")).as_deref(),
            Some(&b"NEW-C"[..]),
            "one unpublishable blob must not strand the ones after it"
        );

        // (2) The failing blob is still staged, and the marker is still the
        // roll-forward promise.
        assert!(marker_exists(dir), "the commit marker must survive");
        assert_eq!(
            read(&dir.join("b.myn.tmp")).as_deref(),
            Some(&b"NEW-B"[..]),
            "the failing blob's staged temp must survive for the roll-forward"
        );

        // …and the roll-forward really does finish it once the destination is
        // writable again. This is the guarantee the caller is being told about.
        std::fs::remove_dir_all(dir.join("b.myn")).unwrap();
        recover_pending_rename(dir).unwrap();
        assert_eq!(read(&dir.join("b.myn")).as_deref(), Some(&b"NEW-B"[..]));
        assert_eq!(myn_tmp_count(dir), 0);
        assert!(!marker_exists(dir));
    }

    /// The other side of the same distinction: a STAGE failure still reports
    /// `Aborted`, because there the "vault untouched" reading is true.
    #[test]
    fn stage_failure_reports_aborted_not_committed() {
        let d = ScopedTempDir::new("txn-abort-kind").unwrap();
        let dir = d.path();
        let blobs = vec![blob(dir, "a", b"NEW-A"), blob(dir, "b", b"NEW-B")];
        let err = write_batch_inner(dir, &blobs, TxnFault::FailStage(1)).unwrap_err();
        assert!(
            matches!(err, TxnFailure::Aborted(_)),
            "a pre-marker failure is genuinely all-or-nothing: {err:?}"
        );
    }

    #[test]
    fn recovery_is_a_noop_on_a_clean_dir() {
        let d = ScopedTempDir::new("txn-clean").unwrap();
        std::fs::write(d.path().join("a.myn"), b"AAA").unwrap();
        recover_pending_rename(d.path()).unwrap();
        assert_eq!(read(&d.path().join("a.myn")).as_deref(), Some(&b"AAA"[..]));
    }

    // ---- cross-impl conformance vectors (companion repo) --------------

    /// One rename-journal recovery scenario: a directory snapshot
    /// (`files`) and the expected snapshot after `recover_pending_rename`.
    struct RjScenario {
        slug: &'static str,
        kind: &'static str,
        desc: &'static str,
        /// `(name, content)` — `.rename-journal` (empty) is the marker;
        /// `*.myn.tmp` are staged blobs; `*.myn` are committed blobs.
        files: &'static [(&'static str, &'static [u8])],
    }

    const RJ_SCENARIOS: &[RjScenario] = &[
        RjScenario {
            slug: "roll-forward-marker-present",
            kind: "roll_forward",
            desc: "The marker is durable, so every staged .myn.tmp is rolled FORWARD to .myn and the marker is cleared. A pre-existing committed .myn is untouched.",
            files: &[
                (".rename-journal", b""),
                ("a.myn.tmp", b"NEW-A"),
                ("b.myn.tmp", b"NEW-B"),
                ("c.myn", b"OLD-C"),
            ],
        },
        RjScenario {
            slug: "roll-forward-replaces-existing",
            kind: "roll_forward",
            desc: "Roll-forward replaces a pre-existing committed .myn with its staged .myn.tmp content (the in-place note-update path).",
            files: &[
                (".rename-journal", b""),
                ("a.myn.tmp", b"NEW-A"),
                ("a.myn", b"OLD-A"),
            ],
        },
        RjScenario {
            slug: "roll-back-no-marker",
            kind: "roll_back",
            desc: "Without the marker the crash happened before the durability fence, so every staged .myn.tmp is rolled BACK (deleted) and the pre-existing committed .myn survives.",
            files: &[
                ("a.myn.tmp", b"NEW-A"),
                ("b.myn.tmp", b"NEW-B"),
                ("c.myn", b"OLD-C"),
            ],
        },
        RjScenario {
            slug: "noop-clean-dir",
            kind: "noop",
            desc: "A clean directory (no marker, no .tmp) is unchanged by recovery.",
            files: &[("a.myn", b"AAA"), ("b.myn", b"BBB")],
        },
    ];

    fn hex_lower(bytes: &[u8]) -> String {
        let mut s = String::with_capacity(bytes.len() * 2);
        for b in bytes {
            s.push_str(&format!("{b:02x}"));
        }
        s
    }

    /// Snapshot a directory as a name-sorted `[(name, bytes)]` list. The
    /// rename journal has no inherent file order (POSIX `readdir` is
    /// unordered), so the snapshot is a SET keyed by name.
    fn snapshot_dir(dir: &Path) -> Vec<(String, Vec<u8>)> {
        let mut out: Vec<(String, Vec<u8>)> = std::fs::read_dir(dir)
            .unwrap()
            .map(|e| {
                let p = e.unwrap().path();
                let name = p.file_name().unwrap().to_string_lossy().into_owned();
                (name, std::fs::read(&p).unwrap())
            })
            .collect();
        out.sort_by(|a, b| a.0.cmp(&b.0));
        out
    }

    fn files_to_json(files: &[(String, Vec<u8>)]) -> serde_json::Value {
        serde_json::Value::Array(
            files
                .iter()
                .map(|(name, bytes)| {
                    serde_json::json!({ "name": name, "content_hex": hex_lower(bytes) })
                })
                .collect(),
        )
    }

    /// Emits `myne-test-vectors/vectors/rename-journal/v0.1/cases.json` to
    /// `/tmp/myne_rename_journal_vectors.json`. `#[ignore]` — regenerating
    /// vectors is a deliberate act. Run with:
    /// `cargo test -p myne-desktop --lib emit_rename_journal_vectors_for_paste -- --ignored`
    ///
    /// Pins `recover_pending_rename` (the §9.12 rename-journal crash-recovery
    /// state machine) as an fs-state conformance fixture: a directory snapshot
    /// → the snapshot after recovery. Self-validating at mint (each emitted
    /// expected snapshot is the live recovery output; recovery is re-run to
    /// confirm idempotency).
    #[test]
    #[ignore]
    fn emit_rename_journal_vectors_for_paste() {
        let mut cases = Vec::new();
        for sc in RJ_SCENARIOS {
            let d = ScopedTempDir::new("gen-rj").unwrap();
            let dir = d.path();
            for (name, content) in sc.files {
                std::fs::write(dir.join(name), content).unwrap();
            }
            recover_pending_rename(dir).unwrap();
            let recovered = snapshot_dir(dir);
            // Idempotency self-check: a second recovery is a fixed point.
            recover_pending_rename(dir).unwrap();
            assert_eq!(
                snapshot_dir(dir),
                recovered,
                "[{}] recovery is not idempotent",
                sc.slug
            );

            let input: Vec<(String, Vec<u8>)> = sc
                .files
                .iter()
                .map(|(n, b)| ((*n).to_string(), b.to_vec()))
                .collect();
            let mut input_sorted = input.clone();
            input_sorted.sort_by(|a, b| a.0.cmp(&b.0));

            cases.push(serde_json::json!({
                "vector_id": format!("rename-journal/v0.1/{}", sc.slug),
                "description": sc.desc,
                "case_kind": sc.kind,
                "input_dir_files": files_to_json(&input_sorted),
                "expected_dir_files": files_to_json(&recovered),
            }));
        }

        let doc = serde_json::json!({
            "schema": "rename-journal",
            "protocol_version": "v0.1",
            "spec_section": "protocol.md §9.12 (transactional multi-note rename — the rename journal)",
            "description": "Pins note_txn::recover_pending_rename — the §9.12 rename-journal crash-recovery state machine — as an fs-state conformance fixture. NOT a byte-output codec: the .rename-journal marker is content-free and POSIX readdir is unordered, so each case pins a directory SNAPSHOT (a name-sorted set of {name, content_hex}) before and after recovery. The marker's presence is the only durability signal: present → roll FORWARD (every *.myn.tmp renamed to *.myn, marker cleared); absent → roll BACK (every *.myn.tmp deleted). A port materializes input_dir_files in a fresh directory, runs its recovery, and asserts the resulting set equals expected_dir_files. Generator + runner live in src-tauri/src/note_txn.rs (the codec is std/fs-bound, like backup-container). Cases generated by `cargo test -p myne-desktop --lib emit_rename_journal_vectors_for_paste -- --ignored`.",
            "cases": cases,
        });
        std::fs::write(
            "/tmp/myne_rename_journal_vectors.json",
            serde_json::to_string_pretty(&doc).unwrap() + "\n",
        )
        .unwrap();
        eprintln!("[ok] wrote /tmp/myne_rename_journal_vectors.json");
    }

    #[test]
    fn rename_journal_vectors() {
        let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("..")
            .join("myne-test-vectors")
            .join("vectors")
            .join("rename-journal")
            .join("v0.1")
            .join("cases.json");
        if !path.exists() {
            eprintln!(
                "[skip] rename-journal: companion repo fixture not present at {}",
                path.display()
            );
            return;
        }

        let raw = std::fs::read_to_string(&path)
            .unwrap_or_else(|e| panic!("read {}: {e}", path.display()));
        let doc: serde_json::Value =
            serde_json::from_str(&raw).unwrap_or_else(|e| panic!("parse {}: {e}", path.display()));
        assert_eq!(doc["schema"], "rename-journal");
        assert_eq!(doc["protocol_version"], "v0.1");

        let cases = doc["cases"].as_array().expect("cases must be a JSON array");
        assert!(
            !cases.is_empty(),
            "rename-journal must have at least one case"
        );

        let hex_decode = |s: &str| -> Vec<u8> {
            assert!(s.len().is_multiple_of(2), "hex length must be even");
            (0..s.len())
                .step_by(2)
                .map(|i| u8::from_str_radix(&s[i..i + 2], 16).expect("ascii hex"))
                .collect()
        };
        let materialize = |dir: &Path, files: &serde_json::Value| {
            for f in files.as_array().expect("dir_files must be an array") {
                let name = f["name"].as_str().expect("file name string");
                let content = hex_decode(f["content_hex"].as_str().expect("content_hex string"));
                std::fs::write(dir.join(name), content).expect("materialize file");
            }
        };
        let expected_set = |files: &serde_json::Value| -> Vec<(String, Vec<u8>)> {
            let mut v: Vec<(String, Vec<u8>)> = files
                .as_array()
                .expect("dir_files must be an array")
                .iter()
                .map(|f| {
                    (
                        f["name"].as_str().expect("name").to_string(),
                        hex_decode(f["content_hex"].as_str().expect("content_hex")),
                    )
                })
                .collect();
            v.sort_by(|a, b| a.0.cmp(&b.0));
            v
        };

        let mut seen_kinds = std::collections::HashSet::new();
        for case in cases {
            let id = case["vector_id"].as_str().expect("vector_id string");
            seen_kinds.insert(
                case["case_kind"]
                    .as_str()
                    .expect("case_kind string")
                    .to_string(),
            );

            let d = ScopedTempDir::new("rj-vec").unwrap();
            let dir = d.path();
            materialize(dir, &case["input_dir_files"]);
            recover_pending_rename(dir).unwrap_or_else(|e| panic!("[{id}] recovery failed: {e}"));
            let got = snapshot_dir(dir);
            let want = expected_set(&case["expected_dir_files"]);
            assert_eq!(
                got, want,
                "[{id}] post-recovery directory snapshot mismatch"
            );

            // Idempotency: a second recovery leaves the snapshot unchanged.
            recover_pending_rename(dir).unwrap();
            assert_eq!(snapshot_dir(dir), want, "[{id}] recovery is not idempotent");
        }
        for kind in ["roll_forward", "roll_back", "noop"] {
            assert!(
                seen_kinds.contains(kind),
                "rename-journal missing every case of case_kind '{kind}' — coverage regression"
            );
        }
    }
}
