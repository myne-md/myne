//! Device-local sync state (SYNC-12, MYND-424 task 4).
//!
//! Three things persist **device-local, never synced** (AS6/A13 — sync state
//! must not leak to the server):
//!
//! 1. **cursor** — the opaque server-issued pull cursor (SYNC-6); a `String`.
//! 2. **last-seen head baseline** — the `MYH1` `vault.head-state` blob
//!    (`protocol.md` §9.15) via `protocol::encode_head_state` /
//!    `decode_head_state` (re-verifies the head's own MAC under `root_key`).
//! 3. **VV-observation log** — the sequence of `(head_id, version_vector)` the
//!    device has seen, the input MYND-427 uses to decide re-convergence
//!    (concurrency) vs never-reconverge (fork). Bounded to the last
//!    [`MAX_VV_LOG`] observations.
//!
//! All three are device-local plaintext (the `registry.json` / `sync-config`
//! precedent): they carry no note plaintext or key material. Their contents —
//! cursors, `device_id`s, VV counters, `head_id`s — are already server-visible
//! (heads are wire-relayed), so device-local plaintext leaks nothing new and the
//! head baseline deliberately has no AEAD (the head carries only server-visible
//! metadata, §9.15). They live under the vault root but are **excluded from the
//! sync taxonomy** (enforced by MYND-426 task 3); the file names are listed in
//! [`DEVICE_LOCAL_SYNC_FILES`].
//!
//! The store is **disk-backed and stateless** — every read hits the file — so it
//! trivially survives lock/unlock (a fresh unlock just reloads from disk).

use super::config::SyncConfigError;
use protocol::{decode_head_state, SealedHead, VaultHead, VvEntry, DEVICE_ID_LEN, HEAD_ID_LEN};
use serde::{Deserialize, Serialize};
use std::path::Path;

/// Device-local sync-state file name (cursor + VV log), under the vault root.
pub const SYNC_STATE_FILE: &str = "sync-state.json";
/// Device-local `MYH1` head-baseline file name (`protocol.md` §9.15).
pub const HEAD_STATE_FILE: &str = "vault.head-state";

/// The device-local files this module owns — NONE may ever enter the sync
/// taxonomy (the allowlist MYND-426 enforces). Asserted by the test below and
/// referenced by 426's taxonomy guard.
pub const DEVICE_LOCAL_SYNC_FILES: &[&str] = &[SYNC_STATE_FILE, HEAD_STATE_FILE];

/// Upper bound on the VV-observation log (keeps the file small; 427 only needs
/// recent history to judge re-convergence).
pub const MAX_VV_LOG: usize = 256;

/// One persisted version-vector entry (`device_id` + counter), hex on disk.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct VvEntryDto {
    /// 16-byte VV-actor device_id, lowercase hex.
    pub device_id_hex: String,
    /// Authored-head counter for this device.
    pub counter: u64,
}

/// One observed head: its `head_id` and version vector at observation time.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct VvObservation {
    /// 32-byte head_id, lowercase hex.
    pub head_id_hex: String,
    /// The head's version vector at the time it was observed.
    pub version_vector: Vec<VvEntryDto>,
}

/// The last-synced state of one content blob (the per-blob CAS bookkeeping the
/// orchestrator needs): the server `version` (the push CAS base) and the
/// `content_nonce` that version carries (the change-detection discriminator).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct BlobSyncState {
    /// The server's opaque per-blob version (the next push's `base_version`).
    pub version: u64,
    /// The 24-byte `content_nonce` of that synced revision, lowercase hex.
    pub content_nonce_hex: String,
}

/// The device-local sync state persisted at `<vault_root>/sync-state.json`.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct SyncState {
    /// The server pull cursor (a monotonic `u64` change-seq high-water; the Go
    /// server's `next_cursor`). `0` = pull from the beginning / never pulled.
    #[serde(default)]
    pub cursor: u64,
    /// The bounded VV-observation log (oldest first).
    #[serde(default)]
    pub vv_log: Vec<VvObservation>,
    /// Per-blob CAS bookkeeping (`blob_id_hex` → last-synced version + nonce).
    /// Lets the orchestrator pick each push's `base_version` and detect which
    /// local notes changed since the last sync. Server-visible metadata only.
    #[serde(default)]
    pub blobs: std::collections::BTreeMap<String, BlobSyncState>,
    /// This device's 16-byte VV-actor `device_id` (lowercase hex), captured at
    /// enrollment so a later `sync_now` can author heads under the right actor.
    #[serde(default)]
    pub device_id_hex: Option<String>,
    /// The account's 16-byte `account_number_hash` (lowercase hex), captured at
    /// enrollment so head authoring binds the right account (the on-disk
    /// `vault.meta` hash is a different, 32-byte value).
    #[serde(default)]
    pub account_hash_hex: Option<String>,
    /// The canonical account-number display string — the SCRAM username. Captured
    /// at enrollment so a still-`pending` device can re-run the handshake to
    /// **claim its token** once an existing device approves it (no credential
    /// re-entry needed; the unlocked `root_key` re-derives the SCRAM secret).
    #[serde(default)]
    pub account_display: Option<String>,
}

impl SyncState {
    /// Append an observation, bounding the log to [`MAX_VV_LOG`] (drops oldest).
    /// Skips a no-op duplicate of the most recent observation.
    pub fn record_observation(&mut self, head_id: &[u8; HEAD_ID_LEN], vv: &[VvEntry]) {
        let obs = VvObservation {
            head_id_hex: hex(head_id),
            version_vector: vv
                .iter()
                .map(|e| VvEntryDto {
                    device_id_hex: hex(&e.device_id),
                    counter: e.counter,
                })
                .collect(),
        };
        if self.vv_log.last() == Some(&obs) {
            return;
        }
        self.vv_log.push(obs);
        if self.vv_log.len() > MAX_VV_LOG {
            let overflow = self.vv_log.len() - MAX_VV_LOG;
            self.vv_log.drain(0..overflow);
        }
    }
}

use super::to_hex as hex;

/// Read `<dir>/sync-state.json`. Absent → default (no cursor, empty log).
pub fn read_sync_state(dir: &Path) -> Result<SyncState, SyncConfigError> {
    let path = dir.join(SYNC_STATE_FILE);
    match std::fs::read(&path) {
        Ok(bytes) => serde_json::from_slice(&bytes).map_err(|_| SyncConfigError::Parse),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(SyncState::default()),
        Err(e) => Err(e.into()),
    }
}

/// Remove the device-local sync baseline files (`sync-state.json` + `vault.head-state`)
/// for a vault — the "reset sync on this device" primitive. Idempotent (absent files
/// are fine). NEVER touches `notes/`, attachments, or `vault.meta`: it only drops the
/// device-local sync bookkeeping so the vault returns to a clean unsynced state and the
/// next sync re-bootstraps the baseline (BootstrapTofu) from the server.
pub fn clear_device_local_sync(dir: &Path) -> Result<(), SyncConfigError> {
    for f in DEVICE_LOCAL_SYNC_FILES {
        match std::fs::remove_file(dir.join(f)) {
            Ok(()) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => return Err(e.into()),
        }
    }
    // Also drop the orchestrator-owned device-local sync artifacts so a reset is a
    // genuinely clean slate — else stale deletion intent and stale conflict copies
    // (keyed to the OLD enrollment's baseline) survive into the next sync cycle after
    // re-enroll. Names mirror orchestrator.rs (`pending-tombstones` file + `conflicts/`
    // staging dir); neither holds note plaintext.
    match std::fs::remove_file(dir.join("pending-tombstones")) {
        Ok(()) => {}
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => return Err(e.into()),
    }
    match std::fs::remove_dir_all(dir.join("conflicts")) {
        Ok(()) => {}
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => return Err(e.into()),
    }
    Ok(())
}

/// Persist the sync state to `<dir>/sync-state.json` (atomic replace).
pub fn write_sync_state(dir: &Path, state: &SyncState) -> Result<(), SyncConfigError> {
    let path = dir.join(SYNC_STATE_FILE);
    let bytes = serde_json::to_vec_pretty(state).map_err(|_| SyncConfigError::Parse)?;
    crate::atomic_write::atomic_write(&path, &bytes, true)?;
    Ok(())
}

/// Persist the last-seen head baseline to `<dir>/vault.head-state` as `MYH1`
/// (atomic replace). The caller seals the head (`VaultHead::seal`) first.
pub fn write_head_baseline(dir: &Path, sealed: &SealedHead) -> Result<(), SyncConfigError> {
    let path = dir.join(HEAD_STATE_FILE);
    let blob = protocol::encode_head_state(sealed, protocol::VAULT_HEAD_FORMAT_V1);
    crate::atomic_write::atomic_write(&path, &blob, true)?;
    Ok(())
}

/// Read + verify the device-local head baseline. Absent → `Ok(None)`. A present
/// blob is MAC-re-verified under `root_key`; a tamper / wrong-key blob is an
/// error (the server cannot have written a valid one).
pub fn read_head_baseline(
    root_key: &[u8; 32],
    dir: &Path,
) -> Result<Option<VaultHead>, HeadBaselineError> {
    let path = dir.join(HEAD_STATE_FILE);
    match std::fs::read(&path) {
        Ok(blob) => decode_head_state(root_key, &blob)
            .map(Some)
            .map_err(|_| HeadBaselineError::Invalid),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(_) => Err(HeadBaselineError::Io),
    }
}

/// Failure surface for the head-baseline read (kept separate from
/// [`SyncConfigError`] because the MAC-verify failure is its own class).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "kind")]
pub enum HeadBaselineError {
    /// Filesystem error reading the baseline.
    Io,
    /// Magic / version / MAC verification failed (not a head this device sealed).
    Invalid,
}

// Re-exported lengths so callers don't import them twice.
const _: () = assert!(DEVICE_ID_LEN == 16);
const _: () = assert!(HEAD_ID_LEN == 32);

#[cfg(test)]
mod tests {
    use super::*;
    use protocol::VAULT_HEAD_FORMAT_V1;

    fn tmpdir(tag: &str) -> std::path::PathBuf {
        let d = std::env::temp_dir().join(format!("myne-syncstate-{}-{}", tag, std::process::id()));
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    fn sample_head(root_key: &[u8; 32], counter: u64) -> SealedHead {
        VaultHead {
            head_format_version: VAULT_HEAD_FORMAT_V1,
            account_number_hash: [0x33; 16],
            manifest_hash: [0x55; 32],
            seq: counter,
            prev_head_hash: Vec::new(),
            version_vector: vec![VvEntry {
                device_id: [0xA1; DEVICE_ID_LEN],
                counter,
            }],
        }
        .seal(root_key)
        .unwrap()
    }

    #[test]
    fn sync_state_roundtrip_and_absent_default() {
        let dir = tmpdir("rt");
        assert_eq!(read_sync_state(&dir).unwrap(), SyncState::default());

        let mut st = SyncState {
            cursor: 42,
            vv_log: Vec::new(),
            ..SyncState::default()
        };
        st.record_observation(
            &[0x01; 32],
            &[VvEntry {
                device_id: [0xA1; 16],
                counter: 1,
            }],
        );
        write_sync_state(&dir, &st).unwrap();
        assert_eq!(read_sync_state(&dir).unwrap(), st);

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn vv_log_dedups_and_bounds() {
        let mut st = SyncState::default();
        let vv = [VvEntry {
            device_id: [0xA1; 16],
            counter: 1,
        }];
        st.record_observation(&[0x01; 32], &vv);
        st.record_observation(&[0x01; 32], &vv); // duplicate → skipped
        assert_eq!(st.vv_log.len(), 1);

        for i in 0..(MAX_VV_LOG + 10) as u64 {
            let mut id = [0u8; 32];
            id[..8].copy_from_slice(&i.to_be_bytes());
            st.record_observation(
                &id,
                &[VvEntry {
                    device_id: [0xA1; 16],
                    counter: i + 2,
                }],
            );
        }
        assert_eq!(st.vv_log.len(), MAX_VV_LOG);
    }

    #[test]
    fn head_baseline_roundtrip_and_wrong_key_rejected() {
        let dir = tmpdir("hb");
        let root = [0x42u8; 32];
        let other = [0x43u8; 32];

        assert_eq!(read_head_baseline(&root, &dir).unwrap(), None);

        let sealed = sample_head(&root, 7);
        write_head_baseline(&dir, &sealed).unwrap();

        let loaded = read_head_baseline(&root, &dir).unwrap().unwrap();
        assert_eq!(loaded.seq, 7);
        assert_eq!(loaded.version_vector[0].counter, 7);

        // Wrong root_key → MAC re-verify fails.
        assert_eq!(
            read_head_baseline(&other, &dir),
            Err(HeadBaselineError::Invalid)
        );

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn device_local_files_are_not_sync_candidates() {
        // The baseline + state files must never appear in the sync content set.
        // The synced content blobs are .myn notes + attachments/<id> + the
        // singleton vault.* blobs; none of these names collide with ours.
        for f in DEVICE_LOCAL_SYNC_FILES {
            assert!(!f.ends_with(".myn"), "{f} must not look like a note blob");
            assert!(
                *f == SYNC_STATE_FILE || *f == HEAD_STATE_FILE,
                "unexpected device-local file {f}"
            );
        }
    }

    #[test]
    fn clear_device_local_sync_removes_all_sync_artifacts_keeps_notes() {
        let dir = std::env::temp_dir().join(format!("myne-clearsync-{}", std::process::id()));
        std::fs::create_dir_all(dir.join("conflicts")).unwrap();
        std::fs::create_dir_all(dir.join("notes")).unwrap();
        // Every device-local sync artifact a reset must clear.
        for f in DEVICE_LOCAL_SYNC_FILES {
            std::fs::write(dir.join(f), b"x").unwrap();
        }
        std::fs::write(dir.join("pending-tombstones"), b"id1\nid2").unwrap();
        std::fs::write(dir.join("conflicts").join("abc.myn"), b"staged").unwrap();
        // User data the reset must NEVER touch.
        std::fs::write(dir.join("notes").join("keep.myn"), b"note").unwrap();
        std::fs::write(dir.join("vault.meta"), b"meta").unwrap();

        clear_device_local_sync(&dir).unwrap();

        for f in DEVICE_LOCAL_SYNC_FILES {
            assert!(!dir.join(f).exists(), "{f} must be removed by reset");
        }
        assert!(
            !dir.join("pending-tombstones").exists(),
            "pending-tombstones queue must be cleared (else stale deletion intent survives)"
        );
        assert!(
            !dir.join("conflicts").exists(),
            "conflicts/ staging dir must be cleared (else stale conflict copies survive)"
        );
        assert!(
            dir.join("notes").join("keep.myn").exists(),
            "reset must NEVER touch notes"
        );
        assert!(
            dir.join("vault.meta").exists(),
            "reset must NEVER touch vault.meta"
        );
        // Idempotent on already-absent artifacts.
        clear_device_local_sync(&dir).unwrap();
        std::fs::remove_dir_all(&dir).ok();
    }
}
