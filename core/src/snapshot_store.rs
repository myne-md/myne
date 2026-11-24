// SPDX-License-Identifier: AGPL-3.0-only
//! On-disk storage layer for encrypted per-note snapshots (MYND-96 — the
//! write-path / storage side of the encrypted-snapshots epic). Shared by the
//! notes-plugin creation hook (snapshot-write-path) and the snapshots plugin's
//! read/management commands (snapshot-management-apis).
//!
//! A snapshot is a **byte-verbatim copy** of a note's `.myn` blob as it was
//! immediately before an overwrite. That blob is already a valid `MY01` blob
//! sealed under the note's `item_key` (`spec/protocol.md` §9.2), so this layer
//! performs **no decryption and no re-encryption** — copying the sealed bytes is
//! the most literal realization of SYNC-1's "frozen `.myn` revision", and it is
//! nonce-safe (the copied blob keeps its original random `content_nonce`; the
//! live note draws a fresh nonce on its next `encode_update`, so no key+nonce
//! pair ever encrypts two different plaintexts).
//!
//! Layout (SYNC-4): flat files `<note-uuid>__<snapshot-uuidv7>.myn` under
//! `<vault-root>/snapshots/`. The `__` separator is unambiguous (UUIDv7 strings
//! contain no `_`); the trailing UUIDv7 gives natural time-sort and a
//! **decrypt-free** capture timestamp (its embedded 48-bit ms clock).

use crate::atomic_write::atomic_write;
use std::path::{Path, PathBuf};
use uuid::Uuid;

const SNAPSHOT_SEP: &str = "__";
const SNAPSHOT_EXT: &str = "myn";

/// Build the snapshot filename `<note_uuid>__<snapshot_uuid>.myn`.
pub fn snapshot_filename(note_uuid: &str, snapshot_uuid: &str) -> String {
    format!("{note_uuid}{SNAPSHOT_SEP}{snapshot_uuid}.{SNAPSHOT_EXT}")
}

/// Parse `<note_uuid>__<snapshot_uuid>.myn` into `(note_uuid, snapshot_uuid)`.
/// Returns `None` for any name not matching the exact shape with two valid
/// UUIDv7 halves — foreign / malformed files in `snapshots/` are skipped by the
/// lister rather than erroring the whole scan.
pub fn parse_snapshot_filename(name: &str) -> Option<(String, String)> {
    let stem = name.strip_suffix(&format!(".{SNAPSHOT_EXT}"))?;
    // UUIDs contain no '_', so the first "__" is unambiguously the separator.
    let (note, snap) = stem.split_once(SNAPSHOT_SEP)?;
    let note_uuid = Uuid::parse_str(note).ok()?;
    let snap_uuid = Uuid::parse_str(snap).ok()?;
    if note_uuid.get_version_num() != 7 || snap_uuid.get_version_num() != 7 {
        return None;
    }
    Some((note.to_string(), snap.to_string()))
}

/// Extract a snapshot's capture time (ms since the Unix epoch) from its UUIDv7,
/// decrypt-free. `None` if the UUID is not a v7 / carries no timestamp.
pub fn snapshot_captured_at_ms(snapshot_uuid: &Uuid) -> Option<u64> {
    let ts = snapshot_uuid.get_timestamp()?;
    let (secs, nanos) = ts.to_unix();
    Some(secs.saturating_mul(1000) + (nanos as u64) / 1_000_000)
}

/// A note's snapshot on disk, as surfaced to the retention policy and the list
/// command — all fields derived without decrypting the blob (SYNC-6).
#[derive(Debug, Clone)]
pub struct SnapshotFile {
    pub path: PathBuf,
    pub snapshot_uuid: String,
    pub captured_at_ms: u64,
    pub size_bytes: u64,
}

/// Generate a fresh snapshot id (UUIDv7 — time-ordered so filenames sort by
/// capture time and the embedded clock is the capture timestamp).
pub fn new_snapshot_uuid() -> Uuid {
    Uuid::now_v7()
}

/// Durably write a snapshot blob (the verbatim pre-overwrite `.myn` bytes) into
/// `snapshots_dir`. Create-only (`replace=false`): a UUIDv7 collision is
/// astronomically improbable and would signal a bug, not a normal retry. Returns
/// the snapshot's path. The caller is responsible for `create_dir_all`ing
/// `snapshots_dir` first (use [`crate::paths::snapshots_dir`]).
pub fn write_snapshot_blob(
    snapshots_dir: &Path,
    note_uuid: &str,
    snapshot_uuid: &str,
    blob: &[u8],
) -> std::io::Result<PathBuf> {
    let path = snapshots_dir.join(snapshot_filename(note_uuid, snapshot_uuid));
    atomic_write(&path, blob, false)?;
    Ok(path)
}

/// List a note's snapshot files (decrypt-free), **newest-first** by capture time
/// (UUIDv7 string as tiebreak). Foreign / malformed names and other notes'
/// snapshots are skipped. A missing `snapshots/` directory is an empty list, not
/// an error (a vault that has never snapshotted).
pub fn list_note_snapshots(
    snapshots_dir: &Path,
    note_uuid: &str,
) -> std::io::Result<Vec<SnapshotFile>> {
    let mut out = Vec::new();
    let rd = match std::fs::read_dir(snapshots_dir) {
        Ok(rd) => rd,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(out),
        Err(e) => return Err(e),
    };
    for entry in rd {
        let entry = entry?;
        let raw = entry.file_name();
        let Some(name) = raw.to_str() else { continue };
        let Some((n, snap)) = parse_snapshot_filename(name) else {
            continue;
        };
        if n != note_uuid {
            continue;
        }
        let Ok(snap_uuid) = Uuid::parse_str(&snap) else {
            continue;
        };
        let captured_at_ms = snapshot_captured_at_ms(&snap_uuid).unwrap_or(0);
        let size_bytes = entry.metadata().map(|m| m.len()).unwrap_or(0);
        out.push(SnapshotFile {
            path: entry.path(),
            snapshot_uuid: snap,
            captured_at_ms,
            size_bytes,
        });
    }
    out.sort_by(|a, b| {
        b.captured_at_ms
            .cmp(&a.captured_at_ms)
            .then_with(|| b.snapshot_uuid.cmp(&a.snapshot_uuid))
    });
    Ok(out)
}

/// Remove one snapshot file. Idempotent: a missing file is `Ok(())` (a
/// concurrent prune / restore may have already removed it).
pub fn remove_snapshot(path: &Path) -> std::io::Result<()> {
    match std::fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e),
    }
}

/// Enforce the retention `policy` on a note's snapshots now (eager prune, SYNC-2),
/// using the canonical [`crate::snapshot_policy`] selection as the single source
/// of truth. Returns the count removed. Errors only if the directory scan
/// itself fails; per-file unlink errors surface so the caller can log them
/// best-effort.
pub fn prune_note_snapshots(
    snapshots_dir: &Path,
    note_uuid: &str,
    now_ms: u64,
    policy: &crate::snapshot_policy::RetentionPolicy,
) -> std::io::Result<usize> {
    let all = list_note_snapshots(snapshots_dir, note_uuid)?;
    let entries: Vec<crate::snapshot_policy::SnapshotEntry> = all
        .iter()
        .map(|s| crate::snapshot_policy::SnapshotEntry {
            captured_at_ms: s.captured_at_ms,
            size_bytes: s.size_bytes,
        })
        .collect();
    let mut removed = 0usize;
    for idx in crate::snapshot_policy::snapshots_to_prune(&entries, now_ms, policy) {
        remove_snapshot(&all[idx].path)?;
        removed += 1;
    }
    Ok(removed)
}

/// Purge **all** of a note's snapshots (the permanent-delete path, SYNC-1).
/// Returns the count removed. Preserves cryptographic erase: after the note's
/// `.myn` is unlinked, its snapshots (sealed under the same now-unrecoverable
/// `item_key`) must not linger as orphan ciphertext.
pub fn remove_all_note_snapshots(snapshots_dir: &Path, note_uuid: &str) -> std::io::Result<usize> {
    let mut removed = 0usize;
    for f in list_note_snapshots(snapshots_dir, note_uuid)? {
        remove_snapshot(&f.path)?;
        removed += 1;
    }
    Ok(removed)
}

/// Best-effort: capture a snapshot of a note's pre-overwrite `.myn` blob
/// (MYND-96), gated by the coalescing window. A snapshot is a recovery
/// convenience, not part of the note write's integrity contract — so this
/// **never** fails the caller's update (SYNC-8); every failure is logged and
/// swallowed. `old_blob` is the verbatim `.myn` bytes about to be replaced;
/// `vault_root` is the parent of `notes/` (the flat `snapshots/` dir is its
/// sibling). Runs inside the caller's `spawn_blocking` + held slot read-guard,
/// before the live note is overwritten — so a failed snapshot cannot corrupt
/// the note. `force` bypasses the coalescing gate (on-close/lock flush, restore
/// undo point).
///
/// **Returns `true` if the snapshot could not be written** (dir-create or write
/// failure) — a non-blocking warning the caller surfaces to the frontend
/// (SYNC-8). Returns `false` on success or a coalesced skip. A prune failure is
/// NOT a warning (the snapshot itself already succeeded).
///
/// Lives in `myne-core` so both clients share one write-path: desktop and
/// mobile each install a `VaultLifecycleHooks` whose `capture_snapshot`
/// delegates here (see the desktop / mobile `hooks.rs`).
pub fn capture_snapshot_best_effort(
    vault_root: &Path,
    note_uuid: &str,
    old_blob: &[u8],
    now_ms: u64,
    force: bool,
) -> bool {
    // Semantics unchanged: `true` still means "could not write". The
    // uuid-returning sibling below is what the agent's run restore point needs,
    // and it exists so the two paths cannot drift into two capture rules.
    matches!(
        capture_snapshot_reporting_uuid(vault_root, note_uuid, old_blob, now_ms, force),
        CaptureOutcome::Failed
    )
}

/// What one capture attempt did.
///
/// [`capture_snapshot_best_effort`] collapses this to a bool for its existing
/// callers, whose contract is "did it fail". The agent's run restore point needs
/// the uuid as well, because a run reverts as one action and that means knowing
/// which snapshot per note to restore.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CaptureOutcome {
    /// Written. Carries the new snapshot's uuid.
    Captured(String),
    /// Skipped by the coalescing window. Not a failure.
    Coalesced,
    /// Could not be written.
    Failed,
}

/// [`capture_snapshot_best_effort`], reporting the snapshot uuid it wrote.
///
/// The agent apply path calls this with `force = true`: an agent run's restore
/// point may not be coalesced away, because the interface has told the user the
/// run can be undone and a skipped capture would make that false.
pub fn capture_snapshot_reporting_uuid(
    vault_root: &Path,
    note_uuid: &str,
    old_blob: &[u8],
    now_ms: u64,
    force: bool,
) -> CaptureOutcome {
    let sdir = match crate::paths::snapshots_dir_under(vault_root) {
        Ok(d) => d,
        Err(e) => {
            tracing::warn!(
                stage = "snapshot_mkdir",
                io_failure_kind = ?crate::io_failure_kind::from_io_error_kind(e.kind()),
                "snapshot dir create failed (best-effort; note save unaffected)"
            );
            return CaptureOutcome::Failed;
        }
    };
    let existing = list_note_snapshots(&sdir, note_uuid).unwrap_or_default();
    let last = existing.first().map(|s| s.captured_at_ms);
    if !crate::snapshot_policy::should_snapshot(last, now_ms, force) {
        tracing::debug!(
            stage = "snapshot_coalesced",
            "snapshot skipped: within window"
        );
        return CaptureOutcome::Coalesced;
    }
    let snap_uuid = new_snapshot_uuid().to_string();
    if let Err(e) = write_snapshot_blob(&sdir, note_uuid, &snap_uuid, old_blob) {
        tracing::warn!(
            stage = "snapshot_write",
            io_failure_kind = ?crate::io_failure_kind::from_io_error_kind(e.kind()),
            "snapshot write failed (best-effort; note save unaffected)"
        );
        return CaptureOutcome::Failed;
    }
    tracing::debug!(
        stage = "snapshot_created",
        "pre-overwrite snapshot captured"
    );

    // Eager prune (SYNC-2): enforce retention at the single write-path source of
    // truth, right after creating the snapshot. Best-effort; a prune failure is
    // not surfaced as a warning (the snapshot already landed).
    if let Err(e) = prune_note_snapshots(
        &sdir,
        note_uuid,
        now_ms,
        &crate::snapshot_policy::RetentionPolicy::default(),
    ) {
        tracing::warn!(
            stage = "snapshot_prune",
            io_failure_kind = ?crate::io_failure_kind::from_io_error_kind(e.kind()),
            "snapshot prune scan failed (best-effort; snapshot already written)"
        );
    }
    CaptureOutcome::Captured(snap_uuid)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::ScopedTempDir;
    use uuid::{NoContext, Timestamp};

    fn v7_at(secs: u64) -> Uuid {
        Uuid::new_v7(Timestamp::from_unix(NoContext, secs, 0))
    }

    #[test]
    fn filename_roundtrips() {
        let note = Uuid::now_v7().to_string();
        let snap = Uuid::now_v7().to_string();
        let name = snapshot_filename(&note, &snap);
        assert!(name.ends_with(".myn"));
        assert_eq!(parse_snapshot_filename(&name), Some((note, snap)));
    }

    #[test]
    fn parse_rejects_foreign_and_malformed_names() {
        assert!(parse_snapshot_filename("0184a2b3.myn").is_none()); // no separator
        assert!(parse_snapshot_filename("not-a-uuid__also-not.myn").is_none());
        assert!(
            parse_snapshot_filename(&format!("{}__{}.txt", Uuid::now_v7(), Uuid::now_v7()))
                .is_none()
        ); // wrong ext
           // a v4 uuid is rejected (snapshots are v7-only)
        let v4 = Uuid::new_v4().to_string();
        let v7 = Uuid::now_v7().to_string();
        assert!(parse_snapshot_filename(&format!("{v4}__{v7}.myn")).is_none());
    }

    #[test]
    fn captured_at_ms_reads_the_v7_clock() {
        let u = v7_at(1_700_000_000);
        assert_eq!(snapshot_captured_at_ms(&u), Some(1_700_000_000_000));
    }

    #[test]
    fn write_is_create_only() {
        let tmp = ScopedTempDir::new("snap-write").unwrap();
        let dir = tmp.path();
        let note = Uuid::now_v7().to_string();
        let snap = Uuid::now_v7().to_string();
        let path = write_snapshot_blob(dir, &note, &snap, b"MY01-blob-bytes").unwrap();
        assert_eq!(std::fs::read(&path).unwrap(), b"MY01-blob-bytes");
        // Second write to the same (note,snap) path is rejected (create-only).
        let err = write_snapshot_blob(dir, &note, &snap, b"other").unwrap_err();
        assert_eq!(err.kind(), std::io::ErrorKind::AlreadyExists);
        // Original bytes untouched.
        assert_eq!(std::fs::read(&path).unwrap(), b"MY01-blob-bytes");
    }

    #[test]
    fn list_is_newest_first_note_scoped_and_skips_foreign() {
        let tmp = ScopedTempDir::new("snap-list").unwrap();
        let dir = tmp.path();
        let note = Uuid::now_v7().to_string();
        let other_note = Uuid::now_v7().to_string();

        let s_old = v7_at(1_700_000_000).to_string();
        let s_mid = v7_at(1_700_000_100).to_string();
        let s_new = v7_at(1_700_000_200).to_string();
        // Write out of order to prove the sort, not insertion order.
        write_snapshot_blob(dir, &note, &s_mid, b"m").unwrap();
        write_snapshot_blob(dir, &note, &s_new, b"nnn").unwrap();
        write_snapshot_blob(dir, &note, &s_old, b"o").unwrap();
        // Another note's snapshot must not appear.
        write_snapshot_blob(dir, &other_note, &v7_at(1_700_000_500).to_string(), b"x").unwrap();
        // A foreign file is ignored.
        std::fs::write(dir.join("README.txt"), b"hi").unwrap();

        let list = list_note_snapshots(dir, &note).unwrap();
        assert_eq!(list.len(), 3);
        assert_eq!(list[0].snapshot_uuid, s_new);
        assert_eq!(list[1].snapshot_uuid, s_mid);
        assert_eq!(list[2].snapshot_uuid, s_old);
        assert_eq!(list[0].size_bytes, 3); // "nnn"
        assert_eq!(list[0].captured_at_ms, 1_700_000_200_000);
    }

    #[test]
    fn list_missing_dir_is_empty_not_error() {
        let tmp = ScopedTempDir::new("snap-empty").unwrap();
        let missing = tmp.path().join("snapshots-never-made");
        let note = Uuid::now_v7().to_string();
        assert!(list_note_snapshots(&missing, &note).unwrap().is_empty());
    }

    #[test]
    fn remove_is_idempotent() {
        let tmp = ScopedTempDir::new("snap-remove").unwrap();
        let dir = tmp.path();
        let note = Uuid::now_v7().to_string();
        let snap = Uuid::now_v7().to_string();
        let path = write_snapshot_blob(dir, &note, &snap, b"b").unwrap();
        remove_snapshot(&path).unwrap();
        assert!(!path.exists());
        // Removing again is Ok (idempotent).
        remove_snapshot(&path).unwrap();
    }

    #[test]
    fn remove_all_purges_only_the_target_note() {
        let tmp = ScopedTempDir::new("snap-purge").unwrap();
        let dir = tmp.path();
        let note = Uuid::now_v7().to_string();
        let keep = Uuid::now_v7().to_string();
        write_snapshot_blob(dir, &note, &Uuid::now_v7().to_string(), b"a").unwrap();
        write_snapshot_blob(dir, &note, &Uuid::now_v7().to_string(), b"b").unwrap();
        write_snapshot_blob(dir, &keep, &Uuid::now_v7().to_string(), b"c").unwrap();

        let removed = remove_all_note_snapshots(dir, &note).unwrap();
        assert_eq!(removed, 2);
        assert!(list_note_snapshots(dir, &note).unwrap().is_empty());
        // The other note's snapshot survives.
        assert_eq!(list_note_snapshots(dir, &keep).unwrap().len(), 1);
    }

    #[test]
    fn prune_removes_out_of_window_snapshots() {
        let tmp = ScopedTempDir::new("snap-prune").unwrap();
        let dir = tmp.path();
        let note = Uuid::now_v7().to_string();
        let now_secs = 1_700_000_000u64;
        let now_ms = now_secs * 1000;

        let old = v7_at(now_secs - 8 * 86_400).to_string(); // older than the 7-day window
        let recent1 = v7_at(now_secs - 3600).to_string();
        let recent2 = v7_at(now_secs - 60).to_string();
        write_snapshot_blob(dir, &note, &old, b"o").unwrap();
        write_snapshot_blob(dir, &note, &recent1, b"r1").unwrap();
        write_snapshot_blob(dir, &note, &recent2, b"r2").unwrap();

        let removed = prune_note_snapshots(
            dir,
            &note,
            now_ms,
            &crate::snapshot_policy::RetentionPolicy::default(),
        )
        .unwrap();
        assert_eq!(removed, 1, "the out-of-window snapshot must be pruned");

        let remaining: Vec<String> = list_note_snapshots(dir, &note)
            .unwrap()
            .into_iter()
            .map(|s| s.snapshot_uuid)
            .collect();
        assert_eq!(remaining, vec![recent2, recent1]); // newest-first, old gone
    }
}
