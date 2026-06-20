//! Sync orchestration — the production glue (MYND-424 R3) that drives the
//! [`super::engine`] primitives over a real transport against the **real local
//! vault**. The engine functions move bytes but have no production caller; this
//! module is that caller.
//!
//! [`run_sync_cycle`] ties one full cycle together:
//!   1. build the local `id → content_nonce` manifest from `<vault>/notes/`;
//!   2. `pull_to_stable` (client-side head MAC-verify + rollback rejection);
//!   3. for each changed remote blob, `download_blob` then write it to disk as
//!      `notes/<uuid>.myn` (the decisive "pulled note lands on disk" step);
//!   4. detect locally-changed notes (content_nonce ≠ last-synced), seal each as
//!      a [`PushBlob`] (the note's existing `.myn` bytes ARE the opaque
//!      ciphertext — no re-encryption), author a linear-advance vault head, and
//!      `push`;
//!   5. persist the advanced cursor + per-blob CAS state + the head baseline.
//!
//! Transport is blocking (`&dyn SyncTransport`); call this from
//! `spawn_blocking`. `vault_root` is where the device-local sync files live
//! (`sync-state.json`, `vault.head-state`); `notes_dir` is `<vault_root>/notes`.

use super::engine::{self, PullError, PushBlob, PushError};
use super::state::{
    read_head_baseline, read_sync_state, write_head_baseline, write_sync_state, BlobSyncState,
};
use super::transport::SyncTransport;
use protocol::{compute_manifest_hash, ManifestEntry, VaultHead, VvEntry, VAULT_HEAD_FORMAT_V1};
use std::collections::HashMap;
use std::path::Path;

/// What one sync cycle did (surfaced to the status indicator + tests).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct SyncSummary {
    /// Remote blobs downloaded + written to the local vault this cycle.
    pub pulled: usize,
    /// Local blobs pushed to the server this cycle.
    pub pushed: usize,
    /// True if a new vault head was authored + accepted.
    pub head_advanced: bool,
    /// The advanced pull cursor.
    pub cursor: u64,
}

/// Sync-cycle failures.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SyncCycleError {
    /// The pull leg failed (incl. `RollbackRejected` — malicious-server defence).
    Pull(PullError),
    /// The push leg failed (incl. `BlobStale` / `HeadStale` — retry next cycle).
    Push(PushError),
    /// A local filesystem error (read/write a `.myn`, read/write sync state).
    Io,
    /// Head authoring (manifest hash / seal) failed.
    Head,
}

fn hex(bytes: &[u8]) -> String {
    let mut s = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        s.push_str(&format!("{b:02x}"));
    }
    s
}

/// The `<vault>/notes/<uuid>.myn` path for a 16-byte blob id.
fn blob_path(notes_dir: &Path, id: &[u8; 16]) -> std::path::PathBuf {
    let uuid = uuid::Uuid::from_bytes(*id);
    notes_dir.join(format!("{uuid}.myn"))
}

/// The engine's `local` manifest (raw 16-byte id → 24-byte content_nonce), read
/// decryption-free from the on-disk notes dir. Converts the notes-domain
/// [`NonceManifest`](crate::search::persist::NonceManifest) String keys to the
/// raw uuid bytes the engine wants.
pub fn local_manifest(notes_dir: &Path) -> HashMap<[u8; 16], [u8; 24]> {
    let mut out = HashMap::new();
    for (id_str, nonce) in crate::plugins::notes::search_sync::scan_on_disk_manifest(notes_dir) {
        if let Ok(u) = uuid::Uuid::parse_str(&id_str) {
            out.insert(*u.as_bytes(), nonce);
        }
    }
    out
}

/// The manifest entries (sorted internally by `compute_manifest_hash`) that the
/// vault head commits as `manifest_hash`.
fn manifest_entries(local: &HashMap<[u8; 16], [u8; 24]>) -> Vec<ManifestEntry> {
    local
        .iter()
        .map(|(id, n)| ManifestEntry {
            id: *id,
            content_nonce: *n,
        })
        .collect()
}

/// Run one full sync cycle against the configured server. `account_number_hash`
/// and `device_id` are the 16-byte values captured at enrollment (the head binds
/// the account; the VV-actor is this device). Idempotent: a no-change cycle is a
/// cheap pull that writes nothing.
// The arguments are each a distinct, independent input to the cycle (the
// transport, the two keys/ids, the token, the two paths, the push gate); bundling
// them into a struct would not aid clarity at this single orchestrator entry.
#[allow(clippy::too_many_arguments)]
pub fn run_sync_cycle(
    transport: &dyn SyncTransport,
    root_key: &[u8; 32],
    account_number_hash: [u8; 16],
    device_id: [u8; 16],
    token: &str,
    notes_dir: &Path,
    vault_root: &Path,
    allow_push: bool,
) -> Result<SyncSummary, SyncCycleError> {
    let mut state = read_sync_state(vault_root).map_err(|_| SyncCycleError::Io)?;

    // Baseline VV + seq from the device-local head baseline (empty on first sync).
    let baseline_head = read_head_baseline(root_key, vault_root).ok().flatten();
    let baseline_vv: Vec<VvEntry> = baseline_head
        .as_ref()
        .map(|h| h.version_vector.clone())
        .unwrap_or_default();
    let baseline_seq = baseline_head.as_ref().map(|h| h.seq).unwrap_or(0);

    // --- PULL (head verify + rollback rejection happen inside) ---
    let local = local_manifest(notes_dir);
    let page = engine::pull_to_stable(
        transport,
        root_key,
        token,
        &baseline_vv,
        state.cursor,
        &local,
    )
    .map_err(SyncCycleError::Pull)?;

    // --- apply remote changes: download + write each changed blob to disk ---
    let mut pulled = 0;
    for c in &page.changed {
        let bytes = engine::download_blob(transport, token, &c.id).map_err(SyncCycleError::Pull)?;
        std::fs::create_dir_all(notes_dir).map_err(|_| SyncCycleError::Io)?;
        crate::atomic_write::atomic_write(&blob_path(notes_dir, &c.id), &bytes, true)
            .map_err(|_| SyncCycleError::Io)?;
        state.blobs.insert(
            hex(&c.id),
            BlobSyncState {
                version: c.version,
                content_nonce_hex: hex(&c.content_nonce),
            },
        );
        pulled += 1;
    }
    state.cursor = page.next_cursor;
    if let Some(vh) = &page.head {
        state.record_observation(&vh.head_id, &vh.head.version_vector);
    }

    // --- detect local changes to push (content_nonce ≠ last-synced) ---
    // Skipped on a poll-driven Pull (`allow_push=false`): pushes are coalesced
    // and fire only after the local-change window elapses (loop_control), so a
    // poll never opens a high-resolution edit-timing channel (resolution-blur).
    let local2 = local_manifest(notes_dir);
    let mut to_push: Vec<PushBlob> = Vec::new();
    if allow_push {
        for (id, nonce) in &local2 {
            let id_hex = hex(id);
            let nonce_hex = hex(nonce);
            let synced = state.blobs.get(&id_hex);
            if synced.map(|b| b.content_nonce_hex.as_str()) == Some(nonce_hex.as_str()) {
                continue; // already in sync
            }
            let ciphertext =
                std::fs::read(blob_path(notes_dir, id)).map_err(|_| SyncCycleError::Io)?;
            to_push.push(PushBlob {
                id: *id,
                base_version: synced.map(|b| b.version).unwrap_or(0),
                content_nonce: *nonce,
                ciphertext,
                tombstone: false,
            });
        }
    }

    let mut pushed = 0;
    let mut head_advanced = false;

    if !to_push.is_empty() {
        // Author a linear-advance head over the current (post-pull) head: bump
        // this device's VV component, seq+1, parent = the server's current head
        // (genesis = the zero prev the server's first-head CAS expects).
        let prev_head_id: [u8; 32] = page.head.as_ref().map(|h| h.head_id).unwrap_or([0u8; 32]);
        let base_vv: Vec<VvEntry> = page
            .head
            .as_ref()
            .map(|h| h.head.version_vector.clone())
            .unwrap_or(baseline_vv);
        let mut vv_map: HashMap<[u8; 16], u64> =
            base_vv.iter().map(|e| (e.device_id, e.counter)).collect();
        *vv_map.entry(device_id).or_insert(0) += 1;
        let version_vector: Vec<VvEntry> = vv_map
            .into_iter()
            .map(|(device_id, counter)| VvEntry { device_id, counter })
            .collect();
        let seq = page
            .head
            .as_ref()
            .map(|h| h.head.seq)
            .unwrap_or(baseline_seq)
            + 1;
        let prev_head_hash = if page.head.is_some() {
            vec![prev_head_id]
        } else {
            Vec::new()
        };
        let manifest_hash =
            compute_manifest_hash(&manifest_entries(&local2)).map_err(|_| SyncCycleError::Head)?;
        let head = VaultHead {
            head_format_version: VAULT_HEAD_FORMAT_V1,
            account_number_hash,
            manifest_hash,
            seq,
            prev_head_hash,
            version_vector: version_vector.clone(),
        };
        let sealed = head.seal(root_key).map_err(|_| SyncCycleError::Head)?;

        let outcome = engine::push(
            transport,
            token,
            &to_push,
            Some((&prev_head_id, &sealed.record)),
        )
        .map_err(SyncCycleError::Push)?;

        for (id, ver) in &outcome.results {
            if let Some(b) = to_push.iter().find(|b| &b.id == id) {
                state.blobs.insert(
                    hex(id),
                    BlobSyncState {
                        version: *ver,
                        content_nonce_hex: hex(&b.content_nonce),
                    },
                );
            }
        }
        pushed = outcome.results.len();
        head_advanced = outcome.head_id.is_some();
        write_head_baseline(vault_root, &sealed).map_err(|_| SyncCycleError::Io)?;
        state.record_observation(&sealed.head_id, &version_vector);
    } else if let Some(vh) = &page.head {
        // No local changes: adopt the pulled head as the new baseline (re-seal
        // the decoded head — deterministic, reproduces the same record/head_id).
        let sealed = vh.head.seal(root_key).map_err(|_| SyncCycleError::Head)?;
        write_head_baseline(vault_root, &sealed).map_err(|_| SyncCycleError::Io)?;
    }

    write_sync_state(vault_root, &state).map_err(|_| SyncCycleError::Io)?;
    Ok(SyncSummary {
        pulled,
        pushed,
        head_advanced,
        cursor: state.cursor,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::plugins::notes::note_id::NoteId;
    use crate::plugins::sync::enroll::{self, EnrollPath};
    use protocol::{decode_note, derive_subkey, encode_new_note, SubkeyRole};
    use std::path::PathBuf;
    use std::process::Child;

    /// Kills the spawned server on drop (so a panicking assert doesn't leak it).
    struct ServerGuard(Child);
    impl Drop for ServerGuard {
        fn drop(&mut self) {
            let _ = self.0.kill();
            let _ = self.0.wait();
        }
    }

    /// Resolve the `myne-server` binary (env override, else the built sibling).
    /// `None` → the binary isn't built; the caller self-skips (the E2E pattern).
    fn server_binary() -> Option<PathBuf> {
        if let Ok(p) = std::env::var("MYNE_E2E_SERVER") {
            let p = PathBuf::from(p);
            return p.exists().then_some(p);
        }
        // cargo test CWD = the crate dir (src-tauri/); the server is a sibling.
        let p = PathBuf::from("../myne-server/myne-server");
        p.exists().then_some(p)
    }

    /// Spawn an ephemeral in-memory server; return (guard, base_url). The
    /// portfile dir is unique per call (process id + a counter) so concurrent
    /// tests in the same process don't race on a shared portfile.
    fn spawn_server() -> Option<(ServerGuard, String)> {
        use std::sync::atomic::{AtomicU64, Ordering};
        static SEQ: AtomicU64 = AtomicU64::new(0);
        let bin = server_binary()?;
        let dir = std::env::temp_dir().join(format!(
            "myne-orch-test-{}-{}",
            std::process::id(),
            SEQ.fetch_add(1, Ordering::Relaxed)
        ));
        std::fs::create_dir_all(&dir).ok()?;
        let portfile = dir.join("port");
        let _ = std::fs::remove_file(&portfile);
        let child = std::process::Command::new(&bin)
            .env("MYNE_SERVER_ADDR", "127.0.0.1:0")
            .env("MYNE_SERVER_PORTFILE", &portfile)
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn()
            .ok()?;
        let guard = ServerGuard(child);
        // Read the OS-assigned port back race-free from the portfile.
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(8);
        let mut port = 0u16;
        while std::time::Instant::now() < deadline {
            if let Ok(s) = std::fs::read_to_string(&portfile) {
                if let Ok(p) = s.trim().parse::<u16>() {
                    if p > 0 {
                        port = p;
                        break;
                    }
                }
            }
            std::thread::sleep(std::time::Duration::from_millis(40));
        }
        if port == 0 {
            return None;
        }
        // Wait until the listener actually accepts.
        while std::time::Instant::now() < deadline {
            if std::net::TcpStream::connect(("127.0.0.1", port)).is_ok() {
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(40));
        }
        Some((guard, format!("http://127.0.0.1:{port}")))
    }

    fn hex32(b: &[u8]) -> String {
        let mut s = String::with_capacity(b.len() * 2);
        for x in b {
            s.push_str(&format!("{x:02x}"));
        }
        s
    }

    /// End-to-end proof: device A authors a note, pushes it through a real
    /// `myne-server` over loopback http, device B pulls it and it lands on B's
    /// disk decrypting to the same plaintext. Self-skips if the server binary
    /// isn't built (CI without the companion binary).
    #[test]
    fn two_devices_replicate_a_note() {
        let Some((_guard, url)) = spawn_server() else {
            eprintln!(
                "SKIP two_devices_replicate_a_note: myne-server binary not found \
                 (build: cd myne-server && go build -o myne-server ./cmd/myne-server, \
                 or set MYNE_E2E_SERVER)"
            );
            return;
        };

        // --- shared account crypto (both devices share root_key + items_key) ---
        let root_key = [0x42u8; 32];
        let account_hash = [0x7Au8; 16];
        let username = "MY-ORCH-TEST";
        let secret = derive_subkey(&root_key, SubkeyRole::ServerAuth);
        let items_key = [0x11u8; 32];
        let items_key_id = [0x22u8; 16];

        // Device A authors a real .myn note in its vault.
        let dir_a = std::env::temp_dir().join(format!("myne-orch-A-{}", std::process::id()));
        let dir_b = std::env::temp_dir().join(format!("myne-orch-B-{}", std::process::id()));
        let notes_a = dir_a.join("notes");
        let notes_b = dir_b.join("notes");
        std::fs::create_dir_all(&notes_a).unwrap();
        std::fs::create_dir_all(&notes_b).unwrap();

        let note = NoteId::new_v7();
        let note_bytes = *note.as_uuid().as_bytes();
        let plaintext = b"hello from device A";
        let blob = encode_new_note(&items_key, &items_key_id, &note_bytes, plaintext).unwrap();
        crate::atomic_write::atomic_write(
            &notes_a.join(format!("{}.myn", note.as_uuid())),
            &blob,
            false,
        )
        .unwrap();

        let ta = crate::plugins::sync::http_transport::build_transport(&url, Vec::new()).unwrap();
        let tb = crate::plugins::sync::http_transport::build_transport(&url, Vec::new()).unwrap();

        // Register the SCRAM verifier (idempotent) then enroll both devices.
        enroll::register_verifier(ta.as_ref(), &account_hash, username, secret.as_slice()).unwrap();

        let dev_a = enroll::generate_device_id();
        let out_a = enroll::enroll(
            ta.as_ref(),
            &account_hash,
            username,
            secret.as_slice(),
            EnrollPath::Recovery,
            "a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0",
            dev_a,
        )
        .unwrap();
        assert!(
            out_a.approved && !out_a.token.is_empty(),
            "device A enrolled"
        );
        let tok_a = hex32(&out_a.token);

        let dev_b = enroll::generate_device_id();
        let out_b = enroll::enroll(
            tb.as_ref(),
            &account_hash,
            username,
            secret.as_slice(),
            EnrollPath::Recovery,
            "b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1",
            dev_b,
        )
        .unwrap();
        assert!(
            out_b.approved && !out_b.token.is_empty(),
            "device B enrolled"
        );
        let tok_b = hex32(&out_b.token);

        // --- A pushes; B pulls ---
        let push = run_sync_cycle(
            ta.as_ref(),
            &root_key,
            account_hash,
            dev_a,
            &tok_a,
            &notes_a,
            &dir_a,
            true,
        )
        .expect("A sync cycle");
        assert_eq!(push.pushed, 1, "A pushed the note");
        assert!(push.head_advanced, "A advanced the head");

        let pull = run_sync_cycle(
            tb.as_ref(),
            &root_key,
            account_hash,
            dev_b,
            &tok_b,
            &notes_b,
            &dir_b,
            true,
        )
        .expect("B sync cycle");
        assert_eq!(pull.pulled, 1, "B pulled the note");

        // --- B's disk has the note, decrypting to the same plaintext ---
        let b_path = notes_b.join(format!("{}.myn", note.as_uuid()));
        assert!(b_path.exists(), "note materialized on device B");
        let b_blob = std::fs::read(&b_path).unwrap();
        let decrypted = decode_note(&b_blob, &note_bytes, &items_key, &items_key_id).unwrap();
        assert_eq!(
            decrypted.plaintext(),
            plaintext,
            "B decrypts A's note to the same plaintext"
        );

        std::fs::remove_dir_all(&dir_a).ok();
        std::fs::remove_dir_all(&dir_b).ok();
    }

    /// The "add this device" flow: device B joins an existing account by
    /// `{account# + password}` → server gates it **pending** (no token) → device
    /// A approves it → B re-runs the handshake and **claims its token** → B syncs
    /// and the owner's note lands on B. No recovery phrase. Self-skips without the
    /// server binary.
    #[test]
    fn password_device_join_pending_approve_claim_then_sync() {
        let Some((_guard, url)) = spawn_server() else {
            eprintln!("SKIP password_device_join_...: myne-server binary not found");
            return;
        };

        let root_key = [0x55u8; 32];
        let account_hash = [0x6Bu8; 16];
        let username = "MY-JOIN-TEST";
        let secret = derive_subkey(&root_key, SubkeyRole::ServerAuth);
        let items_key = [0x12u8; 32];
        let items_key_id = [0x34u8; 16];

        let dir_a = std::env::temp_dir().join(format!("myne-join-A-{}", std::process::id()));
        let dir_b = std::env::temp_dir().join(format!("myne-join-B-{}", std::process::id()));
        let notes_a = dir_a.join("notes");
        let notes_b = dir_b.join("notes");
        std::fs::create_dir_all(&notes_a).unwrap();
        std::fs::create_dir_all(&notes_b).unwrap();
        let mk =
            || crate::plugins::sync::http_transport::build_transport(&url, Vec::new()).unwrap();

        // Owner A: author a note, register the verifier, enroll (recovery →
        // self-approve), push.
        let note = NoteId::new_v7();
        let note_bytes = *note.as_uuid().as_bytes();
        let plaintext = b"note from the owner";
        let blob = encode_new_note(&items_key, &items_key_id, &note_bytes, plaintext).unwrap();
        crate::atomic_write::atomic_write(
            &notes_a.join(format!("{}.myn", note.as_uuid())),
            &blob,
            false,
        )
        .unwrap();
        let ta = mk();
        enroll::register_verifier(ta.as_ref(), &account_hash, username, secret.as_slice()).unwrap();
        let dev_a = enroll::generate_device_id();
        let out_a = enroll::enroll(
            ta.as_ref(),
            &account_hash,
            username,
            secret.as_slice(),
            EnrollPath::Recovery,
            "a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0",
            dev_a,
        )
        .unwrap();
        let tok_a = hex32(&out_a.token);
        run_sync_cycle(
            ta.as_ref(),
            &root_key,
            account_hash,
            dev_a,
            &tok_a,
            &notes_a,
            &dir_a,
            true,
        )
        .unwrap();

        // Device B joins via PASSWORD → the server gates it pending (no token).
        let dev_b = enroll::generate_device_id();
        let out_b = enroll::enroll(
            mk().as_ref(),
            &account_hash,
            username,
            secret.as_slice(),
            EnrollPath::Password,
            "b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1",
            dev_b,
        )
        .unwrap();
        assert!(!out_b.approved, "a password device starts pending");
        assert!(out_b.token.is_empty(), "a pending device has no token yet");

        // Owner A approves B.
        crate::plugins::sync::devices::approve_device(ta.as_ref(), &tok_a, &dev_b).unwrap();

        // B CLAIMS its token by re-running the handshake with the same device_id.
        let out_b2 = enroll::enroll(
            mk().as_ref(),
            &account_hash,
            username,
            secret.as_slice(),
            EnrollPath::Password,
            "b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2",
            dev_b,
        )
        .unwrap();
        assert!(
            out_b2.approved,
            "an approved device claims its token on re-enroll"
        );
        assert!(!out_b2.token.is_empty());
        let tok_b = hex32(&out_b2.token);

        // B syncs → the owner's note lands on B's disk, decrypting to the same text.
        let pull = run_sync_cycle(
            mk().as_ref(),
            &root_key,
            account_hash,
            dev_b,
            &tok_b,
            &notes_b,
            &dir_b,
            true,
        )
        .expect("B sync after join");
        assert_eq!(pull.pulled, 1, "B pulled the owner's note after joining");
        let b_path = notes_b.join(format!("{}.myn", note.as_uuid()));
        assert!(
            b_path.exists(),
            "the note materialized on the joined device"
        );
        let decrypted = decode_note(
            &std::fs::read(&b_path).unwrap(),
            &note_bytes,
            &items_key,
            &items_key_id,
        )
        .unwrap();
        assert_eq!(decrypted.plaintext(), plaintext);

        std::fs::remove_dir_all(&dir_a).ok();
        std::fs::remove_dir_all(&dir_b).ok();
    }
}
