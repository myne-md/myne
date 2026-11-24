// SPDX-License-Identifier: AGPL-3.0-only
/// The enrollment seed withholds the consent and the AI switch, and nothing
/// else.
///
/// Both directions, because the first half alone passes against a function
/// that clears the whole view: what a seed is FOR is adopting the server's
/// preferences, so a carve-out that took more than its two fields would be a
/// different defect wearing this one's fix.
#[test]
fn the_enrollment_seed_withholds_exactly_two_fields() {
    let mut seeded = protocol::PrefsView {
        ai_provider_consent: Some("openrouter".into()),
        ai_enabled: true,
        ai_provider: Some("openrouter".into()),
        daily_folder: Some("Daily/".into()),
        ..Default::default()
    };

    withhold_from_enrollment_seed(&mut seeded);

    assert_eq!(
        seeded.ai_provider_consent, None,
        "an inherited consent is a device sending before anyone at it saw the screen"
    );
    assert!(!seeded.ai_enabled, "the other half of the same gate");
    assert_eq!(
        seeded.ai_provider,
        Some("openrouter".into()),
        "the provider is adopted: naming one is not permission to send to it"
    );
    assert_eq!(
        seeded.daily_folder,
        Some("Daily/".into()),
        "every other preference is adopted, which is what a seed is for"
    );
}
use super::*;
use crate::plugins::notes::note_id::NoteId;
use crate::plugins::sync::enroll::{self, EnrollPath};
use crate::plugins::sync::transport::{
    HttpMethod, TransportError, TransportResponse, BLOB_BATCH_PATH,
};
use protocol::{decode_note, encode_new_note};
use std::path::PathBuf;
use std::process::Child;

// ── the storage seam, filled in for this module's tests ─────────────────
//
// Task 86 made `run_sync_cycle`, `sync_meta_phase`, `resolve_conflict` and
// every sidecar reader/writer take `io: &dyn VaultIo` and become `async`
// (the seam is async because OPFS handle acquisition is). The shims below
// shadow them with the OLD synchronous signatures and supply the real
// `StdVaultIo`, so ~150 call sites across these scenarios read unchanged.
//
// Shims, not fakes: each drives the production function against a real temp
// vault. A stub `VaultIo` would only have proved the signatures compile —
// and these are the tests that pin the CAS, cursor and conflict behaviour.
const IO: crate::vault_io::StdVaultIo = crate::vault_io::StdVaultIo;

fn blocking<F: std::future::Future>(f: F) -> F::Output {
    crate::test_support::block_on(f)
}

// The seam-taking helpers, shadowed with their pre-task-86 signatures so the
// scenarios below read unchanged.
fn list_pending_conflicts(vault_root: &Path) -> Vec<String> {
    blocking(super::list_pending_conflicts(&IO, vault_root))
}
#[allow(dead_code)]
fn read_staged_conflict_blob(vault_root: &Path, id_hex: &str) -> Option<Vec<u8>> {
    blocking(super::read_staged_conflict_blob(&IO, vault_root, id_hex))
}
fn add_pending_tombstone(vault_root: &Path, id_hex: &str) -> Result<(), SyncCycleError> {
    blocking(super::add_pending_tombstone(&IO, vault_root, id_hex))
}
#[allow(dead_code)]
fn add_pending_attachment_tombstone(
    vault_root: &Path,
    id: &[u8; 32],
) -> Result<(), SyncCycleError> {
    blocking(super::add_pending_attachment_tombstone(&IO, vault_root, id))
}
fn read_pending_tombstones(vault_root: &Path) -> std::collections::HashSet<String> {
    blocking(super::read_pending_tombstones(&IO, vault_root))
}
#[allow(dead_code)]
fn write_pending_tombstones(
    vault_root: &Path,
    set: &std::collections::HashSet<String>,
) -> Result<(), SyncCycleError> {
    blocking(super::write_pending_tombstones(&IO, vault_root, set))
}
fn read_pending_attachment_tombstones(vault_root: &Path) -> Vec<PendingAttachmentTombstone> {
    blocking(super::read_pending_attachment_tombstones(&IO, vault_root))
}
#[allow(dead_code)]
fn stage_conflict(
    vault_root: &Path,
    id: &[u8; 16],
    server_version: u64,
    remote_nonce: &[u8; 24],
    ciphertext: &[u8],
) -> Result<(), SyncCycleError> {
    blocking(super::stage_conflict(
        &IO,
        vault_root,
        id,
        server_version,
        remote_nonce,
        ciphertext,
    ))
}
#[allow(dead_code)]
fn quarantine_note(
    vault_root: &Path,
    notes_dir: &Path,
    id: &[u8; 16],
) -> Result<(), SyncCycleError> {
    blocking(super::quarantine_note(&IO, vault_root, notes_dir, id))
}

fn read_sync_state(dir: &Path) -> Result<SyncState, super::super::config::SyncConfigError> {
    blocking(super::read_sync_state(&IO, dir))
}
fn write_sync_state(
    dir: &Path,
    state: &SyncState,
) -> Result<(), super::super::config::SyncConfigError> {
    // Named by its own path rather than through `super::` on purpose: the orchestrator
    // no longer imports the unlocked writer, because every production write goes through
    // `update_sync_state` / `persist_cycle_state` now (myne-md/myne#964). A fixture still
    // needs to lay a state file down, and this is the function that does it.
    blocking(crate::plugins::sync::state::write_sync_state(
        &IO, dir, state,
    ))
}
#[allow(dead_code)]
fn resolve_conflict(vault_root: &Path, id_hex: &str) -> Result<(), SyncCycleError> {
    blocking(super::resolve_conflict(&IO, vault_root, id_hex))
}

/// The pre-MYND-468 cycle shape — a note-only cycle (no attachment keys).
/// The existing note-sync scenarios pin note behavior in isolation;
/// attachment-aware scenarios call `run_sync_cycle` with `Some(keys)`.
#[allow(clippy::too_many_arguments)]
fn run_cycle_legacy(
    transport: &dyn SyncTransport,
    root_key: &[u8; 32],
    account_number_hash: [u8; 16],
    device_id: [u8; 16],
    token: &str,
    notes_dir: &Path,
    vault_root: &Path,
    // Still a bool here, and converted below. The ~80 existing scenarios say
    // "this is a push cycle" / "this is a poll cycle" and mean exactly that;
    // rewriting each to name a `PushGate` would be churn with no reader
    // benefit. The gate's third state (`VerifyHold`) is exercised by its own
    // tests, which call `run_sync_cycle` directly.
    allow_push: bool,
) -> Result<SyncSummary, SyncCycleError> {
    blocking(run_sync_cycle(
        &IO,
        transport,
        Some(root_key),
        &SharedSingletonKey::OwnerRoot(zeroize::Zeroizing::new(*root_key)),
        account_number_hash,
        device_id,
        token,
        notes_dir,
        vault_root,
        if allow_push {
            PushGate::Allowed
        } else {
            PushGate::PollOnly
        },
        MetaVersion::V0_1,
        None,
        None,
        &std::collections::HashSet::new(),
    ))
}

/// A transport that relays everything to a wrapped real transport EXCEPT it
/// fails every `/sync/blob` download with a 500, so the note-body download loop
/// cannot complete. Used to prove the join SAS head observation is recorded +
/// persisted before that loop (`join_head_fingerprint_persists_before_blob_download`).
struct FailBlobTransport {
    inner: Box<dyn SyncTransport>,
}
impl SyncTransport for FailBlobTransport {
    fn request(
        &self,
        method: HttpMethod,
        path: &str,
        body: &[u8],
        token: Option<&str>,
    ) -> Result<TransportResponse, TransportError> {
        // BOTH blob-download routes: the single one and the batch one
        // (myne-md/myne#240). Spelled out rather than left as a
        // `starts_with("/sync/blob")` prefix, which happens to catch both
        // but reads as if it only meant the single route — the same
        // accident that nearly disarmed `NonceCorruptingTransport`.
        if path.starts_with("/sync/blob?") || path == BLOB_BATCH_PATH {
            return Ok(TransportResponse {
                status: 500,
                body: Vec::new(),
            });
        }
        self.inner.request(method, path, body, token)
    }
}

/// Relays to a real transport while watching the `/sync/push` stream: records
/// one entry per push saying whether it carried a `new_head` (the wire field is
/// `skip_serializing_if = "Option::is_none"`, so its mere presence in the body
/// is the answer), and optionally kills the Nth push (1-based) with a
/// `TransportError::Network` — the shape a socket deadline produces mid-request,
/// which is the myne-md/myne#222 failure.
struct PushObserver {
    inner: Box<dyn SyncTransport>,
    /// One `carried_head` flag per observed push, in order.
    pushes: std::sync::Mutex<Vec<bool>>,
    /// 1-based index of the push to fail, if any.
    fail_nth: Option<usize>,
}
impl PushObserver {
    fn new(inner: Box<dyn SyncTransport>, fail_nth: Option<usize>) -> Self {
        Self {
            inner,
            pushes: std::sync::Mutex::new(Vec::new()),
            fail_nth,
        }
    }
    /// `(number of pushes, which of them carried the head)`.
    fn pushes(&self) -> Vec<bool> {
        self.pushes.lock().unwrap().clone()
    }
}
impl SyncTransport for PushObserver {
    fn request(
        &self,
        method: HttpMethod,
        path: &str,
        body: &[u8],
        token: Option<&str>,
    ) -> Result<TransportResponse, TransportError> {
        if path == "/sync/push" {
            let n = {
                let mut seen = self.pushes.lock().unwrap();
                let carried_head = body
                    .windows(b"\"new_head\"".len())
                    .any(|w| w == b"\"new_head\"");
                seen.push(carried_head);
                seen.len()
            };
            if self.fail_nth == Some(n) {
                return Err(TransportError::Network);
            }
        }
        self.inner.request(method, path, body, token)
    }
}

/// Relays to a real transport while watching the blob-download stream: counts
/// batch vs single-blob requests, the ids each batch asked for, and the 429s
/// the server actually returned.
///
/// The 429 count is the discriminating number for myne#240 and it is only
/// observable HERE. `download_blob_backoff` swallows 429s in-cycle, so the
/// pull loop reports success either way and `FailureClass::RateLimited` never
/// fires — the acceptance criterion as originally filed was already green.
/// What the change actually buys is the request count, and therefore the wall
/// clock, which is what this decorator measures.
struct PullObserver {
    inner: Box<dyn SyncTransport>,
    batches: std::sync::Mutex<Vec<usize>>,
    singles: std::sync::atomic::AtomicUsize,
    rate_limited: std::sync::atomic::AtomicUsize,
}
impl PullObserver {
    fn new(inner: Box<dyn SyncTransport>) -> Self {
        Self {
            inner,
            batches: std::sync::Mutex::new(Vec::new()),
            singles: std::sync::atomic::AtomicUsize::new(0),
            rate_limited: std::sync::atomic::AtomicUsize::new(0),
        }
    }
    /// How many ids each `POST /sync/blobs` asked for, in order.
    fn ids_per_batch(&self) -> Vec<usize> {
        self.batches.lock().unwrap().clone()
    }
    fn single_count(&self) -> usize {
        self.singles.load(std::sync::atomic::Ordering::Relaxed)
    }
    fn rate_limited(&self) -> usize {
        self.rate_limited.load(std::sync::atomic::Ordering::Relaxed)
    }
}
impl SyncTransport for PullObserver {
    fn request(
        &self,
        method: HttpMethod,
        path: &str,
        body: &[u8],
        token: Option<&str>,
    ) -> Result<TransportResponse, TransportError> {
        if path == BLOB_BATCH_PATH {
            // The body is this client's own serialization, so parsing it back
            // is safe here in a way PushObserver's byte-scan was not.
            let n = serde_json::from_slice::<serde_json::Value>(body)
                .ok()
                .and_then(|v| v["blob_ids_hex"].as_array().map(|a| a.len()))
                .unwrap_or(0);
            self.batches.lock().unwrap().push(n);
        } else if path.starts_with("/sync/blob?") {
            self.singles
                .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        }
        let resp = self.inner.request(method, path, body, token)?;
        if resp.status == 429 {
            self.rate_limited
                .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        }
        Ok(resp)
    }
}

/// Kills the spawned server on drop (so a panicking assert doesn't leak it).
struct ServerGuard(Child);
impl Drop for ServerGuard {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

/// Resolve the `myne-server` binary (env override, else the built sibling).
///
/// `None` → the binary isn't built and the caller self-skips — **unless
/// this run asked for real fixtures**, in which case a missing binary is a
/// panic naming it.
///
/// **The failure mode that gate exists to prevent.** Every caller does
/// `let Some(..) = spawn_server() else { eprintln!("SKIP …"); return; }`,
/// and a Rust test that returns early **passes**. So the 25 server-backed
/// tests in this file printed one line and reported `ok` on every machine
/// and every CI run without the binary — indistinguishable, in the summary
/// and in the exit code, from having actually run. A green line that
/// asserted nothing is worse than a red one, and this cost a real
/// misdiagnosis: a HEAD baseline taken to decide whether a branch had
/// broken `attachment_readd_after_delete_revives` came back green because
/// the worktree had no server, and the bug was already on develop
/// (myne-md/myne#425).
///
/// Same shape, and the same fix, as `engine_candle.rs::required_test_env`.
/// Opt-in rather than default: a contributor who has not built the
/// companion server should still get "skipped".
fn server_binary() -> Option<PathBuf> {
    let found = if let Ok(p) = std::env::var("MYNE_E2E_SERVER") {
        let p = PathBuf::from(p);
        p.exists().then_some(p)
    } else {
        // cargo test CWD = the crate dir; the server is a sibling.
        let p = PathBuf::from("../myne-server/myne-server");
        p.exists().then_some(p)
    };
    assert!(
            found.is_some() || !crate::plugins::sync::test_fixtures::required("MYNE_TEST_REQUIRE_SERVER"),
            "MYNE_TEST_REQUIRE_SERVER=1 (or MYNE_TEST_REQUIRE_FIXTURES=1) was set, but the \
             myne-server binary is not built — this run was asked to exercise the real server \
             and cannot. Build it with `cd myne-server && go build -o myne-server ./cmd/myne-server`, \
             or point MYNE_E2E_SERVER at one."
        );
    found
}

/// Spawn an ephemeral in-memory server; return (guard, base_url). The
/// portfile dir is unique per call (process id + a counter) so concurrent
/// tests in the same process don't race on a shared portfile.
fn spawn_server() -> Option<(ServerGuard, String)> {
    // Integration tests exercise sync correctness, not abuse throttling — lift
    // the per-account rate limit so a multi-hundred-blob cycle isn't confounded
    // by 429s. The rate-limit backoff test overrides with a low burst.
    spawn_server_env("1000000", "1000000")
}

fn spawn_server_env(burst: &str, refill: &str) -> Option<(ServerGuard, String)> {
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
        .env("MYNE_RATELIMIT_BURST", burst)
        .env("MYNE_RATELIMIT_REFILL", refill)
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
        // `server_binary` floors a MISSING binary; this floors a binary that
        // was found and did not come up. Without it a port-file timeout under
        // load returns `None`, every caller's `else` arm prints SKIP, and the
        // run is green having asserted nothing — the myne-md/myne#425 shape
        // the sync-sim step's own comment records, reached by a different
        // route. It matters more since myne-md/myne#638 put the four
        // migrated-vault scenarios in that step.
        assert!(
            !crate::plugins::sync::test_fixtures::required("MYNE_TEST_REQUIRE_SERVER"),
            "MYNE_TEST_REQUIRE_SERVER=1 was set and the myne-server binary was found, \
                 but it did not report a port within the deadline. This run was asked to \
                 exercise the real server and cannot."
        );
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

/// Drift lock for the three singleton discriminators: each one must be
/// bound to BOTH of its `protocol` §10.3 registry constants, and must
/// refuse a sibling family's magic in either generation. A re-typed literal that stopped matching would
/// not error — `read_singleton_nonce` returns `None`, the blob reads as
/// unchanged, and the family silently stops syncing. Nothing else in the
/// tree compares these bytes against anything but themselves.
#[test]
fn singleton_discriminators_are_bound_to_the_registry_constants() {
    const NONCE: [u8; 24] = [0x7Au8; 24];

    // A 30-byte envelope head: 4-byte magic, 2 filler, then the nonce.
    fn envelope(magic: &[u8; 4]) -> Vec<u8> {
        let mut b = Vec::with_capacity(30);
        b.extend_from_slice(magic);
        b.extend_from_slice(&[0x00, 0x00]);
        b.extend_from_slice(&NONCE);
        b
    }

    // Each reader accepts BOTH of its own family's registry magics. The
    // v0.2 half is the half a migrated vault actually carries, and before
    // myne-md/myne#638 this lock covered only v0.1, which is how the same
    // defect one family over went unnoticed.
    assert_eq!(
        read_catalog_nonce(&envelope(&CATALOG_BLOB_MAGIC)),
        Some(NONCE)
    );
    assert_eq!(
        read_catalog_nonce(&envelope(&CATALOG_BLOB_V0_2_MAGIC)),
        Some(NONCE)
    );
    assert_eq!(read_prefs_nonce(&envelope(&PREFS_BLOB_MAGIC)), Some(NONCE));
    assert_eq!(
        read_prefs_nonce(&envelope(&PREFS_BLOB_V0_2_MAGIC)),
        Some(NONCE)
    );
    assert_eq!(
        read_themes_nonce(&envelope(&THEMES_BLOB_MAGIC)),
        Some(NONCE)
    );
    assert_eq!(
        read_themes_nonce(&envelope(&THEMES_BLOB_V0_2_MAGIC)),
        Some(NONCE)
    );

    // … and refuses every sibling family's, so a copy-paste that swapped
    // two of them fails here instead of quietly halting one family's sync.
    assert_eq!(read_catalog_nonce(&envelope(&PREFS_BLOB_MAGIC)), None);
    assert_eq!(read_catalog_nonce(&envelope(&THEMES_BLOB_MAGIC)), None);
    assert_eq!(read_prefs_nonce(&envelope(&CATALOG_BLOB_MAGIC)), None);
    assert_eq!(read_prefs_nonce(&envelope(&THEMES_BLOB_MAGIC)), None);
    assert_eq!(read_themes_nonce(&envelope(&CATALOG_BLOB_MAGIC)), None);
    assert_eq!(read_themes_nonce(&envelope(&PREFS_BLOB_MAGIC)), None);
    // The same, across generations: a v0.2 magic must not open a sibling
    // family's reader either.
    assert_eq!(read_catalog_nonce(&envelope(&PREFS_BLOB_V0_2_MAGIC)), None);
    assert_eq!(read_prefs_nonce(&envelope(&THEMES_BLOB_V0_2_MAGIC)), None);
    assert_eq!(read_themes_nonce(&envelope(&CATALOG_BLOB_V0_2_MAGIC)), None);

    // Short of the 30-byte nonce window: no partial read.
    let short = envelope(&CATALOG_BLOB_MAGIC);
    assert_eq!(read_catalog_nonce(&short[..29]), None);

    // The registry values themselves, spelled out once here so a change to
    // a §10.3 magic fails a test rather than silently re-keying a family.
    assert_eq!(&CATALOG_BLOB_MAGIC, b"MYC1");
    assert_eq!(&PREFS_BLOB_MAGIC, b"MYP1");
    assert_eq!(&THEMES_BLOB_MAGIC, b"MYT1");
    assert_eq!(&CATALOG_BLOB_V0_2_MAGIC, b"MYC5");
    assert_eq!(&PREFS_BLOB_V0_2_MAGIC, b"MYP5");
    assert_eq!(&THEMES_BLOB_V0_2_MAGIC, b"MYT5");
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

    let ta = crate::plugins::sync::http_transport::build_transport(&url).unwrap();
    let tb = crate::plugins::sync::http_transport::build_transport(&url).unwrap();

    // Register the SCRAM verifier (idempotent) then enroll both devices.
    enroll::register_verifier(ta.as_ref(), &account_hash, secret.as_slice()).unwrap();

    let dev_a = enroll::generate_device_id();
    let out_a = enroll::enroll(
        ta.as_ref(),
        &account_hash,
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
    let push = run_cycle_legacy(
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

    let pull = run_cycle_legacy(
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
    // …and SAYS WHICH ONE (myne#305). The orchestrator holds no `Hooks`, so
    // this list is the only way the cycle boundary can put a pulled note
    // into the full-text index. An empty list here is the bug's shape: the
    // note lands on disk, nothing indexes it, and the next persist certifies
    // it as covered — permanently unsearchable across restarts.
    assert_eq!(
        pull.pulled_note_ids,
        vec![note.as_uuid().to_string()],
        "the cycle must report the id it wrote, not just a count"
    );

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

/// A transport that relays to a real server but swaps every `/sync/blob`
/// ciphertext for a decoy blob whose header nonce does NOT match the wire
/// record — the hostile/buggy-server shape the §11.3 pre-write nonce guard
/// exists for.
struct NonceCorruptingTransport {
    inner: Box<dyn SyncTransport>,
    decoy_b64: String,
    /// How many responses this decorator actually rewrote. Asserted by the
    /// test: a decorator that silently stops corrupting turns the §11.3 guard
    /// into a test that passes having proved nothing. That is not
    /// hypothetical — the batch route (myne-md/myne#240) is caught by the old
    /// `starts_with("/sync/blob")` match, and the old top-level
    /// `v["ciphertext_b64"] = …` rewrite would have added a stray field to a
    /// batch body while leaving every real per-blob ciphertext intact.
    fired: std::sync::atomic::AtomicUsize,
}
impl SyncTransport for NonceCorruptingTransport {
    fn request(
        &self,
        method: HttpMethod,
        path: &str,
        body: &[u8],
        token: Option<&str>,
    ) -> Result<TransportResponse, TransportError> {
        let resp = self.inner.request(method, path, body, token)?;
        if resp.status != 200 {
            return Ok(resp);
        }
        let single = path.starts_with("/sync/blob?");
        let batch = path == BLOB_BATCH_PATH;
        if !single && !batch {
            return Ok(resp);
        }
        let mut v: serde_json::Value =
            serde_json::from_slice(&resp.body).expect("blob response is JSON");
        if single {
            v["ciphertext_b64"] = serde_json::Value::String(self.decoy_b64.clone());
            self.fired
                .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        } else if let Some(entries) = v["blobs"].as_array_mut() {
            // The ciphertexts live one level down in the batch shape. Rewrite
            // each of them; a top-level assignment here would corrupt nothing.
            for e in entries.iter_mut() {
                e["ciphertext_b64"] = serde_json::Value::String(self.decoy_b64.clone());
                self.fired
                    .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
            }
        }
        Ok(TransportResponse {
            status: 200,
            body: serde_json::to_vec(&v).unwrap(),
        })
    }
}

/// §11.3 pre-write nonce guard: bytes whose header nonce disagrees with the
/// wire record are NEVER written and NEVER adopted as a baseline — the
/// record is skipped (counted in `pull_skipped`) and the cycle completes.
/// Pre-guard, the corrupt bytes were written + the server baseline adopted,
/// which is exactly the shape that let a reclaimed empty body destroy a
/// live local note and self-seal. The discriminating assertions: nothing on
/// disk, `pulled == 0`, `pull_skipped == 1`, no wedge.
#[test]
fn corrupt_blob_nonce_is_skipped_never_written() {
    let Some((_guard, url)) = spawn_server() else {
        eprintln!("SKIP corrupt_blob_nonce_forces_manifest_rescan: myne-server unavailable");
        return;
    };

    let root_key = [0x42u8; 32];
    let account_hash = [0x5Cu8; 16];
    let secret = derive_subkey(&root_key, SubkeyRole::ServerAuth);
    let items_key = [0x11u8; 32];
    let items_key_id = [0x22u8; 16];

    let dir_a = std::env::temp_dir().join(format!("myne-orch-nonceA-{}", std::process::id()));
    let dir_b = std::env::temp_dir().join(format!("myne-orch-nonceB-{}", std::process::id()));
    let notes_a = dir_a.join("notes");
    let notes_b = dir_b.join("notes");
    std::fs::create_dir_all(&notes_a).unwrap();
    std::fs::create_dir_all(&notes_b).unwrap();

    let note = NoteId::new_v7();
    let note_bytes = *note.as_uuid().as_bytes();
    let blob = encode_new_note(&items_key, &items_key_id, &note_bytes, b"real body").unwrap();
    crate::atomic_write::atomic_write(
        &notes_a.join(format!("{}.myn", note.as_uuid())),
        &blob,
        false,
    )
    .unwrap();

    // The decoy: a valid MY01 blob for a DIFFERENT note id — its header
    // nonce cannot match the record the server advertises for `note`.
    let decoy_id = NoteId::new_v7();
    let decoy = encode_new_note(
        &items_key,
        &items_key_id,
        decoy_id.as_uuid().as_bytes(),
        b"decoy",
    )
    .unwrap();
    use base64::Engine as _;
    let decoy_b64 = base64::engine::general_purpose::STANDARD.encode(&decoy);

    let ta = crate::plugins::sync::http_transport::build_transport(&url).unwrap();
    enroll::register_verifier(ta.as_ref(), &account_hash, secret.as_slice()).unwrap();

    let dev_a = enroll::generate_device_id();
    let out_a = enroll::enroll(
        ta.as_ref(),
        &account_hash,
        secret.as_slice(),
        EnrollPath::Recovery,
        "a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0",
        dev_a,
    )
    .unwrap();
    let tok_a = hex32(&out_a.token);

    let tb = NonceCorruptingTransport {
        inner: crate::plugins::sync::http_transport::build_transport(&url).unwrap(),
        decoy_b64,
        fired: std::sync::atomic::AtomicUsize::new(0),
    };
    let dev_b = enroll::generate_device_id();
    let out_b = enroll::enroll(
        &tb,
        &account_hash,
        secret.as_slice(),
        EnrollPath::Recovery,
        "b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1",
        dev_b,
    )
    .unwrap();
    let tok_b = hex32(&out_b.token);

    let push = run_cycle_legacy(
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
    assert_eq!(push.pushed, 1);

    // B pulls the corrupted body. The cycle must complete (no wedge) and
    // must NOT write the mismatching bytes or adopt the server baseline —
    // the record is skipped, honestly counted.
    let pull = run_cycle_legacy(
        &tb,
        &root_key,
        account_hash,
        dev_b,
        &tok_b,
        &notes_b,
        &dir_b,
        true,
    )
    .expect("B sync cycle survives a nonce-corrupted download");
    // The decorator must have actually rewritten something. Without this the
    // whole test degrades into "an honest download was skipped", which is
    // false, and it would still pass — the exact way a path-match change
    // could disarm the §11.3 guard in silence.
    assert!(
        tb.fired.load(std::sync::atomic::Ordering::Relaxed) > 0,
        "the corrupting decorator never fired — this test proves nothing"
    );
    assert_eq!(
        pull.pulled, 0,
        "mismatching bytes are never counted as pulled"
    );
    assert_eq!(pull.pull_skipped, 1, "the skip is honestly counted");
    assert_eq!(pull.pushed, 0, "nothing local to push — no phantom re-push");
    assert!(
        !notes_b.join(format!("{}.myn", note.as_uuid())).exists(),
        "corrupt served bytes must never reach disk"
    );
    // No baseline adoption → after a cursor reset (the reconcile/fresh-walk
    // shape) an HONEST transport still sees the note as changed and
    // materializes it correctly. (The incremental cursor advanced past the
    // record on the corrupt cycle — bounded staleness by design — so the
    // self-heal is proven via the walk-from-0 path.)
    let mut st_b = read_sync_state(&dir_b).unwrap();
    assert!(
        !st_b.blobs.contains_key(&hex(note.as_uuid().as_bytes())),
        "the corrupt record's baseline was never adopted"
    );
    st_b.cursor = 0;
    write_sync_state(&dir_b, &st_b).unwrap();
    let heal = run_cycle_legacy(
        crate::plugins::sync::http_transport::build_transport(&url)
            .unwrap()
            .as_ref(),
        &root_key,
        account_hash,
        dev_b,
        &tok_b,
        &notes_b,
        &dir_b,
        true,
    )
    .expect("B heals against an honest transport");
    assert_eq!(
        heal.pulled, 1,
        "self-heals once the server serves real bytes"
    );
    let on_disk = std::fs::read(notes_b.join(format!("{}.myn", note.as_uuid()))).unwrap();
    assert_eq!(on_disk, blob, "disk holds the REAL bytes after the heal");

    std::fs::remove_dir_all(&dir_a).ok();
    std::fs::remove_dir_all(&dir_b).ok();
}

// ── §11.3 reclaimed-blob pipeline (Guard A + drop-leg + F4 probe) ──────
// These run against the in-process FakeTransport — no server binary needed.

use crate::plugins::sync::transport::FakeTransport;

fn meta_json(id: &[u8; 16], version: u64, nonce: &[u8; 24]) -> String {
    format!(
        "{{\"uuid_hex\":\"{}\",\"version\":{version},\"content_nonce_hex\":\"{}\",\"size\":1}}",
        hex(id),
        hex(nonce)
    )
}

fn pull_body(metas_json: &str, next_cursor: u64) -> Vec<u8> {
    format!("{{\"metas\":[{metas_json}],\"next_cursor\":{next_cursor}}}").into_bytes()
}

fn fresh_vault(tag: &str) -> (PathBuf, PathBuf) {
    let dir = std::env::temp_dir().join(format!("myne-orch-{tag}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    let notes = dir.join("notes");
    std::fs::create_dir_all(&notes).unwrap();
    (dir, notes)
}

/// A valid v7 note id as the 16 raw bytes (files named off non-v7 ids are
/// skipped by `enumerate_notes_dir`, so on-disk fixtures must use these).
fn v7_id() -> [u8; 16] {
    *NoteId::new_v7().as_uuid().as_bytes()
}

/// A sealed head fragment (`record_b64`, `head_id_hex`) another device
/// might have authored — makes the canned pull carry verifiable history
/// (the F4 probe is gated on `page.head.is_some()`).
fn sealed_head_fragment(root_key: &[u8; 32], account_number_hash: [u8; 16]) -> (String, String) {
    use base64::Engine as _;
    let head = VaultHead {
        head_format_version: VAULT_HEAD_FORMAT_V1,
        account_number_hash,
        manifest_hash: [0u8; 32],
        seq: 1,
        prev_head_hash: Vec::new(),
        version_vector: vec![VvEntry {
            device_id: [0x99; 16],
            counter: 1,
        }],
    };
    let sealed = head.seal(root_key).unwrap();
    (
        base64::engine::general_purpose::STANDARD.encode(&sealed.record),
        hex(&sealed.head_id),
    )
}

fn pull_body_with_head(metas_json: &str, next_cursor: u64, head: &(String, String)) -> Vec<u8> {
    format!(
            "{{\"metas\":[{metas_json}],\"next_cursor\":{next_cursor},\"head\":{{\"record_b64\":\"{}\",\"head_id_hex\":\"{}\"}}}}",
            head.0, head.1
        )
        .into_bytes()
}

/// Guard A, fresh-join shape: a reclaimed record served as an empty 200
/// (pre-§11.3 server) must be skipped — no 0-byte junk file, no baseline
/// adoption, cycle completes with the skip honestly counted.
#[test]
fn empty_ciphertext_download_is_skipped_not_written() {
    let (dir, notes) = fresh_vault("emptyct");
    let id = [0x01u8; 16];
    let t = FakeTransport::new();
    t.on(
        HttpMethod::Get,
        "/sync/pull?cursor=0",
        200,
        pull_body(&meta_json(&id, 3, &[0xaa; 24]), 1),
    );
    t.on(
        HttpMethod::Get,
        "/sync/pull?cursor=1",
        200,
        pull_body("", 1),
    );
    t.on(
        HttpMethod::Get,
        &format!("/sync/blob?id={}", hex(&id)),
        200,
        b"{\"ciphertext_b64\":\"\"}".to_vec(),
    );

    let s = run_cycle_legacy(
        &t,
        &[0x42; 32],
        [0x5c; 16],
        [0x0a; 16],
        "tok",
        &notes,
        &dir,
        false,
    )
    .expect("cycle survives the empty body");
    assert_eq!(s.pulled, 0, "an empty body is never counted as pulled");
    assert_eq!(s.pull_skipped, 1);
    assert!(
        !blob_path(&notes, &id).exists(),
        "no 0-byte junk file may be written"
    );
    let st = read_sync_state(&dir).unwrap();
    assert!(
        !st.blobs.contains_key(&hex(&id)),
        "the tombstone baseline must NOT be adopted (adoption is what made the bug self-seal)"
    );
    assert_eq!(
        st.cursor, 1,
        "the cursor still advances (bounded staleness)"
    );
    std::fs::remove_dir_all(&dir).ok();
}

/// A member session holds no `root_key`, and its chats phase is `skipped`
/// with an empty roster. The owner-only unwrap before the conversation loop
/// used to run unconditionally and panicked every member cycle, which
/// surfaced as the generic "Sync error" and pulled nothing (no notes, no
/// prefs/name). This drives one full cycle with `root_key = None` on the
/// group tier and asserts it runs to completion instead of unwinding.
#[test]
fn a_member_cycle_does_not_panic_on_the_owner_only_chats_phase() {
    use base64::Engine as _;
    use protocol::person_key::PersonKeyPair;
    use protocol::vault_head::VAULT_HEAD_FORMAT_V2;

    let (dir, notes) = fresh_vault("member-cycle");
    let account_number_hash = [0x5c; 16];
    // The member's own identity; deterministic seeds keep the test stable.
    let person = PersonKeyPair::generate_raw(&[0x11; 64], &[0x22; 32], &[0x33; 32]);
    let person_public = person.public_half();
    let ctx = SignedHeadCtx::new(Some(person), account_number_hash, vec![person_public]);

    // The server serves a signed head so the cycle adopts it rather than
    // authoring a genesis (which would need a push route this test omits).
    let mut rng = rand_core::UnwrapErr(crate::rng::OsRng);
    let head = VaultHead {
        head_format_version: VAULT_HEAD_FORMAT_V2,
        account_number_hash,
        manifest_hash: [0u8; 32],
        seq: 1,
        prev_head_hash: Vec::new(),
        version_vector: vec![VvEntry {
            device_id: [0x99; 16],
            counter: 1,
        }],
    };
    let sealed = ctx.sign(&head, &mut rng).unwrap();
    let head_frag = (
        base64::engine::general_purpose::STANDARD.encode(&sealed.record),
        hex(&sealed.head_id),
    );

    let t = FakeTransport::new();
    t.on(
        HttpMethod::Get,
        "/sync/pull?cursor=0",
        200,
        pull_body_with_head("", 1, &head_frag),
    );
    // The empty page must not advance the cursor, or the engine keeps asking
    // for the next one and hits an unrouted path.
    t.on(
        HttpMethod::Get,
        "/sync/pull?cursor=1",
        200,
        pull_body("", 1),
    );

    let items_key = [0x44u8; 32];
    let items_key_id = [0x55u8; 16];
    let shared = SharedSingletonKey::Group(zeroize::Zeroizing::new([0x77u8; 32]));
    let res = blocking(run_sync_cycle(
        &IO,
        &t,
        None,
        &shared,
        account_number_hash,
        [0x0a; 16],
        "tok",
        &notes,
        &dir,
        PushGate::Allowed,
        MetaVersion::V0_2,
        Some(AttachmentKeys {
            items_key: &items_key,
            items_key_id: &items_key_id,
        }),
        Some(&ctx),
        &std::collections::HashSet::new(),
    ));
    assert!(
        res.is_ok(),
        "a member cycle must run to completion, not panic on an owner-only unwrap: {res:?}"
    );
    std::fs::remove_dir_all(&dir).ok();
}

/// Guard A, the headline data-loss repro: a CLEAN live local note whose
/// server record was reclaimed (served empty) must survive byte-identical.
/// Pre-guard, the empty bytes overwrote it and the adopted baseline sealed
/// the destruction.
#[test]
fn junk_download_never_overwrites_live_note() {
    let (dir, notes) = fresh_vault("junkct");
    let id = v7_id();
    let items_key = [0x11u8; 32];
    let items_key_id = [0x22u8; 16];
    let blob = encode_new_note(&items_key, &items_key_id, &id, b"precious body").unwrap();
    let disk_nonce = crate::note_nonce::read_myn_content_nonce(&blob).unwrap();
    crate::atomic_write::atomic_write(&blob_path(&notes, &id), &blob, false).unwrap();
    // Clean baseline: state matches disk (an in-sync note, dirty-skip must NOT fire).
    let mut st = SyncState::default();
    st.blobs.insert(
        hex(&id),
        BlobSyncState {
            version: 1,
            content_nonce_hex: hex(&disk_nonce),
            doc_heads_hex: Vec::new(),
        },
    );
    write_sync_state(&dir, &st).unwrap();

    let t = FakeTransport::new();
    // The server advanced the record (tombstone version, different nonce)…
    t.on(
        HttpMethod::Get,
        "/sync/pull?cursor=0",
        200,
        pull_body(&meta_json(&id, 2, &[0xbb; 24]), 1),
    );
    t.on(
        HttpMethod::Get,
        "/sync/pull?cursor=1",
        200,
        pull_body("", 1),
    );
    // …but the body is gone (reclaimed → empty 200 on an old server).
    t.on(
        HttpMethod::Get,
        &format!("/sync/blob?id={}", hex(&id)),
        200,
        b"{\"ciphertext_b64\":\"\"}".to_vec(),
    );

    let s = run_cycle_legacy(
        &t,
        &[0x42; 32],
        [0x5c; 16],
        [0x0a; 16],
        "tok",
        &notes,
        &dir,
        false,
    )
    .expect("cycle survives");
    assert_eq!(s.pull_skipped, 1);
    let on_disk = std::fs::read(blob_path(&notes, &id)).unwrap();
    assert_eq!(on_disk, blob, "the live note must survive byte-identical");
    let st2 = read_sync_state(&dir).unwrap();
    assert_eq!(
        st2.blobs.get(&hex(&id)).map(|b| b.version),
        Some(1),
        "the old baseline stays authoritative — no tombstone adoption"
    );
    std::fs::remove_dir_all(&dir).ok();
}

/// Guard A, §11.3 server shape: `/sync/blob` → 410 `blob_reclaimed` is a
/// per-record skip, never a whole-cycle failure.
#[test]
fn blob_reclaimed_410_is_skipped_not_cycle_failure() {
    let (dir, notes) = fresh_vault("blob410");
    let id = [0x03u8; 16];
    let t = FakeTransport::new();
    t.on(
        HttpMethod::Get,
        "/sync/pull?cursor=0",
        200,
        pull_body(&meta_json(&id, 4, &[0xcc; 24]), 1),
    );
    t.on(
        HttpMethod::Get,
        "/sync/pull?cursor=1",
        200,
        pull_body("", 1),
    );
    t.on(
        HttpMethod::Get,
        &format!("/sync/blob?id={}", hex(&id)),
        410,
        b"{\"error_code\":\"blob_reclaimed\"}".to_vec(),
    );

    let s = run_cycle_legacy(
        &t,
        &[0x42; 32],
        [0x5c; 16],
        [0x0a; 16],
        "tok",
        &notes,
        &dir,
        false,
    )
    .expect("410 blob_reclaimed must not fail the cycle");
    assert_eq!(s.pull_skipped, 1);
    assert!(!blob_path(&notes, &id).exists());
    std::fs::remove_dir_all(&dir).ok();
}

/// Drop-leg: a previously-synced note absent from the reconcile roster is
/// QUARANTINED (moved, never destroyed), its baseline and queued tombstone
/// flag dropped, the authored state consistent — and `dropped` counted.
#[test]
fn reconcile_drop_quarantines_previously_synced_absentee() {
    let (dir, notes) = fresh_vault("dropleg");
    let id = v7_id();
    let items_key = [0x11u8; 32];
    let items_key_id = [0x22u8; 16];
    let blob = encode_new_note(&items_key, &items_key_id, &id, b"ghost note").unwrap();
    let disk_nonce = crate::note_nonce::read_myn_content_nonce(&blob).unwrap();
    crate::atomic_write::atomic_write(&blob_path(&notes, &id), &blob, false).unwrap();
    let mut st = SyncState {
        cursor: 5,
        ..Default::default()
    };
    st.blobs.insert(
        hex(&id),
        BlobSyncState {
            version: 1,
            content_nonce_hex: hex(&disk_nonce),
            doc_heads_hex: Vec::new(),
        },
    );
    write_sync_state(&dir, &st).unwrap();
    add_pending_tombstone(&dir, &hex(&id)).unwrap();

    let t = FakeTransport::new();
    // Stale cursor → 410 → reconcile walk whose roster no longer carries the id.
    t.on(
        HttpMethod::Get,
        "/sync/pull?cursor=5",
        410,
        b"{\"error_code\":\"cursor_expired\"}".to_vec(),
    );
    t.on(
        HttpMethod::Get,
        "/sync/pull?cursor=0&reconcile=1",
        200,
        pull_body("", 6),
    );
    t.on(
        HttpMethod::Get,
        "/sync/pull?cursor=6&reconcile=1",
        200,
        pull_body("", 6),
    );

    let s = run_cycle_legacy(
        &t,
        &[0x42; 32],
        [0x5c; 16],
        [0x0a; 16],
        "tok",
        &notes,
        &dir,
        false,
    )
    .expect("reconcile cycle");
    assert!(s.reconcile_ran);
    assert_eq!(s.dropped, 1);
    assert!(
        !blob_path(&notes, &id).exists(),
        "the ghost left the live notes dir"
    );
    let uuid = uuid::Uuid::from_bytes(id);
    assert!(
        dir.join("quarantine").join(format!("{uuid}.myn")).exists(),
        "…but its ciphertext is preserved in quarantine/"
    );
    let st2 = read_sync_state(&dir).unwrap();
    assert!(!st2.blobs.contains_key(&hex(&id)), "baseline dropped");
    assert!(
        !read_pending_tombstones(&dir).contains(&hex(&id)),
        "the moot tombstone flag is dequeued"
    );
    std::fs::remove_dir_all(&dir).ok();
}

/// Drop-leg discriminator: a never-synced local note absent from the
/// roster is NEW LOCAL WORK — kept on disk, never quarantined.
#[test]
fn reconcile_keeps_never_synced_local_note() {
    let (dir, notes) = fresh_vault("keeplocal");
    let id = v7_id();
    let items_key = [0x11u8; 32];
    let items_key_id = [0x22u8; 16];
    let blob = encode_new_note(&items_key, &items_key_id, &id, b"fresh local work").unwrap();
    crate::atomic_write::atomic_write(&blob_path(&notes, &id), &blob, false).unwrap();
    // Enrolled before (cursor advanced), but this note never synced (no baseline).
    let st = SyncState {
        cursor: 5,
        ..Default::default()
    };
    write_sync_state(&dir, &st).unwrap();

    let t = FakeTransport::new();
    t.on(
        HttpMethod::Get,
        "/sync/pull?cursor=5",
        410,
        b"{\"error_code\":\"cursor_expired\"}".to_vec(),
    );
    t.on(
        HttpMethod::Get,
        "/sync/pull?cursor=0&reconcile=1",
        200,
        pull_body("", 6),
    );
    t.on(
        HttpMethod::Get,
        "/sync/pull?cursor=6&reconcile=1",
        200,
        pull_body("", 6),
    );

    let s = run_cycle_legacy(
        &t,
        &[0x42; 32],
        [0x5c; 16],
        [0x0a; 16],
        "tok",
        &notes,
        &dir,
        false,
    )
    .expect("reconcile cycle");
    assert!(s.reconcile_ran);
    assert_eq!(s.dropped, 0, "new local work is never dropped");
    assert!(blob_path(&notes, &id).exists(), "…and stays in notes/");
    std::fs::remove_dir_all(&dir).ok();
}

/// Drop-leg guard: an id with a staged (unresolved) keep-both conflict is
/// never quarantined — conflict resolution owns it.
#[test]
fn staged_conflict_id_is_not_dropped() {
    let (dir, notes) = fresh_vault("stagedskip");
    let id = v7_id();
    let items_key = [0x11u8; 32];
    let items_key_id = [0x22u8; 16];
    let blob = encode_new_note(&items_key, &items_key_id, &id, b"conflicted local").unwrap();
    let disk_nonce = crate::note_nonce::read_myn_content_nonce(&blob).unwrap();
    crate::atomic_write::atomic_write(&blob_path(&notes, &id), &blob, false).unwrap();
    let mut st = SyncState {
        cursor: 5,
        ..Default::default()
    };
    st.blobs.insert(
        hex(&id),
        BlobSyncState {
            version: 1,
            content_nonce_hex: hex(&disk_nonce),
            doc_heads_hex: Vec::new(),
        },
    );
    write_sync_state(&dir, &st).unwrap();
    stage_conflict(&dir, &id, 2, &[0xee; 24], b"staged remote bytes").unwrap();

    let t = FakeTransport::new();
    t.on(
        HttpMethod::Get,
        "/sync/pull?cursor=5",
        410,
        b"{\"error_code\":\"cursor_expired\"}".to_vec(),
    );
    t.on(
        HttpMethod::Get,
        "/sync/pull?cursor=0&reconcile=1",
        200,
        pull_body("", 6),
    );
    t.on(
        HttpMethod::Get,
        "/sync/pull?cursor=6&reconcile=1",
        200,
        pull_body("", 6),
    );

    let s = run_cycle_legacy(
        &t,
        &[0x42; 32],
        [0x5c; 16],
        [0x0a; 16],
        "tok",
        &notes,
        &dir,
        false,
    )
    .expect("reconcile cycle");
    assert_eq!(
        s.dropped, 0,
        "a staged conflict is conflict-resolution's, not the drop-leg's"
    );
    assert!(blob_path(&notes, &id).exists());
    std::fs::remove_dir_all(&dir).ok();
}

/// F4 fresh-cursor probe: a re-enrolled device (cursor 0, wiped baselines)
/// holding a local copy of a RECLAIMED record must quarantine it instead of
/// pushing `base_version 0` into a guaranteed 409 batch-wedge.
#[test]
fn fresh_cursor_push_probe_quarantines_reclaimed() {
    let (dir, notes) = fresh_vault("probe410");
    let id = v7_id();
    let root_key = [0x42u8; 32];
    let account = [0x5cu8; 16];
    let items_key = [0x11u8; 32];
    let items_key_id = [0x22u8; 16];
    let blob = encode_new_note(&items_key, &items_key_id, &id, b"reclaimed ghost").unwrap();
    crate::atomic_write::atomic_write(&blob_path(&notes, &id), &blob, false).unwrap();

    let head = sealed_head_fragment(&root_key, account);
    let t = FakeTransport::new();
    // An account WITH history (head present) whose roster no longer carries
    // the ghost — the §11.3 server omitted the reclaimed record.
    t.on(
        HttpMethod::Get,
        "/sync/pull?cursor=0",
        200,
        pull_body_with_head("", 0, &head),
    );
    // The probe: the server knows this id as a reclaimed record.
    t.on(
        HttpMethod::Get,
        &format!("/sync/blob?id={}", hex(&id)),
        410,
        b"{\"error_code\":\"blob_reclaimed\"}".to_vec(),
    );

    let s = run_cycle_legacy(
        &t, &root_key, account, [0x0a; 16], "tok", &notes, &dir, true,
    )
    .expect("cycle");
    assert_eq!(s.dropped, 1, "the reclaimed ghost is quarantined");
    assert_eq!(
        s.pushed, 0,
        "…and never pushed (base_version 0 would 409-wedge the batch)"
    );
    assert!(!blob_path(&notes, &id).exists());
    let uuid = uuid::Uuid::from_bytes(id);
    assert!(dir.join("quarantine").join(format!("{uuid}.myn")).exists());
    std::fs::remove_dir_all(&dir).ok();
}

// ── apply_pulled_note_blob: in-lock dirty re-check (A1 linearization) ──
// Two-thread race pin deliberately downgraded: `run_sync_cycle` is
// monolithic over a transport with no mid-loop injection seam, so a
// barrier-based race test would need test-only hooks in production code.
// Coverage instead: all THREE note-blob writers share `notes_write_mutex`
// (compile-level) — this one, `note_update_with_dir`, and the §8.3 batch
// (`note_write_batch_with_dir`, which joined them in myne#302) — and these
// units pin the in-lock decision both ways.

/// The cycle-start manifest said "clean", but a local save landed before
/// the write: the in-lock re-read sees the diverged disk nonce and skips —
/// the pulled bytes must never clobber the fresh local edit.
#[test]
fn apply_pulled_note_blob_skips_when_disk_nonce_diverged_from_scan() {
    let (dir, notes) = fresh_vault("applylock-dirty");
    let id = v7_id();
    let items_key = [0x11u8; 32];
    let items_key_id = [0x22u8; 16];
    let original = encode_new_note(&items_key, &items_key_id, &id, b"scanned base").unwrap();
    let scanned_nonce = crate::note_nonce::read_myn_content_nonce(&original).unwrap();
    // …but by write time the disk already holds a NEWER local edit.
    let local_edit = encode_new_note(&items_key, &items_key_id, &id, b"local edit").unwrap();
    crate::atomic_write::atomic_write(&blob_path(&notes, &id), &local_edit, false).unwrap();

    let server_bytes = encode_new_note(&items_key, &items_key_id, &id, b"server v2").unwrap();
    let outcome = blocking(apply_pulled_note_blob(
        &IO,
        &notes,
        &id,
        &server_bytes,
        Some(hex(&scanned_nonce).as_str()),
    ))
    .unwrap();
    assert!(matches!(outcome, PulledNoteApply::SkippedDirty));
    let on_disk = std::fs::read(blob_path(&notes, &id)).unwrap();
    assert_eq!(on_disk, local_edit, "the racing local edit survives");
    std::fs::remove_dir_all(&dir).ok();
}

/// Clean case: disk still matches the synced baseline → the pulled bytes land.
#[test]
fn apply_pulled_note_blob_writes_when_clean() {
    let (dir, notes) = fresh_vault("applylock-clean");
    let id = v7_id();
    let items_key = [0x11u8; 32];
    let items_key_id = [0x22u8; 16];
    let base = encode_new_note(&items_key, &items_key_id, &id, b"synced base").unwrap();
    let base_nonce = crate::note_nonce::read_myn_content_nonce(&base).unwrap();
    crate::atomic_write::atomic_write(&blob_path(&notes, &id), &base, false).unwrap();

    let server_bytes = encode_new_note(&items_key, &items_key_id, &id, b"server v2").unwrap();
    let outcome = blocking(apply_pulled_note_blob(
        &IO,
        &notes,
        &id,
        &server_bytes,
        Some(hex(&base_nonce).as_str()),
    ))
    .unwrap();
    assert!(matches!(outcome, PulledNoteApply::Applied));
    let on_disk = std::fs::read(blob_path(&notes, &id)).unwrap();
    assert_eq!(on_disk, server_bytes);
    // A vanished file under a live baseline is likewise dirty (a mid-cycle
    // local delete must not be resurrected).
    std::fs::remove_file(blob_path(&notes, &id)).unwrap();
    let outcome2 = blocking(apply_pulled_note_blob(
        &IO,
        &notes,
        &id,
        &server_bytes,
        Some(hex(&base_nonce).as_str()),
    ))
    .unwrap();
    assert!(matches!(outcome2, PulledNoteApply::SkippedDirty));
    // No baseline (fresh pull) writes unconditionally.
    let outcome3 = blocking(apply_pulled_note_blob(
        &IO,
        &notes,
        &id,
        &server_bytes,
        None,
    ))
    .unwrap();
    assert!(matches!(outcome3, PulledNoteApply::Applied));
    std::fs::remove_dir_all(&dir).ok();
}

/// F4 sibling: a 404 probe answer means "genuinely new note" — it pushes
/// exactly as before (fail-open).
#[test]
fn fresh_cursor_push_probe_404_pushes_normally() {
    let (dir, notes) = fresh_vault("probe404");
    let id = v7_id();
    let root_key = [0x42u8; 32];
    let account = [0x5cu8; 16];
    let items_key = [0x11u8; 32];
    let items_key_id = [0x22u8; 16];
    let blob = encode_new_note(&items_key, &items_key_id, &id, b"genuinely new").unwrap();
    crate::atomic_write::atomic_write(&blob_path(&notes, &id), &blob, false).unwrap();

    let head = sealed_head_fragment(&root_key, account);
    let t = FakeTransport::new();
    t.on(
        HttpMethod::Get,
        "/sync/pull?cursor=0",
        200,
        pull_body_with_head("", 0, &head),
    );
    t.on(
        HttpMethod::Get,
        &format!("/sync/blob?id={}", hex(&id)),
        404,
        b"{\"error_code\":\"not_found\"}".to_vec(),
    );
    t.on(
        HttpMethod::Post,
        "/sync/push",
        200,
        format!(
            "{{\"results\":[{{\"blob_id_hex\":\"{}\",\"version\":1}}],\"head_id_hex\":\"{}\"}}",
            hex(&id),
            "cd".repeat(32)
        )
        .into_bytes(),
    );

    let s = run_cycle_legacy(
        &t, &root_key, account, [0x0a; 16], "tok", &notes, &dir, true,
    )
    .expect("cycle");
    assert_eq!(
        s.pushed, 1,
        "a 404 probe is fail-open — the new note pushes"
    );
    assert_eq!(s.dropped, 0);
    assert!(blob_path(&notes, &id).exists());
    std::fs::remove_dir_all(&dir).ok();
}

/// Live end-to-end poke: device B holds an open `/sync/poke` SSE stream
/// against the REAL server; device A's push must surface as a contentless
/// poke on B's stream within seconds (the §8.3-as-amended baseline path:
/// push → server Notify → SSE event → SsePokeSignal bump). Self-skips
/// without the server binary.
#[test]
fn push_on_device_a_pokes_device_b_over_live_sse() {
    use crate::plugins::sync::poke_listener::{drain_stream, SsePokeSignal};
    use std::sync::atomic::{AtomicBool, Ordering};

    let Some((_guard, url)) = spawn_server() else {
        eprintln!("SKIP push_on_device_a_pokes_device_b_over_live_sse: myne-server unavailable");
        return;
    };

    let root_key = [0x42u8; 32];
    let account_hash = [0x6Du8; 16];
    let secret = derive_subkey(&root_key, SubkeyRole::ServerAuth);
    let items_key = [0x11u8; 32];
    let items_key_id = [0x22u8; 16];

    let dir_a = std::env::temp_dir().join(format!("myne-orch-pokeA-{}", std::process::id()));
    let notes_a = dir_a.join("notes");
    std::fs::create_dir_all(&notes_a).unwrap();
    let note = NoteId::new_v7();
    let blob = encode_new_note(
        &items_key,
        &items_key_id,
        note.as_uuid().as_bytes(),
        b"poke me",
    )
    .unwrap();
    crate::atomic_write::atomic_write(
        &notes_a.join(format!("{}.myn", note.as_uuid())),
        &blob,
        false,
    )
    .unwrap();

    let ta = crate::plugins::sync::http_transport::build_transport(&url).unwrap();
    enroll::register_verifier(ta.as_ref(), &account_hash, secret.as_slice()).unwrap();
    let dev_a = enroll::generate_device_id();
    let out_a = enroll::enroll(
        ta.as_ref(),
        &account_hash,
        secret.as_slice(),
        EnrollPath::Recovery,
        "a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0",
        dev_a,
    )
    .unwrap();
    let tok_a = hex32(&out_a.token);
    let tb = crate::plugins::sync::http_transport::build_transport(&url).unwrap();
    let dev_b = enroll::generate_device_id();
    let out_b = enroll::enroll(
        tb.as_ref(),
        &account_hash,
        secret.as_slice(),
        EnrollPath::Recovery,
        "b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1",
        dev_b,
    )
    .unwrap();
    let tok_b = hex32(&out_b.token);

    // B opens the live SSE stream and drains it on a side thread.
    let stream = tb
        .open_sse("/sync/poke", &tok_b, std::time::Duration::from_secs(10))
        .expect("open_sse against the live server");
    let shutdown = stream.socket.try_clone().unwrap();
    let signal = SsePokeSignal::default();
    let signal2 = signal.clone();
    let stop = std::sync::Arc::new(AtomicBool::new(false));
    let stop2 = stop.clone();
    let chunked = stream.chunked;
    let reader = stream.reader;
    let drainer = std::thread::spawn(move || drain_stream(reader, chunked, &stop2, &signal2));

    // A pushes — the server must poke B's open stream.
    let push = run_cycle_legacy(
        ta.as_ref(),
        &root_key,
        account_hash,
        dev_a,
        &tok_a,
        &notes_a,
        &dir_a,
        true,
    )
    .expect("A push cycle");
    assert_eq!(push.pushed, 1);

    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
    while signal.get() == 0 && std::time::Instant::now() < deadline {
        std::thread::sleep(std::time::Duration::from_millis(25));
    }
    assert!(
        signal.get() >= 1,
        "device A's push must arrive as a poke on B's live SSE stream"
    );

    stop.store(true, Ordering::Relaxed);
    let _ = shutdown.shutdown(std::net::Shutdown::Both);
    let _ = drainer.join();
    std::fs::remove_dir_all(&dir_a).ok();
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
    let secret = derive_subkey(&root_key, SubkeyRole::ServerAuth);
    let items_key = [0x12u8; 32];
    let items_key_id = [0x34u8; 16];

    let dir_a = std::env::temp_dir().join(format!("myne-join-A-{}", std::process::id()));
    let dir_b = std::env::temp_dir().join(format!("myne-join-B-{}", std::process::id()));
    let notes_a = dir_a.join("notes");
    let notes_b = dir_b.join("notes");
    std::fs::create_dir_all(&notes_a).unwrap();
    std::fs::create_dir_all(&notes_b).unwrap();
    let mk = || crate::plugins::sync::http_transport::build_transport(&url).unwrap();

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
    enroll::register_verifier(ta.as_ref(), &account_hash, secret.as_slice()).unwrap();
    let dev_a = enroll::generate_device_id();
    let out_a = enroll::enroll(
        ta.as_ref(),
        &account_hash,
        secret.as_slice(),
        EnrollPath::Recovery,
        "a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0",
        dev_a,
    )
    .unwrap();
    let tok_a = hex32(&out_a.token);
    run_cycle_legacy(
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
    let pull = run_cycle_legacy(
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

/// #1 (SAS latency): the joining device records + PERSISTS the pulled head
/// observation BEFORE the note-body download loop, so its join SAS
/// (`sync_head_fingerprint` → `vv_log.last()`, read from disk) surfaces without
/// waiting for the whole first-cycle content download. Proven by failing every
/// `/sync/blob` GET: the cycle errors mid-download and NO note lands on disk,
/// yet the persisted `sync-state.json` already carries the head observation.
/// Before the fix the observation was recorded only AFTER the loop and persisted
/// only on whole-cycle success, so a failed cycle left `vv_log` empty.
#[test]
fn join_head_fingerprint_persists_before_blob_download() {
    let Some((_guard, url)) = spawn_server() else {
        eprintln!(
            "SKIP join_head_fingerprint_persists_before_blob_download: server binary not found"
        );
        return;
    };
    let root_key = [0x5Au8; 32];
    let account_hash = [0x5Bu8; 16];
    let secret = derive_subkey(&root_key, SubkeyRole::ServerAuth);
    let items_key = [0x14u8; 32];
    let items_key_id = [0x38u8; 16];

    let dir_a = std::env::temp_dir().join(format!("myne-sasA-{}", std::process::id()));
    let dir_b = std::env::temp_dir().join(format!("myne-sasB-{}", std::process::id()));
    let notes_a = dir_a.join("notes");
    let notes_b = dir_b.join("notes");
    std::fs::create_dir_all(&notes_a).unwrap();
    std::fs::create_dir_all(&notes_b).unwrap();

    // Owner A authors a note and pushes it (server now holds A's head + blob).
    let note = NoteId::new_v7();
    write_note(
        &notes_a,
        &items_key,
        &items_key_id,
        &note,
        b"owner note",
        false,
    );
    let (ta, dev_a, tok_a) = enroll_device(
        &url,
        &account_hash,
        secret.as_slice(),
        "a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0",
        true,
    );
    run_cycle_legacy(
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
    let a_head = read_sync_state(&dir_a)
        .unwrap()
        .vv_log
        .last()
        .cloned()
        .expect("A recorded its head at push");

    // Device B joins (recovery self-approve) and gets a token.
    let (_tb, dev_b, tok_b) = enroll_device(
        &url,
        &account_hash,
        secret.as_slice(),
        "b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1",
        false,
    );

    // B syncs through a transport that FAILS every blob download, so the
    // content-download loop cannot complete.
    let tb_fail = FailBlobTransport {
        inner: crate::plugins::sync::http_transport::build_transport(&url).unwrap(),
    };
    let res = run_cycle_legacy(
        &tb_fail,
        &root_key,
        account_hash,
        dev_b,
        &tok_b,
        &notes_b,
        &dir_b,
        true,
    );
    assert!(
        res.is_err(),
        "the cycle errors because the blob download fails"
    );

    // The note body did NOT land (the download never completed)...
    assert!(
        !notes_b.join(format!("{}.myn", note.as_uuid())).exists(),
        "no note body downloaded"
    );
    // ...yet B's persisted sync-state already carries the head observation: the
    // SAS fingerprint is available before any note body is fetched.
    let b_head = read_sync_state(&dir_b)
        .unwrap()
        .vv_log
        .last()
        .cloned()
        .expect("B recorded + persisted the head BEFORE the download loop");
    assert_eq!(
        b_head.head_id_hex, a_head.head_id_hex,
        "B's early-surfaced SAS fingerprint matches the owner's head"
    );

    std::fs::remove_dir_all(&dir_a).ok();
    std::fs::remove_dir_all(&dir_b).ok();
}

/// myne#292 — a FAILED cycle must not leave the previous cycle's
/// `corpus_complete: true` on disk.
///
/// The flag's only job is to authorise an irreversible cross-device
/// attachment erase, and its own doc says it is "recomputed every cycle, and
/// cleared as readily as it is set". It was not: the recompute is the last
/// statement of the attempt, and only the SUCCESS arm persisted it — so a
/// device that was complete, then fell behind and kept failing, went on
/// authorising "Clean unused" indefinitely with a corpus it no longer had.
///
/// The existing coverage is the success path only (`corpus_complete` is
/// asserted true after a clean pull); this is the other half.
#[test]
fn a_failed_cycle_clears_the_persisted_whole_corpus_flag() {
    let Some((_guard, url)) = spawn_server() else {
        eprintln!("SKIP a_failed_cycle_clears_the_persisted_whole_corpus_flag: no server");
        return;
    };
    let root_key = [0x7Au8; 32];
    let account_hash = [0x7Bu8; 16];
    let secret = derive_subkey(&root_key, SubkeyRole::ServerAuth);
    let items_key = [0x15u8; 32];
    let items_key_id = [0x39u8; 16];

    let dir_a = std::env::temp_dir().join(format!("myne-cc-A-{}", std::process::id()));
    let dir_b = std::env::temp_dir().join(format!("myne-cc-B-{}", std::process::id()));
    let notes_a = dir_a.join("notes");
    let notes_b = dir_b.join("notes");
    std::fs::create_dir_all(&notes_a).unwrap();
    std::fs::create_dir_all(&notes_b).unwrap();

    let note = NoteId::new_v7();
    write_note(
        &notes_a,
        &items_key,
        &items_key_id,
        &note,
        b"owner note",
        false,
    );
    let (ta, dev_a, tok_a) = enroll_device(
        &url,
        &account_hash,
        secret.as_slice(),
        "a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2",
        true,
    );
    run_cycle_legacy(
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

    // B completes a cycle and is genuinely whole-corpus.
    let (tb, dev_b, tok_b) = enroll_device(
        &url,
        &account_hash,
        secret.as_slice(),
        "b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2",
        false,
    );
    run_cycle_legacy(
        tb.as_ref(),
        &root_key,
        account_hash,
        dev_b,
        &tok_b,
        &notes_b,
        &dir_b,
        true,
    )
    .unwrap();
    assert!(
        read_sync_state(&dir_b).unwrap().corpus_complete,
        "precondition: B held the whole corpus after a clean cycle"
    );

    // A authors a second note, so B is now behind.
    let note2 = NoteId::new_v7();
    write_note(
        &notes_a,
        &items_key,
        &items_key_id,
        &note2,
        b"second",
        false,
    );
    run_cycle_legacy(
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

    // B's next cycle dies in the note-body download loop.
    let tb_fail = FailBlobTransport {
        inner: crate::plugins::sync::http_transport::build_transport(&url).unwrap(),
    };
    let res = run_cycle_legacy(
        &tb_fail,
        &root_key,
        account_hash,
        dev_b,
        &tok_b,
        &notes_b,
        &dir_b,
        true,
    );
    assert!(
        res.is_err(),
        "the cycle errors because the blob download fails"
    );

    assert!(
        !read_sync_state(&dir_b).unwrap().corpus_complete,
        "a device that failed mid-cycle must NOT keep authorising the \
             irreversible fleet-wide attachment sweep"
    );

    std::fs::remove_dir_all(&dir_a).ok();
    std::fs::remove_dir_all(&dir_b).ok();
}

/// #2 (empty-vault liveness): a zero-note vault still authors a genesis head on
/// its first push, so a joining device can pull + adopt it and its join SAS
/// appears. Without the genesis-on-empty gate the account never gets a head, the
/// joiner's pull returns `head=None` forever, and the SAS never shows (the phone
/// hangs on "Waiting for approval").
#[test]
fn empty_vault_authors_genesis_head_so_joiner_sees_sas() {
    let Some((_guard, url)) = spawn_server() else {
        eprintln!("SKIP empty_vault_authors_genesis_head...: server binary not found");
        return;
    };
    let root_key = [0x61u8; 32];
    let account_hash = [0x62u8; 16];
    let secret = derive_subkey(&root_key, SubkeyRole::ServerAuth);

    let dir_a = std::env::temp_dir().join(format!("myne-genA-{}", std::process::id()));
    let dir_b = std::env::temp_dir().join(format!("myne-genB-{}", std::process::id()));
    let notes_a = dir_a.join("notes");
    let notes_b = dir_b.join("notes");
    std::fs::create_dir_all(&notes_a).unwrap(); // EMPTY — no notes authored
    std::fs::create_dir_all(&notes_b).unwrap();

    // Owner A: empty vault, enroll, push → authors a genesis head over 0 notes.
    let (ta, dev_a, tok_a) = enroll_device(
        &url,
        &account_hash,
        secret.as_slice(),
        "a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0",
        true,
    );
    let push = run_cycle_legacy(
        ta.as_ref(),
        &root_key,
        account_hash,
        dev_a,
        &tok_a,
        &notes_a,
        &dir_a,
        true,
    )
    .expect("A's first cycle");
    assert!(push.head_advanced, "an empty vault authors a genesis head");
    assert_eq!(push.pushed, 0, "no blobs pushed for an empty vault");
    let a_head = read_sync_state(&dir_a)
        .unwrap()
        .vv_log
        .last()
        .cloned()
        .expect("A recorded the genesis head observation (its own SAS)");

    // Device B joins (recovery self-approve) and pulls: it adopts the genesis
    // head and its join SAS fingerprint appears — matching A's.
    let (tb, dev_b, tok_b) = enroll_device(
        &url,
        &account_hash,
        secret.as_slice(),
        "b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1",
        false,
    );
    let pull = run_cycle_legacy(
        tb.as_ref(),
        &root_key,
        account_hash,
        dev_b,
        &tok_b,
        &notes_b,
        &dir_b,
        true,
    )
    .expect("B's join cycle");
    assert_eq!(pull.pulled, 0, "nothing to download on an empty account");
    let b_head = read_sync_state(&dir_b)
        .unwrap()
        .vv_log
        .last()
        .cloned()
        .expect("the joining device adopts the genesis head → SAS appears");
    assert_eq!(
        b_head.head_id_hex, a_head.head_id_hex,
        "both devices agree on the genesis head fingerprint"
    );

    std::fs::remove_dir_all(&dir_a).ok();
    std::fs::remove_dir_all(&dir_b).ok();
}

/// myne#462, the half that fixes the bug: while a device-verification
/// eye-compare is open, a cycle with local changes authors **no head**, so
/// the fingerprint both screens are reading stands still.
///
/// Asserted as state, not as a return value: the return could report
/// "nothing pushed" for several unrelated reasons, whereas `vv_log.last()`
/// is literally what `sync_head_fingerprint` reads, so pinning it pins the
/// displayed code.
#[test]
fn a_verify_hold_cycle_authors_no_head() {
    let Some((_guard, url)) = spawn_server() else {
        eprintln!("SKIP a_verify_hold_cycle_authors_no_head: myne-server binary not found");
        return;
    };
    let root_key = [0x71u8; 32];
    let account_hash = [0x72u8; 16];
    let secret = derive_subkey(&root_key, SubkeyRole::ServerAuth);
    let items_key = [0x15u8; 32];
    let items_key_id = [0x39u8; 16];

    let dir = std::env::temp_dir().join(format!("myne-hold-{}", std::process::id()));
    let notes = dir.join("notes");
    std::fs::create_dir_all(&notes).unwrap();

    let (t, dev, tok) = enroll_device(
        &url,
        &account_hash,
        secret.as_slice(),
        "c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2",
        true,
    );

    // A first ordinary cycle so the account HAS a head — the genesis case is
    // the sibling test below, and conflating the two would let either pass
    // for the other's reason.
    let first = NoteId::new_v7();
    write_note(&notes, &items_key, &items_key_id, &first, b"one", false);
    run_cycle_legacy(
        t.as_ref(),
        &root_key,
        account_hash,
        dev,
        &tok,
        &notes,
        &dir,
        true,
    )
    .expect("the seeding cycle");
    let before = read_sync_state(&dir)
        .unwrap()
        .vv_log
        .last()
        .cloned()
        .expect("a head after the seeding cycle");

    // Now the ceremony is open, and the user edits (or an autosave fires).
    let second = NoteId::new_v7();
    write_note(&notes, &items_key, &items_key_id, &second, b"two", false);
    let held = blocking(run_sync_cycle(
        &IO,
        t.as_ref(),
        Some(&root_key),
        &SharedSingletonKey::OwnerRoot(zeroize::Zeroizing::new(root_key)),
        account_hash,
        dev,
        &tok,
        &notes,
        &dir,
        PushGate::VerifyHold,
        MetaVersion::V0_1,
        None,
        None,
        &std::collections::HashSet::new(),
    ))
    .expect("the held cycle still runs");
    assert_eq!(held.pushed, 0, "a held cycle pushes no content");
    assert!(!held.head_advanced, "a held cycle authors no head");

    let after = read_sync_state(&dir)
        .unwrap()
        .vv_log
        .last()
        .cloned()
        .expect("the observation survives the held cycle");
    assert_eq!(
        after.head_id_hex, before.head_id_hex,
        "the head the SAS is derived from must not move under the compare"
    );

    // And the edit is not lost — the very next unheld cycle pushes it.
    let released = run_cycle_legacy(
        t.as_ref(),
        &root_key,
        account_hash,
        dev,
        &tok,
        &notes,
        &dir,
        true,
    )
    .expect("the cycle after the compare closed");
    assert_eq!(released.pushed, 1, "the held edit flushes once released");

    std::fs::remove_dir_all(&dir).ok();
}

/// myne#462's liveness carve-out, and the reason `PushGate` is an enum
/// rather than a second bool.
///
/// On an account nobody has ever pushed to, the genesis head is the only
/// thing a joining device can adopt — and without an adopted head its SAS
/// never appears at all (`decisions.md` 2026-07-12, and
/// `empty_vault_authors_genesis_head_so_joiner_sees_sas` above). A hold that
/// suppressed *every* push would therefore hang both screens forever on
/// exactly the accounts where the ceremony matters most: brand new ones.
/// That is a worse bug than the one the hold fixes, and it is invisible on
/// any account that already has a head.
#[test]
fn a_verify_hold_still_authors_the_genesis_head() {
    let Some((_guard, url)) = spawn_server() else {
        eprintln!("SKIP a_verify_hold_still_authors_the_genesis_head: server binary not found");
        return;
    };
    let root_key = [0x73u8; 32];
    let account_hash = [0x74u8; 16];
    let secret = derive_subkey(&root_key, SubkeyRole::ServerAuth);

    let dir = std::env::temp_dir().join(format!("myne-holdgen-{}", std::process::id()));
    let notes = dir.join("notes");
    std::fs::create_dir_all(&notes).unwrap(); // EMPTY — nothing to push

    let (t, dev, tok) = enroll_device(
        &url,
        &account_hash,
        secret.as_slice(),
        "d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3",
        true,
    );

    let held = blocking(run_sync_cycle(
        &IO,
        t.as_ref(),
        Some(&root_key),
        &SharedSingletonKey::OwnerRoot(zeroize::Zeroizing::new(root_key)),
        account_hash,
        dev,
        &tok,
        &notes,
        &dir,
        PushGate::VerifyHold,
        MetaVersion::V0_1,
        None,
        None,
        &std::collections::HashSet::new(),
    ))
    .expect("the held first cycle");
    assert!(
        held.head_advanced,
        "genesis must still be authored under a verify hold, or a joining \
             device on a fresh account never adopts a head and its SAS never appears"
    );
    assert_eq!(held.pushed, 0, "genesis is head-only — no blobs");
    assert!(
        read_sync_state(&dir).unwrap().vv_log.last().is_some(),
        "the genesis observation is recorded, so a fingerprint exists to compare"
    );

    std::fs::remove_dir_all(&dir).ok();
}

/// The genesis carve-out is genesis-ON-EMPTY, and a non-empty corpus is not
/// it.
///
/// The condition used to be `gate.allows_genesis() && page.head.is_none()`
/// with no look at the corpus, which is strictly wider than the §6.1 bullet
/// it implements ("A device with zero content blobs ... a head-only push").
/// A device with notes on disk and no head yet would, under a compare,
/// author a head whose `manifest_hash` comes from the full local manifest
/// while `to_push` is empty, because both content blocks sit behind
/// `gate.allows_content()`. That head commits `content_nonce`s for blobs the
/// server does not hold, which inverts the SYNC-5 ordering this function
/// states as its own invariant, and a peer pulling in that window cannot
/// tell an over-claiming author from a withholding server.
#[test]
fn a_verify_hold_does_not_author_genesis_over_a_non_empty_corpus() {
    let Some((_guard, url)) = spawn_server() else {
        eprintln!(
            "SKIP a_verify_hold_does_not_author_genesis_over_a_non_empty_corpus: \
                 server binary not found"
        );
        return;
    };
    let root_key = [0x75u8; 32];
    let account_hash = [0x76u8; 16];
    let secret = derive_subkey(&root_key, SubkeyRole::ServerAuth);

    let dir = std::env::temp_dir().join(format!("myne-holdgen2-{}", std::process::id()));
    let notes = dir.join("notes");
    std::fs::create_dir_all(&notes).unwrap();
    // NOT empty: one local note, never pushed. This is the whole difference
    // from the sibling test above.
    let items_key = [0x11u8; 32];
    let items_key_id = [0x22u8; 16];
    let only = NoteId::new_v7();
    write_note(
        &notes,
        &items_key,
        &items_key_id,
        &only,
        b"local only",
        false,
    );

    let (t, dev, tok) = enroll_device(
        &url,
        &account_hash,
        secret.as_slice(),
        "d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4",
        true,
    );

    let held = blocking(run_sync_cycle(
        &IO,
        t.as_ref(),
        Some(&root_key),
        &SharedSingletonKey::OwnerRoot(zeroize::Zeroizing::new(root_key)),
        account_hash,
        dev,
        &tok,
        &notes,
        &dir,
        PushGate::VerifyHold,
        MetaVersion::V0_1,
        None,
        None,
        &std::collections::HashSet::new(),
    ))
    .expect("the held first cycle");
    assert_eq!(held.pushed, 0, "content is held, as it must be");
    assert!(
        !held.head_advanced,
        "a head authored here would commit a manifest the server cannot serve"
    );

    std::fs::remove_dir_all(&dir).ok();
}

/// Regression: a device that holds the account's blobs locally but whose
/// synced baseline (`state.blobs`) was lost — the chunked push-response parse
/// bug left it empty even though the server stored the blobs — must SELF-HEAL
/// from the pull roster and push only the genuinely-edited blob (NOT re-push
/// everything at base_version 0, which the server CAS rejects 409), and must
/// not let the pull clobber the unpushed local edit with the server's copy.
#[test]
fn empty_baseline_self_heals_and_local_edit_pushes() {
    let Some((_guard, url)) = spawn_server() else {
        eprintln!("SKIP empty_baseline_self_heals: myne-server binary not found");
        return;
    };

    let root_key = [0x33u8; 32];
    let account_hash = [0x44u8; 16];
    let secret = derive_subkey(&root_key, SubkeyRole::ServerAuth);
    let items_key = [0x13u8; 32];
    let items_key_id = [0x37u8; 16];

    let dir_a = std::env::temp_dir().join(format!("myne-heal-A-{}", std::process::id()));
    let dir_b = std::env::temp_dir().join(format!("myne-heal-B-{}", std::process::id()));
    let notes_a = dir_a.join("notes");
    let notes_b = dir_b.join("notes");
    std::fs::create_dir_all(&notes_a).unwrap();
    std::fs::create_dir_all(&notes_b).unwrap();
    let note = NoteId::new_v7();
    let note_bytes = *note.as_uuid().as_bytes();
    let fname = format!("{}.myn", note.as_uuid());

    // Device A authors a note and pushes it (server stores it at version 1).
    let blob_v1 = encode_new_note(&items_key, &items_key_id, &note_bytes, b"original").unwrap();
    crate::atomic_write::atomic_write(&notes_a.join(&fname), &blob_v1, false).unwrap();
    let ta = crate::plugins::sync::http_transport::build_transport(&url).unwrap();
    enroll::register_verifier(ta.as_ref(), &account_hash, secret.as_slice()).unwrap();
    let dev_a = enroll::generate_device_id();
    let out_a = enroll::enroll(
        ta.as_ref(),
        &account_hash,
        secret.as_slice(),
        EnrollPath::Recovery,
        "a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0",
        dev_a,
    )
    .unwrap();
    let tok_a = hex32(&out_a.token);
    run_cycle_legacy(
        ta.as_ref(),
        &root_key,
        account_hash,
        dev_a,
        &tok_a,
        &notes_a,
        &dir_a,
        true,
    )
    .expect("A initial push");

    // Corruption: clear A's synced baseline — exactly what the chunked
    // push-response parse bug produced (server got the blob, A never recorded
    // it). Device identity + cursor are kept.
    let mut st = read_sync_state(&dir_a).unwrap();
    assert!(
        !st.blobs.is_empty(),
        "baseline populated by the initial push"
    );
    st.blobs.clear();
    write_sync_state(&dir_a, &st).unwrap();

    // A edits the note locally (a fresh content_nonce).
    let blob_v2 = encode_new_note(&items_key, &items_key_id, &note_bytes, b"edited body").unwrap();
    crate::atomic_write::atomic_write(&notes_a.join(&fname), &blob_v2, true).unwrap();

    // A syncs: self-heal the baseline + push the edit (no 409), and do NOT
    // clobber the local edit with the server's v1.
    run_cycle_legacy(
        ta.as_ref(),
        &root_key,
        account_hash,
        dev_a,
        &tok_a,
        &notes_a,
        &dir_a,
        true,
    )
    .expect("A heal + push edit");
    let a_after = std::fs::read(notes_a.join(&fname)).unwrap();
    let a_dec = decode_note(&a_after, &note_bytes, &items_key, &items_key_id).unwrap();
    assert_eq!(
        a_dec.plaintext(),
        b"edited body",
        "A's local edit survived (not clobbered by the pull)"
    );

    // Device B pulls the edit fresh → proves the edit actually propagated.
    let tb = crate::plugins::sync::http_transport::build_transport(&url).unwrap();
    let dev_b = enroll::generate_device_id();
    let out_b = enroll::enroll(
        tb.as_ref(),
        &account_hash,
        secret.as_slice(),
        EnrollPath::Recovery,
        "b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1",
        dev_b,
    )
    .unwrap();
    let tok_b = hex32(&out_b.token);
    let pull = run_cycle_legacy(
        tb.as_ref(),
        &root_key,
        account_hash,
        dev_b,
        &tok_b,
        &notes_b,
        &dir_b,
        true,
    )
    .expect("B pull");
    assert_eq!(pull.pulled, 1, "B pulled the edited note");
    let b_blob = std::fs::read(notes_b.join(&fname)).unwrap();
    let b_dec = decode_note(&b_blob, &note_bytes, &items_key, &items_key_id).unwrap();
    assert_eq!(
        b_dec.plaintext(),
        b"edited body",
        "B sees A's edit (v2 propagated end-to-end)"
    );

    std::fs::remove_dir_all(&dir_a).ok();
    std::fs::remove_dir_all(&dir_b).ok();
}

/// Enroll a device via the recovery path (self-approves). `register` runs the
/// one-time SCRAM verifier registration (call it true on the first device).
fn enroll_device(
    url: &str,
    account_hash: &[u8; 16],
    secret: &[u8],
    nonce: &str,
    register: bool,
) -> (Box<dyn SyncTransport>, [u8; 16], String) {
    let t = crate::plugins::sync::http_transport::build_transport(url).unwrap();
    if register {
        enroll::register_verifier(t.as_ref(), account_hash, secret).unwrap();
    }
    let dev = enroll::generate_device_id();
    let out = enroll::enroll(
        t.as_ref(),
        account_hash,
        secret,
        EnrollPath::Recovery,
        nonce,
        dev,
    )
    .unwrap();
    let tok = hex32(&out.token);
    (t, dev, tok)
}

fn write_note(
    notes_dir: &std::path::Path,
    ik: &[u8; 32],
    iki: &[u8; 16],
    id: &NoteId,
    body: &[u8],
    replace: bool,
) {
    let nb = *id.as_uuid().as_bytes();
    let blob = encode_new_note(ik, iki, &nb, body).unwrap();
    crate::atomic_write::atomic_write(
        &notes_dir.join(format!("{}.myn", id.as_uuid())),
        &blob,
        replace,
    )
    .unwrap();
}

fn read_note(
    notes_dir: &std::path::Path,
    ik: &[u8; 32],
    iki: &[u8; 16],
    id: &NoteId,
) -> Option<Vec<u8>> {
    let nb = *id.as_uuid().as_bytes();
    let blob = std::fs::read(notes_dir.join(format!("{}.myn", id.as_uuid()))).ok()?;
    Some(decode_note(&blob, &nb, ik, iki).ok()?.plaintext().to_vec())
}

/// The user's real shape: a vault larger than the server page size (300 notes
/// against the 256-blob page) replicates fully to a fresh device across
/// multiple pull pages. Guards the cursor-drain loop + reconcile at scale.
#[test]
fn large_vault_300_notes_replicates_across_pages() {
    let Some((_guard, url)) = spawn_server() else {
        eprintln!("SKIP large_vault_300: server binary not found");
        return;
    };
    let root_key = [0x71u8; 32];
    let account_hash = [0x72u8; 16];
    let secret = derive_subkey(&root_key, SubkeyRole::ServerAuth);
    let items_key = [0x73u8; 32];
    let items_key_id = [0x74u8; 16];
    let dir_a = std::env::temp_dir().join(format!("myne-large-A-{}", std::process::id()));
    let dir_b = std::env::temp_dir().join(format!("myne-large-B-{}", std::process::id()));
    let notes_a = dir_a.join("notes");
    let notes_b = dir_b.join("notes");
    std::fs::create_dir_all(&notes_a).unwrap();
    std::fs::create_dir_all(&notes_b).unwrap();

    let mut ids = Vec::new();
    for i in 0..300u32 {
        let note = NoteId::new_v7();
        write_note(
            &notes_a,
            &items_key,
            &items_key_id,
            &note,
            format!("note {i}").as_bytes(),
            false,
        );
        ids.push(note);
    }
    let (ta, dev_a, tok_a) = enroll_device(
        &url,
        &account_hash,
        secret.as_slice(),
        "a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0",
        true,
    );
    let push = run_cycle_legacy(
        ta.as_ref(),
        &root_key,
        account_hash,
        dev_a,
        &tok_a,
        &notes_a,
        &dir_a,
        true,
    )
    .expect("A push 300");
    assert_eq!(push.pushed, 300, "A pushed all 300 notes in one cycle");

    let (tb, dev_b, tok_b) = enroll_device(
        &url,
        &account_hash,
        secret.as_slice(),
        "b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1",
        false,
    );
    let pull = run_cycle_legacy(
        tb.as_ref(),
        &root_key,
        account_hash,
        dev_b,
        &tok_b,
        &notes_b,
        &dir_b,
        true,
    )
    .expect("B pull 300");
    assert_eq!(pull.pulled, 300, "B pulled all 300 notes across pages");
    assert_eq!(
        read_note(&notes_b, &items_key, &items_key_id, &ids[0]).as_deref(),
        Some(&b"note 0"[..])
    );
    assert_eq!(
        read_note(&notes_b, &items_key, &items_key_id, &ids[299]).as_deref(),
        Some(&b"note 299"[..])
    );

    std::fs::remove_dir_all(&dir_a).ok();
    std::fs::remove_dir_all(&dir_b).ok();
}

/// A corpus larger than one push chunk travels as several `/sync/push`
/// requests, and the head rides the LAST one (myne-md/myne#222).
///
/// That ordering is the whole reason chunking needs no protocol change: the
/// head the server accepts still commits only blobs it already holds, which is
/// SYNC-5 blobs-first-then-head (`sync-protocol.md` §5) stated over several
/// requests instead of one. A head on an intermediate chunk would commit a
/// manifest covering blobs still in flight.
#[test]
fn a_large_push_is_chunked_and_the_head_rides_the_last_chunk() {
    let Some((_guard, url)) = spawn_server() else {
        eprintln!("SKIP push_chunking: server binary not found");
        return;
    };
    let root_key = [0x91u8; 32];
    let account_hash = [0x92u8; 16];
    let secret = derive_subkey(&root_key, SubkeyRole::ServerAuth);
    let items_key = [0x93u8; 32];
    let items_key_id = [0x94u8; 16];
    let dir_a = std::env::temp_dir().join(format!("myne-chunk-A-{}", std::process::id()));
    let dir_b = std::env::temp_dir().join(format!("myne-chunk-B-{}", std::process::id()));
    let notes_a = dir_a.join("notes");
    let notes_b = dir_b.join("notes");
    std::fs::create_dir_all(&notes_a).unwrap();
    std::fs::create_dir_all(&notes_b).unwrap();

    // One more than a whole chunk, so the split is exercised and asymmetric.
    let n = PUSH_CHUNK_MAX_BLOBS + 44;
    for i in 0..n {
        write_note(
            &notes_a,
            &items_key,
            &items_key_id,
            &NoteId::new_v7(),
            format!("note {i}").as_bytes(),
            false,
        );
    }
    let (ta, dev_a, tok_a) = enroll_device(
        &url,
        &account_hash,
        secret.as_slice(),
        "a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0",
        true,
    );
    let obs = PushObserver::new(ta, None);
    let push = run_cycle_legacy(
        &obs,
        &root_key,
        account_hash,
        dev_a,
        &tok_a,
        &notes_a,
        &dir_a,
        true,
    )
    .expect("A push");

    assert_eq!(push.pushed, n, "every blob landed across the chunks");
    assert!(push.head_advanced, "the head advanced exactly once");
    assert_eq!(
        obs.pushes(),
        vec![false, true],
        "two /sync/push requests, and only the LAST carried a new_head"
    );

    // The head still describes the whole corpus: a fresh device materialises
    // every note from it, so chunking did not split the manifest.
    let (tb, dev_b, tok_b) = enroll_device(
        &url,
        &account_hash,
        secret.as_slice(),
        "b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1",
        false,
    );
    let pull = run_cycle_legacy(
        tb.as_ref(),
        &root_key,
        account_hash,
        dev_b,
        &tok_b,
        &notes_b,
        &dir_b,
        true,
    )
    .expect("B pull");
    assert_eq!(pull.pulled, n, "B materialised the whole corpus");
    assert!(
        read_sync_state(&dir_b).unwrap().corpus_complete,
        "B's local manifest matches the head's — the head covers every chunk"
    );

    std::fs::remove_dir_all(&dir_a).ok();
    std::fs::remove_dir_all(&dir_b).ok();
}

/// The myne-md/myne#222 regression, in miniature: a first sync whose push dies
/// partway must leave the landed chunks RECORDED, so the next cycle finishes the
/// job instead of re-sending everything from an empty baseline forever.
///
/// Before the fix this vault pushed once, and a transport failure there recorded
/// nothing at all (`sync-state.json` → `blobs: 0`) — which is exactly what was
/// observed on the 50 000-note vault, and why every subsequent cycle repeated the
/// same multi-minute round trip and failed identically.
#[test]
fn a_push_that_dies_midway_resumes_instead_of_wedging() {
    let Some((_guard, url)) = spawn_server() else {
        eprintln!("SKIP push_resume: server binary not found");
        return;
    };
    let root_key = [0x95u8; 32];
    let account_hash = [0x96u8; 16];
    let secret = derive_subkey(&root_key, SubkeyRole::ServerAuth);
    let items_key = [0x97u8; 32];
    let items_key_id = [0x98u8; 16];
    let dir_a = std::env::temp_dir().join(format!("myne-resume-A-{}", std::process::id()));
    let dir_b = std::env::temp_dir().join(format!("myne-resume-B-{}", std::process::id()));
    let notes_a = dir_a.join("notes");
    let notes_b = dir_b.join("notes");
    std::fs::create_dir_all(&notes_a).unwrap();
    std::fs::create_dir_all(&notes_b).unwrap();

    let n = PUSH_CHUNK_MAX_BLOBS + 44;
    let mut ids = Vec::new();
    for i in 0..n {
        let note = NoteId::new_v7();
        write_note(
            &notes_a,
            &items_key,
            &items_key_id,
            &note,
            format!("note {i}").as_bytes(),
            false,
        );
        ids.push(note);
    }
    let (ta, dev_a, tok_a) = enroll_device(
        &url,
        &account_hash,
        secret.as_slice(),
        "a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0",
        true,
    );
    // Kill the SECOND push below HTTP — the shape a socket deadline produces
    // once the request body is out and the server is still working.
    let obs = PushObserver::new(ta, Some(2));

    let err = run_cycle_legacy(
        &obs,
        &root_key,
        account_hash,
        dev_a,
        &tok_a,
        &notes_a,
        &dir_a,
        true,
    )
    .expect_err("the cycle fails with the second chunk");
    assert!(
        matches!(
            err,
            SyncCycleError::Push(PushError::Transport(TransportError::Network))
        ),
        "failed at the transport, not on a CAS: {err:?}"
    );

    let after_fail = read_sync_state(&dir_a).unwrap();
    assert_eq!(
        after_fail.blobs.len(),
        PUSH_CHUNK_MAX_BLOBS,
        "the chunk that LANDED was checkpointed (pre-fix: 0, and the account wedged)"
    );
    assert!(
        std::fs::read(dir_a.join("vault.head-state")).is_err(),
        "no head baseline: the head rides the last chunk, which never went out"
    );

    // Next cycle: only the remainder is dirty, and it converges.
    let resumed = run_cycle_legacy(
        &obs,
        &root_key,
        account_hash,
        dev_a,
        &tok_a,
        &notes_a,
        &dir_a,
        true,
    )
    .expect("the retry cycle completes");
    assert_eq!(
        resumed.pushed,
        n - PUSH_CHUNK_MAX_BLOBS,
        "only the blobs that never landed were re-sent"
    );
    assert!(
        resumed.head_advanced,
        "the head landed on the resumed cycle"
    );
    assert_eq!(
        read_sync_state(&dir_a).unwrap().blobs.len(),
        n,
        "every blob now has a baseline"
    );

    // The account is genuinely converged, not merely locally consistent.
    let (tb, dev_b, tok_b) = enroll_device(
        &url,
        &account_hash,
        secret.as_slice(),
        "b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1",
        false,
    );
    let pull = run_cycle_legacy(
        tb.as_ref(),
        &root_key,
        account_hash,
        dev_b,
        &tok_b,
        &notes_b,
        &dir_b,
        true,
    )
    .expect("B pull");
    assert_eq!(
        pull.pulled, n,
        "a fresh device materialises the whole corpus"
    );
    assert_eq!(
        read_note(&notes_b, &items_key, &items_key_id, &ids[0]).as_deref(),
        Some(&b"note 0"[..])
    );

    std::fs::remove_dir_all(&dir_a).ok();
    std::fs::remove_dir_all(&dir_b).ok();
}

/// A blob the server already holds at OUR revision, with no local baseline
/// saying so, is ADOPTED — not re-pushed at `base_version = 0`.
///
/// **Characterization, not a new mechanism.** myne-md/myne#222 asks for this as
/// a fix ("a device that finds the server holding a blob whose `content_nonce`
/// matches its own local copy should adopt that version as its baseline"); the
/// §11.2 baseline reconcile above `pull_to_stable`'s roster already does it, for
/// every id the server reports, since MYND-426. What was missing was a test in
/// the state the 50 000-note vault was actually observed in — `blobs: 0`,
/// `cursor: 0`, no `vault.head-state`, server holding the blobs — as opposed to
/// `empty_baseline_self_heals_and_local_edit_pushes`, which keeps the cursor and
/// the head baseline and has a genuine local edit to push. Pinning it is what
/// stops a future change from quietly removing the property and re-opening the
/// wedge from the other side.
#[test]
fn an_unrecorded_landed_blob_adopts_the_server_version() {
    let Some((_guard, url)) = spawn_server() else {
        eprintln!("SKIP adopt_landed_blob: server binary not found");
        return;
    };
    let root_key = [0x99u8; 32];
    let account_hash = [0x9Au8; 16];
    let secret = derive_subkey(&root_key, SubkeyRole::ServerAuth);
    let items_key = [0x9Bu8; 32];
    let items_key_id = [0x9Cu8; 16];
    let dir_a = std::env::temp_dir().join(format!("myne-adopt-A-{}", std::process::id()));
    let notes_a = dir_a.join("notes");
    std::fs::create_dir_all(&notes_a).unwrap();

    let note = NoteId::new_v7();
    write_note(&notes_a, &items_key, &items_key_id, &note, b"body", false);
    let (ta, dev_a, tok_a) = enroll_device(
        &url,
        &account_hash,
        secret.as_slice(),
        "a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0",
        true,
    );
    run_cycle_legacy(
        ta.as_ref(),
        &root_key,
        account_hash,
        dev_a,
        &tok_a,
        &notes_a,
        &dir_a,
        true,
    )
    .expect("initial push");

    // Reproduce the observed post-failure state: the server holds the blob, the
    // device recorded nothing about it and has no head baseline either.
    let mut st = read_sync_state(&dir_a).unwrap();
    assert!(!st.blobs.is_empty(), "the initial push recorded a baseline");
    st.blobs.clear();
    st.cursor = 0;
    write_sync_state(&dir_a, &st).unwrap();
    std::fs::remove_file(dir_a.join("vault.head-state")).unwrap();

    let obs = PushObserver::new(ta, None);
    let summary = run_cycle_legacy(
        &obs,
        &root_key,
        account_hash,
        dev_a,
        &tok_a,
        &notes_a,
        &dir_a,
        true,
    )
    .expect("the recovery cycle succeeds");

    assert!(
        obs.pushes().is_empty(),
        "nothing was pushed at all — the server's revision IS ours"
    );
    assert_eq!(summary.pushed, 0);
    assert!(
        summary.conflicts.is_empty(),
        "an identical blob is no conflict"
    );
    let healed = read_sync_state(&dir_a).unwrap();
    assert_eq!(
        healed
            .blobs
            .get(&hex(note.as_uuid().as_bytes()))
            .map(|b| b.version),
        Some(1),
        "the server's version became the baseline"
    );

    std::fs::remove_dir_all(&dir_a).ok();
}

/// An offline delete propagates to a device that was up-to-date before the
/// delete: with an intact baseline the pull correctly DOWNLOADS the deletion
/// (not treated as a local edit), so the note does not resurrect.
#[test]
fn offline_delete_propagates_with_intact_baseline() {
    let Some((_guard, url)) = spawn_server() else {
        eprintln!("SKIP offline_delete: server binary not found");
        return;
    };
    let root_key = [0x61u8; 32];
    let account_hash = [0x62u8; 16];
    let secret = derive_subkey(&root_key, SubkeyRole::ServerAuth);
    let items_key = [0x63u8; 32];
    let items_key_id = [0x64u8; 16];
    let dir_a = std::env::temp_dir().join(format!("myne-del-A-{}", std::process::id()));
    let dir_b = std::env::temp_dir().join(format!("myne-del-B-{}", std::process::id()));
    let notes_a = dir_a.join("notes");
    let notes_b = dir_b.join("notes");
    std::fs::create_dir_all(&notes_a).unwrap();
    std::fs::create_dir_all(&notes_b).unwrap();
    let note = NoteId::new_v7();

    // A authors X "live", pushes; B syncs (B now holds X live, baseline intact).
    write_note(
        &notes_a,
        &items_key,
        &items_key_id,
        &note,
        b"live body",
        false,
    );
    let (ta, dev_a, tok_a) = enroll_device(
        &url,
        &account_hash,
        secret.as_slice(),
        "a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0",
        true,
    );
    run_cycle_legacy(
        ta.as_ref(),
        &root_key,
        account_hash,
        dev_a,
        &tok_a,
        &notes_a,
        &dir_a,
        true,
    )
    .expect("A push live");
    let (tb, dev_b, tok_b) = enroll_device(
        &url,
        &account_hash,
        secret.as_slice(),
        "b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1",
        false,
    );
    run_cycle_legacy(
        tb.as_ref(),
        &root_key,
        account_hash,
        dev_b,
        &tok_b,
        &notes_b,
        &dir_b,
        true,
    )
    .expect("B initial pull");
    assert_eq!(
        read_note(&notes_b, &items_key, &items_key_id, &note).as_deref(),
        Some(&b"live body"[..]),
        "B has the live note"
    );

    // A "deletes" X (the tombstone re-encrypts the blob with the deleted marker
    // → a fresh content_nonce). A pushes.
    write_note(
        &notes_a,
        &items_key,
        &items_key_id,
        &note,
        b"deleted: 2026-06-21T00:00:00Z",
        true,
    );
    run_cycle_legacy(
        ta.as_ref(),
        &root_key,
        account_hash,
        dev_a,
        &tok_a,
        &notes_a,
        &dir_a,
        true,
    )
    .expect("A push delete");

    // B syncs: must DOWNLOAD the deletion (B never edited → not locally dirty).
    run_cycle_legacy(
        tb.as_ref(),
        &root_key,
        account_hash,
        dev_b,
        &tok_b,
        &notes_b,
        &dir_b,
        true,
    )
    .expect("B pull delete");
    assert_eq!(
        read_note(&notes_b, &items_key, &items_key_id, &note).as_deref(),
        Some(&b"deleted: 2026-06-21T00:00:00Z"[..]),
        "the deletion propagated to B (no resurrection)"
    );

    std::fs::remove_dir_all(&dir_a).ok();
    std::fs::remove_dir_all(&dir_b).ok();
}

/// Concurrent same-note edit must NOT wedge the vault. Device B edits X (which
/// A also edited + pushed) AND adds an unrelated note Y, then syncs. B's cycle
/// succeeds: the X conflict is surfaced + EXCLUDED from the push (so it can't
/// fail the atomic batch CAS), Y pushes regardless, and B's local X edit is
/// left untouched. Both revisions survive (B's edit on B, A's edit on the
/// server) — no silent loss, no wedge. The auto-materialization of the remote
/// revision as a conflict copy is the follow-up below.
#[test]
fn concurrent_edit_no_wedge_and_surfaces_conflict() {
    let Some((_guard, url)) = spawn_server() else {
        eprintln!("SKIP concurrent_no_wedge: server binary not found");
        return;
    };
    let root_key = [0x81u8; 32];
    let account_hash = [0x82u8; 16];
    let secret = derive_subkey(&root_key, SubkeyRole::ServerAuth);
    let items_key = [0x83u8; 32];
    let items_key_id = [0x84u8; 16];
    let dir_a = std::env::temp_dir().join(format!("myne-conf-A-{}", std::process::id()));
    let dir_b = std::env::temp_dir().join(format!("myne-conf-B-{}", std::process::id()));
    let dir_c = std::env::temp_dir().join(format!("myne-conf-C-{}", std::process::id()));
    let notes_a = dir_a.join("notes");
    let notes_b = dir_b.join("notes");
    let notes_c = dir_c.join("notes");
    std::fs::create_dir_all(&notes_a).unwrap();
    std::fs::create_dir_all(&notes_b).unwrap();
    std::fs::create_dir_all(&notes_c).unwrap();
    let x = NoteId::new_v7();

    // Both devices reach a synced baseline of X.
    write_note(&notes_a, &items_key, &items_key_id, &x, b"base", false);
    let (ta, dev_a, tok_a) = enroll_device(
        &url,
        &account_hash,
        secret.as_slice(),
        "a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0",
        true,
    );
    run_cycle_legacy(
        ta.as_ref(),
        &root_key,
        account_hash,
        dev_a,
        &tok_a,
        &notes_a,
        &dir_a,
        true,
    )
    .expect("A push base");
    let (tb, dev_b, tok_b) = enroll_device(
        &url,
        &account_hash,
        secret.as_slice(),
        "b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1",
        false,
    );
    run_cycle_legacy(
        tb.as_ref(),
        &root_key,
        account_hash,
        dev_b,
        &tok_b,
        &notes_b,
        &dir_b,
        true,
    )
    .expect("B pull base");

    // A edits X and pushes (server X advances). B edits X offline AND adds a
    // fresh note Y, then syncs.
    write_note(
        &notes_a,
        &items_key,
        &items_key_id,
        &x,
        b"edit from A",
        true,
    );
    run_cycle_legacy(
        ta.as_ref(),
        &root_key,
        account_hash,
        dev_a,
        &tok_a,
        &notes_a,
        &dir_a,
        true,
    )
    .expect("A push edit");
    write_note(
        &notes_b,
        &items_key,
        &items_key_id,
        &x,
        b"edit from B",
        true,
    );
    let y = NoteId::new_v7();
    write_note(
        &notes_b,
        &items_key,
        &items_key_id,
        &y,
        b"unrelated note",
        false,
    );
    let summary = run_cycle_legacy(
        tb.as_ref(),
        &root_key,
        account_hash,
        dev_b,
        &tok_b,
        &notes_b,
        &dir_b,
        true,
    )
    .expect("B sync must succeed despite the conflict (no wedge)");

    assert_eq!(summary.conflicts.len(), 1, "the X conflict is surfaced");
    assert_eq!(
        summary.conflicts[0].conflict_of_hex,
        hex(x.as_uuid().as_bytes()),
        "conflict names X"
    );
    assert!(
        summary.pushed >= 1,
        "the unrelated note Y pushed despite the conflict (no wedge)"
    );
    assert_eq!(
        read_note(&notes_b, &items_key, &items_key_id, &x).as_deref(),
        Some(&b"edit from B"[..]),
        "B's X edit untouched"
    );

    // Y reached the server and A's X edit is preserved there — no revision lost.
    let (tc, dev_c, tok_c) = enroll_device(
        &url,
        &account_hash,
        secret.as_slice(),
        "c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2",
        false,
    );
    run_cycle_legacy(
        tc.as_ref(),
        &root_key,
        account_hash,
        dev_c,
        &tok_c,
        &notes_c,
        &dir_c,
        true,
    )
    .expect("C pull");
    assert_eq!(
        read_note(&notes_c, &items_key, &items_key_id, &y).as_deref(),
        Some(&b"unrelated note"[..]),
        "Y synced through to C"
    );
    assert_eq!(
        read_note(&notes_c, &items_key, &items_key_id, &x).as_deref(),
        Some(&b"edit from A"[..]),
        "A's X edit preserved on the server"
    );

    std::fs::remove_dir_all(&dir_a).ok();
    std::fs::remove_dir_all(&dir_b).ok();
    std::fs::remove_dir_all(&dir_c).ok();
}

/// Full keep-both: after a concurrent edit, B materializes A's revision as a
/// conflict copy (a new note) and keeps its own edit at X — both survive and
/// converge to a third device. The engine stages A's blob + surfaces the plan;
/// the test plays the notes layer's part (decrypt the staged blob → create the
/// copy → resolve_conflict adopts the baseline). End-to-end through `C`.
#[test]
fn concurrent_same_note_edit_materializes_keep_both_copy() {
    let Some((_guard, url)) = spawn_server() else {
        eprintln!("SKIP keep_both: server binary not found");
        return;
    };
    let root_key = [0x91u8; 32];
    let account_hash = [0x92u8; 16];
    let secret = derive_subkey(&root_key, SubkeyRole::ServerAuth);
    let items_key = [0x93u8; 32];
    let items_key_id = [0x94u8; 16];
    let dir_a = std::env::temp_dir().join(format!("myne-kb-A-{}", std::process::id()));
    let dir_b = std::env::temp_dir().join(format!("myne-kb-B-{}", std::process::id()));
    let dir_c = std::env::temp_dir().join(format!("myne-kb-C-{}", std::process::id()));
    let notes_a = dir_a.join("notes");
    let notes_b = dir_b.join("notes");
    let notes_c = dir_c.join("notes");
    std::fs::create_dir_all(&notes_a).unwrap();
    std::fs::create_dir_all(&notes_b).unwrap();
    std::fs::create_dir_all(&notes_c).unwrap();
    let x = NoteId::new_v7();

    // Both reach a synced baseline of X; A edits + pushes; B edits offline.
    write_note(&notes_a, &items_key, &items_key_id, &x, b"base", false);
    let (ta, dev_a, tok_a) = enroll_device(
        &url,
        &account_hash,
        secret.as_slice(),
        "a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0",
        true,
    );
    run_cycle_legacy(
        ta.as_ref(),
        &root_key,
        account_hash,
        dev_a,
        &tok_a,
        &notes_a,
        &dir_a,
        true,
    )
    .expect("A push base");
    let (tb, dev_b, tok_b) = enroll_device(
        &url,
        &account_hash,
        secret.as_slice(),
        "b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1",
        false,
    );
    run_cycle_legacy(
        tb.as_ref(),
        &root_key,
        account_hash,
        dev_b,
        &tok_b,
        &notes_b,
        &dir_b,
        true,
    )
    .expect("B pull base");
    write_note(
        &notes_a,
        &items_key,
        &items_key_id,
        &x,
        b"edit from A",
        true,
    );
    run_cycle_legacy(
        ta.as_ref(),
        &root_key,
        account_hash,
        dev_a,
        &tok_a,
        &notes_a,
        &dir_a,
        true,
    )
    .expect("A push edit");
    write_note(
        &notes_b,
        &items_key,
        &items_key_id,
        &x,
        b"edit from B",
        true,
    );

    // B's conflict cycle: A's revision is staged + surfaced; X is excluded.
    let s1 = run_cycle_legacy(
        tb.as_ref(),
        &root_key,
        account_hash,
        dev_b,
        &tok_b,
        &notes_b,
        &dir_b,
        true,
    )
    .expect("B conflict cycle");
    assert_eq!(s1.conflicts.len(), 1, "conflict surfaced");
    let x_hex = hex(x.as_uuid().as_bytes());
    assert_eq!(
        list_pending_conflicts(&dir_b),
        vec![x_hex.clone()],
        "A's revision staged"
    );

    // --- the notes layer's part (TS `createConflictCopy` + resolve) ---
    let staged = read_staged_conflict_blob(&dir_b, &x_hex).expect("staged blob");
    let remote_body = decode_note(&staged, x.as_uuid().as_bytes(), &items_key, &items_key_id)
        .unwrap()
        .plaintext()
        .to_vec();
    assert_eq!(
        remote_body, b"edit from A",
        "staged remote revision decrypts to A's edit"
    );
    // Materialize the copy as a new note (TS adds the conflict_of frontmatter;
    // the engine flow only needs both bodies to survive + converge).
    let z = NoteId::new_v7();
    write_note(&notes_b, &items_key, &items_key_id, &z, &remote_body, false);
    resolve_conflict(&dir_b, &x_hex).expect("resolve");
    assert!(
        list_pending_conflicts(&dir_b).is_empty(),
        "staging cleared after resolve"
    );

    // B re-syncs: X (edit-B) now pushes as a clean linear advance + the copy Z.
    let s2 = run_cycle_legacy(
        tb.as_ref(),
        &root_key,
        account_hash,
        dev_b,
        &tok_b,
        &notes_b,
        &dir_b,
        true,
    )
    .expect("B push resolved");
    assert!(s2.conflicts.is_empty(), "no conflict after resolution");
    assert_eq!(
        read_note(&notes_b, &items_key, &items_key_id, &x).as_deref(),
        Some(&b"edit from B"[..]),
        "B keeps its own edit at X"
    );

    // A third device sees BOTH revisions — neither edit was lost.
    let (tc, dev_c, tok_c) = enroll_device(
        &url,
        &account_hash,
        secret.as_slice(),
        "c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2",
        false,
    );
    run_cycle_legacy(
        tc.as_ref(),
        &root_key,
        account_hash,
        dev_c,
        &tok_c,
        &notes_c,
        &dir_c,
        true,
    )
    .expect("C pull");
    assert_eq!(
        read_note(&notes_c, &items_key, &items_key_id, &x).as_deref(),
        Some(&b"edit from B"[..]),
        "C sees X = B's edit"
    );
    assert_eq!(
        read_note(&notes_c, &items_key, &items_key_id, &z).as_deref(),
        Some(&b"edit from A"[..]),
        "C sees the keep-both copy = A's edit"
    );

    std::fs::remove_dir_all(&dir_a).ok();
    std::fs::remove_dir_all(&dir_b).ok();
    std::fs::remove_dir_all(&dir_c).ok();
}

/// A device whose token is revoked mid-life fails its next cycle cleanly with
/// `Unauthenticated` (not a corrupt-state commit), and a held local edit
/// survives untouched so a re-enrolled device can still push it. Real
/// multi-device "remove this device" flow.
#[test]
fn revoked_token_fails_cycle_cleanly_without_losing_local_edit() {
    let Some((_guard, url)) = spawn_server() else {
        eprintln!("SKIP revoked_token: server binary not found");
        return;
    };
    let root_key = [0xa1u8; 32];
    let account_hash = [0xa2u8; 16];
    let secret = derive_subkey(&root_key, SubkeyRole::ServerAuth);
    let items_key = [0xa3u8; 32];
    let items_key_id = [0xa4u8; 16];
    let dir_a = std::env::temp_dir().join(format!("myne-rev-A-{}", std::process::id()));
    let dir_b = std::env::temp_dir().join(format!("myne-rev-B-{}", std::process::id()));
    let notes_a = dir_a.join("notes");
    let notes_b = dir_b.join("notes");
    std::fs::create_dir_all(&notes_a).unwrap();
    std::fs::create_dir_all(&notes_b).unwrap();

    // A (owner) enrolls + pushes a note; B enrolls (self-approves via recovery)
    // and syncs once so it holds a valid token + the note.
    let note = NoteId::new_v7();
    write_note(&notes_a, &items_key, &items_key_id, &note, b"shared", false);
    let (ta, dev_a, tok_a) = enroll_device(
        &url,
        &account_hash,
        secret.as_slice(),
        "a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0",
        true,
    );
    run_cycle_legacy(
        ta.as_ref(),
        &root_key,
        account_hash,
        dev_a,
        &tok_a,
        &notes_a,
        &dir_a,
        true,
    )
    .expect("A push");
    let (tb, dev_b, tok_b) = enroll_device(
        &url,
        &account_hash,
        secret.as_slice(),
        "b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1",
        false,
    );
    run_cycle_legacy(
        tb.as_ref(),
        &root_key,
        account_hash,
        dev_b,
        &tok_b,
        &notes_b,
        &dir_b,
        true,
    )
    .expect("B initial sync");

    // The owner revokes B. B makes a local edit, then tries to sync with its
    // now-dead token.
    crate::plugins::sync::devices::revoke_device(ta.as_ref(), &tok_a, &dev_b)
        .expect("owner revokes B");
    write_note(
        &notes_b,
        &items_key,
        &items_key_id,
        &note,
        b"B unsynced edit",
        true,
    );
    let err = run_cycle_legacy(
        tb.as_ref(),
        &root_key,
        account_hash,
        dev_b,
        &tok_b,
        &notes_b,
        &dir_b,
        true,
    )
    .expect_err("revoked token must fail the cycle");
    // DeviceRevoked, not the generic Unauthenticated: the token did not
    // expire, the owner revoked it, and myne#294 exists precisely because
    // reporting that as a retryable "sign-in expired" showed the wrong
    // copy and suppressed the web client's terminal takeover (gated on
    // `detail === "device_revoked"`) for up to a 15-minute auth park.
    // Accepting Unauthenticated here would re-open that collapse silently.
    assert!(
        matches!(
            err,
            SyncCycleError::Pull(PullError::DeviceRevoked)
                | SyncCycleError::Push(PushError::DeviceRevoked)
        ),
        "clean DeviceRevoked, got {err:?}"
    );
    // The local edit is untouched — nothing was lost to the failed cycle.
    assert_eq!(
        read_note(&notes_b, &items_key, &items_key_id, &note).as_deref(),
        Some(&b"B unsynced edit"[..])
    );

    std::fs::remove_dir_all(&dir_a).ok();
    std::fs::remove_dir_all(&dir_b).ok();
}

/// A `cursor_expired` (410) — the server GC'd past the device's stored cursor —
/// resets the cursor to 0 and re-pulls a full reconcile, instead of looping on
/// 410 forever. Driven with a fake transport: the first pull (stale cursor)
/// 410s, the from-0 re-pull succeeds. The re-pull returns no head, so the push
/// phase authors a genesis head (§6.1 re-genesis / genesis-on-empty) — the two
/// recovery paths compose without wedging.
#[test]
fn cursor_expired_resets_and_full_reconciles() {
    use crate::plugins::sync::state::SyncState;
    use crate::plugins::sync::transport::{FakeTransport, HttpMethod};

    let dir = std::env::temp_dir().join(format!("myne-cursor-{}", std::process::id()));
    let notes = dir.join("notes");
    std::fs::create_dir_all(&notes).unwrap();
    // Persist a stale cursor the server will reject.
    let st = SyncState {
        cursor: 5,
        ..Default::default()
    };
    write_sync_state(&dir, &st).unwrap();

    let fake = FakeTransport::new();
    fake.on(
        HttpMethod::Get,
        "/sync/pull?cursor=5",
        410,
        br#"{"error_code":"cursor_expired"}"#.to_vec(),
    );
    // The recovery re-pull carries `reconcile=1` so the server exempts it from
    // the cursor-expired floor (the pagination×floor wedge fix).
    fake.on(
        HttpMethod::Get,
        "/sync/pull?cursor=0&reconcile=1",
        200,
        br#"{"metas":[],"next_cursor":0}"#.to_vec(),
    );
    // The re-pull returns no head (the server has none), so the recovery push
    // authors a genesis head over the empty corpus (§6.1 re-genesis / genesis-on-
    // empty liveness) — canned so the head-only push succeeds.
    fake.on(
            HttpMethod::Post,
            "/sync/push",
            200,
            br#"{"results":[],"head_id_hex":"3333333333333333333333333333333333333333333333333333333333333333"}"#.to_vec(),
        );

    let summary = run_cycle_legacy(
        &fake, &[0u8; 32], [0u8; 16], [0u8; 16], "tok", &notes, &dir, true,
    )
    .expect("the cycle recovers from cursor_expired");
    assert_eq!(summary.cursor, 0, "cursor reset to a full reconcile");
    assert!(
        summary.head_advanced,
        "no server head → the recovery push authors a genesis head (§6.1 re-genesis)"
    );
    assert!(
        summary.reconcile_ran,
        "the 410-recovery full reconcile sets reconcile_ran (drives the banner events)"
    );
    // The recovery re-pull from 0 actually happened, with the reconcile flag.
    let pulled_from_0 = fake
        .requests()
        .iter()
        .any(|(m, p, _, _, _)| *m == HttpMethod::Get && p == "/sync/pull?cursor=0&reconcile=1");
    assert!(
        pulled_from_0,
        "re-pulled from cursor 0 with reconcile=1 after the 410"
    );

    std::fs::remove_dir_all(&dir).ok();
}

/// A fresh device pulling a vault larger than the server's rate-limit burst
/// completes its initial sync in ONE cycle: the blob-download backoff absorbs
/// the 429s (token-bucket refill) instead of failing the whole pull. Uses a
/// deliberately low burst so the backoff path is exercised.
#[test]
fn large_initial_sync_backs_off_through_rate_limit() {
    let Some((_guard, url)) = spawn_server_env("100", "100000") else {
        eprintln!("SKIP rate_limit_backoff: server binary not found");
        return;
    };
    let root_key = [0xb1u8; 32];
    let account_hash = [0xb2u8; 16];
    let secret = derive_subkey(&root_key, SubkeyRole::ServerAuth);
    let items_key = [0xb3u8; 32];
    let items_key_id = [0xb4u8; 16];
    let dir_a = std::env::temp_dir().join(format!("myne-rl-A-{}", std::process::id()));
    let dir_b = std::env::temp_dir().join(format!("myne-rl-B-{}", std::process::id()));
    let notes_a = dir_a.join("notes");
    let notes_b = dir_b.join("notes");
    std::fs::create_dir_all(&notes_a).unwrap();
    std::fs::create_dir_all(&notes_b).unwrap();

    // 150 notes > the 100-blob burst → B's download loop will hit 429s.
    let mut ids = Vec::new();
    for i in 0..150u32 {
        let note = NoteId::new_v7();
        write_note(
            &notes_a,
            &items_key,
            &items_key_id,
            &note,
            format!("n{i}").as_bytes(),
            false,
        );
        ids.push(note);
    }
    let (ta, dev_a, tok_a) = enroll_device(
        &url,
        &account_hash,
        secret.as_slice(),
        "a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0",
        true,
    );
    run_cycle_legacy(
        ta.as_ref(),
        &root_key,
        account_hash,
        dev_a,
        &tok_a,
        &notes_a,
        &dir_a,
        true,
    )
    .expect("A push 150");
    let (tb, dev_b, tok_b) = enroll_device(
        &url,
        &account_hash,
        secret.as_slice(),
        "b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1",
        false,
    );
    let pull = run_cycle_legacy(
        tb.as_ref(),
        &root_key,
        account_hash,
        dev_b,
        &tok_b,
        &notes_b,
        &dir_b,
        true,
    )
    .expect("B initial sync completes despite the rate limit (backoff)");
    assert_eq!(
        pull.pulled, 150,
        "all 150 notes pulled in one cycle via backoff"
    );

    std::fs::remove_dir_all(&dir_a).ok();
    std::fs::remove_dir_all(&dir_b).ok();
}

/// A queued tombstone (the notes layer's `sync_mark_tombstone`) is pushed WITH
/// the server tombstone flag set, then dropped from the device-local queue; the
/// deletion still propagates to a second device.
#[test]
fn queued_tombstone_pushes_with_flag_then_clears() {
    let Some((_guard, url)) = spawn_server() else {
        eprintln!("SKIP tombstone_flag: server binary not found");
        return;
    };
    let root_key = [0xc1u8; 32];
    let account_hash = [0xc2u8; 16];
    let secret = derive_subkey(&root_key, SubkeyRole::ServerAuth);
    let items_key = [0xc3u8; 32];
    let items_key_id = [0xc4u8; 16];
    let dir_a = std::env::temp_dir().join(format!("myne-tomb-A-{}", std::process::id()));
    let dir_b = std::env::temp_dir().join(format!("myne-tomb-B-{}", std::process::id()));
    let notes_a = dir_a.join("notes");
    let notes_b = dir_b.join("notes");
    std::fs::create_dir_all(&notes_a).unwrap();
    std::fs::create_dir_all(&notes_b).unwrap();
    let x = NoteId::new_v7();

    // A authors X live + pushes; B syncs (holds the live note).
    write_note(&notes_a, &items_key, &items_key_id, &x, b"live body", false);
    let (ta, dev_a, tok_a) = enroll_device(
        &url,
        &account_hash,
        secret.as_slice(),
        "a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0",
        true,
    );
    run_cycle_legacy(
        ta.as_ref(),
        &root_key,
        account_hash,
        dev_a,
        &tok_a,
        &notes_a,
        &dir_a,
        true,
    )
    .expect("A push live");
    let (tb, dev_b, tok_b) = enroll_device(
        &url,
        &account_hash,
        secret.as_slice(),
        "b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1",
        false,
    );
    run_cycle_legacy(
        tb.as_ref(),
        &root_key,
        account_hash,
        dev_b,
        &tok_b,
        &notes_b,
        &dir_b,
        true,
    )
    .expect("B initial sync");

    // The notes layer tombstones X: queue it + write the deleted version.
    let x_hex = hex(x.as_uuid().as_bytes());
    add_pending_tombstone(&dir_a, &x_hex).expect("queue tombstone");
    write_note(
        &notes_a,
        &items_key,
        &items_key_id,
        &x,
        b"deleted: 2026-06-21T00:00:00Z",
        true,
    );

    let s = run_cycle_legacy(
        ta.as_ref(),
        &root_key,
        account_hash,
        dev_a,
        &tok_a,
        &notes_a,
        &dir_a,
        true,
    )
    .expect("A push tombstone");
    assert_eq!(s.tombstones_pushed, 1, "X pushed with the tombstone flag");
    assert!(
        read_pending_tombstones(&dir_a).is_empty(),
        "the queue cleared after the flagged push"
    );

    // The deletion propagates to B.
    run_cycle_legacy(
        tb.as_ref(),
        &root_key,
        account_hash,
        dev_b,
        &tok_b,
        &notes_b,
        &dir_b,
        true,
    )
    .expect("B pull deletion");
    assert_eq!(
        read_note(&notes_b, &items_key, &items_key_id, &x).as_deref(),
        Some(&b"deleted: 2026-06-21T00:00:00Z"[..]),
        "B sees the deletion"
    );

    std::fs::remove_dir_all(&dir_a).ok();
    std::fs::remove_dir_all(&dir_b).ok();
}

/// Regression (the Windows→Mac sync wedge): a conflict detected in an EARLIER
/// cycle (while the blob was in the pull window) must STAY excluded from the push
/// after the cursor advances past it. Otherwise the next local edit re-pushes the
/// note at its now-stale `base_version`, the server CAS 409s, and — because the
/// push is one atomic batch — the whole batch wedges, so an innocent sibling note
/// can never reach the server either. The fix excludes any note whose remote
/// revision is still staged as an unresolved keep-both conflict.
#[test]
fn staged_conflict_stays_excluded_and_sibling_pushes_after_cursor_advance() {
    let Some((_guard, url)) = spawn_server() else {
        eprintln!("SKIP staged_conflict_stays_excluded: server binary not found");
        return;
    };
    let root_key = [0x91u8; 32];
    let account_hash = [0x92u8; 16];
    let secret = derive_subkey(&root_key, SubkeyRole::ServerAuth);
    let items_key = [0x93u8; 32];
    let items_key_id = [0x94u8; 16];
    let dir_a = std::env::temp_dir().join(format!("myne-wedge-A-{}", std::process::id()));
    let dir_b = std::env::temp_dir().join(format!("myne-wedge-B-{}", std::process::id()));
    let dir_c = std::env::temp_dir().join(format!("myne-wedge-C-{}", std::process::id()));
    let notes_a = dir_a.join("notes");
    let notes_b = dir_b.join("notes");
    let notes_c = dir_c.join("notes");
    std::fs::create_dir_all(&notes_a).unwrap();
    std::fs::create_dir_all(&notes_b).unwrap();
    std::fs::create_dir_all(&notes_c).unwrap();
    let x = NoteId::new_v7();
    let x_hex = hex(x.as_uuid().as_bytes());

    // A authors X, pushes; B pulls X to a synced baseline (v1).
    write_note(&notes_a, &items_key, &items_key_id, &x, b"base", false);
    let (ta, dev_a, tok_a) = enroll_device(
        &url,
        &account_hash,
        secret.as_slice(),
        "a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0",
        true,
    );
    run_cycle_legacy(
        ta.as_ref(),
        &root_key,
        account_hash,
        dev_a,
        &tok_a,
        &notes_a,
        &dir_a,
        true,
    )
    .expect("A push base");
    let (tb, dev_b, tok_b) = enroll_device(
        &url,
        &account_hash,
        secret.as_slice(),
        "b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1",
        false,
    );
    run_cycle_legacy(
        tb.as_ref(),
        &root_key,
        account_hash,
        dev_b,
        &tok_b,
        &notes_b,
        &dir_b,
        true,
    )
    .expect("B pull base");

    // A edits X and pushes (server X→v2, change-seq advances past X). B edits X
    // offline (concurrent) — it has NOT yet pulled A's revision.
    write_note(
        &notes_a,
        &items_key,
        &items_key_id,
        &x,
        b"edit from A",
        true,
    );
    run_cycle_legacy(
        ta.as_ref(),
        &root_key,
        account_hash,
        dev_a,
        &tok_a,
        &notes_a,
        &dir_a,
        true,
    )
    .expect("A push edit");
    write_note(
        &notes_b,
        &items_key,
        &items_key_id,
        &x,
        b"edit from B",
        true,
    );

    // B cycle #1: pulls A's X@v2 (in window) → conflict detected, staged, and
    // excluded. B's cursor advances PAST X's change-seq. Nothing pushes (X is the
    // only dirty note), and the conflict is left UNRESOLVED (no materialization).
    let s1 = run_cycle_legacy(
        tb.as_ref(),
        &root_key,
        account_hash,
        dev_b,
        &tok_b,
        &notes_b,
        &dir_b,
        true,
    )
    .expect("B cycle 1 surfaces the conflict without wedging");
    assert_eq!(s1.conflicts.len(), 1, "cycle 1 surfaces the X conflict");
    assert_eq!(
        s1.pushed, 0,
        "nothing pushed in cycle 1 (X is the only dirty note)"
    );
    assert!(
        list_pending_conflicts(&dir_b).contains(&x_hex),
        "X is staged pending after cycle 1"
    );

    // B now edits an innocent sibling note Y.
    let y = NoteId::new_v7();
    write_note(
        &notes_b,
        &items_key,
        &items_key_id,
        &y,
        b"innocent sibling",
        false,
    );

    // B cycle #2: X is now OUTSIDE the pull window (the cursor advanced past it in
    // cycle 1). Before the fix, X would be re-pushed at its stale base_version →
    // 409 blob_stale → the whole batch (including Y) wedges and the cycle errors.
    // The fix excludes the still-staged X, so Y pushes cleanly and the cycle is Ok.
    let s2 = run_cycle_legacy(
        tb.as_ref(),
        &root_key,
        account_hash,
        dev_b,
        &tok_b,
        &notes_b,
        &dir_b,
        true,
    )
    .expect("B cycle 2 must NOT wedge — the staged conflict is excluded, Y pushes");
    assert!(
        s2.pushed >= 1,
        "the innocent sibling Y pushed despite the unresolved conflict"
    );

    // B's local X edit is untouched, and X stays a pending conflict until resolved.
    assert_eq!(
        read_note(&notes_b, &items_key, &items_key_id, &x).as_deref(),
        Some(&b"edit from B"[..]),
        "B's X edit untouched (never overwritten by the conflicting remote)"
    );
    assert!(
        list_pending_conflicts(&dir_b).contains(&x_hex),
        "X stays a pending conflict until the keep-both is resolved"
    );

    // Y reached the server (a fresh device C pulls it); A's X@v2 is preserved.
    let (tc, dev_c, tok_c) = enroll_device(
        &url,
        &account_hash,
        secret.as_slice(),
        "c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2",
        false,
    );
    run_cycle_legacy(
        tc.as_ref(),
        &root_key,
        account_hash,
        dev_c,
        &tok_c,
        &notes_c,
        &dir_c,
        true,
    )
    .expect("C pull");
    assert_eq!(
        read_note(&notes_c, &items_key, &items_key_id, &y).as_deref(),
        Some(&b"innocent sibling"[..]),
        "Y synced through to C (no wedge)"
    );
    assert_eq!(
        read_note(&notes_c, &items_key, &items_key_id, &x).as_deref(),
        Some(&b"edit from A"[..]),
        "A's X edit preserved on the server"
    );

    std::fs::remove_dir_all(&dir_a).ok();
    std::fs::remove_dir_all(&dir_b).ok();
    std::fs::remove_dir_all(&dir_c).ok();
}

/// Regression: the reactive lost-CAS recovery. A push that 409s `blob_stale` for
/// a blob that is NOT a pre-staged conflict and sits OUTSIDE the cursor window
/// (a baseline that fell behind the server — the partial-commit / corrupted-state
/// class) must NOT propagate the error and wedge forever. The cycle re-pulls a
/// full reconcile, re-detects the blob as a conflict against the now-complete
/// roster, excludes it, and succeeds.
#[test]
fn blob_stale_recovers_via_full_reconcile_retry() {
    let Some((_guard, url)) = spawn_server() else {
        eprintln!("SKIP blob_stale_recovers: server binary not found");
        return;
    };
    let root_key = [0xA1u8; 32];
    let account_hash = [0xA2u8; 16];
    let secret = derive_subkey(&root_key, SubkeyRole::ServerAuth);
    let items_key = [0xA3u8; 32];
    let items_key_id = [0xA4u8; 16];
    let dir_a = std::env::temp_dir().join(format!("myne-retry-A-{}", std::process::id()));
    let dir_b = std::env::temp_dir().join(format!("myne-retry-B-{}", std::process::id()));
    let notes_a = dir_a.join("notes");
    let notes_b = dir_b.join("notes");
    std::fs::create_dir_all(&notes_a).unwrap();
    std::fs::create_dir_all(&notes_b).unwrap();
    let x = NoteId::new_v7();
    let x_hex = hex(x.as_uuid().as_bytes());

    // A authors X, pushes (v1). B pulls X to a clean baseline (v1).
    write_note(&notes_a, &items_key, &items_key_id, &x, b"base", false);
    let (ta, dev_a, tok_a) = enroll_device(
        &url,
        &account_hash,
        secret.as_slice(),
        "a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0",
        true,
    );
    run_cycle_legacy(
        ta.as_ref(),
        &root_key,
        account_hash,
        dev_a,
        &tok_a,
        &notes_a,
        &dir_a,
        true,
    )
    .expect("A push base");
    let (tb, dev_b, tok_b) = enroll_device(
        &url,
        &account_hash,
        secret.as_slice(),
        "b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1",
        false,
    );
    run_cycle_legacy(
        tb.as_ref(),
        &root_key,
        account_hash,
        dev_b,
        &tok_b,
        &notes_b,
        &dir_b,
        true,
    )
    .expect("B pull base");

    // A edits X → v2 (server change-seq advances past X). B pulls it cleanly (B
    // has NOT edited X, so no conflict): B's baseline → v2, cursor past X.
    write_note(
        &notes_a,
        &items_key,
        &items_key_id,
        &x,
        b"edit from A",
        true,
    );
    run_cycle_legacy(
        ta.as_ref(),
        &root_key,
        account_hash,
        dev_a,
        &tok_a,
        &notes_a,
        &dir_a,
        true,
    )
    .expect("A push v2");
    run_cycle_legacy(
        tb.as_ref(),
        &root_key,
        account_hash,
        dev_b,
        &tok_b,
        &notes_b,
        &dir_b,
        true,
    )
    .expect("B pull v2");
    assert_eq!(
        read_note(&notes_b, &items_key, &items_key_id, &x).as_deref(),
        Some(&b"edit from A"[..]),
        "B holds A's v2 before the corruption"
    );

    // Corrupt B's recorded baseline for X back to v1 WITHOUT staging a conflict —
    // simulating a baseline that fell behind the server while X sits outside the
    // cursor window (the partial-commit / chunked-parse class of desync).
    let mut st = read_sync_state(&dir_b).unwrap();
    st.blobs
        .get_mut(&x_hex)
        .expect("B has a baseline for X")
        .version = 1;
    write_sync_state(&dir_b, &st).unwrap();

    // B edits X locally → dirty over the corrupted v1 baseline. On push B sends
    // X@base_version=1; the server is at v2 → 409 blob_stale. Without the reactive
    // retry the cycle would error; with it, the full-reconcile retry re-detects X
    // as a conflict (server v2 > baseline v1), excludes it, and the cycle is Ok.
    write_note(
        &notes_b,
        &items_key,
        &items_key_id,
        &x,
        b"edit from B",
        true,
    );
    let s = run_cycle_legacy(
        tb.as_ref(),
        &root_key,
        account_hash,
        dev_b,
        &tok_b,
        &notes_b,
        &dir_b,
        true,
    )
    .expect("B cycle recovers from the 409 instead of wedging");
    assert_eq!(
        s.pushed, 0,
        "X (the only dirty note) is excluded, nothing pushes"
    );
    assert!(
        list_pending_conflicts(&dir_b).contains(&x_hex),
        "the recovery staged X as a conflict"
    );
    assert_eq!(
        read_note(&notes_b, &items_key, &items_key_id, &x).as_deref(),
        Some(&b"edit from B"[..]),
        "B's local X edit survived the recovery (never clobbered)"
    );

    std::fs::remove_dir_all(&dir_a).ok();
    std::fs::remove_dir_all(&dir_b).ok();
}

// -----------------------------------------------------------------------
// Attachment sync (MYND-468) — real-server integration
// -----------------------------------------------------------------------

/// The attachment-aware cycle (the production shape; the legacy wrapper
/// above pins note behavior in isolation).
#[allow(clippy::too_many_arguments)]
fn run_cycle_att(
    version: MetaVersion,
    transport: &dyn SyncTransport,
    root_key: &[u8; 32],
    account_number_hash: [u8; 16],
    device_id: [u8; 16],
    token: &str,
    vault_root: &Path,
    items_key: &[u8; 32],
    items_key_id: &[u8; 16],
) -> Result<SyncSummary, SyncCycleError> {
    blocking(run_sync_cycle(
        &IO,
        transport,
        Some(root_key),
        &SharedSingletonKey::OwnerRoot(zeroize::Zeroizing::new(*root_key)),
        account_number_hash,
        device_id,
        token,
        &vault_root.join("notes"),
        vault_root,
        PushGate::Allowed,
        version,
        Some(AttachmentKeys {
            items_key,
            items_key_id,
        }),
        None,
        &std::collections::HashSet::new(),
    ))
}

/// Seed a local attachment exactly as `attachment_import` would: MYA1 blob
/// under `attachments/<id-hex>` + a live MYC1 catalog entry.
#[allow(clippy::too_many_arguments)]
fn seed_attachment(
    version: MetaVersion,
    vault: &Path,
    root_key: &[u8; 32],
    account_hash: &[u8; 16],
    items_key: &[u8; 32],
    items_key_id: &[u8; 16],
    plaintext: &[u8],
    filename: &str,
    created_at: u64,
) -> [u8; 32] {
    let id = protocol::compute_attachment_id(root_key, plaintext);
    let blob = protocol::encode_attachment_blob_versioned(
        version,
        items_key,
        items_key_id,
        &id,
        b"application/octet-stream",
        plaintext,
    )
    .unwrap();
    // Pin the generation the fixture actually produced. Without this a
    // scenario can be handed the wrong `version` and re-run the v0.1 case
    // under an `_on_a_migrated_vault` name, staying green while proving
    // nothing, and it is the same silent-pass shape myne-md/myne#638 exists to
    // remove. Asserted here rather than per scenario so every caller, and
    // every scenario added later, is covered by construction.
    assert_eq!(
        &blob[0..4],
        match version {
            MetaVersion::V0_1 => protocol::attachment_blob::ATTACHMENT_BLOB_MAGIC.as_slice(),
            MetaVersion::V0_2 => protocol::attachment_blob::ATTACHMENT_BLOB_V0_2_MAGIC.as_slice(),
        },
        "seeded body carries the magic of the generation under test"
    );
    let att_dir = vault.join("attachments");
    std::fs::create_dir_all(&att_dir).unwrap();
    crate::atomic_write::atomic_write(&att_dir.join(hex(&id)), &blob, true).unwrap();

    let catalog_key =
        protocol::derive_subkey_versioned(version, root_key, SubkeyRole::AttachmentsCatalogKey);
    let existing = std::fs::read(vault.join("vault.attachments")).ok();
    let mut catalog =
        protocol::read_or_empty_versioned(version, &catalog_key, account_hash, existing.as_deref());
    let id_hex = hex(&id);
    // Mirror the production `attachment_import` causal version bump (#405):
    // `max(prior version) + 1`, so a re-add over a tombstone (version N)
    // outranks it (version N+1) and the §11.4 catalog merge keeps the
    // revival. Without this the helper writes version 0 and the tombstone
    // wins the merge — the shape `attachment_readd_after_delete_revives`
    // caught once `version` became the merge join's primary key.
    let next_version = catalog.entries.get(&id_hex).map_or(0, |e| e.version) + 1;
    let mut meta = protocol::AttachmentMeta::live(
        "application/octet-stream".to_string(),
        created_at,
        filename.to_string(),
        plaintext.len() as u64,
    );
    meta.version = next_version;
    catalog.entries.insert(id_hex, meta);
    let bytes = protocol::encode_attachments_catalog_versioned(
        version,
        &catalog_key,
        account_hash,
        &catalog,
    )
    .unwrap();
    // The catalog is the other half of "this vault is v0.2", and the four
    // scenarios assert against it. Pinned here for the same reason the body
    // is: a `version` threaded correctly to one encoder and wrongly to the
    // other still names itself `_on_a_migrated_vault` and passes.
    assert_eq!(
        &bytes[0..4],
        match version {
            MetaVersion::V0_1 => protocol::CATALOG_BLOB_MAGIC.as_slice(),
            MetaVersion::V0_2 => protocol::CATALOG_BLOB_V0_2_MAGIC.as_slice(),
        },
        "seeded catalog carries the magic of the generation under test"
    );
    crate::atomic_write::atomic_write(&vault.join("vault.attachments"), &bytes, true).unwrap();
    id
}

/// Delete a local attachment exactly as `attachment_delete` would under
/// sync: catalog entry → tombstone (metadata scrubbed) + tombstone queue +
/// blob unlink.
fn delete_attachment_local(
    version: MetaVersion,
    vault: &Path,
    root_key: &[u8; 32],
    account_hash: &[u8; 16],
    id: &[u8; 32],
    deleted_at: u64,
) {
    let catalog_key =
        protocol::derive_subkey_versioned(version, root_key, SubkeyRole::AttachmentsCatalogKey);
    let existing = std::fs::read(vault.join("vault.attachments")).ok();
    let mut catalog =
        protocol::read_or_empty_versioned(version, &catalog_key, account_hash, existing.as_deref());
    let id_hex = hex(id);
    if let Some(meta) = catalog.entries.get(&id_hex).cloned() {
        catalog
            .entries
            .insert(id_hex.clone(), meta.into_tombstone(deleted_at));
    }
    let bytes = protocol::encode_attachments_catalog_versioned(
        version,
        &catalog_key,
        account_hash,
        &catalog,
    )
    .unwrap();
    crate::atomic_write::atomic_write(&vault.join("vault.attachments"), &bytes, true).unwrap();
    add_pending_attachment_tombstone(vault, id).unwrap();
    let _ = std::fs::remove_file(vault.join("attachments").join(&id_hex));
}

fn read_catalog_of(
    version: MetaVersion,
    vault: &Path,
    root_key: &[u8; 32],
    account_hash: &[u8; 16],
) -> protocol::AttachmentsCatalog {
    let catalog_key =
        protocol::derive_subkey_versioned(version, root_key, SubkeyRole::AttachmentsCatalogKey);
    let bytes = std::fs::read(vault.join("vault.attachments")).ok();
    protocol::read_or_empty_versioned(version, &catalog_key, account_hash, bytes.as_deref())
}

/// Everything an attachment scenario needs from two enrolled devices.
struct TwoDevices {
    /// Kills the server on drop; never read.
    _guard: ServerGuard,
    ta: Box<dyn SyncTransport>,
    tb: Box<dyn SyncTransport>,
    dir_a: std::path::PathBuf,
    dir_b: std::path::PathBuf,
    dev_a: [u8; 16],
    dev_b: [u8; 16],
    tok_a: String,
    tok_b: String,
    /// The account the two devices actually enrolled against.
    ///
    /// Returned rather than re-derived. Five scenarios used to recompute it
    /// from `ATT_ROOT` and a re-typed tag literal, so enrolment and the
    /// cycle addressed the same account only as long as two literals agreed;
    /// a typo in either produced an empty-server puzzle rather than a key
    /// mismatch.
    account_hash: [u8; 16],
}

/// Enroll two devices on a fresh server. `None` → self-skip (binary not
/// built).
fn two_device_fixture(tag: &str) -> Option<TwoDevices> {
    let (guard, url) = spawn_server()?;
    let root_key = [0x42u8; 32];
    let account_hash = {
        // Distinct account per scenario so parallel tests never share state.
        let mut h = [0u8; 16];
        let d = protocol::compute_attachment_id(&root_key, tag.as_bytes());
        h.copy_from_slice(&d[..16]);
        h
    };
    let secret = derive_subkey(&root_key, SubkeyRole::ServerAuth);

    let dir_a = std::env::temp_dir().join(format!("myne-att-A-{tag}-{}", std::process::id()));
    let dir_b = std::env::temp_dir().join(format!("myne-att-B-{tag}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir_a);
    let _ = std::fs::remove_dir_all(&dir_b);
    std::fs::create_dir_all(dir_a.join("notes")).unwrap();
    std::fs::create_dir_all(dir_b.join("notes")).unwrap();

    let ta = crate::plugins::sync::http_transport::build_transport(&url).unwrap();
    let tb = crate::plugins::sync::http_transport::build_transport(&url).unwrap();
    enroll::register_verifier(ta.as_ref(), &account_hash, secret.as_slice()).unwrap();
    let dev_a = enroll::generate_device_id();
    let out_a = enroll::enroll(
        ta.as_ref(),
        &account_hash,
        secret.as_slice(),
        EnrollPath::Recovery,
        "a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0",
        dev_a,
    )
    .unwrap();
    let dev_b = enroll::generate_device_id();
    let out_b = enroll::enroll(
        tb.as_ref(),
        &account_hash,
        secret.as_slice(),
        EnrollPath::Recovery,
        "b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1",
        dev_b,
    )
    .unwrap();
    Some(TwoDevices {
        _guard: guard,
        ta,
        tb,
        dir_a,
        dir_b,
        dev_a,
        dev_b,
        tok_a: hex32(&out_a.token),
        tok_b: hex32(&out_b.token),
        account_hash,
    })
}

const ATT_ROOT: [u8; 32] = [0x42u8; 32];
const ATT_ITEMS: [u8; 32] = [0x11u8; 32];
const ATT_ITEMS_ID: [u8; 16] = [0x22u8; 16];

/// A imports an attachment; B receives the exact bytes + the live catalog
/// entry: the end-to-end replication proof over the real byte-transport,
/// run once per generation.
///
/// The `MYA5` half had no coverage anywhere before myne-md/myne#638, and
/// that absence is why the defect shipped: every attachment scenario here
/// hardcoded `MetaVersion::V0_1`, so the suite exercised the one generation
/// that worked while the generation real vaults are on pushed nothing at
/// all, with `attachments_pushed` at 0 and the run green.
///
/// Push and pull are asserted separately on purpose: that defect broke BOTH
/// directions through the same reader, and a test that only checked B's
/// bytes would pass on a fix that repaired the scan and left the
/// downloaded-body verification behind. That the fixture really seeded the
/// generation under test is pinned inside `seed_attachment`, so every
/// scenario gets it rather than this one.
fn replication_proof(version: MetaVersion, tag: &str) {
    let Some(fx) = two_device_fixture(tag) else {
        eprintln!("SKIP replication_proof({tag}): myne-server unavailable");
        return;
    };
    let account_hash = fx.account_hash;

    let plaintext = b"attachment payload from device A";
    let id = seed_attachment(
        version,
        &fx.dir_a,
        &ATT_ROOT,
        &account_hash,
        &ATT_ITEMS,
        &ATT_ITEMS_ID,
        plaintext,
        "payload.bin",
        1_000,
    );
    let push = run_cycle_att(
        version,
        fx.ta.as_ref(),
        &ATT_ROOT,
        account_hash,
        fx.dev_a,
        &fx.tok_a,
        &fx.dir_a,
        &ATT_ITEMS,
        &ATT_ITEMS_ID,
    )
    .expect("A cycle");
    assert_eq!(push.attachments_pushed, 1, "A uploaded the body");
    assert!(
        push.head_advanced,
        "A authored a head over notes∪attachments"
    );

    let pull = run_cycle_att(
        version,
        fx.tb.as_ref(),
        &ATT_ROOT,
        account_hash,
        fx.dev_b,
        &fx.tok_b,
        &fx.dir_b,
        &ATT_ITEMS,
        &ATT_ITEMS_ID,
    )
    .expect("B cycle");
    assert_eq!(pull.attachments_pulled, 1, "B downloaded the body");

    let a_bytes = std::fs::read(fx.dir_a.join("attachments").join(hex(&id))).unwrap();
    let b_bytes = std::fs::read(fx.dir_b.join("attachments").join(hex(&id))).unwrap();
    assert_eq!(
        a_bytes, b_bytes,
        "B holds A's exact ciphertext (server-wins convergence)"
    );

    let cat_b = read_catalog_of(version, &fx.dir_b, &ATT_ROOT, &account_hash);
    let entry = cat_b
        .entries
        .get(&hex(&id))
        .expect("B merged the catalog entry");
    assert!(!entry.is_tombstone());
    assert_eq!(entry.filename, "payload.bin");

    // Idle cycles push nothing (nonce-churn regression): the catalog was
    // adopted verbatim, so no re-encrypt → no endless push loop.
    for (t, dev, tok, dir) in [
        (fx.ta.as_ref(), fx.dev_a, &fx.tok_a, &fx.dir_a),
        (fx.tb.as_ref(), fx.dev_b, &fx.tok_b, &fx.dir_b),
    ] {
        let idle = run_cycle_att(
            version,
            t,
            &ATT_ROOT,
            account_hash,
            dev,
            tok,
            dir,
            &ATT_ITEMS,
            &ATT_ITEMS_ID,
        )
        .expect("idle cycle");
        assert_eq!(
            (
                idle.pushed,
                idle.attachments_pushed,
                idle.attachments_pulled
            ),
            (0, 0, 0),
            "an idle cycle after convergence moves nothing"
        );
    }

    std::fs::remove_dir_all(&fx.dir_a).ok();
    std::fs::remove_dir_all(&fx.dir_b).ok();
}

#[test]
fn two_devices_replicate_an_attachment() {
    replication_proof(MetaVersion::V0_1, "repl");
}

/// The same proof on a MIGRATED vault, where every body is `MYA5` and the
/// catalog is `MYC5`. Its own `#[test]` rather than a loop inside one, so a
/// regression names the generation it broke.
#[test]
fn two_devices_replicate_an_attachment_on_a_migrated_vault() {
    replication_proof(MetaVersion::V0_2, "repl-v0-2");
}

/// A deletes the attachment; B's blob is erased and its catalog entry is a
/// tombstone — and B's stale catalog can never resurrect it (§11.4).
fn attachment_delete_propagates_with_resurrection_guard_case(version: MetaVersion, tag: &str) {
    let Some(fx) = two_device_fixture(tag) else {
        eprintln!("SKIP attachment_delete_propagates_with_resurrection_guard({tag}): myne-server unavailable");
        return;
    };
    let account_hash = fx.account_hash;

    let plaintext = b"to be deleted everywhere";
    let id = seed_attachment(
        version,
        &fx.dir_a,
        &ATT_ROOT,
        &account_hash,
        &ATT_ITEMS,
        &ATT_ITEMS_ID,
        plaintext,
        "doomed.bin",
        1_000,
    );
    // Replicate to B first.
    run_cycle_att(
        version,
        fx.ta.as_ref(),
        &ATT_ROOT,
        account_hash,
        fx.dev_a,
        &fx.tok_a,
        &fx.dir_a,
        &ATT_ITEMS,
        &ATT_ITEMS_ID,
    )
    .unwrap();
    run_cycle_att(
        version,
        fx.tb.as_ref(),
        &ATT_ROOT,
        account_hash,
        fx.dev_b,
        &fx.tok_b,
        &fx.dir_b,
        &ATT_ITEMS,
        &ATT_ITEMS_ID,
    )
    .unwrap();
    assert!(fx.dir_b.join("attachments").join(hex(&id)).exists());

    // A deletes while B is "offline" (B holds a live catalog + the blob).
    delete_attachment_local(version, &fx.dir_a, &ATT_ROOT, &account_hash, &id, 2_000);
    let del = run_cycle_att(
        version,
        fx.ta.as_ref(),
        &ATT_ROOT,
        account_hash,
        fx.dev_a,
        &fx.tok_a,
        &fx.dir_a,
        &ATT_ITEMS,
        &ATT_ITEMS_ID,
    )
    .expect("A delete cycle");
    assert!(
        del.tombstones_pushed >= 1,
        "the §11.4 tombstone record pushed"
    );
    assert!(
        read_pending_attachment_tombstones(&fx.dir_a).is_empty(),
        "the queue drained after the push"
    );

    // B pulls: catalog-first merge → tombstone wins → local erase.
    let pull = run_cycle_att(
        version,
        fx.tb.as_ref(),
        &ATT_ROOT,
        account_hash,
        fx.dev_b,
        &fx.tok_b,
        &fx.dir_b,
        &ATT_ITEMS,
        &ATT_ITEMS_ID,
    )
    .expect("B pull cycle");
    assert_eq!(pull.attachments_deleted, 1, "B erased the tombstoned body");
    assert!(
        !fx.dir_b.join("attachments").join(hex(&id)).exists(),
        "B's blob is gone"
    );
    let cat_b = read_catalog_of(version, &fx.dir_b, &ATT_ROOT, &account_hash);
    assert!(
        cat_b
            .entries
            .get(&hex(&id))
            .is_some_and(|e| e.is_tombstone()),
        "B's catalog entry is the tombstone"
    );

    // Resurrection guard: B's next cycles never re-push the dead entry or
    // re-download the body.
    let idle = run_cycle_att(
        version,
        fx.tb.as_ref(),
        &ATT_ROOT,
        account_hash,
        fx.dev_b,
        &fx.tok_b,
        &fx.dir_b,
        &ATT_ITEMS,
        &ATT_ITEMS_ID,
    )
    .unwrap();
    assert_eq!(
        (
            idle.attachments_pulled,
            idle.attachments_pushed,
            idle.pushed
        ),
        (0, 0, 0),
        "no resurrection churn"
    );

    std::fs::remove_dir_all(&fx.dir_a).ok();
    std::fs::remove_dir_all(&fx.dir_b).ok();
}

#[test]
fn attachment_delete_propagates_with_resurrection_guard() {
    attachment_delete_propagates_with_resurrection_guard_case(MetaVersion::V0_1, "del");
}

/// The same scenario on a MIGRATED vault (`MYA5` bodies, `MYC5`
/// catalog). Its own `#[test]` so a regression names the generation it
/// broke, and a separate fixture tag so the two accounts never share
/// server state.
#[test]
fn attachment_delete_propagates_with_resurrection_guard_on_a_migrated_vault() {
    attachment_delete_propagates_with_resurrection_guard_case(MetaVersion::V0_2, "del-v0-2");
}

/// Both devices import the SAME file independently (same content-addressed
/// id, different random ciphertext) — the §4.2 server-wins rule converges
/// both manifests on one ciphertext instead of diverging forever.
fn double_import_converges_server_wins_case(version: MetaVersion, tag: &str) {
    let Some(fx) = two_device_fixture(tag) else {
        eprintln!("SKIP double_import_converges_server_wins({tag}): myne-server unavailable");
        return;
    };
    let account_hash = fx.account_hash;

    let plaintext = b"identical file imported on two devices";
    let id_a = seed_attachment(
        version,
        &fx.dir_a,
        &ATT_ROOT,
        &account_hash,
        &ATT_ITEMS,
        &ATT_ITEMS_ID,
        plaintext,
        "same.bin",
        1_000,
    );
    let id_b = seed_attachment(
        version,
        &fx.dir_b,
        &ATT_ROOT,
        &account_hash,
        &ATT_ITEMS,
        &ATT_ITEMS_ID,
        plaintext,
        "same.bin",
        1_001,
    );
    assert_eq!(id_a, id_b, "content-addressing: same plaintext → same id");
    assert_ne!(
        std::fs::read(fx.dir_a.join("attachments").join(hex(&id_a))).unwrap(),
        std::fs::read(fx.dir_b.join("attachments").join(hex(&id_b))).unwrap(),
        "randomized encryption: same id, different ciphertext"
    );

    // A wins the race; B's divergent local copy must adopt A's bytes.
    run_cycle_att(
        version,
        fx.ta.as_ref(),
        &ATT_ROOT,
        account_hash,
        fx.dev_a,
        &fx.tok_a,
        &fx.dir_a,
        &ATT_ITEMS,
        &ATT_ITEMS_ID,
    )
    .unwrap();
    run_cycle_att(
        version,
        fx.tb.as_ref(),
        &ATT_ROOT,
        account_hash,
        fx.dev_b,
        &fx.tok_b,
        &fx.dir_b,
        &ATT_ITEMS,
        &ATT_ITEMS_ID,
    )
    .unwrap();

    let a_bytes = std::fs::read(fx.dir_a.join("attachments").join(hex(&id_a))).unwrap();
    let b_bytes = std::fs::read(fx.dir_b.join("attachments").join(hex(&id_a))).unwrap();
    assert_eq!(a_bytes, b_bytes, "server-wins converged the ciphertexts");

    // Convergence is stable: further cycles on both sides move nothing.
    for (t, dev, tok, dir) in [
        (fx.ta.as_ref(), fx.dev_a, &fx.tok_a, &fx.dir_a),
        (fx.tb.as_ref(), fx.dev_b, &fx.tok_b, &fx.dir_b),
    ] {
        let idle = run_cycle_att(
            version,
            t,
            &ATT_ROOT,
            account_hash,
            dev,
            tok,
            dir,
            &ATT_ITEMS,
            &ATT_ITEMS_ID,
        )
        .unwrap();
        assert_eq!(
            (idle.attachments_pulled, idle.attachments_pushed),
            (0, 0),
            "no double-import churn"
        );
    }

    std::fs::remove_dir_all(&fx.dir_a).ok();
    std::fs::remove_dir_all(&fx.dir_b).ok();
}

#[test]
fn double_import_converges_server_wins() {
    double_import_converges_server_wins_case(MetaVersion::V0_1, "dbl");
}

/// The same scenario on a MIGRATED vault (`MYA5` bodies, `MYC5`
/// catalog). Its own `#[test]` so a regression names the generation it
/// broke, and a separate fixture tag so the two accounts never share
/// server state.
#[test]
fn double_import_converges_server_wins_on_a_migrated_vault() {
    double_import_converges_server_wins_case(MetaVersion::V0_2, "dbl-v0-2");
}

/// A re-add after a propagated deletion revives the entry (created_at >
/// deleted_at) and re-uploads the body — the §11.4 rule-4 revival path,
/// including the server-side un-tombstone CAS.
fn attachment_readd_after_delete_revives_case(version: MetaVersion, tag: &str) {
    let Some(fx) = two_device_fixture(tag) else {
        eprintln!("SKIP attachment_readd_after_delete_revives({tag}): myne-server unavailable");
        return;
    };
    let account_hash = fx.account_hash;

    let plaintext = b"deleted then deliberately re-imported";
    let id = seed_attachment(
        version,
        &fx.dir_a,
        &ATT_ROOT,
        &account_hash,
        &ATT_ITEMS,
        &ATT_ITEMS_ID,
        plaintext,
        "phoenix.bin",
        1_000,
    );
    run_cycle_att(
        version,
        fx.ta.as_ref(),
        &ATT_ROOT,
        account_hash,
        fx.dev_a,
        &fx.tok_a,
        &fx.dir_a,
        &ATT_ITEMS,
        &ATT_ITEMS_ID,
    )
    .unwrap();
    run_cycle_att(
        version,
        fx.tb.as_ref(),
        &ATT_ROOT,
        account_hash,
        fx.dev_b,
        &fx.tok_b,
        &fx.dir_b,
        &ATT_ITEMS,
        &ATT_ITEMS_ID,
    )
    .unwrap();

    // Delete + propagate.
    delete_attachment_local(version, &fx.dir_a, &ATT_ROOT, &account_hash, &id, 2_000);
    run_cycle_att(
        version,
        fx.ta.as_ref(),
        &ATT_ROOT,
        account_hash,
        fx.dev_a,
        &fx.tok_a,
        &fx.dir_a,
        &ATT_ITEMS,
        &ATT_ITEMS_ID,
    )
    .unwrap();
    run_cycle_att(
        version,
        fx.tb.as_ref(),
        &ATT_ROOT,
        account_hash,
        fx.dev_b,
        &fx.tok_b,
        &fx.dir_b,
        &ATT_ITEMS,
        &ATT_ITEMS_ID,
    )
    .unwrap();

    // Re-import on A with a LATER created_at (the deliberate re-add).
    let id2 = seed_attachment(
        version,
        &fx.dir_a,
        &ATT_ROOT,
        &account_hash,
        &ATT_ITEMS,
        &ATT_ITEMS_ID,
        plaintext,
        "phoenix.bin",
        3_000,
    );
    assert_eq!(id, id2);
    let readd = run_cycle_att(
        version,
        fx.ta.as_ref(),
        &ATT_ROOT,
        account_hash,
        fx.dev_a,
        &fx.tok_a,
        &fx.dir_a,
        &ATT_ITEMS,
        &ATT_ITEMS_ID,
    )
    .expect("A re-add cycle");
    assert_eq!(readd.attachments_pushed, 1, "A re-uploaded the body");

    // B revives: live entry wins the merge, body re-downloads.
    let pull = run_cycle_att(
        version,
        fx.tb.as_ref(),
        &ATT_ROOT,
        account_hash,
        fx.dev_b,
        &fx.tok_b,
        &fx.dir_b,
        &ATT_ITEMS,
        &ATT_ITEMS_ID,
    )
    .expect("B revival cycle");
    assert_eq!(
        pull.attachments_pulled, 1,
        "B re-downloaded the revived body"
    );
    let cat_b = read_catalog_of(version, &fx.dir_b, &ATT_ROOT, &account_hash);
    assert!(
        cat_b
            .entries
            .get(&hex(&id))
            .is_some_and(|e| !e.is_tombstone()),
        "B's entry is live again (created_at > deleted_at)"
    );

    std::fs::remove_dir_all(&fx.dir_a).ok();
    std::fs::remove_dir_all(&fx.dir_b).ok();
}

#[test]
fn attachment_readd_after_delete_revives() {
    attachment_readd_after_delete_revives_case(MetaVersion::V0_1, "readd");
}

/// The same scenario on a MIGRATED vault (`MYA5` bodies, `MYC5`
/// catalog). Its own `#[test]` so a regression names the generation it
/// broke, and a separate fixture tag so the two accounts never share
/// server state.
#[test]
fn attachment_readd_after_delete_revives_on_a_migrated_vault() {
    attachment_readd_after_delete_revives_case(MetaVersion::V0_2, "readd-v0-2");
}

// ---- F1 Faz B: vault.meta reconcile (sync_meta_phase) --------------------

/// The review's first Critical (myne-md/myne#911).
///
/// The generation gate used to be `magic == NTV6`, which classifies an
/// `NTV7` frame as "older than B2B". A server still holding the pre-upgrade
/// `NTV6` copy was then adopted VERBATIM over it: the person wrap is gone,
/// the phrase wrap was already zeroed, and the vault is left with the
/// password as its only credential, with no error anywhere.
///
/// The fixture is a REAL person-wrapped frame, because that is the only kind
/// the old code would adopt: it verified the owner wrap and the roster under
/// the root key first, and dummy bytes fail that check and skip. So this
/// test drives the actual path: same tail in both frames, so the NTV6 copy
/// verifies, and the only thing that can stop the overwrite is the
/// generation comparison.
mod meta_generation {
    use super::{blocking, IO};

    use crate::plugins::sync::state::SyncState;
    use crate::plugins::sync::transport::FakeTransport;
    use crate::plugins::vault_creation::commands::{
        build_and_serialize_person_vault_meta, build_person_session,
    };
    use crate::plugins::vault_creation::state::CreationPerson;

    use super::super::*;
    use protocol::KdfParams;

    /// Fast KDF: this test never derives a password, and the identity seed's
    /// parameters do not reach the frame. A real-cost derivation here would
    /// add seconds to every `cargo test`.
    const FAST: KdfParams = KdfParams {
        m_kib: protocol::MIN_KDF_M_KIB,
        t: 1,
        p: 1,
        argon2_version: 0x13,
    };

    const PHRASE: &str = "abandon ability able about above absent absorb abstract absurd abuse access accident account accuse achieve acid acoustic acquire across act action actor actress actual";

    /// A real `NTV8` frame plus the root key its group wrap opens under, and
    /// the `NTV6` frame the SAME tail serializes to. The pair is what a
    /// server that has not upgraded yet serves beside an upgraded device.
    fn frames() -> (Vec<u8>, Vec<u8>, zeroize::Zeroizing<[u8; 32]>) {
        let person_id = protocol::kdf::person_id_hash(PHRASE);
        let seed = protocol::kdf::derive_person_identity_seed(PHRASE, &person_id, &FAST)
            .expect("identity seed");
        let seeds = protocol::kdf::expand_person_identity_key_seeds(&seed);
        let person = CreationPerson {
            pair: protocol::PersonKeyPair::generate_raw(&seeds.kem, &seeds.ed25519, &seeds.mldsa),
            person_id,
            number: protocol::account_number_from_person_id(&person_id),
        };
        let session = build_person_session(
            crate::paths::web_single_vault_id(),
            "person-born-test-pw",
            FAST,
            person,
        )
        .expect("person session");
        let (ntv8, _group) =
            build_and_serialize_person_vault_meta(&session).expect("serialize NTV8");
        let parsed = protocol::parse_vault_meta_ntv8(&ntv8).expect("parse NTV8");
        let ntv6 = protocol::serialize_vault_meta_ntv6(&parsed.as_ntv6_tail())
            .expect("the same tail as an NTV6 frame");
        (ntv8, ntv6, session.root_key.clone())
    }

    fn scratch(tag: &str) -> std::path::PathBuf {
        let d = std::env::temp_dir().join(format!(
            "myne-metagen-{tag}-{}-{:p}",
            std::process::id(),
            &tag
        ));
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn refuses_to_adopt_an_ntv6_server_frame_over_a_local_ntv8_frame() {
        let (local, server, root_key) = frames();
        let dir = scratch("older-server");
        std::fs::write(dir.join("vault.meta"), &local).unwrap();
        // The ordinary post-upgrade state: this device has nothing new to
        // say (the upgrade pushed already) and the server still serves the
        // pre-upgrade frame. That is the pairing the old code adopted.
        let mut st = SyncState {
            meta_baseline_hex: Some(sha256_hex(&local)),
            ..SyncState::default()
        };
        let t = FakeTransport::new();
        t.on(HttpMethod::Get, "/vault.meta", 200, server.clone());

        let out = blocking(sync_meta_phase(
            &IO,
            &t,
            "tok",
            &dir,
            &mut st,
            true,
            Some(&root_key),
        ));

        assert_ne!(
            out,
            MetaPhaseOutcome::Adopted,
            "an older generation must never be adopted over a newer local frame"
        );
        assert_eq!(
            std::fs::read(dir.join("vault.meta")).unwrap(),
            local,
            "the group tail must survive a server that has not upgraded yet"
        );
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn the_two_helpers_order_and_classify_every_generation() {
        let (ntv8, ntv6, _root) = frames();
        let legacy = protocol::serialize_vault_meta(
            &protocol::parse_vault_meta_ntv8(&ntv8).expect("parse").base,
        );

        assert_eq!(
            protocol::vault_meta_generation(&legacy),
            protocol::VaultMetaGeneration::Legacy
        );
        assert_eq!(
            protocol::vault_meta_generation(&ntv6),
            protocol::VaultMetaGeneration::B2b
        );
        assert_eq!(
            protocol::vault_meta_generation(&ntv8),
            protocol::VaultMetaGeneration::PersonNoWrap
        );
        // The ordering is what stops an older server frame from replacing a
        // newer local one, so the new generation has to sort ABOVE the one it
        // succeeds: `NTV8` is what an `NTV7` device upgrades into, and the
        // device that has upgraded must never be handed the wrap back.
        assert!(
            protocol::VaultMetaGeneration::PersonNoWrap > protocol::VaultMetaGeneration::Person
        );
        assert!(protocol::VaultMetaGeneration::Person > protocol::VaultMetaGeneration::B2b);
        assert!(protocol::VaultMetaGeneration::B2b > protocol::VaultMetaGeneration::Legacy);
        assert!(protocol::has_b2b_tail(&ntv6));
        assert!(protocol::has_b2b_tail(&ntv8));
        assert!(!protocol::has_b2b_tail(&legacy));
        // And the tail survives a round trip through the `NTV6` view, which is
        // what makes "the same tail in both frames" true for the test above.
        assert_eq!(
            protocol::parse_vault_meta_ntv8(&ntv8)
                .expect("parse")
                .as_ntv6_tail()
                .signed_roster_envelope,
            protocol::parse_vault_meta_ntv6(&ntv6)
                .expect("parse NTV6")
                .signed_roster_envelope
        );
    }
}

// ---- myne-md/myne#640: vault.dictionary phase (sync_dictionary_phase) ----

mod dictionary_phase {
    // The parent module's seam shims (task 86).
    use super::{blocking, IO};

    use super::super::*;
    use crate::plugins::sync::dictionary_payload::{
        clock_key, merge_personal_dictionaries, PersonalDictionaryData, PERSONAL_WORDS_FIELD,
    };
    use crate::plugins::sync::state::SyncState;
    use crate::plugins::sync::transport::FakeTransport;
    use base64::engine::general_purpose::STANDARD as B64;
    use base64::Engine as _;

    const ROOT: [u8; 32] = [0x42; 32];
    const HASH: [u8; 16] = [0x33; 16];

    fn scratch(tag: &str) -> std::path::PathBuf {
        let d = std::env::temp_dir().join(format!(
            "myne-dictphase-{tag}-{}-{:p}",
            std::process::id(),
            &tag
        ));
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    fn dict_key() -> zeroize::Zeroizing<[u8; 32]> {
        derive_subkey(&ROOT, SubkeyRole::PersonalDictKey)
    }

    fn encode(view: &PersonalDictionaryData) -> Vec<u8> {
        protocol::encode_dictionary_blob_versioned(
            MetaVersion::V0_1,
            &dict_key(),
            &HASH,
            &view.encode(),
        )
        .unwrap()
    }

    fn write_local(dir: &Path, view: &PersonalDictionaryData) {
        std::fs::write(dir.join("vault.dictionary"), encode(view)).unwrap();
    }

    fn read_local(dir: &Path) -> PersonalDictionaryData {
        let bytes = std::fs::read(dir.join("vault.dictionary")).unwrap();
        let format = protocol::dictionary_blob_format(&bytes);
        let plaintext = protocol::decode_dictionary_blob_versioned(
            MetaVersion::V0_1,
            &dict_key(),
            &HASH,
            &bytes,
        )
        .unwrap();
        match format {
            Some(protocol::DICTIONARY_BLOB_FORMAT_V1) => {
                crate::plugins::sync::dictionary_payload::PersonalDictionaryV1::decode(&plaintext)
                    .unwrap()
                    .into_current()
            }
            _ => PersonalDictionaryData::decode(&plaintext).unwrap(),
        }
    }

    /// Serve `bytes` under the dictionary id and return the record a puller
    /// sees.
    fn serve(t: &FakeTransport, id: &[u8; 16], bytes: &[u8]) -> ChangedBlob {
        let nonce = read_dictionary_nonce(bytes).unwrap();
        let body = serde_json::json!({ "ciphertext_b64": B64.encode(bytes) });
        t.on(
            HttpMethod::Get,
            &format!("/sync/blob?id={}", hex(id)),
            200,
            serde_json::to_vec(&body).unwrap(),
        );
        ChangedBlob {
            id: *id,
            content_nonce: nonce,
            version: 7,
            size: bytes.len(),
            attachment_id: None,
        }
    }

    fn shared() -> SharedSingletonKey {
        SharedSingletonKey::OwnerRoot(zeroize::Zeroizing::new(ROOT))
    }

    /// `StdVaultIo` with `vault.dictionary` reads failing as a NON-NotFound
    /// error, which is the state `.ok()` used to mistake for "no file".
    struct ReadFailsIo;

    #[async_trait::async_trait]
    impl crate::vault_io::VaultIo for ReadFailsIo {
        async fn read(&self, path: &Path) -> crate::vault_io::IoResult<Vec<u8>> {
            if path.file_name().and_then(|n| n.to_str()) == Some("vault.dictionary") {
                return Err(crate::io_failure_kind::IoFailureKind::Other);
            }
            IO.read(path).await
        }
        async fn read_prefix(&self, path: &Path, len: usize) -> crate::vault_io::IoResult<Vec<u8>> {
            IO.read_prefix(path, len).await
        }
        async fn write(
            &self,
            path: &Path,
            bytes: &[u8],
            opts: crate::vault_io::WriteOpts,
        ) -> crate::vault_io::IoResult<()> {
            IO.write(path, bytes, opts).await
        }
        async fn remove_file(&self, path: &Path) -> crate::vault_io::IoResult<()> {
            IO.remove_file(path).await
        }
        async fn remove_dir_all(&self, path: &Path) -> crate::vault_io::IoResult<()> {
            IO.remove_dir_all(path).await
        }
        async fn create_dir_all(&self, path: &Path) -> crate::vault_io::IoResult<()> {
            IO.create_dir_all(path).await
        }
        async fn read_dir(
            &self,
            path: &Path,
        ) -> crate::vault_io::IoResult<Vec<crate::vault_io::DirEntry>> {
            IO.read_dir(path).await
        }
        async fn stat(
            &self,
            path: &Path,
        ) -> crate::vault_io::IoResult<Option<crate::vault_io::FileStat>> {
            IO.stat(path).await
        }
        async fn exists(&self, path: &Path) -> crate::vault_io::IoResult<bool> {
            IO.exists(path).await
        }
        async fn is_dir(&self, path: &Path) -> crate::vault_io::IoResult<bool> {
            IO.is_dir(path).await
        }
        async fn rename(&self, from: &Path, to: &Path) -> crate::vault_io::IoResult<()> {
            IO.rename(from, to).await
        }
    }

    #[allow(clippy::too_many_arguments)]
    fn run_with_io(
        io: &dyn crate::vault_io::VaultIo,
        t: &FakeTransport,
        dir: &Path,
        st: &mut SyncState,
        id: &[u8; 16],
        remote: Option<&ChangedBlob>,
    ) -> DictionaryPhase {
        blocking(sync_dictionary_phase(
            io,
            t,
            "tok",
            &shared(),
            &HASH,
            dir,
            st,
            id,
            remote,
            MetaVersion::V0_1,
        ))
        .unwrap()
    }

    fn run(
        t: &FakeTransport,
        dir: &Path,
        st: &mut SyncState,
        id: &[u8; 16],
        remote: Option<&ChangedBlob>,
    ) -> DictionaryPhase {
        blocking(sync_dictionary_phase(
            &IO,
            t,
            "tok",
            &shared(),
            &HASH,
            dir,
            st,
            id,
            remote,
            MetaVersion::V0_1,
        ))
        .unwrap()
    }

    /// A vault with no dictionary and a server that has never held one stays
    /// dictionary-silent: an empty dictionary is the ABSENT file, so there is
    /// nothing to publish.
    #[test]
    fn no_local_file_and_no_remote_record_stays_silent() {
        let dir = scratch("silent");
        let mut st = SyncState::default();
        let t = FakeTransport::new();
        let id = dictionary_sync_id(&ROOT);
        let phase = run(&t, &dir, &mut st, &id, None);
        assert!(!phase.dirty);
        assert!(!phase.applied_remote);
        assert!(phase.push_bytes.is_none());
        assert!(!dir.join("vault.dictionary").exists());
        std::fs::remove_dir_all(&dir).ok();
    }

    /// A read that FAILED is not "no dictionary" (myne-md/myne#640). The old
    /// `.ok()` collapsed every IO error into `None`, which becomes the empty
    /// view; with a remote record present that view merges to the remote and
    /// the ADOPT arm writes the server bytes over a file this device never
    /// read, destroying the local words. `ReadFailsIo` fails only the
    /// dictionary read, which is exactly the state the defect needs.
    #[test]
    fn an_unreadable_local_blob_is_a_refusal_not_an_empty_dictionary() {
        let dir = scratch("unreadable");
        let id = dictionary_sync_id(&ROOT);
        let t = FakeTransport::new();
        let mut st = SyncState::default();

        let mut local = PersonalDictionaryData::default();
        local.add_personal("mine", 50);
        write_local(&dir, &local);
        let before = std::fs::read(dir.join("vault.dictionary")).unwrap();

        let mut remote = PersonalDictionaryData::default();
        remote.add_personal("theirs", 90);
        let remote_bytes = protocol::encode_dictionary_blob(&dict_key(), &HASH, &remote.encode())
            .expect("seal remote");
        let rec = serve(&t, &id, &remote_bytes);

        let phase = run_with_io(&ReadFailsIo, &t, &dir, &mut st, &id, Some(&rec));

        assert!(!phase.dirty, "a failed read must not publish");
        assert!(!phase.applied_remote);
        assert!(phase.push_bytes.is_none());
        assert_eq!(
            std::fs::read(dir.join("vault.dictionary")).unwrap(),
            before,
            "the unreadable file must be untouched, not overwritten with the server's copy"
        );
        std::fs::remove_dir_all(&dir).ok();
    }

    /// A remote blob that opens but does not parse is a REFUSAL, not
    /// empty-remote (myne-md/myne#640): adopting it writes bytes this build
    /// cannot read over the local file, and re-pushing over it destroys a
    /// newer peer's record. `sync_member_names_phase` takes the same posture.
    #[test]
    fn an_undecodable_remote_blob_is_refused_rather_than_adopted() {
        let dir = scratch("remote-garbage");
        let id = dictionary_sync_id(&ROOT);
        let t = FakeTransport::new();
        let mut st = SyncState::default();

        let mut local = PersonalDictionaryData::default();
        local.add_personal("mine", 50);
        write_local(&dir, &local);
        let before = std::fs::read(dir.join("vault.dictionary")).unwrap();

        // Sealed under the right key, so it decrypts, but the plaintext is
        // not a postcard payload of either generation.
        let garbage = protocol::encode_dictionary_blob(&dict_key(), &HASH, b"not postcard")
            .expect("seal a bad remote payload");
        let rec = serve(&t, &id, &garbage);
        let phase = run(&t, &dir, &mut st, &id, Some(&rec));

        assert!(!phase.dirty);
        assert!(!phase.applied_remote);
        assert!(phase.push_bytes.is_none());
        assert_eq!(
            std::fs::read(dir.join("vault.dictionary")).unwrap(),
            before,
            "the local dictionary is untouched and nothing is pushed over the remote"
        );
        std::fs::remove_dir_all(&dir).ok();
    }

    /// A local dictionary with no server copy is published once (the initial
    /// publish), and the pushed bytes are the phase's own.
    #[test]
    fn initial_publish_when_server_never_held_a_dictionary() {
        let dir = scratch("initpub");
        let mut local = PersonalDictionaryData::default();
        local.add_personal("myne", 100);
        write_local(&dir, &local);
        let mut st = SyncState::default();
        let t = FakeTransport::new();
        let id = dictionary_sync_id(&ROOT);
        let phase = run(&t, &dir, &mut st, &id, None);
        assert!(phase.dirty, "never-synced server ⇒ initial publish");
        let pushed = phase.push_bytes.expect("dirty carries its bytes");
        let plaintext = protocol::decode_dictionary_blob_versioned(
            MetaVersion::V0_1,
            &dict_key(),
            &HASH,
            &pushed,
        )
        .unwrap();
        assert_eq!(
            PersonalDictionaryData::decode(&plaintext)
                .unwrap()
                .personal_words,
            vec!["myne"]
        );
        std::fs::remove_dir_all(&dir).ok();
    }

    /// The acceptance criterion through the REAL phase: a word added on one
    /// device reaches the other within one round.
    #[test]
    fn a_word_added_on_a_reaches_b_in_one_round() {
        let a_dir = scratch("add-a");
        let b_dir = scratch("add-b");
        let id = dictionary_sync_id(&ROOT);
        let t = FakeTransport::new();
        let mut a_st = SyncState::default();
        let mut b_st = SyncState::default();

        // A adds and publishes.
        let mut a = PersonalDictionaryData::default();
        a.add_personal("vodozemac", 100);
        write_local(&a_dir, &a);
        let phase_a = run(&t, &a_dir, &mut a_st, &id, None);
        assert!(phase_a.dirty);
        let server_bytes = phase_a.push_bytes.unwrap();

        // B pulls it.
        let rec = serve(&t, &id, &server_bytes);
        let phase_b = run(&t, &b_dir, &mut b_st, &id, Some(&rec));
        assert!(phase_b.applied_remote);
        assert_eq!(read_local(&b_dir).personal_words, vec!["vodozemac"]);
        std::fs::remove_dir_all(&a_dir).ok();
        std::fs::remove_dir_all(&b_dir).ok();
    }

    /// The reproduction sequence through the real phase: add on A, sync,
    /// remove on A, two rounds: the word stays gone.
    #[test]
    fn a_removed_word_stays_gone_over_two_rounds() {
        let a_dir = scratch("rm-a");
        let b_dir = scratch("rm-b");
        let id = dictionary_sync_id(&ROOT);
        let t = FakeTransport::new();
        let mut a_st = SyncState::default();
        let mut b_st = SyncState::default();

        // Round 1: add on A, publish, B pulls.
        let mut a = PersonalDictionaryData::default();
        a.add_personal("myne", 100);
        write_local(&a_dir, &a);
        let server_bytes = run(&t, &a_dir, &mut a_st, &id, None).push_bytes.unwrap();
        let rec1 = serve(&t, &id, &server_bytes);
        run(&t, &b_dir, &mut b_st, &id, Some(&rec1));
        assert_eq!(read_local(&b_dir).personal_words, vec!["myne"]);

        // Round 2: remove on A at a later clock, publish, B pulls.
        a.remove_personal("myne", 300);
        write_local(&a_dir, &a);
        let removed_bytes = run(&t, &a_dir, &mut a_st, &id, Some(&rec1))
            .push_bytes
            .expect("the removal must push");
        let rec2 = serve(&t, &id, &removed_bytes);
        let phase_b = run(&t, &b_dir, &mut b_st, &id, Some(&rec2));
        assert!(phase_b.applied_remote, "the removal must reach B");
        assert!(
            read_local(&b_dir).personal_words.is_empty(),
            "the word must be gone on B"
        );

        // Round 3 (the second round after the removal): B reconciles against
        // the same server revision again and the word must NOT come back.
        let phase_b2 = run(&t, &b_dir, &mut b_st, &id, Some(&rec2));
        assert!(!phase_b2.applied_remote);
        assert!(read_local(&b_dir).personal_words.is_empty());

        // And A keeps its tombstone, which is what makes the removal survive
        // a third device that still holds the word.
        let a_view = read_local(&a_dir);
        assert_eq!(
            a_view
                .removal_clocks
                .get(&clock_key(PERSONAL_WORDS_FIELD, "myne")),
            Some(&300)
        );
        assert!(a_view.personal_words.is_empty());
        std::fs::remove_dir_all(&a_dir).ok();
        std::fs::remove_dir_all(&b_dir).ok();
    }

    /// #255 through the phase: an EXISTING local blob that cannot be read is
    /// a refusal, not an empty dictionary, so the peer's copy is never merged
    /// over it.
    #[test]
    fn an_unreadable_local_blob_skips_rather_than_emptying() {
        let dir = scratch("unreadable");
        std::fs::write(dir.join("vault.dictionary"), b"not a MYD1 blob").unwrap();
        let before = std::fs::read(dir.join("vault.dictionary")).unwrap();
        let mut st = SyncState::default();
        let t = FakeTransport::new();
        let id = dictionary_sync_id(&ROOT);
        // A peer DOES have a dictionary; the refusal must still win.
        let mut peer = PersonalDictionaryData::default();
        peer.add_personal("peer-word", 500);
        let rec = serve(&t, &id, &encode(&peer));

        let phase = run(&t, &dir, &mut st, &id, Some(&rec));
        assert!(!phase.dirty, "a refused read must not push");
        assert!(!phase.applied_remote, "a refused read must not adopt");
        assert_eq!(
            std::fs::read(dir.join("vault.dictionary")).unwrap(),
            before,
            "the unreadable blob must be untouched"
        );
        std::fs::remove_dir_all(&dir).ok();
    }

    /// A `0x01` local blob meets a `0x02` peer: the merge runs, the local
    /// words survive, and the file is rewritten as `0x02` with clocks.
    #[test]
    fn a_v1_local_blob_upgrades_when_it_merges() {
        let dir = scratch("upgrade");
        let v1_plain = crate::plugins::sync::dictionary_payload::PersonalDictionaryV1 {
            personal_words: vec!["legacy-word".into()],
            ignore_words: vec![],
        }
        .encode();
        let mut v1 = protocol::encode_dictionary_blob_versioned(
            MetaVersion::V0_1,
            &dict_key(),
            &HASH,
            &v1_plain,
        )
        .unwrap();
        // The `dict_format_version` byte is not in the AAD, so relabelling a
        // freshly sealed blob is exactly how a pre-myne#640 writer's output
        // looks: the same envelope with a `0x01` inner format.
        v1[5] = protocol::DICTIONARY_BLOB_FORMAT_V1;
        std::fs::write(dir.join("vault.dictionary"), &v1).unwrap();
        let mut st = SyncState::default();
        let t = FakeTransport::new();
        let id = dictionary_sync_id(&ROOT);
        let mut peer = PersonalDictionaryData::default();
        peer.add_personal("new-word", 900);
        let rec = serve(&t, &id, &encode(&peer));

        let phase = run(&t, &dir, &mut st, &id, Some(&rec));
        assert!(phase.dirty);
        let after = std::fs::read(dir.join("vault.dictionary")).unwrap();
        assert_eq!(
            protocol::dictionary_blob_format(&after),
            Some(protocol::DICTIONARY_BLOB_FORMAT_V2),
            "the merge must rewrite the legacy blob as 0x02"
        );
        let back = read_local(&dir);
        assert_eq!(back.personal_words, vec!["legacy-word", "new-word"]);
        std::fs::remove_dir_all(&dir).ok();
    }

    /// The push gate: a re-encrypt of IDENTICAL content does not push.
    #[test]
    fn an_identical_re_encrypt_does_not_push() {
        let dir = scratch("gate");
        let mut local = PersonalDictionaryData::default();
        local.add_personal("myne", 100);
        write_local(&dir, &local);
        let mut st = SyncState::default();
        let t = FakeTransport::new();
        let id = dictionary_sync_id(&ROOT);

        // First cycle publishes and records the gate baseline.
        let phase = run(&t, &dir, &mut st, &id, None);
        assert!(phase.dirty);
        let nonce =
            read_dictionary_nonce(&std::fs::read(dir.join("vault.dictionary")).unwrap()).unwrap();
        st.blobs.insert(
            hex(&id),
            BlobSyncState {
                version: 3,
                content_nonce_hex: hex(&nonce),
                doc_heads_hex: Vec::new(),
            },
        );
        set_dictionary_gate_baseline(&dir, phase.gate_hash.clone());

        // Re-encrypt the SAME content under a fresh nonce (the import path
        // persists even when every word was already present).
        let bytes = encode(&local);
        std::fs::write(dir.join("vault.dictionary"), &bytes).unwrap();
        let phase2 = run(&t, &dir, &mut st, &id, None);
        assert!(!phase2.dirty, "identical content must not push");
        std::fs::remove_dir_all(&dir).ok();
    }

    /// Commutativity over the phase's merge, asserted here as well as on the
    /// payload module so the two cannot drift.
    #[test]
    fn the_phase_merge_is_commutative() {
        let mut a = PersonalDictionaryData::default();
        a.add_personal("alpha", 10);
        let mut b = PersonalDictionaryData::default();
        b.add_personal("beta", 10);
        assert_eq!(
            merge_personal_dictionaries(&a, &b),
            merge_personal_dictionaries(&b, &a)
        );
    }
}

// ---- MYND-478: vault.prefs phase (sync_prefs_phase) ----------------------

mod prefs_phase {
    // The parent module's seam shims (task 86).
    use super::{blocking, IO};

    use super::super::*;
    use crate::plugins::sync::prefs_merge::shared_subset_hash;
    use crate::plugins::sync::state::SyncState;
    use crate::plugins::sync::transport::FakeTransport;
    use base64::engine::general_purpose::STANDARD as B64;
    use base64::Engine as _;
    use protocol::PrefsView;

    const ROOT: [u8; 32] = [0x42; 32];
    const HASH: [u8; 16] = [0x33; 16];

    fn scratch(tag: &str) -> std::path::PathBuf {
        let d = std::env::temp_dir().join(format!(
            "myne-prefsphase-{tag}-{}-{:p}",
            std::process::id(),
            &tag
        ));
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    fn prefs_key() -> zeroize::Zeroizing<[u8; 32]> {
        derive_subkey(&ROOT, SubkeyRole::PrefsKey)
    }

    fn write_local(dir: &Path, view: &PrefsView) {
        let bytes = protocol::encode_prefs_blob(&prefs_key(), &HASH, view).unwrap();
        std::fs::write(dir.join("vault.prefs"), &bytes).unwrap();
    }

    fn read_local(dir: &Path) -> PrefsView {
        let bytes = std::fs::read(dir.join("vault.prefs")).unwrap();
        protocol::decode_prefs_blob(&prefs_key(), &HASH, &bytes).unwrap()
    }

    /// A MIGRATED vault meeting a peer that has also migrated: both blobs are
    /// `MYP5` under the v0.2 KEK, and the merge beats the server, so the phase
    /// takes its decode -> merge -> re-encode -> write path.
    ///
    /// Before the generation was threaded in, this phase derived
    /// `SubkeyRole::PrefsKey` under v0.1 unconditionally. The decoder sniffs
    /// the magic, so it picked the right family and then failed its tag check
    /// under the wrong key — and §9.5.5's read semantic answers ANY decode
    /// failure with `PrefsView::default()`. The phase then re-encoded that
    /// default as `MYP1` over the user's `MYP5` blob and pushed it, so the
    /// first sync after a migration reset every preference on every device.
    ///
    /// The two assertions are separate on purpose, and each catches one half:
    /// surviving content catches the KEK, surviving magic catches the encoder.
    /// Getting only the KEK right still writes `MYP1` bytes no v0.2 reader
    /// will open again. Both halves were re-broken individually to confirm
    /// this test names them.
    #[test]
    fn a_migrated_vault_keeps_its_myp5_prefs_instead_of_resetting_them() {
        let dir = scratch("migrated");
        let v0_2_key = protocol::derive_subkey_versioned(
            MetaVersion::V0_2,
            &ROOT,
            protocol::SubkeyRole::PrefsKey,
        );
        let seal = |view: &PrefsView| {
            protocol::encode_prefs_blob_versioned(MetaVersion::V0_2, &v0_2_key, &HASH, view)
                .unwrap()
        };

        // Local: a SHARED field with the newer clock, so the merge beats the
        // server and the phase must take its write-a-fresh-blob branch, plus
        // a device-local one to prove the whole view survives, not just the
        // field under contention. Without the shared win the phase adopts the
        // server's bytes and never re-encodes, which makes the encoder half of
        // this test unfalsifiable (it was, once).
        let mut mine = PrefsView {
            label: Some("Mine".into()),
            auto_lock_seconds: Some(900),
            ..PrefsView::default()
        };
        mine.field_clocks.insert("label".into(), 9_000);
        let local_bytes = seal(&mine);
        assert_eq!(
            &local_bytes[0..4],
            protocol::PREFS_BLOB_V0_2_MAGIC.as_slice()
        );
        std::fs::write(dir.join("vault.prefs"), &local_bytes).unwrap();

        // Remote: a shared edit from the other migrated device, so the merge
        // differs from BOTH sides and the phase must write a fresh blob.
        let mut theirs = PrefsView {
            label: Some("Theirs".into()),
            ..PrefsView::default()
        };
        theirs.field_clocks.insert("label".into(), 100);
        let remote_bytes = seal(&theirs);
        let pid = prefs_sync_id(&ROOT);
        let t = FakeTransport::new();
        t.on(
            HttpMethod::Get,
            &format!("/sync/blob?id={}", hex(&pid)),
            200,
            serde_json::to_vec(&serde_json::json!({ "ciphertext_b64": B64.encode(&remote_bytes) }))
                .unwrap(),
        );
        let rec = ChangedBlob {
            id: pid,
            version: 7,
            content_nonce: read_prefs_nonce(&remote_bytes).unwrap(),
            attachment_id: None,
            size: remote_bytes.len(),
        };

        let mut st = SyncState::default();
        blocking(sync_prefs_phase(
            &IO,
            &t,
            "tok",
            &SharedSingletonKey::OwnerRoot(zeroize::Zeroizing::new(ROOT)),
            &HASH,
            &dir,
            &mut st,
            &pid,
            Some(&rec),
            MetaVersion::V0_2,
        ))
        .unwrap();

        let after = std::fs::read(dir.join("vault.prefs")).unwrap();
        assert_eq!(
            &after[0..4],
            protocol::PREFS_BLOB_V0_2_MAGIC.as_slice(),
            "the phase rewrote a migrated vault's prefs as MYP1",
        );
        let back =
            protocol::decode_prefs_blob(&v0_2_key, &HASH, &after).expect("still v0.2-readable");
        assert_eq!(
            back.label.as_deref(),
            Some("Mine"),
            "the newer local shared edit lost to the server",
        );
        assert_eq!(
            back.auto_lock_seconds,
            Some(900),
            "the user's preferences were reset to defaults",
        );
        std::fs::remove_dir_all(&dir).ok();
    }

    /// Encode a remote view and register its blob under `/sync/blob?id=…`.
    fn serve_remote(t: &FakeTransport, pid: &[u8; 16], view: &PrefsView) -> ChangedBlob {
        let bytes = protocol::encode_prefs_blob(&prefs_key(), &HASH, view).unwrap();
        let nonce = read_prefs_nonce(&bytes).unwrap();
        let body = serde_json::json!({ "ciphertext_b64": B64.encode(&bytes) });
        t.on(
            HttpMethod::Get,
            &format!("/sync/blob?id={}", hex(pid)),
            200,
            serde_json::to_vec(&body).unwrap(),
        );
        ChangedBlob {
            id: *pid,
            content_nonce: nonce,
            version: 7,
            size: bytes.len(),
            attachment_id: None,
        }
    }

    // A server that has never held a prefs blob receives this device's
    // unconditionally: the §10.2.1 initial publish (even a default view).
    #[test]
    fn initial_publish_when_server_never_held_prefs() {
        let dir = scratch("initpub");
        write_local(&dir, &PrefsView::default());
        let mut st = SyncState::default();
        let t = FakeTransport::new();
        let pid = prefs_sync_id(&ROOT);

        let phase = blocking(sync_prefs_phase(
            &IO,
            &t,
            "tok",
            &SharedSingletonKey::OwnerRoot(zeroize::Zeroizing::new(ROOT)),
            &HASH,
            &dir,
            &mut st,
            &pid,
            None,
            MetaVersion::V0_1,
        ))
        .unwrap();
        assert!(phase.dirty, "never-synced server ⇒ initial publish");
        assert!(!phase.applied_remote);
        std::fs::remove_dir_all(&dir).ok();
    }

    // The push gate: a purely device-local edit (theme) re-encrypts the
    // blob but leaves the shared subset unchanged ⇒ NO push.
    #[test]
    fn device_local_change_generates_no_push() {
        let dir = scratch("gate");
        let themed = PrefsView {
            theme: Some(protocol::ThemeChoice::Dark),
            ..PrefsView::default()
        };
        write_local(&dir, &themed);
        let mut st = SyncState::default();
        let pid = prefs_sync_id(&ROOT);
        st.blobs.insert(
            hex(&pid),
            BlobSyncState {
                version: 3,
                content_nonce_hex: "00".repeat(24),
                doc_heads_hex: Vec::new(),
            },
        );
        // The synced baseline was the default view, whose SHARED subset
        // equals the themed view's (theme is device-local).
        set_prefs_gate_baseline(&dir, shared_subset_hash(&PrefsView::default()));
        let t = FakeTransport::new();

        let phase = blocking(sync_prefs_phase(
            &IO,
            &t,
            "tok",
            &SharedSingletonKey::OwnerRoot(zeroize::Zeroizing::new(ROOT)),
            &HASH,
            &dir,
            &mut st,
            &pid,
            None,
            MetaVersion::V0_1,
        ))
        .unwrap();
        assert!(!phase.dirty, "device-local edit must not push");
        std::fs::remove_dir_all(&dir).ok();
    }

    // A shared-field edit (label) changes the shared-subset hash ⇒ push.
    #[test]
    fn shared_change_pushes() {
        let dir = scratch("shared");
        let mut labeled = PrefsView {
            label: Some("Renamed".into()),
            ..PrefsView::default()
        };
        labeled.field_clocks.insert("label".into(), 100);
        write_local(&dir, &labeled);
        let mut st = SyncState::default();
        let pid = prefs_sync_id(&ROOT);
        st.blobs.insert(
            hex(&pid),
            BlobSyncState {
                version: 3,
                content_nonce_hex: "00".repeat(24),
                doc_heads_hex: Vec::new(),
            },
        );
        set_prefs_gate_baseline(&dir, shared_subset_hash(&PrefsView::default()));
        let t = FakeTransport::new();

        let phase = blocking(sync_prefs_phase(
            &IO,
            &t,
            "tok",
            &SharedSingletonKey::OwnerRoot(zeroize::Zeroizing::new(ROOT)),
            &HASH,
            &dir,
            &mut st,
            &pid,
            None,
            MetaVersion::V0_1,
        ))
        .unwrap();
        assert!(phase.dirty, "shared edit must push");
        std::fs::remove_dir_all(&dir).ok();
    }

    // A remote rename lands: merged into the on-disk view (device-local
    // theme preserved), applied_remote=true, and NO re-push: the server
    // already carries the merged shared subset (the anti-ping-pong rule).
    #[test]
    fn remote_rename_merges_applies_and_does_not_repush() {
        let dir = scratch("remote");
        let themed = PrefsView {
            theme: Some(protocol::ThemeChoice::Dark),
            ..PrefsView::default()
        };
        write_local(&dir, &themed);
        let mut st = SyncState::default();
        let pid = prefs_sync_id(&ROOT);
        let t = FakeTransport::new();
        let mut remote = PrefsView {
            label: Some("From Peer".into()),
            ..PrefsView::default()
        };
        remote.field_clocks.insert("label".into(), 500);
        let rec = serve_remote(&t, &pid, &remote);

        let phase = blocking(sync_prefs_phase(
            &IO,
            &t,
            "tok",
            &SharedSingletonKey::OwnerRoot(zeroize::Zeroizing::new(ROOT)),
            &HASH,
            &dir,
            &mut st,
            &pid,
            Some(&rec),
            MetaVersion::V0_1,
        ))
        .unwrap();
        assert!(phase.applied_remote, "remote rename must apply");
        assert!(!phase.dirty, "shared subsets agree ⇒ no re-push");
        let on_disk = read_local(&dir);
        assert_eq!(on_disk.label.as_deref(), Some("From Peer"));
        assert_eq!(
            on_disk.theme,
            Some(protocol::ThemeChoice::Dark),
            "device-local theme survives the merge"
        );
        assert_eq!(
            st.blobs.get(&hex(&pid)).map(|b| b.version),
            Some(7),
            "server revision recorded as baseline"
        );
        // Second cycle against the SAME server record: already reconciled
        // (baseline nonce) ⇒ no download, no dirt, no ping-pong.
        let phase2 = blocking(sync_prefs_phase(
            &IO,
            &t,
            "tok",
            &SharedSingletonKey::OwnerRoot(zeroize::Zeroizing::new(ROOT)),
            &HASH,
            &dir,
            &mut st,
            &pid,
            Some(&rec),
            MetaVersion::V0_1,
        ))
        .unwrap();
        assert!(!phase2.dirty);
        assert!(!phase2.applied_remote);
        std::fs::remove_dir_all(&dir).ok();
    }

    // Enrollment wholesale seed: a VIRGIN vault (no vault.prefs on disk,
    // the just-joined state) adopts the server blob VERBATIM, device-local
    // fields included as starting defaults (Q3/Q7), and never re-seeds.
    #[test]
    fn virgin_vault_seeds_wholesale_from_server() {
        let dir = scratch("seed");
        // NO local vault.prefs: the just-joined-device state.
        let mut st = SyncState::default();
        let pid = prefs_sync_id(&ROOT);
        let t = FakeTransport::new();
        let mut remote = PrefsView {
            label: Some("Vault Identity".into()),
            theme: Some(protocol::ThemeChoice::Dark), // device-local!
            ..PrefsView::default()
        };
        remote.field_clocks.insert("label".into(), 900);
        let rec = serve_remote(&t, &pid, &remote);

        let phase = blocking(sync_prefs_phase(
            &IO,
            &t,
            "tok",
            &SharedSingletonKey::OwnerRoot(zeroize::Zeroizing::new(ROOT)),
            &HASH,
            &dir,
            &mut st,
            &pid,
            Some(&rec),
            MetaVersion::V0_1,
        ))
        .unwrap();
        assert!(phase.applied_remote);
        assert!(!phase.dirty, "a seed adopts; it never pushes");
        let seeded = read_local(&dir);
        assert_eq!(seeded, remote, "wholesale: device-local theme included");
        // Second cycle against the same record: file exists + baseline
        // matches ⇒ no re-seed, no download loop.
        let phase2 = blocking(sync_prefs_phase(
            &IO,
            &t,
            "tok",
            &SharedSingletonKey::OwnerRoot(zeroize::Zeroizing::new(ROOT)),
            &HASH,
            &dir,
            &mut st,
            &pid,
            Some(&rec),
            MetaVersion::V0_1,
        ))
        .unwrap();
        assert!(!phase2.applied_remote);
        assert!(!phase2.dirty);
        std::fs::remove_dir_all(&dir).ok();
    }

    /// §11.3 on the enrollment seed. `decode_prefs_blob` succeeding is NOT
    /// the check: these bytes ARE a valid `MYP1` for this vault, they are
    /// simply not the revision the record advertised, which is exactly
    /// what a server replaying a genuine older blob under a newer record
    /// produces. Seeding them would write the wrong revision to a virgin
    /// vault AND record a baseline the client does not hold.
    #[test]
    fn a_seed_whose_bytes_do_not_match_the_record_is_refused() {
        let dir = scratch("seed-lying");
        let mut st = SyncState::default();
        let pid = prefs_sync_id(&ROOT);
        let t = FakeTransport::new();
        let mut remote = PrefsView {
            label: Some("Vault Identity".into()),
            ..PrefsView::default()
        };
        remote.field_clocks.insert("label".into(), 900);
        let mut rec = serve_remote(&t, &pid, &remote);
        // Same bytes on the wire, a different nonce in the record.
        rec.content_nonce = [0x11; 24];

        let phase = blocking(sync_prefs_phase(
            &IO,
            &t,
            "tok",
            &SharedSingletonKey::OwnerRoot(zeroize::Zeroizing::new(ROOT)),
            &HASH,
            &dir,
            &mut st,
            &pid,
            Some(&rec),
            MetaVersion::V0_1,
        ))
        .unwrap();

        assert!(
            !dir.join("vault.prefs").exists(),
            "a virgin vault must not be seeded from unverified bytes"
        );
        assert!(
            !st.blobs.contains_key(&hex(&pid)),
            "no baseline may be adopted for bytes that were never verified"
        );
        assert!(!phase.applied_remote);
        std::fs::remove_dir_all(&dir).ok();
    }

    /// The steady-state twin: a populated vault must not have its live
    /// `vault.prefs` replaced by a revision the record misidentifies.
    #[test]
    fn a_steady_state_pull_under_a_lying_record_is_skipped() {
        let dir = scratch("steady-lying");
        let local = PrefsView {
            label: Some("Mine".into()),
            ..PrefsView::default()
        };
        write_local(&dir, &local);
        let before = std::fs::read(dir.join("vault.prefs")).unwrap();

        let mut st = SyncState::default();
        let pid = prefs_sync_id(&ROOT);
        let t = FakeTransport::new();
        let mut remote = PrefsView {
            label: Some("Theirs".into()),
            ..PrefsView::default()
        };
        remote.field_clocks.insert("label".into(), 9_000);
        let mut rec = serve_remote(&t, &pid, &remote);
        rec.content_nonce = [0x11; 24];

        let phase = blocking(sync_prefs_phase(
            &IO,
            &t,
            "tok",
            &SharedSingletonKey::OwnerRoot(zeroize::Zeroizing::new(ROOT)),
            &HASH,
            &dir,
            &mut st,
            &pid,
            Some(&rec),
            MetaVersion::V0_1,
        ))
        .unwrap();

        assert_eq!(
            std::fs::read(dir.join("vault.prefs")).unwrap(),
            before,
            "the live blob must be byte-untouched"
        );
        assert_eq!(read_local(&dir).label, Some("Mine".into()));
        assert!(
            !st.blobs.contains_key(&hex(&pid)),
            "the prior baseline stays authoritative"
        );
        assert!(!phase.applied_remote);
        std::fs::remove_dir_all(&dir).ok();
    }

    // A virgin vault against an EMPTY server proceeds on defaults: no
    // crash, no seed, and the initial-publish intent registers as dirty.
    #[test]
    fn virgin_vault_with_empty_server_proceeds_on_defaults() {
        let dir = scratch("seedempty");
        let mut st = SyncState::default();
        let pid = prefs_sync_id(&ROOT);
        let t = FakeTransport::new();

        let phase = blocking(sync_prefs_phase(
            &IO,
            &t,
            "tok",
            &SharedSingletonKey::OwnerRoot(zeroize::Zeroizing::new(ROOT)),
            &HASH,
            &dir,
            &mut st,
            &pid,
            None,
            MetaVersion::V0_1,
        ))
        .unwrap();
        assert!(!phase.applied_remote);
        assert!(phase.dirty, "never-synced ⇒ initial-publish intent");
        assert!(
            !dir.join("vault.prefs").exists(),
            "no file invented; defaults apply in RAM"
        );
        std::fs::remove_dir_all(&dir).ok();
    }

    // Poisoned-gate regression (re-review I7): an UNSYNCED shared edit +
    // app restart (RAM baseline lost) + an unchanged server record must
    // still push. The self-heal may only adopt the gate baseline when the
    // local blob is provably the server's bytes: healing from the edited
    // view would silently withhold the rename from the fleet forever.
    #[test]
    fn unsynced_shared_edit_survives_a_restart() {
        let dir = scratch("restartpush");
        // The synced state was the default view under nonce 0x11…;
        // the user then renamed (re-encrypt, fresh nonce) and the app
        // restarted before any cycle ran (fresh scratch dir ⇒ empty RAM
        // baseline).
        let mut labeled = PrefsView {
            label: Some("Renamed Before Restart".into()),
            ..PrefsView::default()
        };
        labeled.field_clocks.insert("label".into(), 100);
        write_local(&dir, &labeled);
        let mut st = SyncState::default();
        let pid = prefs_sync_id(&ROOT);
        let synced_nonce = [0x11u8; 24];
        st.blobs.insert(
            hex(&pid),
            BlobSyncState {
                version: 3,
                content_nonce_hex: hex(&synced_nonce),
                doc_heads_hex: Vec::new(),
            },
        );
        // Server unchanged: its record still carries the synced nonce.
        let rec = ChangedBlob {
            id: pid,
            content_nonce: synced_nonce,
            version: 3,
            size: 0,
            attachment_id: None,
        };
        let t = FakeTransport::new();

        let phase = blocking(sync_prefs_phase(
            &IO,
            &t,
            "tok",
            &SharedSingletonKey::OwnerRoot(zeroize::Zeroizing::new(ROOT)),
            &HASH,
            &dir,
            &mut st,
            &pid,
            Some(&rec),
            MetaVersion::V0_1,
        ))
        .unwrap();
        assert!(
            phase.dirty,
            "the unsynced rename must push despite the lost RAM baseline"
        );
        assert!(!phase.applied_remote);
        std::fs::remove_dir_all(&dir).ok();
    }

    // Concurrent shared edits on both sides: the merge beats the server's
    // shared subset (local newer label survives + remote icon adopted) ⇒
    // write fresh + push against the server's version.
    #[test]
    fn concurrent_shared_edits_merge_and_push() {
        let dir = scratch("concurrent");
        let mut local = PrefsView {
            label: Some("Local Wins".into()),
            ..PrefsView::default()
        };
        local.field_clocks.insert("label".into(), 200);
        write_local(&dir, &local);
        let mut st = SyncState::default();
        let pid = prefs_sync_id(&ROOT);
        let t = FakeTransport::new();
        let mut remote = PrefsView {
            label: Some("Remote Loses".into()),
            icon: Some("book".into()),
            ..PrefsView::default()
        };
        remote.field_clocks.insert("label".into(), 100);
        remote.field_clocks.insert("icon".into(), 300);
        let rec = serve_remote(&t, &pid, &remote);

        let phase = blocking(sync_prefs_phase(
            &IO,
            &t,
            "tok",
            &SharedSingletonKey::OwnerRoot(zeroize::Zeroizing::new(ROOT)),
            &HASH,
            &dir,
            &mut st,
            &pid,
            Some(&rec),
            MetaVersion::V0_1,
        ))
        .unwrap();
        assert!(phase.dirty, "merge beat the server ⇒ push");
        assert!(phase.applied_remote, "remote icon landed locally");
        let on_disk = read_local(&dir);
        assert_eq!(on_disk.label.as_deref(), Some("Local Wins"));
        assert_eq!(on_disk.icon.as_deref(), Some("book"));
        assert_eq!(on_disk.field_clocks.get("label"), Some(&200));
        assert_eq!(on_disk.field_clocks.get("icon"), Some(&300));
        std::fs::remove_dir_all(&dir).ok();
    }

    // ---- MYND-604: color groups across two devices ----------------------
    //
    // The criterion these serve is task 7's "rules … appear on a second
    // synced device". The restart half is proven by the desktop E2E
    // (`gc2`); this is the OTHER device. What makes a `FakeTransport`
    // faithful here rather than a stand-in: `run_sync_cycle`'s
    // `prefs_phase.dirty` arm uploads `io.read(vault_root/"vault.prefs")`
    // VERBATIM: the pushed ciphertext IS the author's on-disk blob, and
    // the server is a zero-knowledge relay that cannot read or alter it.
    // So serving device A's actual file bytes as B's server record models
    // the wire payload exactly; only the socket is faked, and the response
    // is parsed by the same `download_blob_backoff` + codec production
    // uses. `prefs_merge`'s tests cover the merge algebra in isolation;
    // these cover the phase that carries it between two vault dirs.

    /// Register ALREADY-ENCODED bytes (a peer's on-disk blob, which is
    /// verbatim what the push path uploads) as the server's record.
    fn serve_remote_raw(
        t: &FakeTransport,
        pid: &[u8; 16],
        bytes: &[u8],
        version: u64,
    ) -> ChangedBlob {
        let nonce = read_prefs_nonce(bytes).unwrap();
        let body = serde_json::json!({ "ciphertext_b64": B64.encode(bytes) });
        t.on(
            HttpMethod::Get,
            &format!("/sync/blob?id={}", hex(pid)),
            200,
            serde_json::to_vec(&body).unwrap(),
        );
        ChangedBlob {
            id: *pid,
            content_nonce: nonce,
            version,
            size: bytes.len(),
            attachment_id: None,
        }
    }

    /// Two ordered rules exercising both v1 filter leaves, one of them
    /// DISABLED: a disabled rule is retained, so it must cross the wire
    /// too or re-enabling it on the peer loses the authoring work.
    fn authored_rules() -> Vec<protocol::ColorGroup> {
        use protocol::{ColorGroup, FilterNode};
        vec![
            ColorGroup {
                id: "g-first".into(),
                name: "Work".into(),
                color: "group-teal".into(),
                enabled: true,
                filter: FilterNode::HasTag { tag: "work".into() },
            },
            ColorGroup {
                id: "g-second".into(),
                name: "Archive".into(),
                color: "group-rose".into(),
                enabled: false,
                filter: FilterNode::InFolder {
                    path: "Archive/2026".into(),
                },
            },
        ]
    }

    // Device A authors color groups; device B receives them. A's push
    // registers as dirty, and B's phase lands A's EXACT blob bytes: same
    // rules, same precedence order, same disabled flag, same filter ASTs;
    // while B's own device-local tuning survives untouched.
    #[test]
    fn color_groups_authored_on_device_a_land_on_device_b() {
        let dir_a = scratch("cgdevA");
        let dir_b = scratch("cgdevB");
        let pid = prefs_sync_id(&ROOT);

        // --- Device A: author the rules, then run its phase against a
        // server that has never held prefs → the §10.2.1 initial publish.
        let mut a = PrefsView {
            color_groups: authored_rules(),
            ..PrefsView::default()
        };
        a.field_clocks.insert("color_groups".into(), 1_000);
        write_local(&dir_a, &a);
        let mut st_a = SyncState::default();
        let t_a = FakeTransport::new();
        let phase_a = blocking(sync_prefs_phase(
            &IO,
            &t_a,
            "tok",
            &SharedSingletonKey::OwnerRoot(zeroize::Zeroizing::new(ROOT)),
            &HASH,
            &dir_a,
            &mut st_a,
            &pid,
            None,
            MetaVersion::V0_1,
        ))
        .unwrap();
        assert!(phase_a.dirty, "A must push its newly authored rules");

        // The bytes `run_sync_cycle` would upload for A, read the same way.
        let pushed = std::fs::read(dir_a.join("vault.prefs")).unwrap();

        // --- Device B: an already-synced device with no color groups and
        // its own device-local theme.
        let b_before = PrefsView {
            theme: Some(protocol::ThemeChoice::Dark),
            ..PrefsView::default()
        };
        write_local(&dir_b, &b_before);
        let mut st_b = SyncState::default();
        st_b.blobs.insert(
            hex(&pid),
            BlobSyncState {
                version: 3,
                content_nonce_hex: "00".repeat(24),
                doc_heads_hex: Vec::new(),
            },
        );
        set_prefs_gate_baseline(&dir_b, shared_subset_hash(&PrefsView::default()));
        let t_b = FakeTransport::new();
        let rec = serve_remote_raw(&t_b, &pid, &pushed, 8);

        let phase_b = blocking(sync_prefs_phase(
            &IO,
            &t_b,
            "tok",
            &SharedSingletonKey::OwnerRoot(zeroize::Zeroizing::new(ROOT)),
            &HASH,
            &dir_b,
            &mut st_b,
            &pid,
            Some(&rec),
            MetaVersion::V0_1,
        ))
        .unwrap();
        assert!(phase_b.applied_remote, "A's rules must land on B");
        assert!(
            !phase_b.dirty,
            "B adopted a shared subset it already agrees with ⇒ no ping-pong re-push"
        );

        // B's DISK is the assertion: the peer reads its rules back from
        // the blob it persisted, not from the merge's return value.
        let on_b = read_local(&dir_b);
        assert_eq!(
            on_b.color_groups,
            authored_rules(),
            "every field of every rule, in authoring order (= precedence)"
        );
        assert_eq!(
            on_b.color_groups
                .iter()
                .map(|g| g.id.as_str())
                .collect::<Vec<_>>(),
            vec!["g-first", "g-second"],
            "precedence order survives the wire; never re-sorted by id"
        );
        assert!(!on_b.color_groups[1].enabled, "a disabled rule is retained");
        assert_eq!(on_b.field_clocks.get("color_groups"), Some(&1_000));
        assert_eq!(
            on_b.theme,
            Some(protocol::ThemeChoice::Dark),
            "B's device-local theme is not overwritten by A's vault content"
        );

        std::fs::remove_dir_all(&dir_a).ok();
        std::fs::remove_dir_all(&dir_b).ok();
    }

    // …and back the other way: B edits the list it just received and A
    // converges on B's version. The reverse leg is a separate claim:
    // `color_groups` is `Shared(WholeValueLww)`, so the peer that edits
    // second must WIN on the author, not merge into a hybrid list.
    #[test]
    fn a_color_group_edited_on_device_b_converges_back_onto_device_a() {
        let dir_a = scratch("cgbackA");
        let dir_b = scratch("cgbackB");
        let pid = prefs_sync_id(&ROOT);

        // A holds the authored list (clock 1_000).
        let mut a = PrefsView {
            color_groups: authored_rules(),
            ..PrefsView::default()
        };
        a.field_clocks.insert("color_groups".into(), 1_000);
        write_local(&dir_a, &a);

        // B edits it: reorders (precedence change), renames the first rule
        // and re-enables the second, under a newer clock.
        let mut edited = authored_rules();
        edited.swap(0, 1);
        edited[0].enabled = true;
        edited[1].name = "Work Notes".into();
        let mut b = PrefsView {
            color_groups: edited.clone(),
            theme: Some(protocol::ThemeChoice::Dark),
            ..PrefsView::default()
        };
        b.field_clocks.insert("color_groups".into(), 2_000);
        write_local(&dir_b, &b);
        let b_bytes = std::fs::read(dir_b.join("vault.prefs")).unwrap();

        // A pulls B's blob.
        let mut st_a = SyncState::default();
        st_a.blobs.insert(
            hex(&pid),
            BlobSyncState {
                version: 3,
                content_nonce_hex: "00".repeat(24),
                doc_heads_hex: Vec::new(),
            },
        );
        set_prefs_gate_baseline(&dir_a, shared_subset_hash(&a));
        let t_a = FakeTransport::new();
        let rec = serve_remote_raw(&t_a, &pid, &b_bytes, 9);

        let phase = blocking(sync_prefs_phase(
            &IO,
            &t_a,
            "tok",
            &SharedSingletonKey::OwnerRoot(zeroize::Zeroizing::new(ROOT)),
            &HASH,
            &dir_a,
            &mut st_a,
            &pid,
            Some(&rec),
            MetaVersion::V0_1,
        ))
        .unwrap();
        assert!(phase.applied_remote, "B's newer edit must land on A");

        let on_a = read_local(&dir_a);
        assert_eq!(
            on_a.color_groups, edited,
            "whole-value LWW: A adopts B's list entire, never a hybrid"
        );
        assert_eq!(
            on_a.color_groups
                .iter()
                .map(|g| g.id.as_str())
                .collect::<Vec<_>>(),
            vec!["g-second", "g-first"],
            "the reordered precedence is what converged"
        );
        assert_eq!(on_a.field_clocks.get("color_groups"), Some(&2_000));
        assert_eq!(
            on_a.theme, None,
            "B's device-local theme did NOT travel to A"
        );

        std::fs::remove_dir_all(&dir_a).ok();
        std::fs::remove_dir_all(&dir_b).ok();
    }

    // A stale peer cannot resurrect deleted rules. The delete is the case
    // the codec bug found last turn lived in, and it is the one an LWW
    // field gets wrong most easily: an empty list is omitted from the
    // blob, so "absent" must read as "cleared under clock 3_000", not as
    // "this device has nothing to say".
    #[test]
    fn deleting_every_rule_on_one_device_deletes_them_on_the_other() {
        let dir_a = scratch("cgdelA");
        let pid = prefs_sync_id(&ROOT);

        // A still holds the rules under the OLD clock.
        let mut a = PrefsView {
            label: Some("Keep Me".into()),
            color_groups: authored_rules(),
            ..PrefsView::default()
        };
        a.field_clocks.insert("color_groups".into(), 1_000);
        a.field_clocks.insert("label".into(), 50);
        write_local(&dir_a, &a);

        // B cleared the list under a NEWER clock and pushed that.
        let mut b = PrefsView::default();
        b.field_clocks.insert("color_groups".into(), 3_000);
        let cleared_bytes = protocol::encode_prefs_blob(&prefs_key(), &HASH, &b).unwrap();

        let mut st_a = SyncState::default();
        st_a.blobs.insert(
            hex(&pid),
            BlobSyncState {
                version: 3,
                content_nonce_hex: "00".repeat(24),
                doc_heads_hex: Vec::new(),
            },
        );
        set_prefs_gate_baseline(&dir_a, shared_subset_hash(&a));
        let t_a = FakeTransport::new();
        let rec = serve_remote_raw(&t_a, &pid, &cleared_bytes, 11);

        blocking(sync_prefs_phase(
            &IO,
            &t_a,
            "tok",
            &SharedSingletonKey::OwnerRoot(zeroize::Zeroizing::new(ROOT)),
            &HASH,
            &dir_a,
            &mut st_a,
            &pid,
            Some(&rec),
            MetaVersion::V0_1,
        ))
        .unwrap();

        let on_a = read_local(&dir_a);
        assert!(
            on_a.color_groups.is_empty(),
            "the peer's delete wins; rules do not come back"
        );
        // The neighbour-field guard from last turn's decoder bug: a view
        // that collapsed to defaults would ALSO show an empty list, so
        // assert something else survived the read.
        assert_eq!(
            on_a.label.as_deref(),
            Some("Keep Me"),
            "the rest of the preference set is intact (not a defaults fallback)"
        );

        std::fs::remove_dir_all(&dir_a).ok();
    }
}

// ---- myne-md/myne#675: vault.chats phases (sync_chats_phase,
// sync_chats_conversation_phase) --------------------

mod chats_phase {
    // The parent module's seam shims (task 86).
    use super::{blocking, IO};

    use super::super::*;
    use crate::plugins::sync::state::SyncState;
    use crate::plugins::sync::transport::FakeTransport;
    use crate::vault_io::{IoResult, VaultIo};
    use base64::engine::general_purpose::STANDARD as B64;
    use base64::Engine as _;

    const ROOT: [u8; 32] = [0x42; 32];
    const HASH: [u8; 16] = [0x33; 16];
    const CONV: [u8; 16] = [0xAA; 16];

    fn scratch(tag: &str) -> std::path::PathBuf {
        let d = std::env::temp_dir().join(format!(
            "myne-chatsphase-{tag}-{}-{:p}",
            std::process::id(),
            &tag
        ));
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    fn chats_key() -> zeroize::Zeroizing<[u8; 32]> {
        derive_subkey_versioned(MetaVersion::V0_1, &ROOT, SubkeyRole::ChatsKey)
    }

    fn chats_catalog_key() -> zeroize::Zeroizing<[u8; 32]> {
        derive_subkey_versioned(MetaVersion::V0_1, &ROOT, SubkeyRole::ChatsCatalogKey)
    }

    fn turn(id: &str, text: &str) -> serde_json::Value {
        serde_json::json!({"id": id, "kind": "text", "role": "user", "text": text})
    }

    fn seal_conversation(turns: Vec<serde_json::Value>, title: Option<&str>) -> Vec<u8> {
        let mut map = serde_json::Map::new();
        map.insert("turns".to_string(), serde_json::Value::Array(turns));
        if let Some(t) = title {
            map.insert(
                "title_derived_from".to_string(),
                serde_json::Value::String(t.to_string()),
            );
        }
        let plaintext = serde_json::to_vec(&serde_json::Value::Object(map)).unwrap();
        protocol::encode_chats_blob_versioned(
            MetaVersion::V0_1,
            &chats_key(),
            &HASH,
            &CONV,
            &plaintext,
        )
        .unwrap()
    }

    fn open_conversation(bytes: &[u8]) -> serde_json::Value {
        let plaintext = protocol::decode_chats_blob_versioned(
            MetaVersion::V0_1,
            &chats_key(),
            &HASH,
            &CONV,
            bytes,
        )
        .unwrap();
        serde_json::from_slice(&plaintext).unwrap()
    }

    fn turn_ids(v: &serde_json::Value) -> Vec<String> {
        v.get("turns")
            .and_then(|t| t.as_array())
            .unwrap()
            .iter()
            .map(|t| t.get("id").and_then(|i| i.as_str()).unwrap().to_string())
            .collect()
    }

    /// Encode a remote conversation blob and register it under
    /// `/sync/blob?id=…`.
    fn serve_remote(t: &FakeTransport, bytes: &[u8], version: u64) -> ChangedBlob {
        let nonce = read_chats_blob_nonce(bytes).unwrap();
        let body = serde_json::json!({ "ciphertext_b64": B64.encode(bytes) });
        t.on(
            HttpMethod::Get,
            &format!("/sync/blob?id={}", hex(&CONV)),
            200,
            serde_json::to_vec(&body).unwrap(),
        );
        ChangedBlob {
            id: CONV,
            content_nonce: nonce,
            version,
            size: bytes.len(),
            attachment_id: None,
        }
    }

    fn write_local(dir: &Path, bytes: &[u8]) {
        std::fs::create_dir_all(dir.join("chats")).unwrap();
        std::fs::write(dir.join("chats").join(hex(&CONV)), bytes).unwrap();
    }

    fn run_conversation_phase(
        io: &dyn VaultIo,
        t: &FakeTransport,
        dir: &Path,
        rec: Option<&ChangedBlob>,
    ) -> Result<ChatsConversationPhase, SyncCycleError> {
        blocking(sync_chats_conversation_phase(
            io,
            t,
            "tok",
            &ROOT,
            &HASH,
            dir,
            &CONV,
            rec,
            MetaVersion::V0_1,
        ))
    }

    /// A `VaultIo` whose reads always fail with a non-`NotFound` kind:
    /// pins the absent-vs-unreadable distinction (a wrapper that failed
    /// everything would prove nothing about the `NotFound` arm, which is
    /// exactly why the absent test below uses the real `IO`).
    struct FailReads;
    #[async_trait::async_trait]
    impl VaultIo for FailReads {
        async fn read(&self, _path: &Path) -> IoResult<Vec<u8>> {
            Err(crate::io_failure_kind::IoFailureKind::Other)
        }
        async fn read_prefix(&self, path: &Path, len: usize) -> IoResult<Vec<u8>> {
            crate::vault_io::StdVaultIo.read_prefix(path, len).await
        }
        async fn write(
            &self,
            path: &Path,
            bytes: &[u8],
            opts: crate::vault_io::WriteOpts,
        ) -> IoResult<()> {
            crate::vault_io::StdVaultIo.write(path, bytes, opts).await
        }
        async fn remove_file(&self, path: &Path) -> IoResult<()> {
            crate::vault_io::StdVaultIo.remove_file(path).await
        }
        async fn remove_dir_all(&self, path: &Path) -> IoResult<()> {
            crate::vault_io::StdVaultIo.remove_dir_all(path).await
        }
        async fn create_dir_all(&self, path: &Path) -> IoResult<()> {
            crate::vault_io::StdVaultIo.create_dir_all(path).await
        }
        async fn read_dir(&self, path: &Path) -> IoResult<Vec<crate::vault_io::DirEntry>> {
            crate::vault_io::StdVaultIo.read_dir(path).await
        }
        async fn exists(&self, path: &Path) -> IoResult<bool> {
            crate::vault_io::StdVaultIo.exists(path).await
        }
        async fn is_dir(&self, path: &Path) -> IoResult<bool> {
            crate::vault_io::StdVaultIo.is_dir(path).await
        }
        async fn rename(&self, from: &Path, to: &Path) -> IoResult<()> {
            crate::vault_io::StdVaultIo.rename(from, to).await
        }
    }

    // The refused outcome's contract, pinned where a sixth arm cannot
    // silently invent a new shape: nothing dirty, nothing applied,
    // an empty roster (so the catalog-guarded loops are inert), skipped.
    #[test]
    fn skipped_outcome_holds_its_invariants() {
        let phase = skipped_chats_phase();
        assert!(phase.skipped);
        assert!(!phase.dirty);
        assert!(!phase.applied_remote);
        assert!(phase.push_bytes.is_none());
        assert!(phase.merged.is_empty());
    }

    // A virgin no-conversations vault stays chats-silent: no file, no
    // record, nothing to push.
    #[test]
    fn virgin_vault_stays_chats_silent() {
        let dir = scratch("virgin");
        let mut st = SyncState::default();
        let t = FakeTransport::new();
        let catid = chats_catalog_sync_id(&ROOT);
        let phase = blocking(sync_chats_phase(
            &IO,
            &t,
            "tok",
            &ROOT,
            &HASH,
            &dir,
            &mut st,
            &catid,
            None,
            MetaVersion::V0_1,
        ))
        .unwrap();
        assert!(!phase.dirty);
        assert!(!phase.skipped);
        assert!(phase.push_bytes.is_none());
        std::fs::remove_dir_all(&dir).ok();
    }

    // An unreadable local catalog refuses the plane even against a live
    // remote record: the garbage on disk is untouched (never adopted as
    // the merge base, never re-pushed over the server).
    #[test]
    fn unreadable_local_catalog_skips_the_plane() {
        let dir = scratch("unreadable");
        std::fs::write(dir.join("vault.chats"), b"torn-bytes").unwrap();
        let remote_bytes = protocol::encode_chats_catalog_blob_versioned(
            MetaVersion::V0_1,
            &chats_catalog_key(),
            &HASH,
            b"{}",
        )
        .unwrap();
        let t = FakeTransport::new();
        let catid = chats_catalog_sync_id(&ROOT);
        let nonce = read_chats_catalog_nonce(&remote_bytes).unwrap();
        let body = serde_json::json!({ "ciphertext_b64": B64.encode(&remote_bytes) });
        t.on(
            HttpMethod::Get,
            &format!("/sync/blob?id={}", hex(&catid)),
            200,
            serde_json::to_vec(&body).unwrap(),
        );
        let rec = ChangedBlob {
            id: catid,
            content_nonce: nonce,
            version: 3,
            size: remote_bytes.len(),
            attachment_id: None,
        };
        let mut st = SyncState::default();
        let phase = blocking(sync_chats_phase(
            &IO,
            &t,
            "tok",
            &ROOT,
            &HASH,
            &dir,
            &mut st,
            &catid,
            Some(&rec),
            MetaVersion::V0_1,
        ))
        .unwrap();
        assert!(phase.skipped, "an unreadable store refuses, never merges");
        assert!(!phase.dirty);
        assert_eq!(
            std::fs::read(dir.join("vault.chats")).unwrap(),
            b"torn-bytes",
            "the refused store is never written"
        );
        std::fs::remove_dir_all(&dir).ok();
    }

    // Absent local file + a verified remote record: the remote is
    // adopted verbatim (the `NotFound`-is-absent arm, not a refusal).
    #[test]
    fn absent_conversation_file_adopts_verified_remote() {
        let dir = scratch("absent");
        let t = FakeTransport::new();
        let remote_bytes = seal_conversation(vec![turn("t1", "hello")], Some("remote-title"));
        let rec = serve_remote(&t, &remote_bytes, 2);
        let phase = run_conversation_phase(&IO, &t, &dir, Some(&rec)).unwrap();
        assert!(
            phase.push_bytes.is_none(),
            "verbatim adoption pushes nothing"
        );
        assert!(phase.remote.is_some());
        assert_eq!(
            std::fs::read(dir.join("chats").join(hex(&CONV))).unwrap(),
            remote_bytes,
            "adoption is byte-verbatim"
        );
        std::fs::remove_dir_all(&dir).ok();
    }

    // A conversation file that exists but cannot be READ refuses for the
    // cycle: it must not merge as the empty turn list (which would adopt
    // the remote over turns that never reached the server).
    #[test]
    fn unreadable_conversation_file_refuses_for_the_cycle() {
        let dir = scratch("unreadable-conv");
        let io = FailReads;
        let t = FakeTransport::new();
        let remote_bytes = seal_conversation(vec![turn("t1", "hello")], Some("remote-title"));
        let rec = serve_remote(&t, &remote_bytes, 2);
        let err = run_conversation_phase(&io, &t, &dir, Some(&rec)).unwrap_err();
        assert!(
            matches!(err, SyncCycleError::Io),
            "a failed read refuses, never merges-as-empty"
        );
        std::fs::remove_dir_all(&dir).ok();
    }

    // The merge carries the title snapshot: local wins on disagreement,
    // and the merged file keeps the § 9.24.2 shape.
    #[test]
    fn conversation_merge_keeps_the_local_title() {
        let dir = scratch("title");
        let t = FakeTransport::new();
        write_local(
            &dir,
            &seal_conversation(vec![turn("t1", "hello")], Some("local-title")),
        );
        let remote_bytes = seal_conversation(
            vec![turn("t1", "hello"), turn("t2", "and more")],
            Some("remote-title"),
        );
        let rec = serve_remote(&t, &remote_bytes, 2);
        let phase = run_conversation_phase(&IO, &t, &dir, Some(&rec)).unwrap();
        assert!(
            phase.push_bytes.is_some(),
            "a merge that beats the server pushes"
        );
        let merged = open_conversation(&std::fs::read(dir.join("chats").join(hex(&CONV))).unwrap());
        assert_eq!(turn_ids(&merged), vec!["t1".to_string(), "t2".to_string()]);
        assert_eq!(
            merged.get("title_derived_from").and_then(|s| s.as_str()),
            Some("local-title"),
            "the local snapshot survives the merge"
        );
        std::fs::remove_dir_all(&dir).ok();
    }

    // An agreed title does not churn the nonce: identical turns and an
    // identical snapshot adopt the server bytes verbatim.
    #[test]
    fn conversation_agreed_title_adopts_verbatim() {
        let dir = scratch("title-agree");
        let t = FakeTransport::new();
        let local_bytes = seal_conversation(vec![turn("t1", "hello")], Some("shared-title"));
        write_local(&dir, &local_bytes);
        // A distinct seal of the same turns and title: same plaintext,
        // different outer nonce, so verbatim adoption is observable.
        let remote_bytes = seal_conversation(vec![turn("t1", "hello")], Some("shared-title"));
        let rec = serve_remote(&t, &remote_bytes, 5);
        let phase = run_conversation_phase(&IO, &t, &dir, Some(&rec)).unwrap();
        assert!(phase.push_bytes.is_none(), "an agreed merge pushes nothing");
        assert_eq!(
            std::fs::read(dir.join("chats").join(hex(&CONV))).unwrap(),
            remote_bytes,
            "adoption is byte-verbatim"
        );
        std::fs::remove_dir_all(&dir).ok();
    }
}

// ---- myne-md/myne#697: agent-memory plane (sync_memory_phase) ----------

mod memory_phase {
    // The parent module's seam shims (task 86).
    use super::{blocking, IO};

    use super::super::*;
    use crate::plugins::sync::state::SyncState;
    use crate::plugins::sync::transport::FakeTransport;
    use crate::vault_io::VaultIo;
    use base64::engine::general_purpose::STANDARD as B64;
    use base64::Engine as _;

    const ROOT: [u8; 32] = [0x42; 32];
    const HASH: [u8; 16] = [0x33; 16];
    const ENTRY: [u8; 16] = [0xBB; 16];

    fn scratch(tag: &str) -> std::path::PathBuf {
        let d = std::env::temp_dir().join(format!(
            "myne-memoryphase-{tag}-{}-{:p}",
            std::process::id(),
            &tag
        ));
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    fn memory_catalog_key() -> zeroize::Zeroizing<[u8; 32]> {
        derive_subkey_versioned(MetaVersion::V0_1, &ROOT, SubkeyRole::AgentMemoryCatalogKey)
    }

    fn memory_key() -> zeroize::Zeroizing<[u8; 32]> {
        derive_subkey_versioned(MetaVersion::V0_1, &ROOT, SubkeyRole::AgentMemoryKey)
    }

    fn personality_key() -> zeroize::Zeroizing<[u8; 32]> {
        derive_subkey_versioned(MetaVersion::V0_1, &ROOT, SubkeyRole::AgentPersonalityKey)
    }

    fn row(version: u64) -> serde_json::Value {
        serde_json::json!({"created_at": 1, "updated_at": 1, "version": version})
    }

    fn seal_catalog(map: &serde_json::Value) -> Vec<u8> {
        protocol::encode_agent_memory_catalog_blob_versioned(
            MetaVersion::V0_1,
            &memory_catalog_key(),
            &HASH,
            &serde_json::to_vec(map).unwrap(),
        )
        .unwrap()
    }

    fn seal_entry(id: &[u8; 16], text: &str) -> Vec<u8> {
        let plaintext = serde_json::json!({"text": text}).to_string().into_bytes();
        protocol::encode_agent_memory_blob_versioned(
            MetaVersion::V0_1,
            &memory_key(),
            &HASH,
            id,
            &plaintext,
        )
        .unwrap()
    }

    fn seal_personality(directives: &str) -> Vec<u8> {
        let plaintext = serde_json::json!({"directives": directives})
            .to_string()
            .into_bytes();
        protocol::encode_agent_personality_blob_versioned(
            MetaVersion::V0_1,
            &personality_key(),
            &HASH,
            &plaintext,
        )
        .unwrap()
    }

    fn seal_personality_at(text: &str, updated_at: u64) -> Vec<u8> {
        let plaintext =
            serde_json::json!({"directives": [{"text": text, "updated_at": updated_at}]})
                .to_string()
                .into_bytes();
        protocol::encode_agent_personality_blob_versioned(
            MetaVersion::V0_1,
            &personality_key(),
            &HASH,
            &plaintext,
        )
        .unwrap()
    }

    /// Register bytes under `/sync/blob?id=…` and return the record.
    fn serve(t: &FakeTransport, id: &[u8; 16], bytes: &[u8], version: u64) -> ChangedBlob {
        let nonce = read_agent_memory_blob_nonce(bytes)
            .or_else(|| read_agent_memory_catalog_nonce(bytes))
            .or_else(|| read_personality_nonce(bytes))
            .unwrap();
        let body = serde_json::json!({ "ciphertext_b64": B64.encode(bytes) });
        t.on(
            HttpMethod::Get,
            &format!("/sync/blob?id={}", hex(id)),
            200,
            serde_json::to_vec(&body).unwrap(),
        );
        ChangedBlob {
            id: *id,
            content_nonce: nonce,
            version,
            size: bytes.len(),
            attachment_id: None,
        }
    }

    fn run_catalog_phase(
        io: &dyn VaultIo,
        t: &FakeTransport,
        dir: &Path,
        st: &mut SyncState,
        rec: Option<&ChangedBlob>,
    ) -> Result<MemoryPhase, SyncCycleError> {
        let catid = agent_memory_catalog_sync_id(&ROOT);
        blocking(sync_memory_phase(
            io,
            t,
            "tok",
            &ROOT,
            &HASH,
            dir,
            st,
            &catid,
            rec,
            MetaVersion::V0_1,
        ))
    }

    fn run_entry_phase(
        io: &dyn VaultIo,
        t: &FakeTransport,
        dir: &Path,
        st: &mut SyncState,
        rec: Option<&ChangedBlob>,
        remote_wins: bool,
    ) -> Result<MemoryEntryPhase, SyncCycleError> {
        blocking(sync_memory_entry_phase(
            io,
            t,
            "tok",
            &ROOT,
            &HASH,
            dir,
            st,
            &ENTRY,
            rec,
            remote_wins,
            MetaVersion::V0_1,
        ))
    }

    fn run_personality_phase(
        io: &dyn VaultIo,
        t: &FakeTransport,
        dir: &Path,
        st: &mut SyncState,
        rec: Option<&ChangedBlob>,
    ) -> Result<PersonalityPhase, SyncCycleError> {
        let pid = agent_personality_sync_id(&ROOT);
        blocking(sync_personality_phase(
            io,
            t,
            "tok",
            &ROOT,
            &HASH,
            dir,
            st,
            &pid,
            rec,
            MetaVersion::V0_1,
        ))
    }

    fn seed_baseline(st: &mut SyncState, id_hex: &str, nonce_hex: String) {
        st.blobs.insert(
            id_hex.to_string(),
            BlobSyncState {
                version: 1,
                content_nonce_hex: nonce_hex,
                doc_heads_hex: Vec::new(),
            },
        );
    }

    #[test]
    fn skipped_outcome_holds_its_invariants() {
        let phase = skipped_memory_phase();
        assert!(phase.skipped);
        assert!(!phase.dirty);
        assert!(!phase.applied_remote);
        assert!(phase.push_bytes.is_none());
        assert!(phase.merged.is_empty());
        let phase = skipped_personality_phase();
        assert!(phase.skipped);
        assert!(!phase.dirty);
        assert!(!phase.applied_remote);
        assert!(phase.push_bytes.is_none());
    }

    // A virgin no-memories vault stays memory-silent: no file, no
    // record, nothing to push.
    #[test]
    fn virgin_vault_stays_memory_silent() {
        let dir = scratch("virgin");
        let mut st = SyncState::default();
        let t = FakeTransport::new();
        let phase = run_catalog_phase(&IO, &t, &dir, &mut st, None).unwrap();
        assert!(!phase.dirty);
        assert!(!phase.skipped);
        assert!(phase.push_bytes.is_none());
        let phase = run_personality_phase(&IO, &t, &dir, &mut st, None).unwrap();
        assert!(!phase.dirty);
        assert!(!phase.skipped);
        assert!(phase.push_bytes.is_none());
        std::fs::remove_dir_all(&dir).ok();
    }

    // An unreadable local catalog refuses the plane even against a live
    // remote record: the garbage on disk is untouched.
    #[test]
    fn unreadable_local_catalog_skips_the_plane() {
        let dir = scratch("unreadable");
        std::fs::write(dir.join("vault.agent-memory"), b"torn-bytes").unwrap();
        let catid = agent_memory_catalog_sync_id(&ROOT);
        let remote_bytes = seal_catalog(&serde_json::json!({}));
        let t = FakeTransport::new();
        let rec = serve(&t, &catid, &remote_bytes, 3);
        let mut st = SyncState::default();
        let phase = run_catalog_phase(&IO, &t, &dir, &mut st, Some(&rec)).unwrap();
        assert!(phase.skipped, "an unreadable store refuses, never merges");
        assert!(!phase.dirty);
        assert_eq!(
            std::fs::read(dir.join("vault.agent-memory")).unwrap(),
            b"torn-bytes",
            "the refused store is never written"
        );
        std::fs::remove_dir_all(&dir).ok();
    }

    // Absent local catalog + a verified remote record: adopted verbatim.
    #[test]
    fn absent_catalog_adopts_verified_remote() {
        let dir = scratch("absent-cat");
        let catid = agent_memory_catalog_sync_id(&ROOT);
        let remote_bytes = seal_catalog(&serde_json::json!({hex(&ENTRY): row(1)}));
        let t = FakeTransport::new();
        let rec = serve(&t, &catid, &remote_bytes, 2);
        let mut st = SyncState::default();
        let phase = run_catalog_phase(&IO, &t, &dir, &mut st, Some(&rec)).unwrap();
        assert!(!phase.skipped);
        assert!(
            phase.push_bytes.is_none(),
            "verbatim adoption pushes nothing"
        );
        assert!(phase.applied_remote);
        assert_eq!(
            std::fs::read(dir.join("vault.agent-memory")).unwrap(),
            remote_bytes,
            "adoption is byte-verbatim"
        );
        std::fs::remove_dir_all(&dir).ok();
    }

    // Local-only change: dirty with the exact local bytes to push.
    #[test]
    fn local_only_catalog_change_pushes() {
        let dir = scratch("local-dirty");
        let local_bytes = seal_catalog(&serde_json::json!({hex(&ENTRY): row(1)}));
        std::fs::write(dir.join("vault.agent-memory"), &local_bytes).unwrap();
        let mut st = SyncState::default();
        let t = FakeTransport::new();
        let phase = run_catalog_phase(&IO, &t, &dir, &mut st, None).unwrap();
        assert!(!phase.skipped);
        assert!(phase.dirty);
        assert_eq!(phase.push_bytes.unwrap(), local_bytes);
        std::fs::remove_dir_all(&dir).ok();
    }

    // A merge that beats the server pushes the merged bytes (local row A
    // + remote row B converge to {A, B}, which equals neither side).
    #[test]
    fn merge_that_beats_the_server_pushes() {
        let dir = scratch("merge-wins");
        let other = [0xCC; 16];
        let local_bytes = seal_catalog(&serde_json::json!({hex(&ENTRY): row(1)}));
        std::fs::write(dir.join("vault.agent-memory"), &local_bytes).unwrap();
        let remote_bytes = seal_catalog(&serde_json::json!({hex(&other): row(1)}));
        let catid = agent_memory_catalog_sync_id(&ROOT);
        let t = FakeTransport::new();
        let rec = serve(&t, &catid, &remote_bytes, 2);
        let mut st = SyncState::default();
        let phase = run_catalog_phase(&IO, &t, &dir, &mut st, Some(&rec)).unwrap();
        assert!(!phase.skipped);
        assert!(phase.dirty, "the merge differs from the server store");
        assert!(phase.applied_remote);
        assert_eq!(phase.merged.len(), 2, "both rows survive the join");
        assert!(phase.push_bytes.is_some());
        std::fs::remove_dir_all(&dir).ok();
    }

    // Enrollment seed order (task 8): a catalog adopted wholesale keeps
    // its tombstones, so an entry deleted before this device enrolled does
    // not resurrect here. The tombstoned row survives verbatim; no entry
    // file is fetched for it.
    #[test]
    fn enrollment_seed_keeps_tombstones_verbatim() {
        let dir = scratch("enroll-tomb");
        let dead = [0xDD; 16];
        let remote_bytes = seal_catalog(&serde_json::json!({
            hex(&ENTRY): row(1),
            hex(&dead): {"created_at": 1, "updated_at": 5, "version": 4, "deleted_at": 5},
        }));
        let catid = agent_memory_catalog_sync_id(&ROOT);
        let t = FakeTransport::new();
        let rec = serve(&t, &catid, &remote_bytes, 2);
        let mut st = SyncState::default();
        let phase = run_catalog_phase(&IO, &t, &dir, &mut st, Some(&rec)).unwrap();
        assert!(!phase.skipped);
        assert!(phase.applied_remote);
        let tomb = &phase.merged[&hex(&dead)];
        assert!(
            tomb.deleted_at.is_some(),
            "the pre-enrollment delete must survive the wholesale seed"
        );
        assert_eq!(phase.merged.len(), 2);
        std::fs::remove_dir_all(&dir).ok();
    }

    // Absent entry file + verified remote: adopted verbatim.
    //
    // The fixture deliberately does NOT pre-create `memories/`: an absent
    // local file is exactly the shape of a device that has never authored a
    // memory of its own, which is the device this arm exists for. A fixture
    // that creates the directory first makes the phase's own
    // `create_dir_all` unreachable and the test passes over the production
    // failure (myne-md/myne#883).
    #[test]
    fn absent_entry_adopts_verified_remote() {
        let dir = scratch("absent-entry");
        assert!(
            !dir.join("memories").exists(),
            "the fixture must start without the directory the phase owes"
        );
        let remote_bytes = seal_entry(&ENTRY, "likes tea");
        let t = FakeTransport::new();
        let rec = serve(&t, &ENTRY, &remote_bytes, 2);
        let mut st = SyncState::default();
        let phase = run_entry_phase(&IO, &t, &dir, &mut st, Some(&rec), true).unwrap();
        assert!(phase.push_bytes.is_none());
        assert!(phase.remote.is_some());
        assert_eq!(
            std::fs::read(dir.join("memories").join(hex(&ENTRY))).unwrap(),
            remote_bytes,
            "adoption is byte-verbatim"
        );
        std::fs::remove_dir_all(&dir).ok();
    }

    // Locally dirty entry, no remote change: the local bytes push.
    #[test]
    fn dirty_entry_without_remote_change_pushes() {
        let dir = scratch("dirty-entry");
        let local_bytes = seal_entry(&ENTRY, "local text");
        std::fs::create_dir_all(dir.join("memories")).unwrap();
        std::fs::write(dir.join("memories").join(hex(&ENTRY)), &local_bytes).unwrap();
        let mut st = SyncState::default();
        seed_baseline(&mut st, &hex(&ENTRY), hex(&[0x00; 24]));
        let t = FakeTransport::new();
        let phase = run_entry_phase(&IO, &t, &dir, &mut st, None, false).unwrap();
        assert_eq!(phase.push_bytes.unwrap(), local_bytes);
        assert!(phase.remote.is_none());
        std::fs::remove_dir_all(&dir).ok();
    }

    // Both sides changed: the catalog winner decides. Remote winner →
    // adopt; local winner → push ours.
    #[test]
    fn both_changed_entry_defers_to_the_catalog_winner() {
        for (remote_wins, tag) in [(true, "remote"), (false, "local")] {
            let dir = scratch(&format!("both-changed-{tag}"));
            let local_bytes = seal_entry(&ENTRY, "local text");
            std::fs::create_dir_all(dir.join("memories")).unwrap();
            std::fs::write(dir.join("memories").join(hex(&ENTRY)), &local_bytes).unwrap();
            let remote_bytes = seal_entry(&ENTRY, "remote text");
            let t = FakeTransport::new();
            let rec = serve(&t, &ENTRY, &remote_bytes, 4);
            let mut st = SyncState::default();
            seed_baseline(&mut st, &hex(&ENTRY), hex(&[0x00; 24]));
            let phase = run_entry_phase(&IO, &t, &dir, &mut st, Some(&rec), remote_wins).unwrap();
            if remote_wins {
                assert!(phase.push_bytes.is_none());
                assert_eq!(
                    std::fs::read(dir.join("memories").join(hex(&ENTRY))).unwrap(),
                    remote_bytes,
                    "the catalog winner's file is adopted"
                );
            } else {
                assert_eq!(
                    phase.push_bytes.unwrap(),
                    local_bytes,
                    "the local winner's file pushes"
                );
            }
            std::fs::remove_dir_all(&dir).ok();
        }
    }

    // Personality: remote-only adopts (applied, nothing to push);
    // local-only pushes; both-changed resolves to the remote write.
    #[test]
    fn personality_singleton_reconciles_whole_value() {
        let pid = agent_personality_sync_id(&ROOT);
        // Remote-only.
        let dir = scratch("pers-remote");
        let remote_bytes = seal_personality("be terse");
        let t = FakeTransport::new();
        let rec = serve(&t, &pid, &remote_bytes, 2);
        let mut st = SyncState::default();
        let phase = run_personality_phase(&IO, &t, &dir, &mut st, Some(&rec)).unwrap();
        assert!(!phase.skipped);
        assert!(phase.applied_remote);
        assert!(!phase.dirty);
        assert_eq!(
            std::fs::read(dir.join("vault.personality")).unwrap(),
            remote_bytes
        );
        std::fs::remove_dir_all(&dir).ok();
        // Local-only.
        let dir = scratch("pers-local");
        let local_bytes = seal_personality("be warm");
        std::fs::write(dir.join("vault.personality"), &local_bytes).unwrap();
        let mut st = SyncState::default();
        let t = FakeTransport::new();
        let phase = run_personality_phase(&IO, &t, &dir, &mut st, None).unwrap();
        assert!(phase.dirty);
        assert_eq!(phase.push_bytes.unwrap(), local_bytes);
        std::fs::remove_dir_all(&dir).ok();
        // Both changed: the remote write wins.
        let dir = scratch("pers-both");
        let local_bytes = seal_personality("be warm");
        std::fs::write(dir.join("vault.personality"), &local_bytes).unwrap();
        let remote_bytes = seal_personality("be terse");
        let t = FakeTransport::new();
        let rec = serve(&t, &pid, &remote_bytes, 3);
        let mut st = SyncState::default();
        seed_baseline(&mut st, &hex(&pid), hex(&[0x00; 24]));
        let phase = run_personality_phase(&IO, &t, &dir, &mut st, Some(&rec)).unwrap();
        assert!(!phase.dirty, "whole-value LWW resolves to one side");
        assert!(phase.applied_remote);
        assert_eq!(
            std::fs::read(dir.join("vault.personality")).unwrap(),
            remote_bytes,
            "the remote write wins a concurrent edit"
        );
        std::fs::remove_dir_all(&dir).ok();
        // Both changed, local fresher: the greater updated_at wins (§10.2.7).
        let dir = scratch("pers-fresh-local");
        let local_bytes = seal_personality_at("be warm", 3_000);
        std::fs::write(dir.join("vault.personality"), &local_bytes).unwrap();
        let remote_bytes = seal_personality_at("be terse", 2_000);
        let t = FakeTransport::new();
        let rec = serve(&t, &pid, &remote_bytes, 3);
        let mut st = SyncState::default();
        seed_baseline(&mut st, &hex(&pid), hex(&[0x00; 24]));
        let phase = run_personality_phase(&IO, &t, &dir, &mut st, Some(&rec)).unwrap();
        assert!(phase.dirty, "the fresher local write must push");
        assert!(!phase.applied_remote);
        assert_eq!(
            std::fs::read(dir.join("vault.personality")).unwrap(),
            local_bytes,
            "the fresher side wins a concurrent edit"
        );
        std::fs::remove_dir_all(&dir).ok();
    }
}

// ---- MYND-486: vault.themes phase (sync_themes_phase) --------------------

mod themes_phase {
    // The parent module's seam shims (task 86).
    use super::{blocking, IO};

    use super::super::*;
    use crate::plugins::sync::state::SyncState;
    use crate::plugins::sync::transport::FakeTransport;
    use crate::plugins::themes::commands::{
        encode_themes_map, ThemeEntry, ThemePalette, ThemesMap,
    };
    use base64::engine::general_purpose::STANDARD as B64;
    use base64::Engine as _;

    const ROOT: [u8; 32] = [0x42; 32];
    const HASH: [u8; 16] = [0x33; 16];
    const T0: u64 = 1_700_000_000;

    fn scratch(tag: &str) -> std::path::PathBuf {
        let d = std::env::temp_dir().join(format!(
            "myne-themesphase-{tag}-{}-{:p}",
            std::process::id(),
            &tag
        ));
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    fn themes_key() -> zeroize::Zeroizing<[u8; 32]> {
        derive_subkey(&ROOT, SubkeyRole::CustomThemesKey)
    }

    fn theme(name: &str, accent: &str, now: u64) -> (String, ThemeEntry) {
        (
            name.to_string(),
            ThemeEntry::live(
                ThemePalette::from([("--accent".into(), accent.into())]),
                now,
            ),
        )
    }

    fn write_local(dir: &Path, map: &ThemesMap) {
        let bytes = encode_themes_map(MetaVersion::V0_1, &themes_key(), &HASH, map).unwrap();
        std::fs::write(dir.join("vault.themes"), &bytes).unwrap();
    }

    fn read_local(dir: &Path) -> ThemesMap {
        let bytes = std::fs::read(dir.join("vault.themes")).unwrap();
        crate::plugins::themes::commands::decode_themes_map_or_empty(
            &themes_key(),
            &HASH,
            Some(&bytes),
        )
    }

    /// Encode a remote store and register its blob under `/sync/blob?id=…`.
    fn serve_remote(t: &FakeTransport, tid: &[u8; 16], map: &ThemesMap) -> ChangedBlob {
        let bytes = encode_themes_map(MetaVersion::V0_1, &themes_key(), &HASH, map).unwrap();
        let nonce = read_themes_nonce(&bytes).unwrap();
        let body = serde_json::json!({ "ciphertext_b64": B64.encode(&bytes) });
        t.on(
            HttpMethod::Get,
            &format!("/sync/blob?id={}", hex(tid)),
            200,
            serde_json::to_vec(&body).unwrap(),
        );
        ChangedBlob {
            id: *tid,
            content_nonce: nonce,
            version: 7,
            size: bytes.len(),
            attachment_id: None,
        }
    }

    // The themes sync-id is the reserved DeriveSubkey(root, "themes-sync-id")
    // [0..16] — deterministic across the fleet and distinct from the sibling
    // singletons' ids (a collision would merge two blob families).
    #[test]
    fn themes_sync_id_is_deterministic_and_distinct() {
        assert_eq!(themes_sync_id(&ROOT), themes_sync_id(&ROOT));
        assert_ne!(themes_sync_id(&ROOT), prefs_sync_id(&ROOT));
        assert_ne!(themes_sync_id(&ROOT), catalog_sync_id(&ROOT));
        assert_ne!(themes_sync_id(&ROOT), themes_sync_id(&[0x11; 32]));
    }

    // The addressing switch that lets a member sync shared singletons: an
    // owner/pre-B2B session keeps the historical root-derived id, an `NTV6`
    // session derives it from the group key (`GroupRole`), so an owner and a
    // member holding the same epoch compute the SAME id while a member can
    // never reproduce the root-derived one.
    #[test]
    fn shared_sync_ids_are_group_derived_for_ntv6_and_root_derived_for_ntv5() {
        let root = [0x33u8; 32];
        let group = zeroize::Zeroizing::new([0x77u8; 32]);
        let owner = SharedSingletonKey::OwnerRoot(zeroize::Zeroizing::new(root));
        let member = SharedSingletonKey::Group(group.clone());
        for (role, group_role) in [
            (
                SubkeyRole::CatalogSyncId,
                protocol::GroupRole::CatalogSyncId,
            ),
            (SubkeyRole::PrefsSyncId, protocol::GroupRole::PrefsSyncId),
            (SubkeyRole::ThemesSyncId, protocol::GroupRole::ThemesSyncId),
            (
                SubkeyRole::PersonalDictSyncId,
                protocol::GroupRole::PersonalDictSyncId,
            ),
        ] {
            // The owner id is unchanged by this switch.
            assert_eq!(shared_sync_id(&owner, role), sync_id_for(&root, role));
            // The NTV6 id is the group derivation's first 16 bytes.
            let derived =
                protocol::derive_group_subkey_v0_2(&protocol::GroupKey::new(*group), group_role);
            let mut expected = [0u8; 16];
            expected.copy_from_slice(&derived[..16]);
            assert_eq!(shared_sync_id(&member, role), expected);
            // A member could never have produced the root-derived id.
            assert_ne!(shared_sync_id(&member, role), shared_sync_id(&owner, role));
        }
        // Distinct per family, so two blob families never collide.
        assert_ne!(
            shared_sync_id(&member, SubkeyRole::PrefsSyncId),
            shared_sync_id(&member, SubkeyRole::ThemesSyncId)
        );
    }

    // The chats / agent-memory / agent-personality catalogs are ROOT-derived
    // even on an `NTV6` session, because they are person-private and have no
    // `GroupRole` (decisions/protocol/0609, 0608). Routing them through
    // `shared_sync_id` on a group session hit the `expect` and panicked the
    // whole cycle (myne-md/myne#791). This pins both halves: their id helper
    // is the root derivation, and it must not be reachable through the group
    // tier at all.
    #[test]
    fn private_catalogs_stay_root_derived_and_have_no_group_role() {
        let root = [0x33u8; 32];
        for (role, id) in [
            (SubkeyRole::ChatsCatalogSyncId, chats_catalog_sync_id(&root)),
            (
                SubkeyRole::AgentMemoryCatalogSyncId,
                agent_memory_catalog_sync_id(&root),
            ),
            (
                SubkeyRole::AgentPersonalitySyncId,
                agent_personality_sync_id(&root),
            ),
        ] {
            assert_eq!(id, sync_id_for(&root, role));
            assert!(
                role.shared_group_role().is_none(),
                "{role:?} must have no GroupRole: it is person-private, not shared"
            );
        }
    }

    // A theme-less vault stays themes-silent: no local blob, no server
    // record ⇒ nothing to push (no §10.2.1-style initial publish here —
    // vault.themes carries no vault identity a joiner needs).
    #[test]
    fn virgin_store_is_not_pushed() {
        let dir = scratch("virgin");
        let mut st = SyncState::default();
        let t = FakeTransport::new();
        let tid = themes_sync_id(&ROOT);

        let phase = blocking(sync_themes_phase(
            &IO,
            &t,
            "tok",
            &SharedSingletonKey::OwnerRoot(zeroize::Zeroizing::new(ROOT)),
            &HASH,
            &dir,
            &mut st,
            &tid,
            None,
            MetaVersion::V0_1,
        ))
        .unwrap();
        assert!(!phase.dirty, "a theme-less vault generates no traffic");
        assert!(!phase.applied_remote);
        std::fs::remove_dir_all(&dir).ok();
    }

    // A local import the server has never seen ⇒ push.
    #[test]
    fn local_only_theme_is_dirty() {
        let dir = scratch("localonly");
        write_local(&dir, &ThemesMap::from([theme("nord", "#88c0d0", T0)]));
        let mut st = SyncState::default();
        let t = FakeTransport::new();
        let tid = themes_sync_id(&ROOT);

        let phase = blocking(sync_themes_phase(
            &IO,
            &t,
            "tok",
            &SharedSingletonKey::OwnerRoot(zeroize::Zeroizing::new(ROOT)),
            &HASH,
            &dir,
            &mut st,
            &tid,
            None,
            MetaVersion::V0_1,
        ))
        .unwrap();
        assert!(phase.dirty, "an unsynced local theme must push");
        // The phase carries the bytes the push will send (myne#436) — the
        // push site derives no key and re-reads nothing.
        assert_eq!(
            phase.push_bytes.as_deref().map(|b| &b[0..4]),
            Some(protocol::THEMES_BLOB_MAGIC.as_slice()),
            "a dirty phase must hand the push its verified bytes"
        );
        std::fs::remove_dir_all(&dir).ok();
    }

    /// A MIGRATED vault's dirty theme store must still produce pushable
    /// bytes — sealed `MYT5` under the v0.2 KEK (myne-md/myne#436).
    ///
    /// The failure this pins is silent by construction, which is why it
    /// survived a release. `read_verified_themes_bytes` is a strict verifier:
    /// handed a KEK that does not open the blob it answers `None`, not an
    /// error. So a generation-blind derivation does not fail the cycle, log
    /// anything, or surface a toast — the themes push is simply skipped, and
    /// every other device stops receiving the user's theme edits forever
    /// while sync reports success.
    ///
    /// Asserting `dirty` alone would NOT catch it (the flag is computed from
    /// the outer nonce, which needs no key), and asserting "no error" catches
    /// nothing at all. The load-bearing assertion is that bytes come out AND
    /// that they are the v0.2 family.
    #[test]
    fn a_migrated_vault_still_pushes_its_myt5_theme_store() {
        let dir = scratch("migrated-push");
        let v0_2_key = protocol::derive_subkey_versioned(
            MetaVersion::V0_2,
            &ROOT,
            SubkeyRole::CustomThemesKey,
        );
        let map = ThemesMap::from([theme("nord", "#88c0d0", T0)]);
        let bytes = encode_themes_map(MetaVersion::V0_2, &v0_2_key, &HASH, &map).unwrap();
        assert_eq!(
            &bytes[0..4],
            protocol::THEMES_BLOB_V0_2_MAGIC.as_slice(),
            "fixture must be a v0.2 store or the test proves nothing"
        );
        std::fs::write(dir.join("vault.themes"), &bytes).unwrap();

        let mut st = SyncState::default();
        let t = FakeTransport::new();
        let tid = themes_sync_id(&ROOT);
        let phase = blocking(sync_themes_phase(
            &IO,
            &t,
            "tok",
            &SharedSingletonKey::OwnerRoot(zeroize::Zeroizing::new(ROOT)),
            &HASH,
            &dir,
            &mut st,
            &tid,
            None,
            MetaVersion::V0_2,
        ))
        .unwrap();

        assert!(phase.dirty, "an unsynced migrated theme store must push");
        let pushed = phase
            .push_bytes
            .expect("a migrated vault's dirty store must reach the push");
        assert_eq!(
            &pushed[0..4],
            protocol::THEMES_BLOB_V0_2_MAGIC.as_slice(),
            "the push must carry the v0.2 store, not a v0.1 re-seal"
        );
        // And it is the user's store, not an empty one read through the
        // §9.21.4 fallback.
        assert_eq!(
            crate::plugins::themes::commands::decode_themes_map_or_empty(
                &v0_2_key,
                &HASH,
                Some(&pushed)
            ),
            map,
            "the pushed store must be the themes the user actually has"
        );
        std::fs::remove_dir_all(&dir).ok();
    }

    // The push gate: a local blob whose nonce still equals the synced
    // baseline's is provably untouched since the last sync ⇒ no push.
    #[test]
    fn unchanged_local_blob_generates_no_push() {
        let dir = scratch("clean");
        let map = ThemesMap::from([theme("nord", "#88c0d0", T0)]);
        write_local(&dir, &map);
        let nonce = read_themes_nonce(&std::fs::read(dir.join("vault.themes")).unwrap())
            .expect("MYT1 nonce");
        let mut st = SyncState::default();
        let tid = themes_sync_id(&ROOT);
        st.blobs.insert(
            hex(&tid),
            BlobSyncState {
                version: 3,
                content_nonce_hex: hex(&nonce),
                doc_heads_hex: Vec::new(),
            },
        );
        let t = FakeTransport::new();

        let phase = blocking(sync_themes_phase(
            &IO,
            &t,
            "tok",
            &SharedSingletonKey::OwnerRoot(zeroize::Zeroizing::new(ROOT)),
            &HASH,
            &dir,
            &mut st,
            &tid,
            None,
            MetaVersion::V0_1,
        ))
        .unwrap();
        assert!(!phase.dirty, "byte-untouched blob must not push");
        std::fs::remove_dir_all(&dir).ok();
    }

    // A concurrent add on each side: the merge keeps BOTH themes, beats the
    // server's store ⇒ written fresh + pushed this cycle, with the server's
    // version recorded as the CAS base.
    #[test]
    fn concurrent_adds_merge_and_push() {
        let dir = scratch("merge");
        write_local(&dir, &ThemesMap::from([theme("nord", "#88c0d0", T0)]));
        let mut st = SyncState::default();
        let t = FakeTransport::new();
        let tid = themes_sync_id(&ROOT);
        let remote = ThemesMap::from([theme("solarized", "#268bd2", T0 + 1)]);
        let rec = serve_remote(&t, &tid, &remote);

        let phase = blocking(sync_themes_phase(
            &IO,
            &t,
            "tok",
            &SharedSingletonKey::OwnerRoot(zeroize::Zeroizing::new(ROOT)),
            &HASH,
            &dir,
            &mut st,
            &tid,
            Some(&rec),
            MetaVersion::V0_1,
        ))
        .unwrap();
        assert!(phase.dirty, "merge beat the server ⇒ push");
        assert!(phase.applied_remote, "the peer's theme landed locally");
        let on_disk = read_local(&dir);
        assert_eq!(on_disk.len(), 2, "both themes survive");
        assert!(on_disk.contains_key("nord"));
        assert!(on_disk.contains_key("solarized"));
        // The server's revision is the CAS base for this cycle's push.
        assert_eq!(st.blobs[&hex(&tid)].version, 7);
        std::fs::remove_dir_all(&dir).ok();
    }

    // The merge equals the remote (a virgin device pulling a peer's store):
    // adopt the server bytes VERBATIM — re-encrypting would nonce-churn an
    // endless push loop.
    #[test]
    fn merge_equal_to_remote_adopts_server_bytes_verbatim() {
        let dir = scratch("adopt");
        let mut st = SyncState::default();
        let t = FakeTransport::new();
        let tid = themes_sync_id(&ROOT);
        let remote = ThemesMap::from([theme("nord", "#88c0d0", T0)]);
        let rec = serve_remote(&t, &tid, &remote);

        let phase = blocking(sync_themes_phase(
            &IO,
            &t,
            "tok",
            &SharedSingletonKey::OwnerRoot(zeroize::Zeroizing::new(ROOT)),
            &HASH,
            &dir,
            &mut st,
            &tid,
            Some(&rec),
            MetaVersion::V0_1,
        ))
        .unwrap();
        assert!(!phase.dirty, "adopting the server's bytes pushes nothing");
        assert!(phase.applied_remote);
        assert_eq!(read_local(&dir), remote);
        // Baseline == the server's exact revision (version + nonce), so the
        // next cycle sees the blob as clean.
        let on_disk_nonce =
            read_themes_nonce(&std::fs::read(dir.join("vault.themes")).unwrap()).unwrap();
        assert_eq!(st.blobs[&hex(&tid)].content_nonce_hex, hex(&on_disk_nonce));
        assert_eq!(st.blobs[&hex(&tid)].version, 7);
        std::fs::remove_dir_all(&dir).ok();
    }

    // A remote delete vs a stale local live copy: the tombstone wins the
    // merge (no resurrection) and the theme leaves the local list.
    #[test]
    fn remote_tombstone_applies_locally_without_resurrection() {
        let dir = scratch("tomb");
        write_local(&dir, &ThemesMap::from([theme("nord", "#88c0d0", T0)]));
        let mut st = SyncState::default();
        let t = FakeTransport::new();
        let tid = themes_sync_id(&ROOT);
        let (name, entry) = theme("nord", "#88c0d0", T0);
        let remote = ThemesMap::from([(name, entry.into_tombstone(T0 + 10))]);
        let rec = serve_remote(&t, &tid, &remote);

        let phase = blocking(sync_themes_phase(
            &IO,
            &t,
            "tok",
            &SharedSingletonKey::OwnerRoot(zeroize::Zeroizing::new(ROOT)),
            &HASH,
            &dir,
            &mut st,
            &tid,
            Some(&rec),
            MetaVersion::V0_1,
        ))
        .unwrap();
        assert!(phase.applied_remote, "the peer's delete landed");
        let on_disk = read_local(&dir);
        assert!(
            on_disk["nord"].is_tombstone(),
            "the local live copy did NOT resurrect the theme"
        );
        assert!(
            // The themes list moved onto the IO seam (phase3-web-client
            // task 45), so this sync-side assertion drives it through the
            // native arm rather than through `std::fs` directly.
            crate::test_support::block_on(crate::plugins::themes::commands::themes_list_in_dir(
                &crate::vault_io::StdVaultIo,
                &dir,
                &themes_key(),
                &HASH,
            ))
            .expect("the store is readable here")
            .is_empty(),
            "a tombstoned theme is gone from the user's list"
        );
        std::fs::remove_dir_all(&dir).ok();
    }

    // A hostile/corrupt remote store collapses to empty (§9.21.4):
    // merge(local, empty) == local, so nothing is lost and the local store
    // re-pushes over it.
    #[test]
    fn corrupt_remote_store_loses_nothing() {
        let dir = scratch("hostile");
        let local = ThemesMap::from([theme("nord", "#88c0d0", T0)]);
        write_local(&dir, &local);
        let mut st = SyncState::default();
        let t = FakeTransport::new();
        let tid = themes_sync_id(&ROOT);
        let body = serde_json::json!({ "ciphertext_b64": B64.encode(b"not a MYT1 blob") });
        t.on(
            HttpMethod::Get,
            &format!("/sync/blob?id={}", hex(&tid)),
            200,
            serde_json::to_vec(&body).unwrap(),
        );
        let rec = ChangedBlob {
            id: tid,
            content_nonce: [0x9e; 24],
            version: 7,
            size: 15,
            attachment_id: None,
        };

        let phase = blocking(sync_themes_phase(
            &IO,
            &t,
            "tok",
            &SharedSingletonKey::OwnerRoot(zeroize::Zeroizing::new(ROOT)),
            &HASH,
            &dir,
            &mut st,
            &tid,
            Some(&rec),
            MetaVersion::V0_1,
        ))
        .unwrap();
        assert!(phase.dirty, "the local store re-pushes over the garbage");
        assert_eq!(read_local(&dir), local, "nothing lost");
        // §11.3: the baseline must NOT be adopted either. Before the
        // pre-write gate landed, this silently became `[0x9e; 24]` — a
        // baseline for a revision the client does not hold — and the test
        // did not look.
        assert!(
            !st.blobs.contains_key(&hex(&tid)),
            "a record whose bytes failed verification must leave no baseline"
        );
        std::fs::remove_dir_all(&dir).ok();
    }

    /// The case the old code actually destroyed data in, and the reason the
    /// check has to run BEFORE the write rather than being inferred from
    /// the merge outcome.
    ///
    /// With no local store, `decode_themes_map_or_empty` yields empty for
    /// the junk too, so `merged == remote_map` holds and the adopt arm
    /// writes the junk to `vault.themes` verbatim. Worse, the junk carries
    /// no `MYT1` magic, so on the next cycle `read_themes_nonce` of the
    /// on-disk file is `None`: the push-side `if let Some(nonce)` guard
    /// adds nothing to `to_push`, `dirty` stays true forever, and the blob
    /// can never heal.
    #[test]
    fn junk_never_reaches_disk_when_there_is_no_local_store() {
        let dir = scratch("hostile-virgin");
        let mut st = SyncState::default();
        let t = FakeTransport::new();
        let tid = themes_sync_id(&ROOT);
        let body = serde_json::json!({ "ciphertext_b64": B64.encode(b"not a MYT1 blob") });
        t.on(
            HttpMethod::Get,
            &format!("/sync/blob?id={}", hex(&tid)),
            200,
            serde_json::to_vec(&body).unwrap(),
        );
        let rec = ChangedBlob {
            id: tid,
            content_nonce: [0x9e; 24],
            version: 7,
            size: 15,
            attachment_id: None,
        };

        let phase = blocking(sync_themes_phase(
            &IO,
            &t,
            "tok",
            &SharedSingletonKey::OwnerRoot(zeroize::Zeroizing::new(ROOT)),
            &HASH,
            &dir,
            &mut st,
            &tid,
            Some(&rec),
            MetaVersion::V0_1,
        ))
        .unwrap();

        assert!(
            !dir.join("vault.themes").exists(),
            "unverified bytes must never be written; a virgin store stays virgin"
        );
        assert!(
            !st.blobs.contains_key(&hex(&tid)),
            "no baseline may be adopted for bytes that were never verified"
        );
        assert!(!phase.applied_remote, "nothing was applied");
        std::fs::remove_dir_all(&dir).ok();
    }

    /// myne#386 end-to-end: a palette carrying an off-grammar value
    /// arrives through the merge, is stored verbatim — and does not reach a
    /// reader.
    ///
    /// The attacker is anything holding `root_key` that writes
    /// `vault.themes` without running the validator: a second enrolled
    /// device on a modified or older build, a hand-crafted `MYT1`, or a
    /// restored backup. **Not** a hostile server — the blob is AEAD-sealed
    /// under `DeriveSubkey(root_key, "custom-themes-key")`, so TB5 can only
    /// withhold or replay, which is what the neighbouring tests cover.
    ///
    /// The merge deliberately keeps the bytes: `merge_custom_themes` clones
    /// a name only the peer has, and the agreeing-store arm adopts the
    /// server's bytes verbatim. Filtering there would fight the CRDT and
    /// churn the nonce. The read is the right chokepoint, and this asserts
    /// the two halves together — the store keeps what the peer sent, the
    /// reader does not see it.
    #[test]
    fn an_off_grammar_palette_from_a_peer_never_reaches_a_reader() {
        let dir = scratch("hostile-palette");
        let mut st = SyncState::default();
        let t = FakeTransport::new();
        let tid = themes_sync_id(&ROOT);

        // A peer's theme whose accent is the CSS escape hatch the
        // allowlist exists to close, alongside one well-formed token.
        let mut palette = ThemePalette::from([(
            "--accent".to_string(),
            "url(https://evil.example/x)".to_string(),
        )]);
        palette.insert("--ink-1".into(), "#123456".into());
        let remote = ThemesMap::from([("peer".to_string(), ThemeEntry::live(palette, T0))]);
        let rec = serve_remote(&t, &tid, &remote);

        let phase = blocking(sync_themes_phase(
            &IO,
            &t,
            "tok",
            &SharedSingletonKey::OwnerRoot(zeroize::Zeroizing::new(ROOT)),
            &HASH,
            &dir,
            &mut st,
            &tid,
            Some(&rec),
            MetaVersion::V0_1,
        ))
        .unwrap();
        assert!(phase.applied_remote, "the peer's theme was adopted");

        // The store holds what the peer sent — the merge is not the place
        // this gets fixed, and pretending otherwise would hide the point.
        let stored = read_local(&dir);
        assert_eq!(
            stored["peer"].palette.get("--accent").map(String::as_str),
            Some("url(https://evil.example/x)"),
            "the merge stores the peer's bytes verbatim, by design"
        );

        // The reader — the only path to `applyCustomTheme` and the CSSOM —
        // does not.
        let read = blocking(crate::plugins::themes::commands::themes_read_in_dir(
            &IO,
            &dir,
            &themes_key(),
            &HASH,
            "peer",
        ))
        .expect("read");
        assert!(
            !read.contains_key("--accent"),
            "an off-grammar value must not survive the read that feeds the DOM"
        );
        assert_eq!(
            read.get("--ink-1").map(String::as_str),
            Some("#123456"),
            "the rest of the palette is kept — this filters, it does not reject"
        );

        std::fs::remove_dir_all(&dir).ok();
    }

    /// A well-formed `MYT1` blob for this vault, served under a record that
    /// advertises a DIFFERENT nonce. Everything decrypts; only the identity
    /// of the revision is wrong. This is the case `decode_*` cannot catch
    /// and the one a malicious server actually has cheap access to — it
    /// replays a genuine older revision under a newer record.
    #[test]
    fn a_genuine_blob_under_a_lying_record_is_skipped() {
        let dir = scratch("lying-record");
        let local = ThemesMap::from([theme("nord", "#88c0d0", T0)]);
        write_local(&dir, &local);
        let before = std::fs::read(dir.join("vault.themes")).unwrap();

        let remote = ThemesMap::from([theme("gruvbox", "#282828", T0 + 1)]);
        let remote_bytes =
            encode_themes_map(MetaVersion::V0_1, &themes_key(), &HASH, &remote).unwrap();

        let mut st = SyncState::default();
        let t = FakeTransport::new();
        let tid = themes_sync_id(&ROOT);
        let body = serde_json::json!({ "ciphertext_b64": B64.encode(&remote_bytes) });
        t.on(
            HttpMethod::Get,
            &format!("/sync/blob?id={}", hex(&tid)),
            200,
            serde_json::to_vec(&body).unwrap(),
        );
        // The record advertises a nonce these bytes do not carry.
        let rec = ChangedBlob {
            id: tid,
            content_nonce: [0x11; 24],
            version: 9,
            size: remote_bytes.len(),
            attachment_id: None,
        };

        let phase = blocking(sync_themes_phase(
            &IO,
            &t,
            "tok",
            &SharedSingletonKey::OwnerRoot(zeroize::Zeroizing::new(ROOT)),
            &HASH,
            &dir,
            &mut st,
            &tid,
            Some(&rec),
            MetaVersion::V0_1,
        ))
        .unwrap();

        assert_eq!(
            std::fs::read(dir.join("vault.themes")).unwrap(),
            before,
            "the live file must be byte-untouched"
        );
        assert_eq!(read_local(&dir), local, "the local store is unchanged");
        assert!(
            !st.blobs.contains_key(&hex(&tid)),
            "the prior baseline stays authoritative"
        );
        assert!(!phase.applied_remote);
        std::fs::remove_dir_all(&dir).ok();
    }
}

mod member_names_phase {
    //! `vault.member-names` (task 3b-ii): the singleton classification and the
    //! pull-merge hook. The family is `NTV6`-only, so every fixture is a group-tier
    //! session over a real `vault.meta`.

    // The parent module's seam shims (task 86).
    use super::{blocking, fresh_vault, meta_json, pull_body, pull_body_with_head, IO};

    use super::super::*;
    use crate::plugins::sync::state::SyncState;
    use crate::plugins::sync::transport::FakeTransport;
    use base64::engine::general_purpose::STANDARD as B64;
    use base64::Engine as _;
    use protocol::person_key::PersonKeyPair;

    // The constants and the NTV6 fixture below are `pub(super)` because the
    // device-bindings phase module beside this one drives the SAME vault shape:
    // one `group_key_epoch`, one account hash, one structural `vault.meta`. A
    // second copy of the seal sequence there would be a second opinion about what
    // the resolver reads, and the two phases have to agree about it or the failure
    // looks like a fixture problem in whichever one was edited last.
    pub(super) const GROUP: [u8; 32] = [0x77; 32];
    pub(super) const HASH: [u8; 16] = [0x5c; 16];
    pub(super) const EPOCH: u64 = 3;

    pub(super) fn scratch(tag: &str) -> std::path::PathBuf {
        let d = std::env::temp_dir().join(format!(
            "myne-namesphase-{tag}-{}-{:p}",
            std::process::id(),
            &tag
        ));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    pub(super) fn group_tier() -> SharedSingletonKey {
        SharedSingletonKey::Group(zeroize::Zeroizing::new(GROUP))
    }

    fn names_key() -> zeroize::Zeroizing<[u8; 32]> {
        protocol::derive_group_subkey_v0_2(
            &protocol::GroupKey::new(GROUP),
            protocol::GroupRole::MemberNamesKey,
        )
    }

    pub(super) fn person(kem: u8, ed: u8, mldsa: u8) -> PersonKeyPair {
        PersonKeyPair::generate_raw(&[kem; 64], &[ed; 32], &[mldsa; 32])
    }

    /// A structurally valid `NTV6` `vault.meta` at `epoch`, built exactly as a
    /// migration/seal does, so `parse_vault_meta_ntv6` accepts it and the family's
    /// resolver reads the epoch its AAD binds.
    pub(super) fn ntv6_meta_bytes(epoch: u64) -> Vec<u8> {
        let root_key = [7u8; 32];
        let items_key = [9u8; 32];
        let items_key_id = [0x07u8; 16];
        let mut base = protocol::parse_vault_meta_v0_2(
            &protocol::encode_vault_meta_v0_2_raw(
                &root_key,
                &items_key,
                &items_key_id,
                "pw",
                "abandon abandon abandon",
                &HASH,
                &protocol::DEFAULT_V0_1_KDF_PARAMS,
                &[2u8; protocol::ARGON2_SALT_LEN],
                &[4u8; protocol::ARGON2_SALT_LEN],
                &[5u8; protocol::AEAD_NONCE_LEN],
                &[6u8; protocol::AEAD_NONCE_LEN],
                &[8u8; protocol::AEAD_NONCE_LEN],
            )
            .expect("encode NTV5 base"),
        )
        .expect("parse NTV5 base");
        let group_key = protocol::GroupKey::new(GROUP);
        let group_nonce = [12u8; protocol::AEAD_NONCE_LEN];
        let items_nonce = [13u8; protocol::AEAD_NONCE_LEN];
        let enc_group = protocol::aead_seal_ctx(
            &protocol::derive_owner_subkey_v0_2(
                &protocol::OwnerKey::new(root_key),
                protocol::OwnerRole::GroupKeyWrap,
            ),
            &group_nonce,
            &GROUP,
            &protocol::aad_vault_group_key_wrap_v0_2(&HASH, epoch),
        )
        .expect("seal group key");
        let enc_items = protocol::aead_seal_ctx(
            &protocol::derive_group_subkey_v0_2(&group_key, protocol::GroupRole::ItemsKeyWrap),
            &items_nonce,
            &items_key,
            &protocol::aad_vault_items_key_wrap_v0_2(&items_key_id),
        )
        .expect("seal items key");
        base.items_key_nonce = items_nonce;
        base.enc_items_key.copy_from_slice(&enc_items);
        let signed_roster_envelope = protocol::person_invite::seal_group_roster(
            &GROUP,
            &HASH,
            epoch,
            &[0xE6; protocol::AEAD_NONCE_LEN],
            &protocol::person_invite::SignedGroupRoster {
                payload: vec![0xC3; 32],
                signature: protocol::person_key::PersonSigned {
                    ed25519_sig: [0xD4; protocol::person_key::PERSON_ED25519_SIG_LEN],
                    mldsa_sig: vec![0xE5; protocol::person_key::PERSON_MLDSA_SIG_LEN],
                },
            },
        )
        .expect("seal roster envelope");
        protocol::serialize_vault_meta_ntv6(&protocol::B2bVaultMeta {
            base,
            group_key_nonce: group_nonce,
            enc_group_key: enc_group.try_into().expect("fixed group-key wrap"),
            group_key_epoch: epoch,
            signed_roster_envelope,
        })
        .expect("serialize NTV6")
    }

    pub(super) fn seed_meta(dir: &Path) {
        std::fs::write(dir.join("vault.meta"), ntv6_meta_bytes(EPOCH)).unwrap();
    }

    /// One row, signed by the person it names (the only shape the codec accepts).
    fn row(
        who: &PersonKeyPair,
        person_id: &[u8; 16],
        version: u64,
        name: &str,
    ) -> protocol::MemberNameEntry {
        let mut rng = rand_core::UnwrapErr(crate::rng::OsRng);
        protocol::sign_member_name(who, person_id, version, false, name, &mut rng).unwrap()
    }

    /// A map holding exactly one row.
    fn one_row(
        who: &PersonKeyPair,
        person_id: &[u8; 16],
        version: u64,
        name: &str,
    ) -> protocol::MemberNamesMap {
        let mut map = protocol::MemberNamesMap::new();
        map.insert(hex(person_id), row(who, person_id, version, name));
        map
    }

    fn write_local(dir: &Path, map: &protocol::MemberNamesMap) -> Vec<u8> {
        let bytes = protocol::encode_member_names_blob(&names_key(), &HASH, EPOCH, map).unwrap();
        std::fs::write(dir.join("vault.member-names"), &bytes).unwrap();
        bytes
    }

    /// Encode a remote store and register its blob under `/sync/blob?id=…`.
    fn serve_remote(t: &FakeTransport, id: &[u8; 16], bytes: &[u8], version: u64) -> ChangedBlob {
        let nonce = read_member_names_nonce(bytes).unwrap();
        let body = serde_json::json!({ "ciphertext_b64": B64.encode(bytes) });
        t.on(
            HttpMethod::Get,
            &format!("/sync/blob?id={}", hex(id)),
            200,
            serde_json::to_vec(&body).unwrap(),
        );
        ChangedBlob {
            id: *id,
            content_nonce: nonce,
            version,
            size: bytes.len(),
            attachment_id: None,
        }
    }

    // The family is addressed through the GROUP tier only: a pre-B2B `OwnerRoot`
    // session has no group key, and this family has no `SubkeyRole` counterpart to
    // derive a root-tier id from. So the id helper answers `None`, and the phase
    // generates no traffic at all rather than deriving a key no member could read.
    #[test]
    fn a_pre_b2b_session_has_no_member_names_phase() {
        let dir = scratch("pre-b2b");
        let mut st = SyncState::default();
        let t = FakeTransport::new();
        let id = [0x0a; 16];
        let owner = SharedSingletonKey::OwnerRoot(zeroize::Zeroizing::new([0x33; 32]));
        assert!(
            member_names_sync_id(&owner).is_none(),
            "a group-derived id must not be expressible on the root tier"
        );
        let phase = blocking(sync_member_names_phase(
            &IO, &t, "tok", &owner, &dir, &mut st, &id, None,
        ))
        .unwrap();
        assert!(!phase.dirty, "a pre-B2B vault has no name store to push");
        assert!(!phase.applied_remote);
        assert!(phase.push_bytes.is_none());
        assert!(
            t.requests().is_empty(),
            "a pre-B2B vault generates no member-names traffic"
        );
        std::fs::remove_dir_all(&dir).ok();
    }

    // The id is group-derived and per-family, so an owner and a member of one epoch
    // compute the SAME id and two families never collide on one.
    #[test]
    fn the_member_names_id_agrees_with_the_group_derivation_and_no_sibling() {
        let member = group_tier();
        let id = member_names_sync_id(&member).expect("group tier");
        assert_eq!(id, crate::plugins::member_names::names_sync_id(&GROUP));
        assert_ne!(id, shared_sync_id(&member, SubkeyRole::ThemesSyncId));
        assert_ne!(id, shared_sync_id(&member, SubkeyRole::PrefsSyncId));
        assert_ne!(id, shared_sync_id(&member, SubkeyRole::CatalogSyncId));
    }

    // A name the server has never seen ⇒ the phase reports dirty AND carries the
    // exact bytes the push must send (the myne#436 single-derivation discipline: the
    // push site re-reads nothing).
    #[test]
    fn a_local_only_name_is_dirty_and_the_phase_carries_its_bytes() {
        let dir = scratch("local-only");
        seed_meta(&dir);
        let ann = person(0x11, 0x12, 0x13);
        let ann_id = [0x21; 16];
        write_local(&dir, &one_row(&ann, &ann_id, 1, "Ada"));

        let mut st = SyncState::default();
        let t = FakeTransport::new();
        let id = member_names_sync_id(&group_tier()).unwrap();
        let phase = blocking(sync_member_names_phase(
            &IO,
            &t,
            "tok",
            &group_tier(),
            &dir,
            &mut st,
            &id,
            None,
        ))
        .unwrap();
        assert!(phase.dirty, "an unsynced local name must push");
        assert!(!phase.applied_remote);
        assert_eq!(
            phase.push_bytes.as_deref().map(|b| &b[0..4]),
            Some(protocol::MEMBER_NAMES_BLOB_MAGIC.as_slice()),
            "a dirty phase must hand the push its verified bytes"
        );
        std::fs::remove_dir_all(&dir).ok();
    }

    // `merge(local, empty) == local`, so a pulled copy that fails the AEAD must be
    // REFUSED with no local mutation: merging it as empty would discard a peer's
    // rename and then write that emptiness back over it. The served bytes carry our
    // magic and an advertised nonce, so they pass the §11.3 header check and fail
    // only the decrypt: exactly the copy this arm exists for.
    #[test]
    fn a_pulled_copy_that_does_not_decode_is_refused() {
        let dir = scratch("refuse");
        seed_meta(&dir);
        let ann = person(0x11, 0x12, 0x13);
        let ann_id = [0x21; 16];
        let before = write_local(&dir, &one_row(&ann, &ann_id, 1, "Ada"));

        let mut st = SyncState::default();
        let t = FakeTransport::new();
        let id = member_names_sync_id(&group_tier()).unwrap();

        let mut junk = Vec::from(protocol::MEMBER_NAMES_BLOB_MAGIC);
        junk.extend_from_slice(&[0x01, 0x01]);
        junk.extend_from_slice(&[0xAB; 24]);
        junk.extend_from_slice(&8u32.to_be_bytes());
        junk.extend_from_slice(&[0x00; 8]);
        t.on(
            HttpMethod::Get,
            &format!("/sync/blob?id={}", hex(&id)),
            200,
            serde_json::to_vec(&serde_json::json!({ "ciphertext_b64": B64.encode(&junk) }))
                .unwrap(),
        );
        let rec = ChangedBlob {
            id,
            content_nonce: [0xAB; 24],
            version: 9,
            size: junk.len(),
            attachment_id: None,
        };

        let phase = blocking(sync_member_names_phase(
            &IO,
            &t,
            "tok",
            &group_tier(),
            &dir,
            &mut st,
            &id,
            Some(&rec),
        ))
        .unwrap();
        assert!(!phase.dirty, "a refused copy must not dirty the store");
        assert!(!phase.applied_remote);
        assert_eq!(
            std::fs::read(dir.join("vault.member-names")).unwrap(),
            before,
            "the live file must be byte-untouched"
        );
        assert!(
            !st.blobs.contains_key(&hex(&id)),
            "no baseline may be adopted for a refused copy"
        );
        std::fs::remove_dir_all(&dir).ok();
    }

    // A remote copy is pulled and MERGED entry by entry, and the merge is reported
    // where the WebView can see it: on the cycle summary. The remote row (Bob) and
    // the local row (Ann) are a concurrent rename of DIFFERENT rows, so both must
    // survive, and with the flag false the roster would keep drawing the stale name
    // until something else happened to re-read it.
    #[test]
    fn a_pulled_member_name_is_merged_and_reported_at_the_cycle_boundary() {
        use protocol::vault_head::VAULT_HEAD_FORMAT_V2;

        let (dir, notes) = fresh_vault("member-names-cycle");
        seed_meta(&dir);

        let ann = person(0x11, 0x12, 0x13);
        let ann_id = [0x21; 16];
        let bob = person(0x31, 0x32, 0x33);
        let bob_id = [0x41; 16];
        write_local(&dir, &one_row(&ann, &ann_id, 1, "Ada"));

        // The server holds only Bob's row, at a version it never shared.
        let remote_bytes = protocol::encode_member_names_blob(
            &names_key(),
            &HASH,
            EPOCH,
            &one_row(&bob, &bob_id, 1, "Grace"),
        )
        .unwrap();
        let names_id = member_names_sync_id(&group_tier()).unwrap();

        // A signed head so the cycle adopts the server's rather than authoring a
        // genesis (a push route this test does not need).
        let person = person(0x51, 0x52, 0x53);
        let person_public = person.public_half();
        let ctx = SignedHeadCtx::new(Some(person), HASH, vec![person_public]);
        let mut rng = rand_core::UnwrapErr(crate::rng::OsRng);
        let head = VaultHead {
            head_format_version: VAULT_HEAD_FORMAT_V2,
            account_number_hash: HASH,
            manifest_hash: [0u8; 32],
            seq: 1,
            prev_head_hash: Vec::new(),
            version_vector: vec![VvEntry {
                device_id: [0x99; 16],
                counter: 1,
            }],
        };
        let sealed = ctx.sign(&head, &mut rng).unwrap();
        let head_frag = (B64.encode(&sealed.record), hex(&sealed.head_id));

        let t = FakeTransport::new();
        let remote_nonce = read_member_names_nonce(&remote_bytes).unwrap();
        t.on(
            HttpMethod::Get,
            "/sync/pull?cursor=0",
            200,
            pull_body_with_head(&meta_json(&names_id, 4, &remote_nonce), 1, &head_frag),
        );
        t.on(
            HttpMethod::Get,
            "/sync/pull?cursor=1",
            200,
            pull_body("", 1),
        );
        t.on(
            HttpMethod::Get,
            &format!("/sync/blob?id={}", hex(&names_id)),
            200,
            serde_json::to_vec(&serde_json::json!({ "ciphertext_b64": B64.encode(&remote_bytes) }))
                .unwrap(),
        );

        let items_key = [0x44u8; 32];
        let items_key_id = [0x55u8; 16];
        let summary = blocking(run_sync_cycle(
            &IO,
            &t,
            None,
            &group_tier(),
            HASH,
            [0x0a; 16],
            "tok",
            &notes,
            &dir,
            PushGate::PollOnly,
            MetaVersion::V0_2,
            Some(AttachmentKeys {
                items_key: &items_key,
                items_key_id: &items_key_id,
            }),
            Some(&ctx),
            &std::collections::HashSet::new(),
        ))
        .expect("cycle runs");

        assert!(
            summary.member_names_applied_remote,
            "a merged remote name must be reported at the cycle boundary"
        );
        let on_disk = std::fs::read(dir.join("vault.member-names")).unwrap();
        let merged =
            protocol::decode_member_names_blob(&names_key(), &HASH, EPOCH, &on_disk).unwrap();
        assert_eq!(merged.len(), 2, "both rows survive the merge");
        assert_eq!(merged.get(&hex(&ann_id)).unwrap().name, "Ada");
        assert_eq!(merged.get(&hex(&bob_id)).unwrap().name, "Grace");
        std::fs::remove_dir_all(&dir).ok();
    }
}

// The device-bindings phase (member-devices task 3), the `member_names_phase`
// module's twin and driven the same way: the phase directly for the arms that need
// no cycle, plus ONE real `run_sync_cycle` for the merge, because the phase's
// invocation is a `match` arm inside the 14 000-line orchestrator and
// `core/src/plugins/sync/mod.rs` carries `#![allow(dead_code)]`, so a phase that
// stopped being called would be silent to clippy, tests and every guard in
// `scripts/`. The cycle-level test is the only thing in the tree that would notice.
mod device_bindings_phase {
    use super::member_names_phase::{group_tier, person, scratch, seed_meta, EPOCH, GROUP, HASH};
    use super::{blocking, fresh_vault, meta_json, pull_body, pull_body_with_head, IO};

    use super::super::*;
    use crate::plugins::sync::state::{BlobSyncState, SyncState};
    use crate::plugins::sync::transport::FakeTransport;
    use base64::engine::general_purpose::STANDARD as B64;
    use base64::Engine as _;
    use protocol::person_key::PersonKeyPair;

    /// The device-binding KEK, derived exactly as the family's own resolver does, so
    /// a fixture sealed here is one the phase can open.
    fn bindings_key() -> zeroize::Zeroizing<[u8; 32]> {
        protocol::derive_group_subkey_v0_2(
            &protocol::GroupKey::new(GROUP),
            protocol::GroupRole::DeviceBindingKey,
        )
    }

    /// One row, signed by the person it NAMES, which is the only shape
    /// `verify_device_binding` accepts: the signer's own fingerprint has to equal
    /// the fingerprint the row claims. The row key is the device, which is what makes
    /// a merge over this map different from the sibling family's.
    fn row(
        who: &PersonKeyPair,
        device_id: &[u8; 16],
        version: u64,
    ) -> protocol::DeviceBindingEntry {
        let mut rng = rand_core::UnwrapErr(crate::rng::OsRng);
        protocol::sign_device_binding(who, device_id, who.fingerprint(), version, false, &mut rng)
            .unwrap()
    }

    /// A map holding exactly one live row for `device_id`.
    fn one_row(
        who: &PersonKeyPair,
        device_id: &[u8; 16],
        version: u64,
    ) -> protocol::DeviceBindingsMap {
        let mut map = protocol::DeviceBindingsMap::new();
        map.insert(hex(device_id), row(who, device_id, version));
        map
    }

    fn write_local(dir: &Path, map: &protocol::DeviceBindingsMap) -> Vec<u8> {
        let bytes =
            protocol::encode_device_binding_blob(&bindings_key(), &HASH, EPOCH, map).unwrap();
        std::fs::write(device_bindings_file_path(dir), &bytes).unwrap();
        bytes
    }

    fn decode(bytes: &[u8]) -> protocol::DeviceBindingsMap {
        protocol::decode_device_binding_blob(&bindings_key(), &HASH, EPOCH, bytes).unwrap()
    }

    /// Encode a remote store and register its blob under `/sync/blob?id=…`, with the
    /// `ChangedBlob` the pull page would carry.
    fn serve_remote(t: &FakeTransport, id: &[u8; 16], bytes: &[u8], version: u64) -> ChangedBlob {
        let nonce = read_device_bindings_nonce(bytes).unwrap();
        let body = serde_json::json!({ "ciphertext_b64": B64.encode(bytes) });
        t.on(
            HttpMethod::Get,
            &format!("/sync/blob?id={}", hex(id)),
            200,
            serde_json::to_vec(&body).unwrap(),
        );
        ChangedBlob {
            id: *id,
            content_nonce: nonce,
            version,
            size: bytes.len(),
            attachment_id: None,
        }
    }

    // The family is addressed through the GROUP tier only, exactly as the sibling is:
    // a pre-B2B `OwnerRoot` session holds no group key, so there is no KEK to derive
    // and no epoch to bind into the AAD. The phase must stand down BEFORE it reads
    // anything, which the empty request log is what proves.
    #[test]
    fn a_pre_b2b_session_has_no_device_bindings_phase() {
        let dir = scratch("bindings-pre-b2b");
        let mut st = SyncState::default();
        let t = FakeTransport::new();
        let id = [0x0b; 16];
        let owner = SharedSingletonKey::OwnerRoot(zeroize::Zeroizing::new([0x33; 32]));
        assert!(
            device_bindings_sync_id(&owner).is_none(),
            "a group-derived id must not be expressible on the root tier"
        );
        let phase = blocking(sync_device_bindings_phase(
            &IO, &t, "tok", &owner, &dir, &mut st, &id, None,
        ))
        .unwrap();
        assert!(!phase.dirty);
        assert!(!phase.applied_remote);
        assert!(phase.push_bytes.is_none());
        assert!(
            t.requests().is_empty(),
            "a pre-B2B vault generates no device-binding traffic"
        );
        std::fs::remove_dir_all(&dir).ok();
    }

    // Both ids are a 16-byte group-derived value with no `SubkeyRole` counterpart, so
    // the ONLY thing separating this family's sync id from its four siblings' is the
    // domain string inside the derivation. A collision would make the two phases
    // overwrite each other's blob at the server.
    #[test]
    fn the_device_bindings_id_agrees_with_the_group_derivation_and_no_sibling() {
        let member = group_tier();
        let id = device_bindings_sync_id(&member).expect("group tier");
        assert_eq!(id, crate::plugins::device_binding::bindings_sync_id(&GROUP));
        assert_ne!(
            id,
            member_names_sync_id(&member).expect("group tier"),
            "the two group-tier singletons must never share one sync id"
        );
        assert_ne!(id, shared_sync_id(&member, SubkeyRole::ThemesSyncId));
        assert_ne!(id, shared_sync_id(&member, SubkeyRole::PrefsSyncId));
        assert_ne!(id, shared_sync_id(&member, SubkeyRole::CatalogSyncId));
    }

    // Criterion 1 and 3 at the phase layer. A claim written while offline is a local
    // file the server has never seen: the phase reports it dirty AND carries the
    // exact bytes the push must send (the myne#436 single-derivation discipline: the
    // push site re-reads nothing), and those bytes are the row the user's device
    // really wrote rather than a re-derivation of it.
    #[test]
    fn a_local_only_binding_is_dirty_and_the_phase_carries_its_bytes() {
        let dir = scratch("bindings-local-only");
        seed_meta(&dir);
        let me = person(0x11, 0x12, 0x13);
        let mine = [0x21; 16];
        write_local(&dir, &one_row(&me, &mine, 1));

        let mut st = SyncState::default();
        let t = FakeTransport::new();
        let id = device_bindings_sync_id(&group_tier()).unwrap();
        let phase = blocking(sync_device_bindings_phase(
            &IO,
            &t,
            "tok",
            &group_tier(),
            &dir,
            &mut st,
            &id,
            None,
        ))
        .unwrap();
        assert!(
            phase.dirty,
            "a binding claimed while offline must push on the next cycle"
        );
        assert!(!phase.applied_remote);
        let pushed = phase
            .push_bytes
            .as_deref()
            .expect("a dirty phase hands over bytes");
        assert_eq!(
            &pushed[0..4],
            protocol::DEVICE_BINDING_BLOB_MAGIC.as_slice(),
            "a dirty phase must hand the push its verified bytes"
        );
        let map = decode(pushed);
        assert_eq!(map.len(), 1);
        assert!(
            protocol::verify_device_binding(
                &me.public_half(),
                &mine,
                map.get(&hex(&mine)).unwrap()
            ),
            "the bytes pushed are the row this device signed, verified against its own public half"
        );

        // The OTHER half of criterion 1: once the server has that exact nonce
        // recorded as this blob's baseline, the next cycle is not dirty and pushes
        // nothing. Without this the push loop would re-send the same store forever.
        let mut synced = SyncState::default();
        synced.blobs.insert(
            hex(&id),
            BlobSyncState {
                version: 4,
                content_nonce_hex: hex(&read_device_bindings_nonce(pushed).unwrap()),
                doc_heads_hex: Vec::new(),
            },
        );
        let t2 = FakeTransport::new();
        let again = blocking(sync_device_bindings_phase(
            &IO,
            &t2,
            "tok",
            &group_tier(),
            &dir,
            &mut synced,
            &id,
            None,
        ))
        .unwrap();
        assert!(
            !again.dirty && again.push_bytes.is_none(),
            "a store already synced at the server's nonce must push nothing"
        );
        std::fs::remove_dir_all(&dir).ok();
    }

    // `merge(local, empty) == local`, so a pulled copy that fails the AEAD must be
    // REFUSED with no local mutation: merging it as empty would discard a peer's
    // claim and then write that emptiness back over it. The served bytes are sealed
    // under the WRONG key, so they carry our magic and a real header nonce; they
    // pass the §11.3 gate and fail only the decrypt, which is exactly this arm.
    #[test]
    fn a_pulled_copy_that_does_not_decode_is_refused() {
        let dir = scratch("bindings-refuse");
        seed_meta(&dir);
        let me = person(0x11, 0x12, 0x13);
        let mine = [0x21; 16];
        let before = write_local(&dir, &one_row(&me, &mine, 1));

        let peer = person(0x31, 0x32, 0x33);
        let theirs = [0x41; 16];
        let foreign = protocol::encode_device_binding_blob(
            &[0x99u8; 32],
            &HASH,
            EPOCH,
            &one_row(&peer, &theirs, 1),
        )
        .unwrap();

        let mut st = SyncState::default();
        let t = FakeTransport::new();
        let id = device_bindings_sync_id(&group_tier()).unwrap();
        let rec = serve_remote(&t, &id, &foreign, 9);

        let phase = blocking(sync_device_bindings_phase(
            &IO,
            &t,
            "tok",
            &group_tier(),
            &dir,
            &mut st,
            &id,
            Some(&rec),
        ))
        .unwrap();
        assert!(!phase.dirty, "a refused copy must not dirty the store");
        assert!(!phase.applied_remote);
        assert_eq!(
            std::fs::read(device_bindings_file_path(&dir)).unwrap(),
            before,
            "the live file must be byte-untouched"
        );
        assert!(
            !st.blobs.contains_key(&hex(&id)),
            "no baseline may be adopted for a refused copy"
        );
        assert!(
            decode(&std::fs::read(device_bindings_file_path(&dir)).unwrap())
                .contains_key(&hex(&mine)),
            "the local row survives the refusal"
        );
        std::fs::remove_dir_all(&dir).ok();
    }

    // Criterion 2 at the phase layer, and the reason this family has a phase of its
    // own: the key is the DEVICE and the row names the person, so a peer's copy and
    // this device's copy are claims over DISJOINT keys and the merge is a union, not
    // a replace. The merged map is then what the push carries, so the peer's claim is
    // not lost on the way to the server.
    #[test]
    fn a_pulled_binding_is_merged_entry_by_entry_and_the_merge_is_what_gets_pushed() {
        let dir = scratch("bindings-merge");
        seed_meta(&dir);
        let me = person(0x11, 0x12, 0x13);
        let mine = [0x21; 16];
        let peer = person(0x31, 0x32, 0x33);
        let theirs = [0x41; 16];
        write_local(&dir, &one_row(&me, &mine, 1));

        let remote_bytes = protocol::encode_device_binding_blob(
            &bindings_key(),
            &HASH,
            EPOCH,
            &one_row(&peer, &theirs, 1),
        )
        .unwrap();

        let mut st = SyncState::default();
        let t = FakeTransport::new();
        let id = device_bindings_sync_id(&group_tier()).unwrap();
        let rec = serve_remote(&t, &id, &remote_bytes, 4);

        let phase = blocking(sync_device_bindings_phase(
            &IO,
            &t,
            "tok",
            &group_tier(),
            &dir,
            &mut st,
            &id,
            Some(&rec),
        ))
        .unwrap();
        assert!(
            phase.applied_remote,
            "a merge that changed the local store must be reported at the cycle boundary"
        );
        assert!(
            phase.dirty,
            "a merge the server has not seen must push, or the peer's claim lives only here"
        );
        let pushed = decode(phase.push_bytes.as_deref().expect("merged bytes"));
        assert_eq!(
            pushed.len(),
            2,
            "both devices stay bound: the merge is a union, not a replace"
        );
        assert!(pushed.contains_key(&hex(&mine)));
        assert!(pushed.contains_key(&hex(&theirs)));
        let on_disk = decode(&std::fs::read(device_bindings_file_path(&dir)).unwrap());
        assert_eq!(
            on_disk, pushed,
            "the store and the push carry ONE map, not two derivations of it"
        );
        assert!(
            protocol::verify_device_binding(
                &me.public_half(),
                &mine,
                on_disk.get(&hex(&mine)).unwrap()
            ),
            "the local row is still this device's own signature after the merge"
        );
        assert!(
            protocol::verify_device_binding(
                &peer.public_half(),
                &theirs,
                on_disk.get(&hex(&theirs)).unwrap()
            ),
            "and the peer's row is still the peer's, unaltered by the merge"
        );
        std::fs::remove_dir_all(&dir).ok();
    }

    // Criteria 2 and 3 through the REAL cycle, which is also the only proof in the
    // tree that `sync_device_bindings_phase` is invoked at all: `sync/mod.rs`'s
    // `#![allow(dead_code)]` makes a phase that stopped being called invisible to
    // clippy, and nothing under `scripts/` reads Rust call graphs. A device that
    // claimed while offline (the local store) meets a peer's row on the server, both
    // survive, and the boundary reports it where the device list can see it.
    #[test]
    fn an_offline_claim_is_merged_at_the_cycle_boundary() {
        use protocol::vault_head::VAULT_HEAD_FORMAT_V2;

        let (dir, notes) = fresh_vault("device-bindings-cycle");
        seed_meta(&dir);

        let me = person(0x11, 0x12, 0x13);
        let mine = [0x21; 16];
        let peer = person(0x31, 0x32, 0x33);
        let theirs = [0x41; 16];
        write_local(&dir, &one_row(&me, &mine, 1));

        // The server holds only the peer's row, at a version this device never saw.
        let remote_bytes = protocol::encode_device_binding_blob(
            &bindings_key(),
            &HASH,
            EPOCH,
            &one_row(&peer, &theirs, 1),
        )
        .unwrap();
        let bindings_id = device_bindings_sync_id(&group_tier()).unwrap();

        // A signed head so the cycle adopts the server's rather than authoring a
        // genesis (a push route this test does not need).
        let signer = person(0x51, 0x52, 0x53);
        let signer_public = signer.public_half();
        let ctx = SignedHeadCtx::new(Some(signer), HASH, vec![signer_public]);
        let mut rng = rand_core::UnwrapErr(crate::rng::OsRng);
        let head = VaultHead {
            head_format_version: VAULT_HEAD_FORMAT_V2,
            account_number_hash: HASH,
            manifest_hash: [0u8; 32],
            seq: 1,
            prev_head_hash: Vec::new(),
            version_vector: vec![VvEntry {
                device_id: [0x99; 16],
                counter: 1,
            }],
        };
        let sealed = ctx.sign(&head, &mut rng).unwrap();
        let head_frag = (B64.encode(&sealed.record), hex(&sealed.head_id));

        let t = FakeTransport::new();
        let remote_nonce = read_device_bindings_nonce(&remote_bytes).unwrap();
        t.on(
            HttpMethod::Get,
            "/sync/pull?cursor=0",
            200,
            pull_body_with_head(&meta_json(&bindings_id, 4, &remote_nonce), 1, &head_frag),
        );
        t.on(
            HttpMethod::Get,
            "/sync/pull?cursor=1",
            200,
            pull_body("", 1),
        );
        t.on(
            HttpMethod::Get,
            &format!("/sync/blob?id={}", hex(&bindings_id)),
            200,
            serde_json::to_vec(&serde_json::json!({ "ciphertext_b64": B64.encode(&remote_bytes) }))
                .unwrap(),
        );

        let items_key = [0x44u8; 32];
        let items_key_id = [0x55u8; 16];
        let summary = blocking(run_sync_cycle(
            &IO,
            &t,
            None,
            &group_tier(),
            HASH,
            [0x0a; 16],
            "tok",
            &notes,
            &dir,
            PushGate::PollOnly,
            MetaVersion::V0_2,
            Some(AttachmentKeys {
                items_key: &items_key,
                items_key_id: &items_key_id,
            }),
            Some(&ctx),
            &std::collections::HashSet::new(),
        ))
        .expect("cycle runs");

        assert!(
            summary.device_bindings_applied_remote,
            "a merged binding must be reported at the cycle boundary, or the device \
                 list keeps drawing the stale roster"
        );
        let on_disk = decode(&std::fs::read(device_bindings_file_path(&dir)).unwrap());
        assert_eq!(on_disk.len(), 2, "both claims survive the cycle's merge");
        assert!(
            on_disk.contains_key(&hex(&mine)),
            "the offline claim survived"
        );
        assert!(on_disk.contains_key(&hex(&theirs)), "and so did the peer's");
        std::fs::remove_dir_all(&dir).ok();
    }

    // A merge the codec REFUSES is carried OUT of the phase, not only logged
    // (myne-md/myne#976).
    //
    // The phase cannot repair it: the repair is a signed write and the phase holds no
    // session, deliberately (it is `AppHandle`-free AND session-free so `sim.rs` can
    // drive it). So the one thing it must not do is swallow the conflict, which is what
    // made a single forged row a SILENT, permanent freeze of the store: the codec
    // refuses the whole map rather than the row, no baseline was recorded, and every
    // later cycle retried the same refusal with nothing on any surface saying so.
    #[test]
    fn a_refused_merge_is_reported_and_mutates_nothing() {
        let dir = scratch("bindings-conflict-reported");
        seed_meta(&dir);

        let me = person(0x11, 0x12, 0x13);
        let device = [0x21; 16];
        write_local(&dir, &one_row(&me, &device, 1));
        let before = std::fs::read(device_bindings_file_path(&dir)).unwrap();

        // The ONE pair with no winner: the same device, the same version, a different
        // person. Expressed as a co-member's row so the fixture reaches the state the
        // refusal needs: a row for a different DEVICE would merge cleanly and this test
        // would prove nothing.
        let them = person(0x31, 0x32, 0x33);
        let remote_bytes = protocol::encode_device_binding_blob(
            &bindings_key(),
            &HASH,
            EPOCH,
            &one_row(&them, &device, 1),
        )
        .unwrap();
        assert!(
            protocol::merge_device_bindings(&one_row(&me, &device, 1), &one_row(&them, &device, 1))
                .is_err(),
            "the fixture must be a conflict the codec really refuses, or the phase's \
                 flag would be asserting the wrong thing"
        );

        let mut st = SyncState::default();
        let t = FakeTransport::new();
        let id = device_bindings_sync_id(&group_tier()).unwrap();
        let rec = serve_remote(&t, &id, &remote_bytes, 4);

        let phase = blocking(sync_device_bindings_phase(
            &IO,
            &t,
            "tok",
            &group_tier(),
            &dir,
            &mut st,
            &id,
            Some(&rec),
        ))
        .unwrap();
        assert_eq!(
            phase.conflict,
            vec![protocol::hex::encode_lower(&device)],
            "a refused merge must reach the cycle boundary naming the DEVICE that is tied, \
                 which is the only frame that can sign the repair and the only way it can tell a \
                 pair it can separate from one between two other members"
        );
        assert!(
            !phase.dirty && !phase.applied_remote && phase.push_bytes.is_none(),
            "a refused merge writes nothing: reporting the conflict must not become a \
                 merge that guessed a winner"
        );
        assert_eq!(
            std::fs::read(device_bindings_file_path(&dir)).unwrap(),
            before,
            "the local store is byte-untouched by the refusal"
        );
        std::fs::remove_dir_all(&dir).ok();
    }
}

mod meta_phase {
    // The parent module's seam shims, re-exported into this nested one.
    use super::{blocking, IO};

    use super::super::*;
    use crate::plugins::sync::state::{mark_vault_meta_dirty, vault_meta_is_dirty, SyncState};
    use crate::plugins::sync::transport::{FakeTransport, HttpMethod};
    use protocol::{
        serialize_vault_meta, VaultMeta, VAULT_META_ITEMS_KEY_ID_LEN, VAULT_META_NONCE_LEN,
        VAULT_META_SALT_RANDOM_LEN, VAULT_META_WRAPPED_ITEMS_KEY_LEN,
        VAULT_META_WRAPPED_ROOT_KEY_LEN,
    };

    // A vault.meta with a given password-side marker. Recovery-side, KDF, and
    // the itemsKey wrap are FIXED (the cross-device invariants) so two of these
    // differ only in the password-side wrap — exactly a password change.
    fn meta_bytes(pw: u8) -> Vec<u8> {
        let m = VaultMeta {
            account_number_hash: [0x33; 16],
            kdf_params: protocol::DEFAULT_V0_1_KDF_PARAMS,
            random_salt_password: [pw; VAULT_META_SALT_RANDOM_LEN],
            random_salt_recovery: [0x55; VAULT_META_SALT_RANDOM_LEN],
            nonce_password_wrap: [pw; VAULT_META_NONCE_LEN],
            enc_root_key_password: [pw; VAULT_META_WRAPPED_ROOT_KEY_LEN],
            nonce_recovery_wrap: [0x55; VAULT_META_NONCE_LEN],
            enc_root_key_recovery: [0x55; VAULT_META_WRAPPED_ROOT_KEY_LEN],
            items_key_id: [0x07; VAULT_META_ITEMS_KEY_ID_LEN],
            items_key_nonce: [0x08; VAULT_META_NONCE_LEN],
            enc_items_key: [0x09; VAULT_META_WRAPPED_ITEMS_KEY_LEN],
            membership: None,
            person_binding: None,
        };
        serialize_vault_meta(&m).to_vec()
    }

    fn scratch(tag: &str) -> std::path::PathBuf {
        let d = std::env::temp_dir().join(format!(
            "myne-metaphase-{tag}-{}-{:p}",
            std::process::id(),
            &tag
        ));
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    fn put_recorded(t: &FakeTransport) -> Vec<Vec<u8>> {
        t.requests()
            .into_iter()
            .filter(|(m, p, _, _, _)| *m == HttpMethod::Put && p == "/vault.meta")
            .map(|(_, _, body, _, _)| body)
            .collect()
    }

    /// The silent-revert trap (phase3-web-client task 88).
    ///
    /// `sync-state.json` and `vault.meta-dirty` live in the same evictable
    /// OPFS container, so a browser eviction or a torn sidecar write loses
    /// them TOGETHER. `local_changed` then computes `false` (no dirty marker,
    /// and the baseline clause is guarded by `baseline.is_some()`) while
    /// `server_changed` computes `true` — and the adopt branch overwrites the
    /// local `vault.meta` with the server's older copy.
    ///
    /// What the user sees: the password they just changed stops working and
    /// the old one starts working again, with no error anywhere. On the web
    /// client there is no recovery phrase by settled decision, so the only
    /// remedy is a native client with a password they have just been told is
    /// no longer theirs.
    #[test]
    fn refuses_to_adopt_a_differing_credential_when_no_baseline_says_which_moved() {
        let dir = scratch("ambiguous");
        let local = meta_bytes(0xAA); // this device's NEW password wrap
        let server = meta_bytes(0xBB); // the server's older one
        std::fs::write(dir.join("vault.meta"), &local).unwrap();
        // The post-eviction state: no baseline, no dirty marker.
        let mut st = SyncState::default();
        let t = FakeTransport::new();
        t.on(HttpMethod::Get, "/vault.meta", 200, server.clone());

        let out = blocking(sync_meta_phase(&IO, &t, "tok", &dir, &mut st, true, None));

        assert_eq!(out, MetaPhaseOutcome::CredentialAmbiguous);
        assert_eq!(
            std::fs::read(dir.join("vault.meta")).unwrap(),
            local,
            "the local credential must survive an unresolvable disagreement"
        );
        assert!(
            st.meta_baseline_hex.is_none(),
            "refusing must not invent a baseline — that would make the NEXT cycle adopt"
        );
        std::fs::remove_dir_all(&dir).ok();
    }

    /// The other half, and the reason the guard is scoped to the password
    /// side. An absent baseline with an IDENTICAL password wrap is ordinary —
    /// another device changed something this one holds no opinion about — and
    /// refusing there would stall propagation for no safety gain.
    #[test]
    fn an_absent_baseline_still_adopts_when_the_credential_is_unchanged() {
        let dir = scratch("ambiguous-same-pw");
        // Same password side, different elsewhere: only the recovery-side
        // bytes are varied here, which `merge_vault_meta` treats as a hard
        // divergence — so this asserts the guard did not fire, via the
        // outcome it DOES produce rather than by adopting something the
        // merge would refuse.
        let local = meta_bytes(0xAA);
        std::fs::write(dir.join("vault.meta"), &local).unwrap();
        let mut st = SyncState::default();
        let t = FakeTransport::new();
        // Identical bytes → the early "already agree" return, which proves
        // the guard is not reached for an unchanged credential.
        t.on(HttpMethod::Get, "/vault.meta", 200, local.clone());

        let out = blocking(sync_meta_phase(&IO, &t, "tok", &dir, &mut st, true, None));
        assert_eq!(out, MetaPhaseOutcome::NoChange);
        assert_eq!(st.meta_baseline_hex, Some(sha256_hex(&local)));
        std::fs::remove_dir_all(&dir).ok();
    }

    // Device B holds an old meta, made NO local change; the server carries a
    // newer password-side (device A changed it). B must ADOPT it: the local
    // file becomes the server bytes, and no PUT is sent.
    #[test]
    fn adopts_remote_change_when_not_dirty() {
        let dir = scratch("adopt");
        let local = meta_bytes(0xAA);
        let server = meta_bytes(0xBB);
        std::fs::write(dir.join("vault.meta"), &local).unwrap();
        // Baseline = the local we last synced (so "server changed, I didn't").
        let mut st = SyncState {
            meta_baseline_hex: Some(sha256_hex(&local)),
            ..Default::default()
        };
        let t = FakeTransport::new();
        t.on(HttpMethod::Get, "/vault.meta", 200, server.clone());

        let out = blocking(sync_meta_phase(&IO, &t, "tok", &dir, &mut st, true, None));
        assert_eq!(out, MetaPhaseOutcome::Adopted);
        assert_eq!(
            std::fs::read(dir.join("vault.meta")).unwrap(),
            server,
            "B adopts the server's newer meta verbatim"
        );
        assert_eq!(st.meta_baseline_hex, Some(sha256_hex(&server)));
        assert!(put_recorded(&t).is_empty(), "adoption pushes nothing");
        std::fs::remove_dir_all(&dir).ok();
    }

    // Device A changed its password (dirty); the server still holds the old
    // meta (== baseline). A must PUSH its local meta and clear the marker.
    #[test]
    fn pushes_local_change_when_only_i_changed() {
        let dir = scratch("push");
        let baseline = meta_bytes(0xAA); // what the server still has
        let local = meta_bytes(0xCC); // A's new password-side
        std::fs::write(dir.join("vault.meta"), &local).unwrap();
        blocking(mark_vault_meta_dirty(&IO, &dir)).unwrap();
        let mut st = SyncState {
            meta_baseline_hex: Some(sha256_hex(&baseline)),
            ..Default::default()
        };
        let t = FakeTransport::new();
        t.on(HttpMethod::Get, "/vault.meta", 200, baseline);
        t.on(HttpMethod::Put, "/vault.meta", 200, Vec::new());

        let out = blocking(sync_meta_phase(&IO, &t, "tok", &dir, &mut st, true, None));
        assert_eq!(out, MetaPhaseOutcome::Pushed);
        let puts = put_recorded(&t);
        assert_eq!(puts.len(), 1);
        assert_eq!(puts[0], local, "A pushes its own new meta");
        assert_eq!(st.meta_baseline_hex, Some(sha256_hex(&local)));
        assert!(
            !blocking(vault_meta_is_dirty(&IO, &dir)),
            "dirty cleared after a successful push"
        );
        std::fs::remove_dir_all(&dir).ok();
    }

    // A B2B vault's `vault.meta` PUT is OWNER-authorized: the server refuses a
    // device token with 403 `owner_required`. When this device holds the
    // owner's per-vault membership token, the push must carry IT, or the
    // roster/epoch never reaches the server and a member joins against a
    // stale roster (its own heads then fail to verify, wedging sync).
    #[test]
    fn a_b2b_meta_push_uses_the_owner_membership_token() {
        let dir = scratch("owner-token");
        let baseline = meta_bytes(0xAA); // what the server still has
        let local = meta_bytes(0xCC); // our changed meta
        std::fs::write(dir.join("vault.meta"), &local).unwrap();
        blocking(mark_vault_meta_dirty(&IO, &dir)).unwrap();
        let mut st = SyncState {
            meta_baseline_hex: Some(sha256_hex(&baseline)),
            owner_member_token_hex: Some("owner-tok".to_string()),
            ..Default::default()
        };
        let t = FakeTransport::new();
        t.on(HttpMethod::Get, "/vault.meta", 200, baseline);
        t.on(HttpMethod::Put, "/vault.meta", 200, Vec::new());

        let out = blocking(sync_meta_phase(
            &IO,
            &t,
            "device-tok",
            &dir,
            &mut st,
            true,
            None,
        ));
        assert_eq!(out, MetaPhaseOutcome::Pushed);
        let put_token = t
            .requests()
            .into_iter()
            .find(|(m, p, _, _, _)| *m == HttpMethod::Put && p == "/vault.meta")
            .and_then(|(_, _, _, tok, _)| tok);
        assert_eq!(
            put_token.as_deref(),
            Some("owner-tok"),
            "the meta PUT must carry the owner membership token, not the device token"
        );
        std::fs::remove_dir_all(&dir).ok();
    }

    // myne#293 — a poll cycle (allow_push=false) with the DIRTY MARKER set
    // must push anyway.
    //
    // This test asserted the opposite, and that was the defect: the marker's
    // only production writer is the credential-push failure arm, and a
    // credential change bumps no local-change counter, so the scheduler
    // never opened a push window on its own. A password change whose
    // immediate push failed then sat unpushed until an unrelated note edit
    // happened to open one — while a second device joining in that window
    // fetched the stale meta and was unlocked by the OLD password.
    //
    // What `allow_push` protects is edit-TIMING inference from push cadence.
    // The marker carries no edit timing, only "a credential changed and the
    // server does not have it", which the immediate push at change time
    // already revealed.
    #[test]
    fn poll_cycle_pushes_a_pending_credential_change() {
        let dir = scratch("poll");
        let baseline = meta_bytes(0xAA);
        let local = meta_bytes(0xCC);
        std::fs::write(dir.join("vault.meta"), &local).unwrap();
        blocking(mark_vault_meta_dirty(&IO, &dir)).unwrap();
        let mut st = SyncState {
            meta_baseline_hex: Some(sha256_hex(&baseline)),
            ..Default::default()
        };
        let t = FakeTransport::new();
        t.on(HttpMethod::Get, "/vault.meta", 200, baseline);
        t.on(HttpMethod::Put, "/vault.meta", 200, Vec::new());

        let out = blocking(sync_meta_phase(&IO, &t, "tok", &dir, &mut st, false, None));
        assert_eq!(out, MetaPhaseOutcome::Pushed);
        assert_eq!(
            put_recorded(&t),
            vec![local],
            "the rotated credential reaches the server without waiting for an \
                 unrelated content edit"
        );
        assert!(
            !blocking(vault_meta_is_dirty(&IO, &dir)),
            "dirty cleared once the server has it"
        );
        std::fs::remove_dir_all(&dir).ok();
    }

    // …and the coalescing rule is otherwise untouched: a poll cycle with a
    // local change but NO pending credential change still pushes nothing.
    #[test]
    fn poll_cycle_still_defers_a_plain_local_divergence() {
        let dir = scratch("poll-clean");
        let baseline = meta_bytes(0xAA);
        let local = meta_bytes(0xCC);
        std::fs::write(dir.join("vault.meta"), &local).unwrap();
        // No `mark_vault_meta_dirty` — the divergence is inferred from the
        // baseline, not from a credential change.
        let mut st = SyncState {
            meta_baseline_hex: Some(sha256_hex(&baseline)),
            ..Default::default()
        };
        let t = FakeTransport::new();
        t.on(HttpMethod::Get, "/vault.meta", 200, baseline);

        let out = blocking(sync_meta_phase(&IO, &t, "tok", &dir, &mut st, false, None));
        assert_eq!(out, MetaPhaseOutcome::NoChange);
        assert!(put_recorded(&t).is_empty(), "a poll cycle pushes nothing");
        std::fs::remove_dir_all(&dir).ok();
    }

    // Both devices changed concurrently: the phase merges deterministically and
    // BOTH devices, from their own perspective, converge on the SAME winner.
    #[test]
    fn concurrent_change_converges_deterministically() {
        let baseline = meta_bytes(0x10); // the shared last-synced state
        let a_pw = meta_bytes(0xAA); // device A's new password-side
        let b_pw = meta_bytes(0xBB); // device B's new password-side
                                     // Deterministic winner is the greater enc_root_key_password → 0xBB.
        let winner = b_pw.clone();

        // --- A's perspective: local=A, server=B (B pushed first) ---
        let dir_a = scratch("conc-a");
        std::fs::write(dir_a.join("vault.meta"), &a_pw).unwrap();
        blocking(mark_vault_meta_dirty(&IO, &dir_a)).unwrap();
        let mut st_a = SyncState {
            meta_baseline_hex: Some(sha256_hex(&baseline)),
            ..Default::default()
        };
        let ta = FakeTransport::new();
        ta.on(HttpMethod::Get, "/vault.meta", 200, b_pw.clone());
        ta.on(HttpMethod::Put, "/vault.meta", 200, Vec::new());
        let out_a = blocking(sync_meta_phase(
            &IO, &ta, "tok", &dir_a, &mut st_a, true, None,
        ));
        assert_eq!(out_a, MetaPhaseOutcome::Merged);
        assert_eq!(
            std::fs::read(dir_a.join("vault.meta")).unwrap(),
            winner,
            "A converges on the deterministic winner (0xBB)"
        );

        // --- B's perspective: local=B, server=A (A pushed first) ---
        let dir_b = scratch("conc-b");
        std::fs::write(dir_b.join("vault.meta"), &b_pw).unwrap();
        blocking(mark_vault_meta_dirty(&IO, &dir_b)).unwrap();
        let mut st_b = SyncState {
            meta_baseline_hex: Some(sha256_hex(&baseline)),
            ..Default::default()
        };
        let tb = FakeTransport::new();
        tb.on(HttpMethod::Get, "/vault.meta", 200, a_pw.clone());
        tb.on(HttpMethod::Put, "/vault.meta", 200, Vec::new());
        let out_b = blocking(sync_meta_phase(
            &IO, &tb, "tok", &dir_b, &mut st_b, true, None,
        ));
        assert_eq!(out_b, MetaPhaseOutcome::Merged);
        assert_eq!(
            std::fs::read(dir_b.join("vault.meta")).unwrap(),
            winner,
            "B converges on the SAME deterministic winner (0xBB)"
        );
        // Both devices agree — the whole point.
        assert_eq!(st_a.meta_baseline_hex, st_b.meta_baseline_hex);

        std::fs::remove_dir_all(&dir_a).ok();
        std::fs::remove_dir_all(&dir_b).ok();
    }

    // The v0.2 (`NTV5`) twin of `meta_bytes`: same fields, stamped with the
    // migrated magic. Two of these differ only in the password-side wrap — a
    // password change on a MIGRATED vault.
    fn meta_bytes_v0_2(pw: u8) -> Vec<u8> {
        let m = VaultMeta {
            account_number_hash: [0x33; 16],
            kdf_params: protocol::DEFAULT_V0_1_KDF_PARAMS,
            random_salt_password: [pw; VAULT_META_SALT_RANDOM_LEN],
            random_salt_recovery: [0x55; VAULT_META_SALT_RANDOM_LEN],
            nonce_password_wrap: [pw; VAULT_META_NONCE_LEN],
            enc_root_key_password: [pw; VAULT_META_WRAPPED_ROOT_KEY_LEN],
            nonce_recovery_wrap: [0x55; VAULT_META_NONCE_LEN],
            enc_root_key_recovery: [0x55; VAULT_META_WRAPPED_ROOT_KEY_LEN],
            items_key_id: [0x07; VAULT_META_ITEMS_KEY_ID_LEN],
            items_key_nonce: [0x08; VAULT_META_NONCE_LEN],
            enc_items_key: [0x09; VAULT_META_WRAPPED_ITEMS_KEY_LEN],
            membership: None,
            person_binding: None,
        };
        protocol::serialize_vault_meta_v0_2(&m).to_vec()
    }

    // A concurrent password change on two MIGRATED (v0.2 / `NTV5`) devices must
    // re-serialize the merged meta as `NTV5`, NOT `MYV1`. Serializing it as
    // `MYV1` (the old unconditional `serialize_vault_meta`) writes v0.2 wrap
    // bytes under a v0.1 magic: the next unlock reads `V0_1`, derives the wrong
    // KDF salt domain, and BRICKS the vault (password AND recovery), stranding
    // every `NC05` note under the now-unreachable v0.2 `itemsKey`. The
    // generation guard in `sync_meta_phase` is what prevents that.
    #[test]
    fn concurrent_change_on_migrated_vaults_re_serializes_as_ntv5_not_myv1() {
        let baseline = meta_bytes_v0_2(0x10);
        let a_pw = meta_bytes_v0_2(0xAA);
        let b_pw = meta_bytes_v0_2(0xBB); // deterministic winner (greater wrap)

        let dir = scratch("conc-v0_2");
        std::fs::write(dir.join("vault.meta"), &a_pw).unwrap();
        blocking(mark_vault_meta_dirty(&IO, &dir)).unwrap();
        let mut st = SyncState {
            meta_baseline_hex: Some(sha256_hex(&baseline)),
            ..Default::default()
        };
        let t = FakeTransport::new();
        t.on(HttpMethod::Get, "/vault.meta", 200, b_pw.clone());
        t.on(HttpMethod::Put, "/vault.meta", 200, Vec::new());

        let out = blocking(sync_meta_phase(&IO, &t, "tok", &dir, &mut st, true, None));
        assert_eq!(out, MetaPhaseOutcome::Merged);
        let merged = std::fs::read(dir.join("vault.meta")).unwrap();
        assert_eq!(
            &merged[0..4],
            protocol::VAULT_META_V0_2_MAGIC.as_slice(),
            "a merged migrated meta stays NTV5 — it must never revert to MYV1"
        );
        assert_eq!(merged, b_pw, "still converges on the deterministic winner");
        std::fs::remove_dir_all(&dir).ok();
    }

    // A server meta with a DIVERGENT itemsKey wrap (different vault / corrupt /
    // hostile) must NEVER overwrite the local credential root — it SKIPS.
    #[test]
    fn refuses_to_adopt_incompatible_server_meta() {
        let dir = scratch("incompat");
        let local = meta_bytes(0xAA);
        std::fs::write(dir.join("vault.meta"), &local).unwrap();
        // Server meta with a different itemsKey → merge_vault_meta rejects it.
        let mut bad = VaultMeta {
            account_number_hash: [0x33; 16],
            kdf_params: protocol::DEFAULT_V0_1_KDF_PARAMS,
            random_salt_password: [0xBB; VAULT_META_SALT_RANDOM_LEN],
            random_salt_recovery: [0x55; VAULT_META_SALT_RANDOM_LEN],
            nonce_password_wrap: [0xBB; VAULT_META_NONCE_LEN],
            enc_root_key_password: [0xBB; VAULT_META_WRAPPED_ROOT_KEY_LEN],
            nonce_recovery_wrap: [0x55; VAULT_META_NONCE_LEN],
            enc_root_key_recovery: [0x55; VAULT_META_WRAPPED_ROOT_KEY_LEN],
            items_key_id: [0x07; VAULT_META_ITEMS_KEY_ID_LEN],
            items_key_nonce: [0x08; VAULT_META_NONCE_LEN],
            enc_items_key: [0x09; VAULT_META_WRAPPED_ITEMS_KEY_LEN],
            membership: None,
            person_binding: None,
        };
        bad.enc_items_key = [0xEE; VAULT_META_WRAPPED_ITEMS_KEY_LEN]; // divergent!
        let server = serialize_vault_meta(&bad).to_vec();
        let mut st = SyncState {
            meta_baseline_hex: Some(sha256_hex(&local)),
            ..Default::default()
        };
        let t = FakeTransport::new();
        t.on(HttpMethod::Get, "/vault.meta", 200, server);

        let out = blocking(sync_meta_phase(&IO, &t, "tok", &dir, &mut st, true, None));
        assert_eq!(out, MetaPhaseOutcome::Skipped);
        assert_eq!(
            std::fs::read(dir.join("vault.meta")).unwrap(),
            local,
            "local credential root is NEVER overwritten by an incompatible meta"
        );
        std::fs::remove_dir_all(&dir).ok();
    }

    // Server holds no meta yet (404) + a pending local change → push it.
    #[test]
    fn pushes_on_404_when_dirty() {
        let dir = scratch("seed");
        let local = meta_bytes(0xAA);
        std::fs::write(dir.join("vault.meta"), &local).unwrap();
        blocking(mark_vault_meta_dirty(&IO, &dir)).unwrap();
        let mut st = SyncState::default();
        let t = FakeTransport::new();
        t.on(HttpMethod::Get, "/vault.meta", 404, Vec::new());
        t.on(HttpMethod::Put, "/vault.meta", 200, Vec::new());

        let out = blocking(sync_meta_phase(&IO, &t, "tok", &dir, &mut st, true, None));
        assert_eq!(out, MetaPhaseOutcome::Pushed);
        assert_eq!(put_recorded(&t), vec![local.clone()]);
        assert_eq!(st.meta_baseline_hex, Some(sha256_hex(&local)));
        assert!(!blocking(vault_meta_is_dirty(&IO, &dir)));
        std::fs::remove_dir_all(&dir).ok();
    }

    // Server and local already agree → clear dirt, record baseline, no push.
    #[test]
    fn no_op_when_already_in_sync() {
        let dir = scratch("agree");
        let m = meta_bytes(0xAA);
        std::fs::write(dir.join("vault.meta"), &m).unwrap();
        blocking(mark_vault_meta_dirty(&IO, &dir)).unwrap();
        let mut st = SyncState::default();
        let t = FakeTransport::new();
        t.on(HttpMethod::Get, "/vault.meta", 200, m.clone());

        let out = blocking(sync_meta_phase(&IO, &t, "tok", &dir, &mut st, true, None));
        assert_eq!(out, MetaPhaseOutcome::NoChange);
        assert!(put_recorded(&t).is_empty());
        assert_eq!(st.meta_baseline_hex, Some(sha256_hex(&m)));
        assert!(
            !blocking(vault_meta_is_dirty(&IO, &dir)),
            "an agreeing server clears a stale dirty flag"
        );
        std::fs::remove_dir_all(&dir).ok();
    }
}

/// Batch blob fetch on the pull path (myne-md/myne#240).
mod blob_batch {
    use super::*;

    fn changed(size: usize) -> engine::ChangedBlob {
        engine::ChangedBlob {
            id: [0u8; 16],
            content_nonce: [0u8; 24],
            version: 1,
            size,
            attachment_id: None,
        }
    }

    /// The inversion of `push_chunks`, and the reason it gets a test of its
    /// own: push returns ONE EMPTY chunk for an empty batch (a head-only
    /// genesis push must still be sent), so the obvious copy of it here would
    /// send an empty batch request — spending a token and a round-trip on
    /// nothing. Every byte of the resulting data would be correct, so nothing
    /// else in the suite would notice.
    #[test]
    fn an_empty_queue_yields_no_window() {
        assert_eq!(fetch_window(&[]), 0);
    }

    #[test]
    fn a_window_closes_on_the_count_bound() {
        let all: Vec<engine::ChangedBlob> = (0..FETCH_WINDOW_MAX_BLOBS + 44)
            .map(|_| changed(1))
            .collect();
        let q: Vec<&engine::ChangedBlob> = all.iter().collect();
        assert_eq!(fetch_window(&q), FETCH_WINDOW_MAX_BLOBS);
        assert_eq!(fetch_window(&q[FETCH_WINDOW_MAX_BLOBS..]), 44);
        // Exactly at the bound splits cleanly rather than leaving a stray.
        assert_eq!(
            fetch_window(&q[..FETCH_WINDOW_MAX_BLOBS]),
            FETCH_WINDOW_MAX_BLOBS
        );
    }

    #[test]
    fn a_window_closes_on_the_byte_bound_before_the_count_bound() {
        // 512 KiB each → 16 fit in the 8 MiB budget, far below the count cap.
        let all: Vec<engine::ChangedBlob> = (0..40).map(|_| changed(512 * 1024)).collect();
        let q: Vec<&engine::ChangedBlob> = all.iter().collect();
        let n = fetch_window(&q);
        assert_eq!(n, 16, "the byte budget must bind before the count cap");
        assert!(n * 512 * 1024 <= FETCH_WINDOW_MAX_BYTES);
    }

    /// A lone blob over the whole budget still travels, or the drain loops on
    /// it forever. Mirrors push_chunks' oversized-lone-blob rule.
    #[test]
    fn a_lone_oversized_blob_gets_a_window_of_one() {
        let all = [changed(FETCH_WINDOW_MAX_BYTES * 2), changed(1)];
        let q: Vec<&engine::ChangedBlob> = all.iter().collect();
        assert_eq!(fetch_window(&q), 1);
    }

    /// `size` is server-advertised and untrusted (§8.1), and an older server
    /// omits it so it deserializes to 0. Neither is special-cased: with 0 the
    /// byte accumulator never trips and windowing degrades to count-only,
    /// after which the server serves the prefix that fits and the client
    /// re-windows the rest.
    #[test]
    fn a_zero_size_degrades_to_the_count_bound() {
        let all: Vec<engine::ChangedBlob> = (0..FETCH_WINDOW_MAX_BLOBS * 2)
            .map(|_| changed(0))
            .collect();
        let q: Vec<&engine::ChangedBlob> = all.iter().collect();
        assert_eq!(fetch_window(&q), FETCH_WINDOW_MAX_BLOBS);
    }

    /// The 50 000-note arithmetic, done as arithmetic rather than as a corpus.
    /// 1424 B is the 71.2 MB / 50 000 average recorded in the myne#222
    /// decisions entry; the count cap binds at that size, so the pull that
    /// used to be 50 000 requests is 196.
    #[test]
    fn fifty_thousand_notes_plan_one_hundred_ninety_six_windows() {
        let all: Vec<engine::ChangedBlob> = (0..50_000).map(|_| changed(1424)).collect();
        let mut q: &[&engine::ChangedBlob] = &all.iter().collect::<Vec<_>>();
        let mut windows = 0usize;
        while !q.is_empty() {
            let n = fetch_window(q);
            assert!(
                n > 0,
                "a window is never empty — the drain would not advance"
            );
            assert!(n <= FETCH_WINDOW_MAX_BLOBS);
            assert!(
                n == 1 || q[..n].iter().map(|c| c.size).sum::<usize>() <= FETCH_WINDOW_MAX_BYTES
            );
            windows += 1;
            q = &q[n..];
        }
        assert_eq!(windows, 196);
    }

    /// The end-to-end proof, against the production limiter defaults spelled
    /// out literally rather than `spawn_server`'s lifted values.
    ///
    /// On `develop` this fails at `rate_limited() == 0`: 600 sequential GETs
    /// against a burst of 256 refilling at 16/s collects hundreds of 429s,
    /// which `download_blob_backoff` absorbs — the pull still succeeds, just
    /// slowly, which is exactly why the request count and not the failure
    /// class is the honest assertion.
    #[test]
    fn a_first_pull_of_a_large_vault_fits_inside_the_default_burst() {
        let Some((_guard, url)) = spawn_server_env("256", "16") else {
            eprintln!("SKIP blob_batch burst: server binary not found");
            return;
        };
        let root_key = [0xc1u8; 32];
        let account_hash = [0xc2u8; 16];
        let secret = derive_subkey(&root_key, SubkeyRole::ServerAuth);
        let items_key = [0xc3u8; 32];
        let items_key_id = [0xc4u8; 16];
        let dir_a = std::env::temp_dir().join(format!("myne-bb-A-{}", std::process::id()));
        let dir_b = std::env::temp_dir().join(format!("myne-bb-B-{}", std::process::id()));
        let notes_a = dir_a.join("notes");
        let notes_b = dir_b.join("notes");
        std::fs::create_dir_all(&notes_a).unwrap();
        std::fs::create_dir_all(&notes_b).unwrap();

        // 600 = 2 full windows + 88, so the split is exercised and asymmetric.
        const N: usize = 600;
        let mut written = Vec::with_capacity(N);
        for i in 0..N {
            let id = NoteId::new_v7();
            write_note(
                &notes_a,
                &items_key,
                &items_key_id,
                &id,
                format!("note-{i}").as_bytes(),
                false,
            );
            written.push(id);
        }
        let (ta, dev_a, tok_a) = enroll_device(
            &url,
            &account_hash,
            secret.as_slice(),
            "c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0",
            true,
        );
        run_cycle_legacy(
            ta.as_ref(),
            &root_key,
            account_hash,
            dev_a,
            &tok_a,
            &notes_a,
            &dir_a,
            true,
        )
        .expect("A pushes 600 notes");

        let (_tb, dev_b, tok_b) = enroll_device(
            &url,
            &account_hash,
            secret.as_slice(),
            "d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1",
            false,
        );
        let obs =
            PullObserver::new(crate::plugins::sync::http_transport::build_transport(&url).unwrap());
        let pull = run_cycle_legacy(
            &obs,
            &root_key,
            account_hash,
            dev_b,
            &tok_b,
            &notes_b,
            &dir_b,
            true,
        )
        .expect("B cold-syncs in ONE cycle");

        assert_eq!(pull.pulled, N, "every note landed in one cycle");
        assert_eq!(
            obs.rate_limited(),
            0,
            "the cold sync must not touch the limiter at all — this is the \
                 assertion that fails before batching, where 600 GETs against a \
                 256 burst collect hundreds of 429s"
        );
        assert_eq!(
            obs.ids_per_batch(),
            vec![FETCH_WINDOW_MAX_BLOBS, FETCH_WINDOW_MAX_BLOBS, 88],
            "note bodies travel in bounded windows"
        );
        assert_eq!(
            obs.single_count(),
            0,
            "no note body fell back to the single-blob route"
        );

        // The control arm, and the reason the assertion above is meaningful:
        // the same account, against the same limiter, must still bind when the
        // blob bodies are asked for ONE GET at a time — the pre-#240 shape,
        // still live as the old-server fallback. Without this, the "0 429s"
        // above could just mean the corpus was too small to exhaust the burst.
        //
        // CONCURRENT, and that is a robustness fix rather than a shortcut.
        // Driving this through a second `run_cycle_legacy` bound nothing on a
        // loaded machine: the full `cargo test --workspace` run failed here on
        // a tree where the same test passed alone, with 600 single GETs and 0
        // refusals. The bucket refills at 16 tokens a second, so the control
        // only binds when requests arrive faster than that, and one sequential
        // loop's rate is loopback latency — which under full-suite load fell
        // below the refill, so the refill covered the whole corpus. The claim
        // is a property of the SERVER ("this many single GETs exhaust a
        // 256-token bucket"), so the requests only have to arrive faster than
        // the refill; 32 threads give that by construction (384 requests at
        // even a 1 s latency is 32/s), and the slow-path COMPLETION is pinned
        // by `a_server_without_the_batch_route_falls_back_to_single_blob`,
        // which is where it belongs.
        let (_tc, _dev_c, tok_c) = enroll_device(
            &url,
            &account_hash,
            secret.as_slice(),
            "e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2",
            false,
        );
        let control =
            PullObserver::new(crate::plugins::sync::http_transport::build_transport(&url).unwrap());
        // 384 = the 256-token burst + 128, i.e. 8 s of refill, so arriving
        // faster than 16/s cannot be absorbed.
        let hammer: Vec<[u8; 16]> = written
            .iter()
            .take(384)
            .map(|id| *id.as_uuid().as_bytes())
            .collect();
        std::thread::scope(|scope| {
            for chunk in hammer.chunks(12) {
                let control = &control;
                let token = tok_c.as_str();
                scope.spawn(move || {
                    for id in chunk {
                        // The refusal IS the observation; a 200 or a 404 is
                        // noise here, and both are counted by the observer.
                        let _ = engine::download_blob(control, token, id);
                    }
                });
            }
        });
        assert_eq!(
            control.single_count(),
            hammer.len(),
            "the control asked for every blob one GET at a time"
        );
        assert!(
            control.rate_limited() > 0,
            "the control arm did not bind the limiter ({} single GETs, 0 refusals), \
                 so the 0-429 assertion above proves nothing",
            control.single_count()
        );
        std::fs::remove_dir_all(&dir_a).ok();
        std::fs::remove_dir_all(&dir_b).ok();
    }

    /// A server without the route (404, or 405 behind a proxy that knows the
    /// /sync prefix but not the method) is probed ONCE and the rest of the
    /// attempt uses the single-blob route.
    #[test]
    fn a_server_without_the_batch_route_falls_back_to_single_blob() {
        let Some((_guard, url)) = spawn_server() else {
            eprintln!("SKIP blob_batch fallback: server binary not found");
            return;
        };
        let root_key = [0xe1u8; 32];
        let account_hash = [0xe2u8; 16];
        let secret = derive_subkey(&root_key, SubkeyRole::ServerAuth);
        let items_key = [0xe3u8; 32];
        let items_key_id = [0xe4u8; 16];
        let dir_a = std::env::temp_dir().join(format!("myne-bbf-A-{}", std::process::id()));
        let dir_b = std::env::temp_dir().join(format!("myne-bbf-B-{}", std::process::id()));
        let notes_a = dir_a.join("notes");
        let notes_b = dir_b.join("notes");
        std::fs::create_dir_all(&notes_a).unwrap();
        std::fs::create_dir_all(&notes_b).unwrap();

        for i in 0..5 {
            write_note(
                &notes_a,
                &items_key,
                &items_key_id,
                &NoteId::new_v7(),
                format!("old-server-{i}").as_bytes(),
                false,
            );
        }
        let (ta, dev_a, tok_a) = enroll_device(
            &url,
            &account_hash,
            secret.as_slice(),
            "e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0",
            true,
        );
        run_cycle_legacy(
            ta.as_ref(),
            &root_key,
            account_hash,
            dev_a,
            &tok_a,
            &notes_a,
            &dir_a,
            true,
        )
        .expect("A push");

        for status in [404u16, 405] {
            let dir = dir_b.join(status.to_string());
            let notes = dir.join("notes");
            std::fs::create_dir_all(&notes).unwrap();
            let (_t, dev, tok) = enroll_device(
                &url,
                &account_hash,
                secret.as_slice(),
                &format!("{status}0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f")[..32],
                false,
            );
            let obs = PullObserver::new(Box::new(RouteAbsentTransport {
                inner: crate::plugins::sync::http_transport::build_transport(&url).unwrap(),
                status,
            }));
            let pull =
                run_cycle_legacy(&obs, &root_key, account_hash, dev, &tok, &notes, &dir, true)
                    .expect("the cycle completes against a server without the route");
            assert_eq!(pull.pulled, 5, "every note landed via the fallback");
            assert_eq!(
                obs.ids_per_batch().len(),
                1,
                "status {status}: the absent route is probed ONCE, not once per window"
            );
            assert_eq!(
                obs.single_count(),
                5,
                "status {status}: one GET per note after the fallback"
            );
        }
        std::fs::remove_dir_all(&dir_a).ok();
        std::fs::remove_dir_all(&dir_b).ok();
    }

    /// The negative case, and the one that matters: a transport-level failure
    /// is a server OUTAGE, not a missing route. Falling back on it would mask
    /// a real outage as a slow success and permanently downgrade the session
    /// on one dropped packet. The cycle must fail and try the batch again.
    #[test]
    fn a_transport_error_on_the_batch_route_does_not_disable_it() {
        let Some((_guard, url)) = spawn_server() else {
            eprintln!("SKIP blob_batch outage: server binary not found");
            return;
        };
        let root_key = [0xf1u8; 32];
        let account_hash = [0xf2u8; 16];
        let secret = derive_subkey(&root_key, SubkeyRole::ServerAuth);
        let items_key = [0xf3u8; 32];
        let items_key_id = [0xf4u8; 16];
        let dir_a = std::env::temp_dir().join(format!("myne-bbo-A-{}", std::process::id()));
        let dir_b = std::env::temp_dir().join(format!("myne-bbo-B-{}", std::process::id()));
        let notes_a = dir_a.join("notes");
        let notes_b = dir_b.join("notes");
        std::fs::create_dir_all(&notes_a).unwrap();
        std::fs::create_dir_all(&notes_b).unwrap();

        let note = NoteId::new_v7();
        write_note(&notes_a, &items_key, &items_key_id, &note, b"outage", false);
        let (ta, dev_a, tok_a) = enroll_device(
            &url,
            &account_hash,
            secret.as_slice(),
            "f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0",
            true,
        );
        run_cycle_legacy(
            ta.as_ref(),
            &root_key,
            account_hash,
            dev_a,
            &tok_a,
            &notes_a,
            &dir_a,
            true,
        )
        .expect("A push");
        let (_tb, dev_b, tok_b) = enroll_device(
            &url,
            &account_hash,
            secret.as_slice(),
            "0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f",
            false,
        );

        // First cycle: the batch route drops below HTTP.
        use crate::plugins::sync::transport::{FaultInjectingTransport, FaultMode};
        let dead = FaultInjectingTransport::fail_path(
            crate::plugins::sync::http_transport::build_transport(&url).unwrap(),
            BLOB_BATCH_PATH,
            99,
            FaultMode::Network,
        );
        let err = run_cycle_legacy(
            &dead,
            &root_key,
            account_hash,
            dev_b,
            &tok_b,
            &notes_b,
            &dir_b,
            true,
        )
        .expect_err("an outage on the batch route fails the cycle");
        assert!(
            matches!(err, SyncCycleError::Pull(PullError::Transport(_))),
            "an outage stays a transport error, it is not laundered into a \
                 fallback: got {err:?}"
        );
        assert!(
            !notes_b.join(format!("{}.myn", note.as_uuid())).exists(),
            "nothing was written by the failed cycle"
        );

        // Next cycle, healthy transport: the batch route is tried AGAIN.
        let obs =
            PullObserver::new(crate::plugins::sync::http_transport::build_transport(&url).unwrap());
        let pull = run_cycle_legacy(
            &obs,
            &root_key,
            account_hash,
            dev_b,
            &tok_b,
            &notes_b,
            &dir_b,
            true,
        )
        .expect("the next cycle recovers");
        assert_eq!(pull.pulled, 1);
        assert_eq!(
            obs.ids_per_batch(),
            vec![1],
            "the batch route was retried, not permanently disabled"
        );
        assert_eq!(obs.single_count(), 0);
        std::fs::remove_dir_all(&dir_a).ok();
        std::fs::remove_dir_all(&dir_b).ok();
    }

    /// Every way a batch response can try to make an id land as empty
    /// bytes, against a PRE-EXISTING LIVE LOCAL NOTE so a failure is
    /// destructive and visible. A correct server emits none of these — the
    /// point is that the client refuses them anyway, because "no local
    /// mutation" (§11.3) has to hold against a hostile or buggy peer too.
    ///
    /// Arms: the id omitted with each code; the id served with an EMPTY
    /// ciphertext (a pre-§11.3 server, or a hostile one); the id in BOTH
    /// arrays; and the id in NEITHER, which must stay queued rather than
    /// default to empty bytes.
    #[test]
    fn an_omitted_id_can_never_be_applied_as_a_zero_byte_body() {
        let items_key = [0x11u8; 32];
        let items_key_id = [0x22u8; 16];
        let id_hex_of = |id: &[u8; 16]| hex(id);

        /// `(tag, build the batch body the server returns for this window)`.
        type Arm = (&'static str, Box<dyn Fn(&str) -> String>);
        let arms: Vec<Arm> = vec![
            (
                "omitted-reclaimed",
                Box::new(|h: &str| {
                    format!("{{\"blobs\":[],\"omitted\":[{{\"blob_id_hex\":\"{h}\",\"error_code\":\"blob_reclaimed\"}}]}}")
                }),
            ),
            (
                "omitted-notfound",
                Box::new(|h: &str| {
                    format!("{{\"blobs\":[],\"omitted\":[{{\"blob_id_hex\":\"{h}\",\"error_code\":\"not_found\"}}]}}")
                }),
            ),
            (
                "omitted-internal",
                Box::new(|h: &str| {
                    format!("{{\"blobs\":[],\"omitted\":[{{\"blob_id_hex\":\"{h}\",\"error_code\":\"internal\"}}]}}")
                }),
            ),
            (
                "served-empty",
                Box::new(|h: &str| {
                    format!("{{\"blobs\":[{{\"blob_id_hex\":\"{h}\",\"ciphertext_b64\":\"\"}}],\"omitted\":[]}}")
                }),
            ),
            (
                "in-both-arrays",
                Box::new(|h: &str| {
                    format!("{{\"blobs\":[{{\"blob_id_hex\":\"{h}\",\"ciphertext_b64\":\"\"}}],\"omitted\":[{{\"blob_id_hex\":\"{h}\",\"error_code\":\"blob_reclaimed\"}}]}}")
                }),
            ),
            (
                "accounted-nowhere",
                Box::new(|_h: &str| "{\"blobs\":[],\"omitted\":[]}".to_string()),
            ),
        ];

        for (tag, body_for) in arms {
            let (dir, notes) = fresh_vault(&format!("bbzero-{tag}"));
            let id = v7_id();
            let blob = encode_new_note(&items_key, &items_key_id, &id, b"precious body").unwrap();
            let disk_nonce = crate::note_nonce::read_myn_content_nonce(&blob).unwrap();
            crate::atomic_write::atomic_write(&blob_path(&notes, &id), &blob, false).unwrap();
            // A CLEAN baseline, so the cheap dirty-filter does not fire and the
            // record really does reach the batch drain.
            let mut st = SyncState::default();
            st.blobs.insert(
                hex(&id),
                BlobSyncState {
                    version: 1,
                    content_nonce_hex: hex(&disk_nonce),
                    doc_heads_hex: Vec::new(),
                },
            );
            write_sync_state(&dir, &st).unwrap();

            let t = FakeTransport::new();
            // The server advanced the record (new version + nonce), so the
            // client wants to download it.
            t.on(
                HttpMethod::Get,
                "/sync/pull?cursor=0",
                200,
                pull_body(&meta_json(&id, 2, &[0xbb; 24]), 1),
            );
            t.on(
                HttpMethod::Get,
                "/sync/pull?cursor=1",
                200,
                pull_body("", 1),
            );
            t.on(
                HttpMethod::Post,
                BLOB_BATCH_PATH,
                200,
                body_for(&id_hex_of(&id)).into_bytes(),
            );

            let out = run_cycle_legacy(
                &t,
                &[0x42; 32],
                [0x5c; 16],
                [0x0a; 16],
                "tok",
                &notes,
                &dir,
                false,
            );
            match tag {
                // An id the response accounted for nowhere leaves the drain
                // with no progress to make. Failing the cycle is the ONLY safe
                // answer: looping would hang, and skipping would silently
                // discard a record the server never spoke about.
                "accounted-nowhere" => {
                    assert!(
                            matches!(out, Err(SyncCycleError::Pull(PullError::BadResponse))),
                            "{tag}: a window that accounts for nothing must fail the cycle, got {out:?}"
                        );
                }
                _ => {
                    let s = out.unwrap_or_else(|e| panic!("{tag}: cycle failed: {e:?}"));
                    assert_eq!(s.pulled, 0, "{tag}: nothing may count as pulled");
                    assert_eq!(s.pull_skipped, 1, "{tag}: the skip is honestly counted");
                }
            }
            // The load-bearing assertion, identical in every arm.
            let on_disk = std::fs::read(blob_path(&notes, &id)).unwrap();
            assert_eq!(
                on_disk, blob,
                "{tag}: the live note must survive byte-identical"
            );
            let st2 = read_sync_state(&dir).unwrap();
            assert_eq!(
                st2.blobs.get(&hex(&id)).map(|b| b.version),
                Some(1),
                "{tag}: the baseline must NOT be adopted — adoption is what made \
                     this class of bug self-seal"
            );
            std::fs::remove_dir_all(&dir).ok();
        }
    }
}

/// The peer's exit from the re-key (myne-md/myne#447): a head it cannot open
/// while the server holds a NEWER-generation `vault.meta` must **stage** those
/// bytes on the way out.
///
/// Before this, the branch returned `RekeyedElsewhere` and nothing else — so
/// the peer locked, the user unlocked, the OLD local meta re-derived the OLD
/// root, and the next cycle met the same head. A loop with no exit, on the
/// one path whose entire job is to move a peer onto the new generation.
///
/// Hermetic: the head is authored under one root and the cycle runs under
/// another, which is exactly the MAC failure a re-key produces — no server,
/// no live migration.
#[test]
fn the_rekey_path_stages_the_servers_meta_on_its_way_out() {
    let dir = std::env::temp_dir().join(format!(
        "myne-orch-stage-{}-{:p}",
        std::process::id(),
        &"stage"
    ));
    std::fs::create_dir_all(dir.join("notes")).unwrap();

    // A v0.1 meta locally; a v0.2 meta on the server. Only a migration
    // produces that pairing, and it is what `server_meta_of_newer_generation`
    // keys off.
    let local_v0_1 = protocol::serialize_vault_meta(&meta_fixture()).to_vec();
    std::fs::write(dir.join("vault.meta"), &local_v0_1).unwrap();
    let server_v0_2 = protocol::serialize_vault_meta_v0_2(&meta_fixture()).to_vec();

    // The head is sealed under a DIFFERENT root than the cycle runs with, so
    // it fails its MAC verify — the peer-side signature of a re-key.
    let authored_under = [0xC1u8; 32];
    let running_under = [0xC2u8; 32];
    let account_hash = [0x33u8; 16];
    let head = sealed_head_fragment(&authored_under, account_hash);

    let t = FakeTransport::new();
    t.on(
        HttpMethod::Get,
        "/sync/pull?cursor=0",
        200,
        pull_body_with_head("", 0, &head),
    );
    t.on(HttpMethod::Get, "/vault.meta", 200, server_v0_2.clone());

    let err = run_cycle_legacy(
        &t,
        &running_under,
        account_hash,
        [0xA1; 16],
        "tok",
        &dir.join("notes"),
        &dir,
        true,
    )
    .expect_err("an unopenable head over a newer generation is RekeyedElsewhere");
    assert!(
        matches!(err, SyncCycleError::RekeyedElsewhere),
        "expected RekeyedElsewhere, got {err:?}"
    );

    // `vault.meta` is UNTOUCHED — asserted FIRST, deliberately. Staging is
    // not adopting: this device cannot verify these bytes, and overwriting
    // the only local copy of the wrapped root_key on a server's say-so is
    // the hole staging exists to avoid. Checked before the staged file so
    // that "adopted instead of staged" fails on the assertion that NAMES it,
    // rather than incidentally on a missing staging file.
    assert_eq!(
        std::fs::read(dir.join("vault.meta")).unwrap(),
        local_v0_1,
        "the re-key path overwrote vault.meta with unverified server bytes"
    );
    // …and the bytes are staged for the unlock path to prove.
    let staged = std::fs::read(dir.join("vault.meta.incoming"))
        .expect("the server's newer meta must be staged, or the peer has no way forward");
    assert_eq!(staged, server_v0_2);

    std::fs::remove_dir_all(&dir).ok();
}

/// A `vault.meta` fixture whose fields are irrelevant to the test — only its
/// GENERATION matters, and that comes from which serializer stamps it.
fn meta_fixture() -> protocol::VaultMeta {
    protocol::VaultMeta {
        account_number_hash: [0x33; 16],
        kdf_params: protocol::DEFAULT_V0_1_KDF_PARAMS,
        random_salt_password: [0x11; protocol::VAULT_META_SALT_RANDOM_LEN],
        random_salt_recovery: [0x22; protocol::VAULT_META_SALT_RANDOM_LEN],
        nonce_password_wrap: [0x33; protocol::VAULT_META_NONCE_LEN],
        enc_root_key_password: [0x44; protocol::VAULT_META_WRAPPED_ROOT_KEY_LEN],
        nonce_recovery_wrap: [0x55; protocol::VAULT_META_NONCE_LEN],
        enc_root_key_recovery: [0x66; protocol::VAULT_META_WRAPPED_ROOT_KEY_LEN],
        items_key_id: [0x07; protocol::VAULT_META_ITEMS_KEY_ID_LEN],
        items_key_nonce: [0x08; protocol::VAULT_META_NONCE_LEN],
        enc_items_key: [0x09; protocol::VAULT_META_WRAPPED_ITEMS_KEY_LEN],
        membership: None,
        person_binding: None,
    }
}

// -----------------------------------------------------------------------
// Orphan-tombstone reclaim (`sync-protocol.md` §5.6.1, myne-md/myne#443)
// -----------------------------------------------------------------------

/// Records every `/sync/push` body and answers each with a caller-supplied
/// verdict, so the drain's triage is exercised with no server at all.
use super::super::state::OrphanTombstone;

struct ScriptedPush {
    bodies: std::sync::Mutex<Vec<String>>,
    verdict: Box<dyn Fn() -> Result<TransportResponse, TransportError> + Send + Sync>,
}
impl ScriptedPush {
    fn new(
        verdict: impl Fn() -> Result<TransportResponse, TransportError> + Send + Sync + 'static,
    ) -> Self {
        Self {
            bodies: std::sync::Mutex::new(Vec::new()),
            verdict: Box::new(verdict),
        }
    }
    fn bodies(&self) -> Vec<String> {
        self.bodies.lock().unwrap().clone()
    }
}
impl SyncTransport for ScriptedPush {
    fn request(
        &self,
        _method: HttpMethod,
        path: &str,
        body: &[u8],
        _token: Option<&str>,
    ) -> Result<TransportResponse, TransportError> {
        assert_eq!(
            path, "/sync/push",
            "the drain must not call any other route"
        );
        self.bodies
            .lock()
            .unwrap()
            .push(String::from_utf8_lossy(body).into_owned());
        (self.verdict)()
    }
}

fn ok_push(results: &[(&str, u64)]) -> Result<TransportResponse, TransportError> {
    let rows: Vec<String> = results
        .iter()
        .map(|(id, v)| format!(r#"{{"blob_id_hex":"{id}","version":{v}}}"#))
        .collect();
    Ok(TransportResponse {
        status: 200,
        body: format!(r#"{{"results":[{}]}}"#, rows.join(",")).into_bytes(),
    })
}

fn queued_state(ids: &[(&str, u64)]) -> SyncState {
    SyncState {
        pending_orphan_tombstones: ids
            .iter()
            .map(|(id, v)| OrphanTombstone {
                blob_id_hex: (*id).to_string(),
                base_version: *v,
                content_nonce_hex: "ab".repeat(24),
            })
            .collect(),
        ..SyncState::default()
    }
}

/// The reclaim itself: one request, every queued id in it, each marked
/// `tombstone` with an EMPTY body and the base version the migration
/// recorded — and the queue empty afterwards, so the next cycle does not
/// re-flag records the server already marked.
#[test]
fn orphan_tombstones_are_pushed_as_empty_deletions_and_leave_the_queue() {
    let ids = ["11".repeat(16), "22".repeat(16)];
    let t = ScriptedPush::new(move || ok_push(&[("11".repeat(16).as_str(), 8)]));
    let mut state = queued_state(&[(&ids[0], 7), (&ids[1], 3)]);

    let n = blocking(drain_orphan_tombstones(&t, "tok", &mut state));

    let bodies = t.bodies();
    assert_eq!(bodies.len(), 1, "one request, not one per id: {bodies:?}");
    let body = &bodies[0];
    for id in &ids {
        assert!(body.contains(id.as_str()), "{id} missing from {body}");
    }
    assert!(body.contains(r#""base_version":7"#), "{body}");
    assert!(body.contains(r#""base_version":3"#), "{body}");
    assert!(body.contains(r#""tombstone":true"#), "{body}");
    // Empty ciphertext — a tombstone carries no body. Base64 of "" is "".
    assert!(body.contains(r#""ciphertext_b64":"""#), "{body}");
    // No head rides this request: it is a cleanup errand, and advancing the
    // head from here would put a CAS the cycle already performed at risk.
    assert!(!body.contains("new_head"), "{body}");
    assert_eq!(n, 1, "the count comes from the server's results");
    assert!(
        state.pending_orphan_tombstones.is_empty(),
        "a landed reclaim must leave the queue"
    );
}

/// A lost CAS is abandoned, not retried (#443).
///
/// The version came from a baseline recorded before the migration, and a
/// peer that wrote to the same old id while this device was offline makes it
/// stale. The server returns no current version with its 409, so there is
/// nothing to retry WITH — a kept entry would buy one useless request per
/// cycle, forever, to reclaim three blobs.
#[test]
fn an_orphan_tombstone_that_lost_its_cas_is_abandoned_rather_than_retried_forever() {
    let t = ScriptedPush::new(|| {
        Ok(TransportResponse {
            status: 409,
            body: br#"{"error_code":"blob_stale"}"#.to_vec(),
        })
    });
    let mut state = queued_state(&[(&"33".repeat(16), 7)]);

    let n = blocking(drain_orphan_tombstones(&t, "tok", &mut state));

    assert_eq!(n, 0);
    assert!(
        state.pending_orphan_tombstones.is_empty(),
        "a structurally-refused reclaim must be dropped; the blobs stay \
             stranded, which is exactly the pre-#443 state"
    );
}

/// A transport failure says nothing about the request — keep it queued.
///
/// The distinction matters: abandoning on a flaky network would throw the
/// reclaim away for a reason that will be gone in thirty seconds.
#[test]
fn a_transport_failure_keeps_the_orphan_tombstones_queued() {
    let t = ScriptedPush::new(|| Err(TransportError::Network));
    let mut state = queued_state(&[(&"44".repeat(16), 2)]);

    let n = blocking(drain_orphan_tombstones(&t, "tok", &mut state));

    assert_eq!(n, 0);
    assert_eq!(
        state.pending_orphan_tombstones.len(),
        1,
        "a network error must not spend the reclaim"
    );
}

/// An empty queue costs nothing — no request at all, so an ordinary cycle
/// on a vault that never migrated is byte-identical to before.
#[test]
fn an_empty_orphan_queue_issues_no_request() {
    let t = ScriptedPush::new(|| unreachable!("no request may be made"));
    let mut state = SyncState::default();
    assert_eq!(blocking(drain_orphan_tombstones(&t, "tok", &mut state)), 0);
    assert!(t.bodies().is_empty());
}

/// The wedge property, against the REAL server (#443).
///
/// A queued reclaim whose base version is wrong produces a genuine 409 from
/// the real store — no decorator, no simulated status. The cycle must still
/// succeed and the user's note must still land. Had the tombstones ridden
/// the content chunk, that 409 would fail the whole push, the cycle would
/// retry, fail again, and every future push would wedge behind a
/// storage-cleanup errand the user never asked for.
#[test]
fn a_refused_orphan_reclaim_does_not_cost_the_cycle_its_push() {
    let Some((_guard, url)) = spawn_server() else {
        eprintln!("SKIP a_refused_orphan_reclaim_...: myne-server unavailable");
        return;
    };
    let root_key = [0x71u8; 32];
    let account_hash = [0x72u8; 16];
    let secret = derive_subkey(&root_key, SubkeyRole::ServerAuth);
    let items_key = [0x73u8; 32];
    let items_key_id = [0x74u8; 16];

    let dir = std::env::temp_dir().join(format!("myne-orch-orphan-{}", std::process::id()));
    let notes = dir.join("notes");
    std::fs::create_dir_all(&notes).unwrap();
    let note = NoteId::new_v7();
    let blob = encode_new_note(
        &items_key,
        &items_key_id,
        note.as_uuid().as_bytes(),
        b"this note must land anyway",
    )
    .unwrap();
    crate::atomic_write::atomic_write(&notes.join(format!("{}.myn", note.as_uuid())), &blob, false)
        .unwrap();

    let t = crate::plugins::sync::http_transport::build_transport(&url).unwrap();
    enroll::register_verifier(t.as_ref(), &account_hash, secret.as_slice()).unwrap();
    let dev = enroll::generate_device_id();
    let out = enroll::enroll(
        t.as_ref(),
        &account_hash,
        secret.as_slice(),
        EnrollPath::Recovery,
        "c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2",
        dev,
    )
    .unwrap();
    let tok = hex32(&out.token);

    // A reclaim the server cannot honour: the id has no blob, so its
    // current version is 0 and a base of 7 is a real CAS mismatch.
    let orphan = "9f".repeat(16);
    let mut seeded = read_sync_state(&dir).unwrap();
    seeded.device_id_hex = Some(hex(&dev));
    seeded.account_hash_hex = Some(hex(&account_hash));
    seeded.pending_orphan_tombstones = vec![OrphanTombstone {
        blob_id_hex: orphan.clone(),
        base_version: 7,
        content_nonce_hex: "ab".repeat(24),
    }];
    write_sync_state(&dir, &seeded).unwrap();

    let summary = run_cycle_legacy(
        t.as_ref(),
        &root_key,
        account_hash,
        dev,
        &tok,
        &notes,
        &dir,
        true,
    )
    .expect("a refused reclaim must not fail the cycle");
    assert!(
        summary.pushed >= 1,
        "the user's note must still have been pushed, got {summary:?}"
    );

    let after = read_sync_state(&dir).unwrap();
    assert!(
        after.pending_orphan_tombstones.is_empty(),
        "the refused reclaim must be abandoned rather than left to re-fail \
             on every future cycle"
    );
    assert!(
        after.blobs.contains_key(&hex(note.as_uuid().as_bytes())),
        "the note's CAS baseline must have been recorded"
    );

    std::fs::remove_dir_all(&dir).ok();
}

/// The structural half (#443): the reclaim queue has exactly ONE reader.
///
/// `drain_orphan_tombstones` cannot fail a cycle — it returns `usize`, not
/// `Result`, so there is no error to propagate and the guarantee is the
/// signature rather than a test. What a signature cannot hold is someone
/// later folding these entries into `to_push` "to save a request", which
/// silently restores the wedge every assertion above exists to prevent.
#[test]
fn the_orphan_reclaim_queue_is_read_in_exactly_one_place() {
    let src = include_str!("orchestrator.rs");
    let production = &src[..src.find("#[cfg(test)]").expect("test module")];
    // Compared by POSITION, not by text. The first draft asked whether each
    // matching LINE also appeared inside the drain, and a read folded into
    // the push loop passed it — because the line injected there was a copy
    // of one already in the drain, so the function was being compared
    // against itself. That is the shape this repo keeps rediscovering, and
    // a byte range is the fix: a site either falls inside the function or
    // it does not.
    let start = production
        .find("async fn drain_orphan_tombstones")
        .expect("the drain function");
    let end = start
        + production[start..]
            .find("\n}\n")
            .map(|i| i + 3)
            .expect("the drain function ends");

    let mut sites = 0usize;
    let mut cursor = 0usize;
    while let Some(i) = production[cursor..].find("pending_orphan_tombstones") {
        let at = cursor + i;
        assert!(
            at >= start && at < end,
            "the reclaim queue is read outside `drain_orphan_tombstones` \
                 (byte {at}, function spans {start}..{end}) — folding these \
                 into the content push restores the 409 wedge"
        );
        sites += 1;
        cursor = at + 1;
    }
    // Not pinned to an exact count: refactoring the drain's internals is
    // nobody's regression. The lower bound is what keeps the test from
    // passing vacuously if the field is renamed and nothing matches at all.
    assert!(
        sites >= 2,
        "expected at least the emptiness check and the iteration; a search \
             that matches nothing asserts nothing"
    );
}

/// Answers `POST /sync/blobs` with a chosen status (404/405) while relaying
/// everything else, modelling a server that predates the route.
struct RouteAbsentTransport {
    inner: Box<dyn SyncTransport>,
    status: u16,
}
impl SyncTransport for RouteAbsentTransport {
    fn request(
        &self,
        method: HttpMethod,
        path: &str,
        body: &[u8],
        token: Option<&str>,
    ) -> Result<TransportResponse, TransportError> {
        if path == BLOB_BATCH_PATH {
            return Ok(TransportResponse {
                status: self.status,
                body: b"{}".to_vec(),
            });
        }
        self.inner.request(method, path, body, token)
    }
}
mod ntv6_epoch {
    //! The `NTV6` epoch merge read path (myne-md/myne#711 task 13).
    use super::super::*;
    use super::{blocking, IO};
    use crate::plugins::sync::state::{mark_vault_meta_dirty, SyncState};
    use crate::plugins::sync::transport::{FakeTransport, HttpMethod};
    use crate::vault_io::VaultIo as _;

    /// A structurally valid `NTV6` `vault.meta` at `epoch`: the group-key
    /// wrap, the items-key wrap and the sealed roster are built exactly as a
    /// migration/seal does, so `parse_vault_meta_ntv6` accepts it.
    fn ntv6_meta_bytes(epoch: u64) -> Vec<u8> {
        let root_key = [7u8; 32];
        let items_key = [9u8; 32];
        let group_key_bytes = [11u8; 32];
        let account_hash = [0x33u8; 16];
        let items_key_id = [0x07u8; 16];
        let mut base = protocol::parse_vault_meta_v0_2(
            &protocol::encode_vault_meta_v0_2_raw(
                &root_key,
                &items_key,
                &items_key_id,
                "pw",
                "abandon abandon abandon",
                &account_hash,
                &protocol::DEFAULT_V0_1_KDF_PARAMS,
                &[2u8; protocol::ARGON2_SALT_LEN],
                &[4u8; protocol::ARGON2_SALT_LEN],
                &[5u8; protocol::AEAD_NONCE_LEN],
                &[6u8; protocol::AEAD_NONCE_LEN],
                &[8u8; protocol::AEAD_NONCE_LEN],
            )
            .expect("encode NTV5 base"),
        )
        .expect("parse NTV5 base");
        let group_key = protocol::GroupKey::new(group_key_bytes);
        let group_nonce = [12u8; protocol::AEAD_NONCE_LEN];
        let items_nonce = [13u8; protocol::AEAD_NONCE_LEN];
        let enc_group = protocol::aead_seal_ctx(
            &protocol::derive_owner_subkey_v0_2(
                &protocol::OwnerKey::new(root_key),
                protocol::OwnerRole::GroupKeyWrap,
            ),
            &group_nonce,
            &group_key_bytes,
            &protocol::aad_vault_group_key_wrap_v0_2(&account_hash, epoch),
        )
        .expect("seal group key");
        let enc_items = protocol::aead_seal_ctx(
            &protocol::derive_group_subkey_v0_2(&group_key, protocol::GroupRole::ItemsKeyWrap),
            &items_nonce,
            &items_key,
            &protocol::aad_vault_items_key_wrap_v0_2(&items_key_id),
        )
        .expect("seal items key");
        base.items_key_nonce = items_nonce;
        base.enc_items_key.copy_from_slice(&enc_items);
        let signed_roster_envelope = protocol::person_invite::seal_group_roster(
            &group_key_bytes,
            &account_hash,
            epoch,
            &[0xE6; protocol::AEAD_NONCE_LEN],
            &protocol::person_invite::SignedGroupRoster {
                payload: vec![0xC3; 32],
                signature: protocol::person_key::PersonSigned {
                    ed25519_sig: [0xD4; protocol::person_key::PERSON_ED25519_SIG_LEN],
                    mldsa_sig: vec![0xE5; protocol::person_key::PERSON_MLDSA_SIG_LEN],
                },
            },
        )
        .expect("seal roster envelope");
        protocol::serialize_vault_meta_ntv6(&protocol::B2bVaultMeta {
            base,
            group_key_nonce: group_nonce,
            enc_group_key: enc_group.try_into().expect("fixed group-key wrap"),
            group_key_epoch: epoch,
            signed_roster_envelope,
        })
        .expect("serialize NTV6")
    }

    /// A structurally valid `NTV5` (v0.2, pre-B2B) `vault.meta`, the shape the
    /// server still holds after an owner migrated locally but never pushed.
    fn ntv5_meta_bytes() -> Vec<u8> {
        protocol::encode_vault_meta_v0_2_raw(
            &[7u8; 32],
            &[9u8; 32],
            &[0x07u8; 16],
            "pw",
            "abandon abandon abandon",
            &[0x33u8; 16],
            &protocol::DEFAULT_V0_1_KDF_PARAMS,
            &[2u8; protocol::ARGON2_SALT_LEN],
            &[4u8; protocol::ARGON2_SALT_LEN],
            &[5u8; protocol::AEAD_NONCE_LEN],
            &[6u8; protocol::AEAD_NONCE_LEN],
            &[8u8; protocol::AEAD_NONCE_LEN],
        )
        .expect("encode NTV5")
        .to_vec()
    }

    fn scratch(tag: &str) -> crate::test_support::ScopedTempDir {
        crate::test_support::ScopedTempDir::new(tag).expect("temp dir")
    }

    async fn read_local(tmp: &crate::test_support::ScopedTempDir) -> Vec<u8> {
        IO.read(&tmp.path().join("vault.meta")).await.unwrap()
    }

    async fn seeded(tag: &str, local: &[u8]) -> (crate::test_support::ScopedTempDir, SyncState) {
        let tmp = scratch(tag);
        IO.write(
            &tmp.path().join("vault.meta"),
            local,
            crate::vault_io::WriteOpts::default(),
        )
        .await
        .unwrap();
        let st = SyncState {
            // Baseline == the local bytes → "only the server changed".
            meta_baseline_hex: Some(super::super::sha256_hex(local)),
            ..SyncState::default()
        };
        (tmp, st)
    }

    #[test]
    fn a_strictly_greater_epoch_is_adopted_and_clears_baselines() {
        blocking(async {
            let local = ntv6_meta_bytes(1);
            let server = ntv6_meta_bytes(2);
            let (dir, mut st) = seeded("adopt", &local).await;
            st.blobs.insert(
                "aa".repeat(16),
                crate::plugins::sync::state::BlobSyncState {
                    version: 1,
                    content_nonce_hex: "bb".repeat(24),
                    doc_heads_hex: Vec::new(),
                },
            );
            let t = FakeTransport::new();
            t.on(HttpMethod::Get, "/vault.meta", 200, server.clone());
            let out =
                sync_meta_phase(&IO, &t, "tok", dir.path(), &mut st, false, Some(&[7u8; 32])).await;
            assert_eq!(out, MetaPhaseOutcome::Adopted);
            assert_eq!(
                read_local(&dir).await,
                server,
                "server bytes written verbatim"
            );
            assert!(st.blobs.is_empty(), "M1 refresh cleared the baselines");
            assert_eq!(
                st.meta_baseline_hex.as_deref(),
                Some(super::super::sha256_hex(&server).as_str())
            );
        });
    }

    #[test]
    fn a_lower_epoch_is_refused_as_a_rollback() {
        blocking(async {
            let local = ntv6_meta_bytes(2);
            let server = ntv6_meta_bytes(1);
            let (dir, mut st) = seeded("rollback", &local).await;
            let t = FakeTransport::new();
            t.on(HttpMethod::Get, "/vault.meta", 200, server);
            let out =
                sync_meta_phase(&IO, &t, "tok", dir.path(), &mut st, false, Some(&[7u8; 32])).await;
            assert_eq!(out, MetaPhaseOutcome::Skipped);
            assert_eq!(
                read_local(&dir).await,
                local,
                "a rollback must not regress the meta"
            );
        });
    }

    #[test]
    fn a_member_device_adopts_but_never_pushes() {
        blocking(async {
            // Local epoch 1 differs from the server's equal-epoch copy and is
            // dirty; the server is unchanged since our baseline. A MEMBER
            // (root_key None) must NOT push; an OWNER pushes.
            let server = ntv6_meta_bytes(1);
            let local = ntv6_meta_bytes(1);
            let (dir, mut st) = seeded("member", &local).await;
            st.meta_baseline_hex = Some(super::super::sha256_hex(&server));
            mark_vault_meta_dirty(&IO, dir.path()).await.unwrap();
            let t = FakeTransport::new();
            t.on(HttpMethod::Get, "/vault.meta", 200, server);
            t.on(HttpMethod::Put, "/vault.meta", 200, b"{}".to_vec());
            let member = sync_meta_phase(&IO, &t, "tok", dir.path(), &mut st, false, None).await;
            assert_eq!(member, MetaPhaseOutcome::NoChange);
            assert!(
                !t.requests()
                    .iter()
                    .any(|r| r.1 == "/vault.meta" && r.0 == HttpMethod::Put),
                "a member must never write vault.meta"
            );
        });
    }

    // myne-md/myne#797: a member CANNOT verify a `vault.meta` epoch itself (it
    // holds no root key), so a strictly-greater server epoch must be HELD, not
    // written. Writing it unverified is irreversible: the genuine lower epoch
    // is refused as a rollback afterwards: so a hostile server that mints a
    // high epoch could wedge the member out of its own vault. The commit is
    // `member_adopt_rotation_from_host`'s, and only after the member's own
    // delivered package opens at that exact epoch against the pinned owner.
    #[test]
    fn a_member_holds_a_strictly_greater_epoch_until_its_package_verifies() {
        blocking(async {
            let local = ntv6_meta_bytes(1);
            let server = ntv6_meta_bytes(2);
            let (dir, mut st) = seeded("member-epoch-hold", &local).await;
            let t = FakeTransport::new();
            t.on(HttpMethod::Get, "/vault.meta", 200, server);
            let out = sync_meta_phase(&IO, &t, "tok", dir.path(), &mut st, false, None).await;
            assert_eq!(
                out,
                MetaPhaseOutcome::Skipped,
                "a member must not commit an unverified epoch"
            );
            assert_eq!(
                read_local(&dir).await,
                local,
                "the minted epoch must NOT be written"
            );
            assert!(
                !t.requests()
                    .iter()
                    .any(|r| r.1 == "/vault.meta" && r.0 == HttpMethod::Put),
                "and nothing is pushed either"
            );
        });
    }

    // myne-md/myne#795: after the owner migrates NTV5->NTV6 locally, the server
    // still holds the NTV5 copy (the migration never pushes). The meta phase
    // must PUBLISH the local NTV6 generation, not skip it, or a member's accept
    // fetches NTV5 and dies at parse forever.
    #[test]
    fn a_one_sided_local_ntv6_is_pushed_and_never_adopts_the_server_ntv5() {
        blocking(async {
            let local = ntv6_meta_bytes(1);
            let server = ntv5_meta_bytes();
            let (dir, mut st) = seeded("gen-push", &local).await;
            mark_vault_meta_dirty(&IO, dir.path()).await.unwrap();
            let t = FakeTransport::new();
            t.on(HttpMethod::Get, "/vault.meta", 200, server);
            t.on(HttpMethod::Put, "/vault.meta", 200, b"{}".to_vec());
            let out =
                sync_meta_phase(&IO, &t, "tok", dir.path(), &mut st, false, Some(&[7u8; 32])).await;
            assert_eq!(out, MetaPhaseOutcome::Pushed);
            assert!(
                t.requests()
                    .iter()
                    .any(|r| r.0 == HttpMethod::Put && r.1 == "/vault.meta"),
                "the migrated NTV6 meta must be PUT to the server"
            );
            assert_eq!(
                read_local(&dir).await,
                local,
                "the local NTV6 meta must not be overwritten by the server's NTV5"
            );
            assert_eq!(
                st.meta_baseline_hex.as_deref(),
                Some(super::super::sha256_hex(&local).as_str())
            );
        });
    }

    // A member never holds `root_key`, so it can never have migrated; it must
    // not push when it somehow sees a one-sided local NTV6.
    #[test]
    fn a_one_sided_local_ntv6_is_not_pushed_by_a_member() {
        blocking(async {
            let local = ntv6_meta_bytes(1);
            let server = ntv5_meta_bytes();
            let (dir, mut st) = seeded("gen-member", &local).await;
            mark_vault_meta_dirty(&IO, dir.path()).await.unwrap();
            let t = FakeTransport::new();
            t.on(HttpMethod::Get, "/vault.meta", 200, server);
            t.on(HttpMethod::Put, "/vault.meta", 200, b"{}".to_vec());
            let out = sync_meta_phase(&IO, &t, "tok", dir.path(), &mut st, false, None).await;
            assert_eq!(out, MetaPhaseOutcome::Skipped);
            assert!(
                !t.requests()
                    .iter()
                    .any(|r| r.0 == HttpMethod::Put && r.1 == "/vault.meta"),
                "a member must never push vault.meta"
            );
        });
    }
}
