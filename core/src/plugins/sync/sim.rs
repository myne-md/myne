//! Multi-device sync **simulation harness** (Phase 1 of the sync test-env work).
//!
//! **KNOWN GAP, whole-harness: every scenario here is a v0.1 vault.** Not just
//! the two `MetaVersion::V0_1` literals below, but every version-less v0.1-only
//! helper this file reaches for (`encode_new_note`, `encode_prefs_blob`,
//! `derive_subkey`, `encode_themes_map`). A vault created today is v0.2
//! throughout (`protocol.md` §10.3.1), so this harness exercises the generation
//! nobody runs. It is not widened because `Device` builds its notes through
//! those v0.1-only free functions, and a device claiming a generation its notes
//! do not honour would be worse than an honest v0.1 one. What that leaves
//! uncovered here is covered in `orchestrator::tests` instead: four
//! `_on_a_migrated_vault` attachment scenarios, `a_migrated_vault_keeps_its_myp5_prefs…`
//! and `a_migrated_vault_still_pushes_its_myt5_theme_store`. Until this harness
//! is widened, a v0.2 behaviour proven nowhere else does not get to claim this
//! file as its coverage (myne-md/myne#638).
//!
//! WHY THIS EXISTS. The pre-existing two-device tests (`orchestrator.rs` tests,
//! `e2e/sync-replication.e2e.ts`) feed the engine its *idealized* inputs — a
//! direct `note_update`, the *correct* `deleted:`-marker tombstone encoding — and
//! assert "the mechanism works". They never drive the operations the user
//! actually performs through the UI (the editor's autosave-on-reload, the Trash
//! panel's *Empty trash* button), so whole classes of bug live in that bypassed
//! layer and escape every green test.
//!
//! This harness drives **faithful client-op encodings** (including the buggy
//! ones — `empty_trash_buggy` mirrors `emptyTrash → noteDelete` bare-unlink;
//! `autosave_resave` mirrors `reloadOpenNote → useAutosave` re-writing an open
//! note with a fresh nonce on an incoming sync) against a REAL `myne-server`
//! over loopback, then asserts **end-state invariants** instead of per-mechanism
//! contracts:
//!
//! - **Convergence** — after every device syncs to quiescence, all devices hold
//!   the identical note set (same plaintext per id; an emptied note absent
//!   everywhere).
//! - **No false conflict** — a note only one device semantically edited never
//!   lands in another device's keep-both conflict staging.
//!
//! These tests originally reproduced bugs 1, 2 & 3 as RED `#[ignore]`d cases;
//! the client-side fixes have landed (`emptyTrash → deleteNoteRouted`;
//! `useAutosave.acceptReloadedBody` so a sync reload no longer re-dirties a clean
//! open note), so the modeled ops now mirror the fixed behavior and the cases
//! are GREEN regression gates. The `#[ignore]`d SOAK fuzz is opt-in for time, not
//! a known bug. The harness self-skips when the `myne-server` binary isn't built
//! — same posture as the other server-backed tests (build: `cd myne-server &&
//! go build -o myne-server ./cmd/myne-server`, or set `MYNE_E2E_SERVER`).

#![cfg(test)]

use std::collections::BTreeSet;
use std::path::PathBuf;
use std::process::Child;

use protocol::{decode_note, derive_subkey, encode_new_note, SubkeyRole};

use crate::plugins::notes::note_id::NoteId;
use crate::plugins::sync::enroll::{self, EnrollPath};
use crate::plugins::sync::orchestrator::{
    add_pending_tombstone, list_pending_conflicts, read_staged_conflict_blob, resolve_conflict,
    run_sync_cycle, SyncSummary,
};
use crate::plugins::sync::transport::SyncTransport;

// ---------------------------------------------------------------------------
// Server lifecycle (self-contained copy of the orchestrator-test spawn logic).
// ---------------------------------------------------------------------------

/// Kills the spawned server on drop so a panicking assert never leaks it.
struct ServerGuard(Child);
impl ServerGuard {
    /// Kill the server NOW without dropping the guard binding — the crash /
    /// restart scenarios kill mid-test and later respawn on the same port.
    fn kill_now(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}
impl Drop for ServerGuard {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

/// Resolve the `myne-server` binary, or `None` when it is not built.
///
/// Gated exactly like `orchestrator.rs`'s twin, and for the same reason: a
/// caller that self-skips reports `ok`, so these tests were green everywhere
/// the binary was absent. See `super::test_fixtures` for the full account.
fn server_binary() -> Option<PathBuf> {
    let found = if let Ok(p) = std::env::var("MYNE_E2E_SERVER") {
        let p = PathBuf::from(p);
        p.exists().then_some(p)
    } else {
        // `cargo test` CWD = the crate dir; the server is a sibling.
        let p = PathBuf::from("../myne-server/myne-server");
        p.exists().then_some(p)
    };
    assert!(
        found.is_some() || !super::test_fixtures::required("MYNE_TEST_REQUIRE_SERVER"),
        "MYNE_TEST_REQUIRE_SERVER=1 (or MYNE_TEST_REQUIRE_FIXTURES=1) was set, but the \
         myne-server binary is not built — this run was asked to exercise the real server \
         and cannot. Build it with `cd myne-server && go build -o myne-server ./cmd/myne-server`, \
         or point MYNE_E2E_SERVER at one."
    );
    found
}

/// Server spawn options. `Default` = today's shape: ephemeral port, in-memory
/// store. `addr` pins a fixed listen address (a respawn re-binding the port a
/// killed instance used); `storage_dir` switches to the FSStore backend rooted
/// there (the production topology — state survives kill+respawn).
#[derive(Default)]
struct ServerOpts {
    addr: Option<String>,
    storage_dir: Option<PathBuf>,
    /// `(burst, refill)` for the per-account limiter. `None` keeps the lifted
    /// values every other scenario relies on; a scenario that is ABOUT the
    /// limiter sets the production defaults explicitly.
    rate_limit: Option<(u64, u64)>,
}

/// Spawn an ephemeral server; return (guard, base_url). Per-call unique
/// portfile dir so concurrent tests don't race. Rate limit is lifted — these
/// tests exercise sync correctness, not abuse throttling.
fn spawn_server_with(opts: &ServerOpts) -> Option<(ServerGuard, String)> {
    use std::sync::atomic::{AtomicU64, Ordering};
    static SEQ: AtomicU64 = AtomicU64::new(0);
    let bin = server_binary()?;
    let dir = std::env::temp_dir().join(format!(
        "myne-sim-srv-{}-{}",
        std::process::id(),
        SEQ.fetch_add(1, Ordering::Relaxed)
    ));
    std::fs::create_dir_all(&dir).ok()?;
    let portfile = dir.join("port");
    let _ = std::fs::remove_file(&portfile);
    let mut cmd = std::process::Command::new(&bin);
    cmd.env(
        "MYNE_SERVER_ADDR",
        opts.addr.as_deref().unwrap_or("127.0.0.1:0"),
    )
    .env("MYNE_SERVER_PORTFILE", &portfile);
    let (burst, refill) = opts
        .rate_limit
        .map(|(b, r)| (b.to_string(), r.to_string()))
        .unwrap_or_else(|| ("1000000".into(), "1000000".into()));
    cmd.env("MYNE_RATELIMIT_BURST", burst)
        .env("MYNE_RATELIMIT_REFILL", refill);
    if let Some(storage) = &opts.storage_dir {
        std::fs::create_dir_all(storage).ok()?;
        cmd.env("MYNE_STORAGE_BACKEND", "fs")
            .env("MYNE_STORAGE_PATH", storage);
    }
    let child = cmd
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()
        .ok()?;
    let guard = ServerGuard(child);
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
    while std::time::Instant::now() < deadline {
        if std::net::TcpStream::connect(("127.0.0.1", port)).is_ok() {
            break;
        }
        std::thread::sleep(std::time::Duration::from_millis(40));
    }
    Some((guard, format!("http://127.0.0.1:{port}")))
}

/// Spawn an ephemeral in-memory server (the default shape).
fn spawn_server() -> Option<(ServerGuard, String)> {
    spawn_server_with(&ServerOpts::default())
}

/// Skip-or-run gate: returns the spawned server, or prints a skip line and
/// `None` so the caller `return`s (the established self-skip pattern).
macro_rules! server_or_skip {
    ($name:literal) => {
        match spawn_server() {
            Some(v) => v,
            None => {
                eprintln!(concat!(
                    "SKIP ",
                    $name,
                    ": myne-server binary not found ",
                    "(cd myne-server && go build -o myne-server ./cmd/myne-server)"
                ));
                return;
            }
        }
    };
}

use super::to_hex as hex;

/// Parse a 32-hex note id back to its 16 raw bytes (the inverse of `hex` over a
/// note id). `None` on a malformed id.
fn id_hex_to_bytes(h: &str) -> Option<[u8; 16]> {
    if h.len() != 32 {
        return None;
    }
    let mut out = [0u8; 16];
    for (i, slot) in out.iter_mut().enumerate() {
        *slot = u8::from_str_radix(&h[i * 2..i * 2 + 2], 16).ok()?;
    }
    Some(out)
}

// ---------------------------------------------------------------------------
// Account + virtual device model.
// ---------------------------------------------------------------------------

/// Account-level crypto shared by every device on the account.
#[derive(Clone)]
struct Account {
    root_key: [u8; 32],
    account_hash: [u8; 16],
    items_key: [u8; 32],
    items_key_id: [u8; 16],
}

impl Account {
    /// Deterministic per-test account (the byte seeds only need to be distinct
    /// across concurrently-running tests, not secret).
    fn new(seed: u8) -> Self {
        Account {
            root_key: [seed; 32],
            account_hash: [seed ^ 0x5a; 16],
            items_key: [seed ^ 0xa5; 32],
            items_key_id: [seed ^ 0x3c; 16],
        }
    }
    fn secret(&self) -> Vec<u8> {
        derive_subkey(&self.root_key, SubkeyRole::ServerAuth)
            .as_slice()
            .to_vec()
    }
}

/// One simulated device: a vault dir + an enrolled transport + the account
/// crypto. Its op surface mirrors the REAL client operations (including the
/// buggy ones) so the harness reproduces what the app actually does, not the
/// engine's idealized contract.
struct Device {
    label: &'static str,
    acct: Account,
    transport: Box<dyn SyncTransport>,
    device_id: [u8; 16],
    token: String,
    vault_dir: PathBuf,
    notes_dir: PathBuf,
}

impl Device {
    /// Enroll a fresh device on `acct`. `register` registers the SCRAM verifier
    /// (the first device on an account does this exactly once).
    fn enroll(label: &'static str, acct: &Account, url: &str, nonce: &str, register: bool) -> Self {
        let t = crate::plugins::sync::http_transport::build_transport(url, Vec::new()).unwrap();
        if register {
            enroll::register_verifier(t.as_ref(), &acct.account_hash, &acct.secret()).unwrap();
        }
        let device_id = enroll::generate_device_id();
        let out = enroll::enroll(
            t.as_ref(),
            &acct.account_hash,
            &acct.secret(),
            EnrollPath::Recovery,
            nonce,
            device_id,
        )
        .unwrap();
        assert!(out.approved && !out.token.is_empty(), "{label} enrolled");
        let vault_dir = std::env::temp_dir().join(format!(
            "myne-sim-{}-{}-{}",
            label,
            std::process::id(),
            hex(&device_id)
        ));
        let notes_dir = vault_dir.join("notes");
        std::fs::create_dir_all(&notes_dir).unwrap();
        Device {
            label,
            acct: acct.clone(),
            transport: t,
            device_id,
            token: hex(&out.token),
            vault_dir,
            notes_dir,
        }
    }

    fn blob_path(&self, id: &NoteId) -> PathBuf {
        self.notes_dir.join(format!("{}.myn", id.as_uuid()))
    }

    /// 32-hex id (no dashes) — the form the tombstone/conflict-staging surfaces use.
    fn id_hex(id: &NoteId) -> String {
        hex(id.as_uuid().as_bytes())
    }

    fn encode(&self, id: &NoteId, plaintext: &[u8]) -> Vec<u8> {
        let nb = *id.as_uuid().as_bytes();
        encode_new_note(
            &self.acct.items_key,
            &self.acct.items_key_id,
            &nb,
            plaintext,
        )
        .unwrap()
    }

    fn write_blob(&self, id: &NoteId, plaintext: &[u8], replace: bool) {
        let blob = self.encode(id, plaintext);
        crate::atomic_write::atomic_write(&self.blob_path(id), &blob, replace).unwrap();
    }

    // --- real client operations (faithful mirrors) ---

    /// `note_create`: a brand-new note.
    fn create_note(&self, plaintext: &[u8]) -> NoteId {
        let id = NoteId::new_v7();
        self.write_blob(&id, plaintext, false);
        id
    }

    /// `note_update`: a real user edit (fresh content → fresh nonce).
    fn edit_note(&self, id: &NoteId, plaintext: &[u8]) {
        self.write_blob(id, plaintext, true);
    }

    /// Mirrors the Bug-1 trigger: on an incoming sync the editor's
    /// `reloadOpenNote` re-reads the open note and `useAutosave` re-writes it
    /// with a FRESH nonce even though the user never typed — a *semantic no-op*
    /// the nonce-based engine cannot distinguish from a real concurrent edit.
    fn autosave_resave(&self, id: &NoteId) {
        if let Some(pt) = self.read_note(id) {
            self.write_blob(id, &pt, true);
        }
    }

    /// Mirrors the Bug-3 path: `emptyTrash → noteDelete` is a BARE hard-delete
    /// (`note_delete` unlink), NOT the sync-aware `deleteNoteRouted`. The
    /// tombstone flag is queued but never attaches (the blob is already gone
    /// from the local set), so the deletion never propagates.
    fn empty_trash_buggy(&self, id: &NoteId) {
        let _ = std::fs::remove_file(self.blob_path(id));
        let _ = crate::test_support::block_on(add_pending_tombstone(
            &crate::vault_io::StdVaultIo,
            &self.vault_dir,
            &Self::id_hex(id),
        ));
    }

    /// Move a note to the trash — a soft, recoverable state set by a `trashed:`
    /// marker. Like any content edit it propagates as a normal blob version.
    fn move_to_trash(&self, id: &NoteId) {
        if let Some(mut pt) = self.read_note(id) {
            pt.extend_from_slice(b"\ntrashed: true");
            self.write_blob(id, &pt, true);
        }
    }

    /// Mirrors the FIXED `emptyTrash` (sync Bug 3 fix): emptying the trash now
    /// routes through `deleteNoteRouted`, i.e. a propagating tombstone — identical
    /// to [`delete_routed`] at the blob level. (Pre-fix it was a bare unlink; see
    /// [`empty_trash_buggy`].)
    fn empty_trash(&self, id: &NoteId) {
        self.delete_routed(id);
    }

    /// Mirrors the CORRECT deletion (`deleteNoteRouted → tombstoneNote`): write a
    /// `deleted:` marker version (propagates as a normal edit) + queue the GC
    /// flag. The blob stays present-but-marked; it converges everywhere.
    fn delete_routed(&self, id: &NoteId) {
        if let Some(mut pt) = self.read_note(id) {
            pt.extend_from_slice(b"\ndeleted: 2026-06-21T00:00:00Z");
            self.write_blob(id, &pt, true);
            let _ = crate::test_support::block_on(add_pending_tombstone(
                &crate::vault_io::StdVaultIo,
                &self.vault_dir,
                &Self::id_hex(id),
            ));
        }
    }

    /// One full sync cycle (pull → detect → push), the wired engine loop.
    /// Attachment-aware (MYND-468): the sim vault mostly has no attachments, in
    /// which case the attachment phases are a cheap no-op scan.
    fn sync(&self) -> SyncSummary {
        self.try_sync().expect("sync cycle")
    }

    /// [`Device::sync`] without the panic-on-error — the fault-injection
    /// scenarios assert on the error shape instead.
    fn try_sync(&self) -> Result<SyncSummary, super::orchestrator::SyncCycleError> {
        // `run_sync_cycle` became `async` with task 86; the sim's scenarios are
        // synchronous by design (they drive a deterministic two-device timeline
        // step by step), so each cycle is driven on a runtime. The engine under
        // test is unchanged.
        crate::test_support::block_on(run_sync_cycle(
            &crate::vault_io::StdVaultIo,
            self.transport.as_ref(),
            Some(&self.acct.root_key),
            &crate::plugins::vault_unlock::state::SharedSingletonKey::OwnerRoot(
                zeroize::Zeroizing::new(self.acct.root_key),
            ),
            self.acct.account_hash,
            self.device_id,
            &self.token,
            &self.notes_dir,
            &self.vault_dir,
            crate::plugins::sync::orchestrator::PushGate::Allowed,
            // v0.1 throughout: see the whole-harness KNOWN GAP at the top of
            // this file (myne-md/myne#638).
            protocol::MetaVersion::V0_1,
            Some(super::orchestrator::AttachmentKeys {
                items_key: &self.acct.items_key,
                items_key_id: &self.acct.items_key_id,
            }),
            None,
        ))
    }

    fn read_note(&self, id: &NoteId) -> Option<Vec<u8>> {
        let nb = *id.as_uuid().as_bytes();
        let blob = std::fs::read(self.blob_path(id)).ok()?;
        Some(
            decode_note(&blob, &nb, &self.acct.items_key, &self.acct.items_key_id)
                .ok()?
                .plaintext()
                .to_vec(),
        )
    }

    // --- NC05 CRDT note operations (the automerge-sync-migration path) ---
    //
    // The same `.myn` on-disk slot as a `MY01` note, but the blob is an `NC05`
    // CRDT note; the sync cycle dispatches on the cleartext magic. The device_id
    // seeds the Automerge actor (device provenance, ASM-3), and `NoopHost` supplies
    // the change timestamp (deterministic for the sim; the value is immaterial).

    /// Create a brand-new `NC05` CRDT note (the post-migration note shape).
    fn create_crdt_note(&self, markdown: &str) -> NoteId {
        let id = NoteId::new_v7();
        let nb = *id.as_uuid().as_bytes();
        let blob = crate::plugins::notes::crdt::encode_note_blob(
            markdown,
            &self.acct.items_key,
            &self.acct.items_key_id,
            &nb,
            &self.device_id,
            &crate::host::NoopHost,
        )
        .expect("seal NC05 note");
        crate::atomic_write::atomic_write(&self.blob_path(&id), &blob, false).unwrap();
        id
    }

    /// Edit an existing `NC05` note in place — replaces the single `Text` while
    /// preserving change-graph ancestry, so a peer's concurrent edit still merges.
    fn edit_crdt_note(&self, id: &NoteId, markdown: &str) {
        let nb = *id.as_uuid().as_bytes();
        let existing = std::fs::read(self.blob_path(id)).expect("read NC05 blob");
        let upd = crate::plugins::notes::crdt::encode_note_edit(
            &existing,
            markdown,
            &self.acct.items_key,
            &self.acct.items_key_id,
            &nb,
            &crate::host::NoopHost,
        )
        .expect("edit NC05 note");
        crate::atomic_write::atomic_write(&self.blob_path(id), &upd.blob, true).unwrap();
    }

    /// Decode an `NC05` note to its markdown, or `None` if absent/undecodable.
    fn read_crdt_note(&self, id: &NoteId) -> Option<String> {
        let nb = *id.as_uuid().as_bytes();
        let blob = std::fs::read(self.blob_path(id)).ok()?;
        crate::plugins::notes::crdt::decode_note_blob(
            &blob,
            &nb,
            &self.acct.items_key,
            &self.acct.items_key_id,
        )
        .ok()
    }

    /// On-disk byte length of a note's `.myn` blob — for the history-growth
    /// assertion (a CRDT note's blob carries its full Automerge change-history, so
    /// it grows with edit count; #421 task 3).
    fn crdt_blob_len(&self, id: &NoteId) -> Option<u64> {
        std::fs::metadata(self.blob_path(id)).ok().map(|m| m.len())
    }

    /// The 32-hex ids of every `.myn` blob present in this device's vault.
    fn local_ids(&self) -> BTreeSet<String> {
        let mut out = BTreeSet::new();
        if let Ok(entries) = std::fs::read_dir(&self.notes_dir) {
            for e in entries.flatten() {
                let p = e.path();
                if p.extension().and_then(|x| x.to_str()) == Some("myn") {
                    if let Some(stem) = p.file_stem().and_then(|s| s.to_str()) {
                        if let Ok(u) = uuid::Uuid::parse_str(stem) {
                            out.insert(hex(u.as_bytes()));
                        }
                    }
                }
            }
        }
        out
    }

    fn pending_conflicts(&self) -> Vec<String> {
        crate::test_support::block_on(list_pending_conflicts(
            &crate::vault_io::StdVaultIo,
            &self.vault_dir,
        ))
    }

    /// Resolve EVERY staged conflict the way the frontend does: for each, keep
    /// the remote revision as a new "copy" note, then adopt it as baseline so the
    /// local edit pushes as a linear advance. Returns the copy ids created (so a
    /// convergence check can include them). The auto-resolve used by the
    /// multi-writer stress fuzz.
    fn resolve_all_conflicts(&self) -> Vec<NoteId> {
        let mut copies = Vec::new();
        for id_hex in self.pending_conflicts() {
            if let (Some(idb), Some(blob)) = (
                id_hex_to_bytes(&id_hex),
                crate::test_support::block_on(read_staged_conflict_blob(
                    &crate::vault_io::StdVaultIo,
                    &self.vault_dir,
                    &id_hex,
                )),
            ) {
                if let Ok(dec) =
                    decode_note(&blob, &idb, &self.acct.items_key, &self.acct.items_key_id)
                {
                    copies.push(self.create_note(dec.plaintext()));
                }
            }
            let _ = crate::test_support::block_on(resolve_conflict(
                &crate::vault_io::StdVaultIo,
                &self.vault_dir,
                &id_hex,
            ));
        }
        copies
    }

    /// Integrity: every `.myn` blob this device holds must still decrypt under
    /// the account keys (no AEAD-tag corruption, no truncated/half-written blob).
    fn assert_all_blobs_decrypt(&self) {
        if let Ok(entries) = std::fs::read_dir(&self.notes_dir) {
            for e in entries.flatten() {
                let p = e.path();
                if p.extension().and_then(|x| x.to_str()) != Some("myn") {
                    continue;
                }
                let stem = p.file_stem().and_then(|s| s.to_str()).unwrap_or("");
                let idb = uuid::Uuid::parse_str(stem)
                    .map(|u| *u.as_bytes())
                    .unwrap_or_else(|_| panic!("device {}: bad blob filename {stem}", self.label));
                let blob = std::fs::read(&p).expect("read blob");
                decode_note(&blob, &idb, &self.acct.items_key, &self.acct.items_key_id)
                    .unwrap_or_else(|_| {
                        panic!(
                            "device {}: blob {stem} failed to decrypt (corruption)",
                            self.label
                        )
                    });
            }
        }
    }

    /// Resolve a staged keep-both conflict (mirrors `sync_resolve_conflict`):
    /// adopt the staged remote revision's (version, nonce) as this device's
    /// baseline + clear the staging, so the untouched local edit pushes next as
    /// a clean linear advance.
    fn resolve_conflict(&self, id: &NoteId) {
        let _ = crate::test_support::block_on(resolve_conflict(
            &crate::vault_io::StdVaultIo,
            &self.vault_dir,
            &Self::id_hex(id),
        ));
    }

    /// Decrypt the remote revision staged as a keep-both conflict for `id`
    /// (the bytes the notes layer would turn into a "conflict copy"). `None` if
    /// nothing is staged for that note.
    fn read_staged_conflict(&self, id: &NoteId) -> Option<Vec<u8>> {
        let blob = crate::test_support::block_on(read_staged_conflict_blob(
            &crate::vault_io::StdVaultIo,
            &self.vault_dir,
            &Self::id_hex(id),
        ))?;
        let nb = *id.as_uuid().as_bytes();
        Some(
            decode_note(&blob, &nb, &self.acct.items_key, &self.acct.items_key_id)
                .ok()?
                .plaintext()
                .to_vec(),
        )
    }
}

impl Drop for Device {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.vault_dir);
    }
}

// ---------------------------------------------------------------------------
// Scenario helpers + invariants.
// ---------------------------------------------------------------------------

/// Enroll `count` devices on a fresh account against `url`.
fn enroll_devices(acct: &Account, url: &str, count: usize) -> Vec<Device> {
    const LABELS: [&str; 4] = ["A", "B", "C", "D"];
    (0..count)
        .map(|i| {
            // Distinct 32-hex enroll nonce per device.
            let nonce = hex(&[(0x10 + i as u8); 16]);
            Device::enroll(LABELS[i], acct, url, &nonce, i == 0)
        })
        .collect()
}

/// Sync every device round-robin until a full round makes no progress (nothing
/// pulled, pushed, or newly staged) — the system has reached quiescence — or
/// `max_rounds` is hit (a non-converging loop, which the invariant then flags).
fn quiesce(devices: &[Device], max_rounds: usize) {
    quiesce_reached(devices, max_rounds);
}

/// Like [`quiesce`] but returns `true` iff the system actually reached a no-
/// progress fixpoint within `max_rounds` (false = it was still churning — a
/// livelock signal the chaos fuzz asserts against).
fn quiesce_reached(devices: &[Device], max_rounds: usize) -> bool {
    for _ in 0..max_rounds {
        let mut progressed = false;
        for d in devices {
            let s = d.sync();
            if s.pulled > 0 || s.pushed > 0 || !s.conflicts.is_empty() {
                progressed = true;
            }
        }
        if !progressed {
            return true;
        }
    }
    false
}

/// Quiesce while AUTO-RESOLVING every staged conflict each round (the multi-
/// writer model: real concurrent edits stage keep-both copies, the "user"
/// resolves them, and the system must then converge). Returns the copy notes
/// created by resolution so a convergence check can include them.
fn quiesce_with_resolve(devices: &[Device], max_rounds: usize) -> Vec<NoteId> {
    let mut copies = Vec::new();
    for _ in 0..max_rounds {
        let mut progressed = false;
        for d in devices {
            let s = d.sync();
            if s.pulled > 0 || s.pushed > 0 || !s.conflicts.is_empty() {
                progressed = true;
            }
        }
        for d in devices {
            let made = d.resolve_all_conflicts();
            if !made.is_empty() {
                progressed = true;
                copies.extend(made);
            }
        }
        if !progressed {
            break;
        }
    }
    copies
}

/// Convergence over an explicit note set: every device must agree on each note's
/// plaintext (or agree it is absent). Returns a human description on mismatch.
fn assert_converged(devices: &[Device], notes: &[NoteId]) {
    for id in notes {
        let views: Vec<(&str, Option<Vec<u8>>)> =
            devices.iter().map(|d| (d.label, d.read_note(id))).collect();
        let first = &views[0].1;
        for (label, v) in &views[1..] {
            assert!(
                v == first,
                "DIVERGENCE on note {}: device {} has {:?} but device {} has {:?}",
                id.as_uuid(),
                views[0].0,
                first
                    .as_ref()
                    .map(|b| String::from_utf8_lossy(b).into_owned()),
                label,
                v.as_ref().map(|b| String::from_utf8_lossy(b).into_owned()),
            );
        }
    }
}

/// Every device holds the identical set of blob ids. A soft-deleted note
/// (`deleted:` marker) stays present-and-identical on ALL devices, so this holds
/// for the correct deletion path; a bare-unlink that vanishes on one device but
/// lingers on another breaks it.
fn assert_same_blob_sets(devices: &[Device]) {
    let first = devices[0].local_ids();
    for d in &devices[1..] {
        let s = d.local_ids();
        assert!(
            s == first,
            "BLOB-SET DIVERGENCE: device {} holds {:?} but device {} holds {:?}",
            devices[0].label,
            first,
            d.label,
            s,
        );
    }
}

/// No device carries a staged keep-both conflict.
fn assert_no_conflicts(devices: &[Device]) {
    for d in devices {
        let c = d.pending_conflicts();
        assert!(
            c.is_empty(),
            "FALSE CONFLICT: device {} staged keep-both copies {:?} with no genuine concurrent edit",
            d.label,
            c,
        );
    }
}

// ---------------------------------------------------------------------------
// GREEN tests — prove the harness itself works (these MUST pass today).
// ---------------------------------------------------------------------------

/// Sanity: a created note replicates and both devices converge. If this is RED
/// the harness is broken, not the engine.
#[test]
fn harness_self_check_replicates_and_converges() {
    let (_guard, url) = server_or_skip!("harness_self_check");
    let acct = Account::new(0x10);
    let devices = enroll_devices(&acct, &url, 2);

    let n = devices[0].create_note(b"shared note body");
    quiesce(&devices, 8);

    assert_converged(&devices, &[n]);
    assert_eq!(
        devices[1].read_note(&n).as_deref(),
        Some(&b"shared note body"[..]),
        "B received A's note"
    );
    assert_no_conflicts(&devices);
}

/// MYND-478 prefs sync end-to-end over a real server: a vault rename on A
/// reaches B's decrypted `vault.prefs` (shared field), while B's theme stays
/// B's own (device-local field never crosses the merge) — and the fleet
/// converges with no push ping-pong.
#[test]
fn prefs_rename_replicates_and_device_local_stays_local() {
    let (_guard, url) = server_or_skip!("prefs_rename");
    let acct = Account::new(0x77);
    let devices = enroll_devices(&acct, &url, 2);
    let prefs_key = derive_subkey(&acct.root_key, SubkeyRole::PrefsKey);

    let write_prefs = |d: &Device, view: &protocol::PrefsView| {
        let bytes = protocol::encode_prefs_blob(&prefs_key, &acct.account_hash, view).unwrap();
        std::fs::write(d.vault_dir.join("vault.prefs"), &bytes).unwrap();
    };
    let read_prefs = |d: &Device| -> protocol::PrefsView {
        let bytes = std::fs::read(d.vault_dir.join("vault.prefs")).unwrap();
        protocol::decode_prefs_blob(&prefs_key, &acct.account_hash, &bytes).unwrap()
    };

    // A renames the vault (a clocked shared edit); B holds a device-local
    // theme choice the sync must never overwrite.
    let mut a_view = protocol::PrefsView {
        label: Some(String::from("Renamed On A")),
        ..protocol::PrefsView::default()
    };
    a_view.field_clocks.insert(String::from("label"), 1_000);
    write_prefs(&devices[0], &a_view);
    let b_view = protocol::PrefsView {
        theme: Some(protocol::ThemeChoice::Dark),
        ..protocol::PrefsView::default()
    };
    write_prefs(&devices[1], &b_view);

    quiesce(&devices, 8);

    let b_after = read_prefs(&devices[1]);
    assert_eq!(
        b_after.label.as_deref(),
        Some("Renamed On A"),
        "A's rename reached B"
    );
    assert_eq!(
        b_after.theme,
        Some(protocol::ThemeChoice::Dark),
        "B's device-local theme survived"
    );
    let a_after = read_prefs(&devices[0]);
    assert_eq!(a_after.label.as_deref(), Some("Renamed On A"));
    assert_eq!(a_after.theme, None, "B's theme never crossed to A");

    // Steady state: further cycles push nothing (no ping-pong).
    let s0 = devices[0].sync();
    let s1 = devices[1].sync();
    assert_eq!(s0.pushed + s1.pushed, 0, "quiesced fleet stays silent");
}

/// MYND-562 regression canary — the original desktop↔mobile decoration scramble,
/// reproduced at the plane it actually lives (the `vault.prefs` merge). Two
/// devices concurrently decorate DIFFERENT folders and mark the SAME folder as a
/// case-variant deliberate empty. After sync BOTH devices must converge to:
///   • both folder colors + the icon preserved — the per-key LWW fix (whole-map
///     LWW dropped the lower-clock side's *entire* map, losing the other folder's
///     decoration); and
///   • a SINGLE canonical `deliberate_folders` entry — the fold-aware set-union
///     fix (case-sensitive union let "personal/" and "PERSONAL/" coexist).
/// RED against the pre-MYND-562 merge (whole-map LWW + case-sensitive union),
/// GREEN after Tasks 1 & 2.
#[test]
fn decoration_prefs_converge_per_key_across_case_variants() {
    let (_guard, url) = server_or_skip!("decoration_prefs_562");
    let acct = Account::new(0x5c);
    let devices = enroll_devices(&acct, &url, 2);
    let prefs_key = derive_subkey(&acct.root_key, SubkeyRole::PrefsKey);

    let write_prefs = |d: &Device, view: &protocol::PrefsView| {
        let bytes = protocol::encode_prefs_blob(&prefs_key, &acct.account_hash, view).unwrap();
        std::fs::write(d.vault_dir.join("vault.prefs"), &bytes).unwrap();
    };
    let read_prefs = |d: &Device| -> protocol::PrefsView {
        let bytes = std::fs::read(d.vault_dir.join("vault.prefs")).unwrap();
        protocol::decode_prefs_blob(&prefs_key, &acct.account_hash, &bytes).unwrap()
    };

    // A decorates folder `work/` (color + icon) and marks `personal/` deliberate.
    let mut a = protocol::PrefsView {
        deliberate_folders: vec![String::from("personal/")],
        ..protocol::PrefsView::default()
    };
    a.item_colors
        .insert(String::from("work/"), String::from("clay"));
    a.folder_icons
        .insert(String::from("work/"), String::from("book"));
    a.field_clocks
        .insert(String::from("item_colors/work/"), 1_000);
    a.field_clocks
        .insert(String::from("folder_icons/work/"), 1_000);
    write_prefs(&devices[0], &a);

    // B concurrently decorates a DIFFERENT folder `ideas/` and marks the SAME
    // folder as the case-variant `PERSONAL/`.
    let mut b = protocol::PrefsView {
        deliberate_folders: vec![String::from("PERSONAL/")],
        ..protocol::PrefsView::default()
    };
    b.item_colors
        .insert(String::from("ideas/"), String::from("moss"));
    b.field_clocks
        .insert(String::from("item_colors/ideas/"), 1_000);
    write_prefs(&devices[1], &b);

    quiesce(&devices, 8);

    for d in &devices {
        let v = read_prefs(d);
        // Per-key LWW: BOTH folders' colors survive the merge (whole-map LWW
        // would have dropped one side's entire map).
        assert_eq!(
            v.item_colors.get("work/").map(String::as_str),
            Some("clay"),
            "device {}: A's work/ color survived",
            d.label
        );
        assert_eq!(
            v.item_colors.get("ideas/").map(String::as_str),
            Some("moss"),
            "device {}: B's ideas/ color survived (no lost update)",
            d.label
        );
        assert_eq!(
            v.folder_icons.get("work/").map(String::as_str),
            Some("book"),
            "device {}: A's work/ icon survived",
            d.label
        );
        // Fold-aware set-union: the case-variant deliberate folders collapse to a
        // single lexicographic-min canonical entry.
        assert_eq!(
            v.deliberate_folders,
            vec![String::from("PERSONAL/")],
            "device {}: case-variant deliberate folders folded to one canonical",
            d.label
        );
    }
}

/// A folder deleted while a third device was offline stays deleted when it
/// rejoins (myne-md/myne#613).
///
/// This is the scenario the unit tests cannot reach. They merge two views once;
/// the defect needs three replicas and two rounds. Before the removal clock was
/// carried across a round in which both merging sides had already dropped the
/// entry, this returned the folder: the two online devices converged, their next
/// merge discarded the tombstone as an orphan, and the rejoining device then met
/// a peer with no clock at all and won with its own original add clock.
///
/// The assertion is on all three devices rather than on the rejoining one,
/// because the failure propagates: once the offline device wins, the entry is
/// back everywhere.
#[test]
fn a_folder_deleted_while_a_device_was_offline_stays_deleted() {
    let (_guard, url) = server_or_skip!("deliberate_removal_613");
    let acct = Account::new(0x61);
    let devices = enroll_devices(&acct, &url, 3);
    let prefs_key = derive_subkey(&acct.root_key, SubkeyRole::PrefsKey);

    let write_prefs = |d: &Device, view: &protocol::PrefsView| {
        let bytes = protocol::encode_prefs_blob(&prefs_key, &acct.account_hash, view).unwrap();
        std::fs::write(d.vault_dir.join("vault.prefs"), &bytes).unwrap();
    };
    let read_prefs = |d: &Device| -> protocol::PrefsView {
        let bytes = std::fs::read(d.vault_dir.join("vault.prefs")).unwrap();
        protocol::decode_prefs_blob(&prefs_key, &acct.account_hash, &bytes).unwrap()
    };

    // All three know about `Projects/`, registered at t=100.
    let mut held = protocol::PrefsView {
        deliberate_folders: vec![String::from("Projects/")],
        ..protocol::PrefsView::default()
    };
    held.field_clocks
        .insert(String::from("deliberate_folders/projects/"), 100);
    for d in &devices {
        write_prefs(d, &held);
    }

    // The first two delete it at t=300. The third is offline and writes nothing,
    // so it keeps the entry under its original add clock.
    let mut deleted = protocol::PrefsView::default();
    deleted
        .field_clocks
        .insert(String::from("deliberate_folders/projects/"), 300);
    write_prefs(&devices[0], &deleted);
    write_prefs(&devices[1], &deleted);

    // Slice rather than clone: `Device` is not `Clone` and does not need to be.
    quiesce(&devices[..2], 8);

    // Now everyone, including the device that was out for the deletion.
    quiesce(&devices, 8);

    for d in &devices {
        let v = read_prefs(d);
        assert!(
            v.deliberate_folders.is_empty(),
            "device {}: a folder deleted while this device was offline must not \
             come back when it rejoins",
            d.label
        );
    }
}

/// The CORRECT deletion path (`deleteNoteRouted`) converges: both devices end
/// with the `deleted:`-marked version. This is the control proving the harness
/// distinguishes the good path from the buggy `empty_trash` one below.
#[test]
fn routed_delete_converges() {
    let (_guard, url) = server_or_skip!("routed_delete");
    let acct = Account::new(0x20);
    let devices = enroll_devices(&acct, &url, 2);

    let n = devices[0].create_note(b"to be routed-deleted");
    quiesce(&devices, 8);
    assert_converged(&devices, &[n]);

    devices[0].delete_routed(&n);
    quiesce(&devices, 8);

    let b_body = devices[1].read_note(&n);
    assert!(
        b_body
            .as_ref()
            .is_some_and(|b| b.windows(8).any(|w| w == b"deleted:")),
        "routed deletion propagated to B (deleted: marker present)"
    );
    assert_converged(&devices, &[n]);
}

/// POSITIVE CONTROL for the conflict detector. When BOTH devices genuinely edit
/// the same note before syncing, a keep-both conflict on the loser is the
/// CORRECT outcome — and its staged revision is the winner's content. This is
/// the mirror image of the Bug-1 test: there a conflict with NO real edit is
/// wrong; here a conflict WITH two real edits is right. If this ever goes RED
/// the engine stopped detecting genuine conflicts.
#[test]
fn genuine_concurrent_edit_stages_a_real_conflict() {
    let (_guard, url) = server_or_skip!("genuine_conflict");
    let acct = Account::new(0x60);
    let devices = enroll_devices(&acct, &url, 2);
    let (a, b) = (&devices[0], &devices[1]);

    let n = a.create_note(b"base");
    quiesce(&devices, 8);
    assert_converged(&devices, &[n]);

    // Both edit the SAME note while each is unaware of the other (no sync yet).
    a.edit_note(&n, b"A's real edit");
    b.edit_note(&n, b"B's real edit");
    // A pushes first (wins the CAS); B's push then loses → B stages A's revision
    // as a keep-both conflict instead of clobbering an edit.
    a.sync();
    b.sync();

    let id_hex = Device::id_hex(&n);
    assert!(
        b.pending_conflicts().contains(&id_hex),
        "a genuine concurrent edit MUST stage a keep-both conflict on the loser"
    );
    assert_eq!(
        b.read_staged_conflict(&n).as_deref(),
        Some(&b"A's real edit"[..]),
        "the staged revision is the winner's (A's) content"
    );
    // A made no conflicting observation — it won cleanly.
    assert!(
        a.pending_conflicts().is_empty(),
        "the winner has no conflict"
    );
}

/// Replication + single-writer convergence across THREE devices: a created note
/// reaches both peers, and a later owner-edit converges everywhere.
#[test]
fn three_devices_converge() {
    let (_guard, url) = server_or_skip!("three_devices");
    let acct = Account::new(0x70);
    let devices = enroll_devices(&acct, &url, 3);

    let n = devices[0].create_note(b"v1");
    quiesce(&devices, 12);
    assert_converged(&devices, &[n]);
    assert_eq!(
        devices[2].read_note(&n).as_deref(),
        Some(&b"v1"[..]),
        "C got it"
    );

    devices[0].edit_note(&n, b"v2 from A");
    quiesce(&devices, 12);
    assert_converged(&devices, &[n]);
    assert_same_blob_sets(&devices);
    assert_no_conflicts(&devices);
}

/// The automerge-sync-migration end-to-end (myne-md/myne#419): three devices
/// concurrently edit the SAME `NC05` CRDT note; the engine MERGES (never keep-
/// both), every device converges to a byte-identical merged note that drops
/// neither edit, and a further cycle pushes NOTHING. That last property is the
/// point of the migration: the ASM-5 causal-heads convergence marker means a
/// non-deterministic Automerge re-serialize is not seen as a push, so the note-
/// level §10.2.2 CAS ping-pong (the fragility class #405 fixed for singletons)
/// cannot recur one layer down.
#[test]
fn crdt_note_three_device_concurrent_edit_merges_converges_no_ping_pong() {
    let (_guard, url) = server_or_skip!("crdt_note_converge");
    let acct = Account::new(0x50);
    let devices = enroll_devices(&acct, &url, 3);

    // A creates the note; it replicates to B and C. All three now share the same
    // Automerge change-graph ancestry — the precondition `merge()` needs.
    let n = devices[0].create_crdt_note("base");
    quiesce(&devices, 12);
    for d in &devices {
        assert_eq!(
            d.read_crdt_note(&n).as_deref(),
            Some("base"),
            "device {} received the CRDT note",
            d.label
        );
    }

    // Two devices edit the SAME note concurrently (neither syncs first — the fork).
    devices[0].edit_crdt_note(&n, "AAA");
    devices[1].edit_crdt_note(&n, "BBB");
    quiesce(&devices, 16);

    // Converged: every device holds byte-identical merged markdown...
    let merged = devices[0]
        .read_crdt_note(&n)
        .expect("A holds the merged note");
    for d in &devices[1..] {
        assert_eq!(
            d.read_crdt_note(&n).as_deref(),
            Some(merged.as_str()),
            "device {} converged to the same merged bytes",
            d.label
        );
    }
    // ...that dropped NEITHER edit (both distinctive runs survive the interleave,
    // §10.1)...
    assert!(
        merged.contains('A') && merged.contains('B'),
        "both concurrent edits present after merge: {merged:?}"
    );
    // ...silently: a CRDT merge is never surfaced as a keep-both conflict (ASM-6→B),
    // and every device holds the one note id.
    assert_no_conflicts(&devices);
    assert_same_blob_sets(&devices);

    // Steady state: a further cycle on EVERY device pushes nothing — the heads did
    // not change, so a re-serialized blob is not mistaken for a local edit.
    let pushed: usize = devices.iter().map(|d| d.sync().pushed).sum();
    assert_eq!(
        pushed, 0,
        "quiesced CRDT fleet stays silent (no ASM-5 CAS ping-pong)"
    );
}

/// #421 task 3 (ASM-12 Reading B): unbounded synced Automerge history round-trips
/// across a fleet, and the accepted cost — per-note blob size growing with edit
/// count — is asserted, not hidden. Many sequential edits of ONE `NC05` note
/// converge on every device each round, and the on-disk blob is strictly larger
/// after the edits than at creation (the full change-history rides inside it). The
/// assertion is deliberate: a future retention bound (#423) needs a known baseline,
/// and a blob that stopped growing would mean history was silently dropped.
#[test]
fn crdt_note_unbounded_history_round_trips_and_grows_with_edits() {
    let (_guard, url) = server_or_skip!("crdt_history_retention");
    let acct = Account::new(0x51);
    let devices = enroll_devices(&acct, &url, 3);

    let n = devices[0].create_crdt_note("rev-0");
    quiesce(&devices, 12);
    let size_at_create = devices[2].crdt_blob_len(&n).expect("C holds the note");

    // Many sequential edits on A, each replicated to the whole fleet.
    const EDITS: usize = 6;
    for i in 1..=EDITS {
        devices[0].edit_crdt_note(&n, &format!("rev-{i}"));
        quiesce(&devices, 12);
        for d in &devices {
            assert_eq!(
                d.read_crdt_note(&n).as_deref(),
                Some(format!("rev-{i}").as_str()),
                "device {} converged to rev-{i}",
                d.label
            );
        }
    }
    // A single-writer edit stream is never a conflict.
    assert_no_conflicts(&devices);

    // The accepted cost (the epic's sharpest residual): the synced blob carries the
    // full edit-history, so it is strictly larger after EDITS edits than at
    // creation. This is the unbounded-now stance made measurable (#423 bounds it).
    let size_after = devices[2]
        .crdt_blob_len(&n)
        .expect("C still holds the note");
    assert!(
        size_after > size_at_create,
        "unbounded history must accumulate: blob grew from {size_at_create} to \
         {size_after} bytes over {EDITS} edits (a non-growing blob would mean \
         history was dropped)"
    );
}

/// myne-md/myne#405 end-to-end: the §10.2.2 non-associative counterexample as a
/// THREE-device fleet, driven through the real sync cycle. Before the causal-
/// `version` fix the tombstone-guard merge was non-associative, so the fleet's
/// `merged == remote` push-gate never agreed and the devices CAS-ping-ponged
/// forever. With the fix the merge is a join over `version` (associative), so the
/// fleet reaches a fixed point: every device holds byte-identical `vault.themes`
/// and a further cycle pushes NOTHING.
#[test]
fn themes_three_device_counterexample_converges_no_ping_pong() {
    use crate::plugins::themes::commands::{
        decode_themes_map_or_empty, encode_themes_map, ThemeEntry, ThemePalette, ThemesMap,
    };

    let (_guard, url) = server_or_skip!("themes_405_converge");
    let acct = Account::new(0x40);
    let devices = enroll_devices(&acct, &url, 3);
    let themes_key = derive_subkey(&acct.root_key, SubkeyRole::CustomThemesKey);

    let palette = |c: &str| ThemePalette::from([(String::from("--accent"), String::from(c))]);
    let write_themes = |d: &Device, map: &ThemesMap| {
        let bytes = encode_themes_map(
            // v0.1 throughout: see the whole-harness KNOWN GAP at the top of
            // this file (myne-md/myne#638).
            protocol::MetaVersion::V0_1,
            &themes_key,
            &acct.account_hash,
            map,
        )
        .unwrap();
        std::fs::write(d.vault_dir.join("vault.themes"), &bytes).unwrap();
    };
    let read_themes = |d: &Device| -> ThemesMap {
        let bytes = std::fs::read(d.vault_dir.join("vault.themes")).unwrap_or_default();
        decode_themes_map_or_empty(&themes_key, &acct.account_hash, Some(&bytes))
    };

    // The exact §10.2.2 counterexample, all at the SAME `version` (concurrent):
    //   A = tombstone("nord")   version 1, deleted_at 5   (the deletion)
    //   B = live("nord", #bbb)  version 1, created 10/updated 10
    //   C = live("nord", #ccc)  version 1, created 1 /updated 100
    // The old `created_at`-vs-`deleted_at` guard reconciled these three to
    // different bytes by pairing order → ping-pong; the version-primary join is
    // associative → they converge (remove-wins ⇒ the tombstone).
    let mut a = ThemesMap::new();
    a.insert(
        "nord".into(),
        ThemeEntry {
            created_at: 100,
            deleted_at: Some(5),
            palette: ThemePalette::new(),
            updated_at: 100,
            version: 1,
        },
    );
    let mut b = ThemesMap::new();
    b.insert(
        "nord".into(),
        ThemeEntry {
            created_at: 10,
            deleted_at: None,
            palette: palette("#bbb"),
            updated_at: 10,
            version: 1,
        },
    );
    let mut c = ThemesMap::new();
    c.insert(
        "nord".into(),
        ThemeEntry {
            created_at: 1,
            deleted_at: None,
            palette: palette("#ccc"),
            updated_at: 100,
            version: 1,
        },
    );
    write_themes(&devices[0], &a);
    write_themes(&devices[1], &b);
    write_themes(&devices[2], &c);

    quiesce(&devices, 16);

    // Every device converged to a byte-identical themes map.
    let m0 = read_themes(&devices[0]);
    let m1 = read_themes(&devices[1]);
    let m2 = read_themes(&devices[2]);
    assert_eq!(m0, m1, "A and B converged");
    assert_eq!(m1, m2, "B and C converged");
    assert!(
        m0["nord"].is_tombstone(),
        "the concurrent-tie fixed point is the tombstone (remove-wins)"
    );

    // Steady state: a further cycle on every device pushes NOTHING — the CAS
    // ping-pong the old non-associative guard produced is gone.
    let pushed: usize = devices.iter().map(|d| d.sync().pushed).sum();
    assert_eq!(pushed, 0, "quiesced fleet stays silent (no CAS ping-pong)");
}

/// AI conversations (myne-md/myne#675): two devices append concurrently to the
/// SAME conversation while a third holds nothing; the fleet converges to one
/// catalog and one turn list holding BOTH suffixes, and a further cycle pushes
/// nothing.
///
/// A holds turns [a1, a2, a3], B holds [a1, a2, b3] (common prefix + both
/// suffixes); C holds no catalog file at all. Both A and B carry the same
/// catalog row (version 1); the interesting divergence is in the files, not
/// the roster. After quiesce every device decodes the same catalog row and the
/// same [a1, a2, a3, b3] turn list (decoded equality: re-seals carry fresh
/// nonces, so raw bytes differ the way they do for notes too).
#[test]
fn chats_concurrent_append_converges_no_ping_pong() {
    use crate::plugins::chats::commands::{ChatsCatalogMap, ConversationEntry};
    use protocol::{
        decode_chats_blob, decode_chats_catalog_blob, derive_subkey, encode_chats_blob,
        encode_chats_catalog_blob, SubkeyRole,
    };

    let (_guard, url) = server_or_skip!("chats_concurrent_append");
    let acct = Account::new(0xA0);
    let devices = enroll_devices(&acct, &url, 3);
    let catalog_key = derive_subkey(&acct.root_key, SubkeyRole::ChatsCatalogKey);
    let chats_key = derive_subkey(&acct.root_key, SubkeyRole::ChatsKey);

    let conv_id = [0xC0u8; 16];
    let conv_hex = "c0".repeat(16);
    let row = || ConversationEntry {
        created_at: 1,
        deleted_at: None,
        title: "taxes".to_string(),
        updated_at: 100,
        version: 1,
        note_id: None,
    };
    let write_catalog = |d: &Device, map: &ChatsCatalogMap| {
        let plaintext = serde_json::to_vec(map).unwrap();
        let bytes =
            encode_chats_catalog_blob(&catalog_key, &acct.account_hash, &plaintext).unwrap();
        std::fs::write(d.vault_dir.join("vault.chats"), &bytes).unwrap();
    };
    let write_turns = |d: &Device, ids: &[&str]| {
        let turns: Vec<serde_json::Value> =
            ids.iter().map(|id| serde_json::json!({"id": id})).collect();
        let payload = serde_json::to_vec(&serde_json::json!({ "turns": turns })).unwrap();
        let bytes = encode_chats_blob(&chats_key, &acct.account_hash, &conv_id, &payload).unwrap();
        std::fs::create_dir_all(d.vault_dir.join("chats")).unwrap();
        std::fs::write(d.vault_dir.join("chats").join(&conv_hex), &bytes).unwrap();
    };
    let read_row = |d: &Device| -> ConversationEntry {
        let bytes = std::fs::read(d.vault_dir.join("vault.chats")).unwrap();
        let plaintext =
            decode_chats_catalog_blob(&catalog_key, &acct.account_hash, &bytes).unwrap();
        let map: ChatsCatalogMap = serde_json::from_slice(&plaintext).unwrap();
        map[&conv_hex].clone()
    };
    let read_turn_ids = |d: &Device| -> Vec<String> {
        let bytes = std::fs::read(d.vault_dir.join("chats").join(&conv_hex)).unwrap();
        let plaintext =
            decode_chats_blob(&chats_key, &acct.account_hash, &conv_id, &bytes).unwrap();
        let v: serde_json::Value = serde_json::from_slice(&plaintext).unwrap();
        v["turns"]
            .as_array()
            .unwrap()
            .iter()
            .map(|t| t["id"].as_str().unwrap().to_string())
            .collect()
    };

    let mut map_a = ChatsCatalogMap::new();
    map_a.insert(conv_hex.clone(), row());
    write_catalog(&devices[0], &map_a);
    write_turns(&devices[0], &["a1", "a2", "a3"]);
    let mut map_b = ChatsCatalogMap::new();
    map_b.insert(conv_hex.clone(), row());
    write_catalog(&devices[1], &map_b);
    write_turns(&devices[1], &["a1", "a2", "b3"]);
    // Device C holds nothing: no catalog file, no chats/ dir.

    quiesce(&devices, 16);

    // Every device converged to the same row and the same merged turn list.
    for d in &devices[1..] {
        assert_eq!(read_row(&devices[0]), read_row(d), "catalog rows converged");
        assert_eq!(
            read_turn_ids(&devices[0]),
            read_turn_ids(d),
            "turn lists converged"
        );
    }
    assert_eq!(
        read_turn_ids(&devices[0]),
        vec!["a1", "a2", "a3", "b3"],
        "common prefix kept, both suffixes kept in id order, no turn dropped"
    );

    // Steady state: a further cycle on every device pushes NOTHING.
    let pushed: usize = devices.iter().map(|d| d.sync().pushed).sum();
    assert_eq!(pushed, 0, "quiesced fleet stays silent (no CAS ping-pong)");
}

/// Two devices create DIFFERENT notes offline; after sync both notes exist on
/// both devices. Distinct-note concurrency is never a conflict.
#[test]
fn concurrent_distinct_creates_all_survive() {
    let (_guard, url) = server_or_skip!("distinct_creates");
    let acct = Account::new(0x80);
    let devices = enroll_devices(&acct, &url, 2);

    let n_a = devices[0].create_note(b"A's note");
    let n_b = devices[1].create_note(b"B's note");
    quiesce(&devices, 12);

    assert_converged(&devices, &[n_a, n_b]);
    assert_same_blob_sets(&devices);
    assert_no_conflicts(&devices);
    assert_eq!(
        devices[1].read_note(&n_a).as_deref(),
        Some(&b"A's note"[..])
    );
    assert_eq!(
        devices[0].read_note(&n_b).as_deref(),
        Some(&b"B's note"[..])
    );
}

/// Moving a note to the trash (the soft `trashed:` marker, NOT empty-trash)
/// propagates and converges — it is an ordinary content edit. This is the
/// baseline the buggy `empty_trash` is contrasted against.
#[test]
fn soft_trash_marker_propagates() {
    let (_guard, url) = server_or_skip!("soft_trash");
    let acct = Account::new(0x90);
    let devices = enroll_devices(&acct, &url, 2);

    let n = devices[0].create_note(b"note heading to trash");
    quiesce(&devices, 8);

    devices[0].move_to_trash(&n);
    quiesce(&devices, 8);

    assert!(
        devices[1]
            .read_note(&n)
            .is_some_and(|b| b.windows(8).any(|w| w == b"trashed:")),
        "B sees the note as trashed (soft-trash propagated)"
    );
    assert_converged(&devices, &[n]);
    assert_same_blob_sets(&devices);
}

/// Once the system is quiescent, an extra sync round must be a pure no-op — no
/// blob pushed, none pulled, no conflict staged. A spurious push here would mean
/// the engine churns the head every cycle (battery + needless server traffic).
#[test]
fn idempotent_resync_is_a_noop() {
    let (_guard, url) = server_or_skip!("idempotent");
    let acct = Account::new(0xA0);
    let devices = enroll_devices(&acct, &url, 2);

    devices[0].create_note(b"settle me");
    quiesce(&devices, 8);

    // One more full round after quiescence — must move nothing.
    for d in &devices {
        let s = d.sync();
        assert_eq!(
            s.pushed, 0,
            "device {} pushed on a quiescent resync",
            d.label
        );
        assert_eq!(
            s.pulled, 0,
            "device {} pulled on a quiescent resync",
            d.label
        );
        assert!(
            s.conflicts.is_empty(),
            "device {} staged a conflict on a quiescent resync",
            d.label
        );
    }
    assert_no_conflicts(&devices);
}

// ---------------------------------------------------------------------------
// RED tests — reproduce the live bugs. `#[ignore]`d so they don't break CI;
// run with `-- --ignored` to watch the harness catch them. Drop `#[ignore]`
// once the matching client fix lands and they become regression gates.
// ---------------------------------------------------------------------------

/// BUG 3 (FIXED) — emptying the trash on one device propagates to the other.
/// Pre-fix `emptyTrash` did a bare unlink that vanished on the deleting device
/// and never reached the peer (both still showed "synced"). The fix routes it
/// through `deleteNoteRouted` (a `deleted:`-marker tombstone), so A and B
/// converge — this test (formerly RED, `empty_trash_buggy`) is now GREEN with
/// the fixed `empty_trash` op. Regression gate: a revert to bare-unlink diverges.
#[test]
fn empty_trash_propagates_to_other_device() {
    let (_guard, url) = server_or_skip!("empty_trash_propagates");
    let acct = Account::new(0x30);
    let devices = enroll_devices(&acct, &url, 2);

    // Both devices hold the note.
    let n = devices[0].create_note(b"note that will be trashed");
    quiesce(&devices, 8);
    assert_converged(&devices, &[n]);
    assert!(
        devices[1].read_note(&n).is_some(),
        "B has the note before empty"
    );

    // A empties the trash via the FIXED (routed) path, then everyone syncs.
    devices[0].empty_trash(&n);
    quiesce(&devices, 8);

    // A and B agree on the note's fate: a `deleted:`-marked blob present on BOTH
    // (propagated), not vanished-on-A / live-on-B.
    assert_converged(&devices, &[n]);
    assert_same_blob_sets(&devices);
    assert!(
        devices[1]
            .read_note(&n)
            .is_some_and(|b| b.windows(8).any(|w| w == b"deleted:")),
        "B received the deletion (deleted: marker propagated)"
    );
}

/// BUG 1 (FIXED) — a note edited on B while "open" on A must NOT become a false
/// conflict. Pre-fix, A's editor reload-on-sync re-saved the pulled note with a
/// fresh nonce (a semantic no-op the user never typed), so A looked locally-dirty
/// and the next remote edit staged a spurious keep-both conflict. The fix
/// (`useAutosave.acceptReloadedBody` — a reload re-baselines instead of
/// dirtying) means the reload is NOT a local edit, so no `autosave_resave` is
/// modeled here: A simply pulls each remote edit cleanly. Formerly RED, now GREEN.
#[test]
fn open_note_remote_edit_is_not_a_false_conflict() {
    let (_guard, url) = server_or_skip!("false_conflict");
    let acct = Account::new(0x40);
    let devices = enroll_devices(&acct, &url, 2);
    let (a, b) = (&devices[0], &devices[1]);

    // Both synced to v1.
    let n = a.create_note(b"v1 body");
    quiesce(&devices, 8);
    assert_converged(&devices, &[n]);

    // B edits (v2); A (note "open", clean) pulls it — the FIXED reload adopts the
    // body as loaded content, it does NOT re-save/re-dirty (no autosave_resave).
    b.edit_note(&n, b"v2 from B");
    b.sync();
    a.sync();

    // B edits again (v3); A pulls again — still clean, still no false dirty.
    b.edit_note(&n, b"v3 from B");
    b.sync();
    a.sync();
    quiesce(&devices, 8);

    // No conflict was staged for a note A never semantically edited.
    assert_no_conflicts(&devices);
    assert_converged(&devices, &[n]);
}

/// BUG 2 (FIXED) — "a file won't sync". The wedge was downstream of Bug 1: a
/// FALSE conflict excluded the note from every push until manually resolved, so
/// later edits on the wedged device never reached the peer. With Bug 1 fixed a
/// clean open note no longer false-conflicts, so it is never wedged: A's later
/// edits reach B normally. The Bug-1 trigger (`autosave_resave`) is gone; this
/// asserts the note keeps flowing. Formerly RED, now GREEN. (A GENUINE conflict
/// still wedges-until-resolved by design — see `genuine_concurrent_edit…`.)
#[test]
fn wedged_note_never_reaches_peer_after_false_conflict() {
    let (_guard, url) = server_or_skip!("wedged_note");
    let acct = Account::new(0xB0);
    let devices = enroll_devices(&acct, &url, 2);
    let (a, b) = (&devices[0], &devices[1]);

    // The old wedge path, minus the (now-fixed) reload re-dirty: A just pulls
    // B's edits cleanly, so no false conflict is staged.
    let n = a.create_note(b"v1");
    quiesce(&devices, 8);
    b.edit_note(&n, b"v2 from B");
    b.sync();
    a.sync(); // FIXED reload: adopt v2, no re-dirty
    b.edit_note(&n, b"v3 from B");
    b.sync();
    a.sync();

    // A now makes a genuine, deliberate edit it wants to share.
    a.edit_note(&n, b"A's deliberate later edit");
    quiesce(&devices, 12);

    // Not wedged: A's later edit reaches B (no stale staged conflict blocking push).
    assert_eq!(
        b.read_note(&n).as_deref(),
        Some(&b"A's deliberate later edit"[..]),
        "A's later edit must reach B (no false-conflict wedge after the Bug-1 fix)"
    );
    assert_no_conflicts(&devices);
    assert_converged(&devices, &[n]);
}

// ---------------------------------------------------------------------------
// Fuzz driver — random single-writer op sequences across K devices. With a
// correct engine these ALWAYS converge (single writer per note ⇒ no legitimate
// keep-both). It surfaced Bug 3 before the fix (bare-unlink divergence); now
// GREEN over the routed `empty_trash`, it guards against any future
// deletion-propagation regression. Deterministic seed → reproducible.
// ---------------------------------------------------------------------------

/// Tiny deterministic PRNG (xorshift64*) — no external dep, no `Math.random`
/// equivalent (the harness must reproduce byte-for-byte across runs).
struct Rng(u64);
impl Rng {
    fn next(&mut self) -> u64 {
        let mut x = self.0;
        x ^= x >> 12;
        x ^= x << 25;
        x ^= x >> 27;
        self.0 = x;
        x.wrapping_mul(0x2545_F491_4F6C_DD1D)
    }
    fn below(&mut self, n: usize) -> usize {
        (self.next() % n as u64) as usize
    }
}

#[test]
fn fuzz_single_writer_sequences_converge() {
    let (_guard, url) = server_or_skip!("fuzz_converge");
    let acct = Account::new(0x50);
    let devices = enroll_devices(&acct, &url, 3);

    let mut rng = Rng(0x9E37_79B9_7F4A_7C15); // fixed seed
                                              // Single-writer model: each note has one owning device that is the only one
                                              // to ever semantically edit or delete it. `all` tracks EVERY note created
                                              // (for the convergence check — a deleted note must converge, not vanish from
                                              // the assertion); `live` tracks the not-yet-emptied ones we still mutate.
    let mut all: Vec<NoteId> = Vec::new();
    let mut live: Vec<(NoteId, usize)> = Vec::new();
    let mut edit_ctr: u64 = 0;

    for _ in 0..120 {
        match rng.below(5) {
            // Create (owned by a random device).
            0 => {
                let owner = rng.below(devices.len());
                let id = devices[owner].create_note(format!("n{}", all.len()).as_bytes());
                all.push(id);
                live.push((id, owner));
            }
            // Edit by the owner (only the owner ever semantically edits).
            1 if !live.is_empty() => {
                let (id, owner) = live[rng.below(live.len())];
                edit_ctr += 1;
                devices[owner].edit_note(&id, format!("edit{edit_ctr}").as_bytes());
            }
            // Empty-trash by the owner (the FIXED routed path). It leaves `all`
            // (must still converge) but leaves `live` (no longer mutated).
            2 if !live.is_empty() => {
                let idx = rng.below(live.len());
                let (id, owner) = live[idx];
                devices[owner].empty_trash(&id);
                live.remove(idx);
            }
            // Sync a random device.
            _ => {
                devices[rng.below(devices.len())].sync();
            }
        }
    }

    quiesce(&devices, 32);

    // The whole correctness statement: every note ever created converges to an
    // identical state on every device (live ones to their last edit, deleted
    // ones to a state all devices agree on), with no false conflicts and no
    // device clinging to a blob another already dropped. The buggy bare-unlink
    // breaks the last two (an emptied note lingers on the non-owner).
    assert_converged(&devices, &all);
    assert_no_conflicts(&devices);
    assert_same_blob_sets(&devices);
}

// ===========================================================================
// DISCOVERY tests — written to find UNKNOWN bugs, not reproduce known ones.
// They assert the CORRECT behavior and RUN (not `#[ignore]`d). A pass confirms
// the path is sound (and locks it as a regression gate); a FAILURE is a newly
// discovered bug — then it earns an `#[ignore]` + a description. They steer
// around the three known bugs (no `autosave_resave`, no `empty_trash_buggy`) so
// a NEW divergence is not masked by an old one.
// ===========================================================================

/// EXPLORATORY FUZZ over the SAFE op set across many seeds. Single-writer per
/// note (only the owner edits/trashes/deletes it) ⇒ a correct engine MUST
/// converge with no conflicts. Uses `delete_routed` (not the buggy bare-unlink)
/// and never `autosave_resave`, so any divergence here is a *new* bug in
/// pull/push/head/cursor/reconcile — not one of the three known ones.
#[test]
fn discovery_fuzz_safe_ops_converge() {
    let (_guard, url) = server_or_skip!("discovery_fuzz");

    for seed_ix in 0..6u64 {
        let acct = Account::new(0xC0u8.wrapping_add(seed_ix as u8));
        let devices = enroll_devices(&acct, &url, 3);
        // Distinct stream per seed (seed_ix folded into the constant).
        let mut rng = Rng(0xD1CE_0000_0000_0001 ^ seed_ix.wrapping_mul(0x9E37_79B9_7F4A_7C15));

        let mut all: Vec<NoteId> = Vec::new();
        let mut live: Vec<(NoteId, usize)> = Vec::new(); // (id, owner)
        let mut ctr: u64 = 0;

        for _ in 0..90 {
            match rng.below(6) {
                0 => {
                    let owner = rng.below(devices.len());
                    let id = devices[owner].create_note(format!("n{}", all.len()).as_bytes());
                    all.push(id);
                    live.push((id, owner));
                }
                1 if !live.is_empty() => {
                    let (id, owner) = live[rng.below(live.len())];
                    ctr += 1;
                    devices[owner].edit_note(&id, format!("e{ctr}").as_bytes());
                }
                2 if !live.is_empty() => {
                    let (id, owner) = live[rng.below(live.len())];
                    devices[owner].move_to_trash(&id); // soft trash (an edit)
                }
                3 if !live.is_empty() => {
                    let idx = rng.below(live.len());
                    let (id, owner) = live[idx];
                    devices[owner].delete_routed(&id); // CORRECT deletion path
                    live.remove(idx);
                }
                // Bias toward syncing so the system actually exchanges state.
                _ => {
                    devices[rng.below(devices.len())].sync();
                }
            }
        }

        quiesce(&devices, 40);
        assert_converged(&devices, &all);
        assert_same_blob_sets(&devices);
        assert_no_conflicts(&devices);
    }
}

/// The keep-both RESOLUTION path end-to-end: a genuine concurrent edit stages a
/// conflict on B; B resolves it (keep the remote as a copy + adopt it as
/// baseline); after sync BOTH devices converge to the same two notes (the
/// surviving edit + the conflict copy) with nothing left staged. Exercises
/// `resolve_conflict`, the half the keep-both detector tests never drove.
#[test]
fn discovery_conflict_resolution_converges() {
    let (_guard, url) = server_or_skip!("resolution_converges");
    let acct = Account::new(0xE0);
    let devices = enroll_devices(&acct, &url, 2);
    let (a, b) = (&devices[0], &devices[1]);

    let n = a.create_note(b"base");
    quiesce(&devices, 8);

    a.edit_note(&n, b"A wins");
    b.edit_note(&n, b"B local");
    a.sync();
    b.sync(); // B stages A's revision as a keep-both conflict
    assert!(
        b.pending_conflicts().contains(&Device::id_hex(&n)),
        "precondition: B has a staged conflict"
    );

    // B resolves: materialize the remote as a separate copy, adopt baseline.
    let remote = b.read_staged_conflict(&n).expect("staged remote present");
    let copy = b.create_note(&remote); // the "keep-both" copy note
    b.resolve_conflict(&n);

    quiesce(&devices, 12);

    // Convergence with NO staged conflict left, over both surviving notes.
    assert_converged(&devices, &[n, copy]);
    assert_same_blob_sets(&devices);
    assert_no_conflicts(&devices);
}

/// RACE: A deletes a note (correct routed path) while B concurrently edits the
/// SAME note, then both sync. The outcome is policy-dependent (deletion wins, or
/// the edit resurrects it) — but whatever it is, both devices MUST agree. A
/// divergence here is a real bug. (Discovery: we don't assert which side wins,
/// only that they converge.)
#[test]
fn discovery_concurrent_delete_and_edit_surfaces_conflict() {
    let (_guard, url) = server_or_skip!("delete_edit_race");
    let acct = Account::new(0xE1);
    let devices = enroll_devices(&acct, &url, 2);
    let (a, b) = (&devices[0], &devices[1]);

    let n = a.create_note(b"contested");
    quiesce(&devices, 8);

    a.delete_routed(&n); // A deletes
    b.edit_note(&n, b"B still editing"); // B edits the same note, unaware
    a.sync();
    b.sync();
    quiesce(&devices, 16);

    // A delete-vs-edit race is a GENUINE concurrent change. The safety property
    // is that it is SURFACED (staged keep-both) so neither side is silently
    // lost — never a silent divergence. (We don't assert plain convergence here:
    // like any real conflict it converges only after the user resolves it.)
    let staged = b.pending_conflicts().contains(&Device::id_hex(&n));
    assert!(
        staged,
        "delete-vs-edit race must surface as a staged conflict (no silent loss), \
         but B has none — A={:?} B={:?}",
        a.read_note(&n)
            .map(|v| String::from_utf8_lossy(&v).into_owned()),
        b.read_note(&n)
            .map(|v| String::from_utf8_lossy(&v).into_owned()),
    );
    // B's own edit is preserved on disk (not clobbered by the pulled deletion).
    assert_eq!(
        b.read_note(&n).as_deref(),
        Some(&b"B still editing"[..]),
        "B's local edit must survive the race"
    );
}

/// Both devices delete the SAME note at the same time (routed). Identical intent
/// should converge cleanly — ideally without a spurious keep-both for two
/// "deleted" revisions.
#[test]
fn discovery_double_delete_converges() {
    let (_guard, url) = server_or_skip!("double_delete");
    let acct = Account::new(0xE2);
    let devices = enroll_devices(&acct, &url, 2);
    let (a, b) = (&devices[0], &devices[1]);

    let n = a.create_note(b"doomed");
    quiesce(&devices, 8);

    a.delete_routed(&n);
    b.delete_routed(&n);
    a.sync();
    b.sync();
    quiesce(&devices, 16);

    assert_converged(&devices, &[n]);
    assert_same_blob_sets(&devices);
}

/// A device offline through MANY remote changes catches up in one rejoin: B
/// stays dark while A creates + edits a batch, then B syncs to quiescence and
/// must hold exactly A's state. Stresses the cursor-drain / multi-page pull.
#[test]
fn discovery_offline_device_catches_up() {
    let (_guard, url) = server_or_skip!("offline_catchup");
    let acct = Account::new(0xE3);
    let devices = enroll_devices(&acct, &url, 2);

    // Seed one shared note so B has a baseline, then B goes dark.
    let shared = devices[0].create_note(b"shared base");
    quiesce(&devices, 8);

    // A churns: 40 new notes + edits, syncing only A (B never syncs).
    let mut ids = vec![shared];
    for i in 0..40 {
        let id = devices[0].create_note(format!("offline-batch {i}").as_bytes());
        ids.push(id);
        if i % 5 == 0 {
            devices[0].edit_note(&shared, format!("shared rev {i}").as_bytes());
        }
        devices[0].sync();
    }

    // B rejoins and drains everything.
    quiesce(&devices, 60);
    assert_converged(&devices, &ids);
    assert_same_blob_sets(&devices);
    assert_no_conflicts(&devices);
}

/// The same catch-up, but against the PRODUCTION limiter (`256` burst, `16`/s
/// refill) and a corpus several times the burst — the shape myne-md/myne#240 was
/// filed about, end to end through the real client ops rather than the engine.
///
/// What this proves is **convergence under a binding limiter**: the batched drain
/// crosses a bucket it genuinely exhausts without wedging, without a false
/// conflict, and without a record going missing. Every other scenario in this
/// file lifts the limiter, so nothing else here would notice a batch path that
/// mishandled a 429 mid-window.
///
/// What it deliberately does NOT claim is a speedup. The wall-clock bound below
/// is a hang detector, not a measurement — it is loose enough that the
/// one-GET-per-blob shape would also fit under it, and a bound tight enough to
/// discriminate would be a bound tight enough to go flaky on a loaded runner.
/// The request-count proof, with its control arm, lives in
/// `orchestrator::tests::blob_batch::a_first_pull_of_a_large_vault_fits_inside_the_default_burst`.
#[test]
fn discovery_offline_device_catches_up_under_the_production_rate_limit() {
    let Some((_guard, url)) = spawn_server_with(&ServerOpts {
        rate_limit: Some((256, 16)),
        ..Default::default()
    }) else {
        eprintln!("SKIP offline_catchup_rate_limited: server binary not found");
        return;
    };
    let acct = Account::new(0xE9);
    let devices = enroll_devices(&acct, &url, 2);

    let shared = devices[0].create_note(b"shared base");
    quiesce(&devices, 8);

    let mut ids = vec![shared];
    for i in 0..400 {
        ids.push(devices[0].create_note(format!("throttled {i}").as_bytes()));
    }
    devices[0].sync();

    let started = std::time::Instant::now();
    quiesce(&devices, 30);
    let elapsed = started.elapsed();

    assert_converged(&devices, &ids);
    assert_same_blob_sets(&devices);
    assert_no_conflicts(&devices);
    assert!(
        elapsed < std::time::Duration::from_secs(120),
        "catching up 401 notes under the production limiter took {elapsed:?} — \
         a drain that stalls on 429s rather than crossing them"
    );
}

/// Trash then RESTORE (remove the `trashed:` marker) propagates: a note moved to
/// trash on A and then restored converges to the restored (live) state on B.
#[test]
fn discovery_trash_then_restore_propagates() {
    let (_guard, url) = server_or_skip!("trash_restore");
    let acct = Account::new(0xE4);
    let devices = enroll_devices(&acct, &url, 2);
    let (a, b) = (&devices[0], &devices[1]);

    let n = a.create_note(b"live note body");
    quiesce(&devices, 8);
    a.move_to_trash(&n);
    quiesce(&devices, 8);
    // Restore = overwrite with a fresh body carrying no trashed: marker.
    a.edit_note(&n, b"restored note body");
    quiesce(&devices, 8);

    let bv = b.read_note(&n).expect("B has the note");
    assert!(
        !bv.windows(8).any(|w| w == b"trashed:"),
        "B must see the restored (un-trashed) note"
    );
    assert_converged(&devices, &[n]);
    assert_same_blob_sets(&devices);
}

/// MULTI-WRITER stress: ANY device may edit ANY note it holds (real concurrent
/// edits, not single-writer), staging genuine keep-both conflicts; the harness
/// auto-resolves them every round. After resolution the system MUST converge —
/// every device holding the identical set of surviving notes + conflict copies,
/// nothing left staged. A non-convergence here (resolution that never settles,
/// or a copy that fails to replicate) is a real conflict-engine bug.
#[test]
fn discovery_multiwriter_fuzz_with_resolve_converges() {
    let (_guard, url) = server_or_skip!("multiwriter_fuzz");
    let acct = Account::new(0xF0);
    let devices = enroll_devices(&acct, &url, 3);
    let mut rng = Rng(0x1234_5678_9ABC_DEF1);

    let mut all: Vec<NoteId> = Vec::new();
    let mut ctr: u64 = 0;

    for _ in 0..110 {
        match rng.below(5) {
            // Create.
            0 => {
                let owner = rng.below(devices.len());
                let id = devices[owner].create_note(format!("n{}", all.len()).as_bytes());
                all.push(id);
            }
            // Multi-writer edit: a RANDOM device that currently HOLDS the note
            // edits it (so two devices can race the same note → real conflict).
            1 | 2 if !all.is_empty() => {
                let id = all[rng.below(all.len())];
                let holders: Vec<usize> = (0..devices.len())
                    .filter(|&i| devices[i].read_note(&id).is_some())
                    .collect();
                if !holders.is_empty() {
                    let d = holders[rng.below(holders.len())];
                    ctr += 1;
                    devices[d].edit_note(&id, format!("e{ctr}-d{d}").as_bytes());
                } else {
                    devices[rng.below(devices.len())].sync();
                }
            }
            // Sync (occasionally resolve mid-stream too, like a live user).
            _ => {
                let d = rng.below(devices.len());
                devices[d].sync();
                let _ = devices[d].resolve_all_conflicts();
            }
        }
    }

    // Settle: sync + auto-resolve to a fixpoint. Copies created join the set.
    let copies = quiesce_with_resolve(&devices, 80);
    all.extend(copies);
    // A couple of plain rounds so the last copies fully replicate.
    quiesce(&devices, 20);

    assert_no_conflicts(&devices);
    assert_same_blob_sets(&devices);
    assert_converged(&devices, &all);
}

/// CHAOS fuzz — throws the FULL op set, INCLUDING the two known-buggy ops
/// (`autosave_resave`, `empty_trash_buggy`), at the engine. It deliberately does
/// NOT assert convergence (the known bugs break that). Instead it asserts the
/// orthogonal LIVENESS + INTEGRITY properties the known bugs do NOT violate, so
/// a failure here is a DIFFERENT, new class of bug hiding underneath:
///   1. no sync ever errors (every cycle returns Ok — `sync()` panics on Err),
///   2. the system still reaches quiescence (no infinite push/pull livelock),
///   3. every blob on every device still decrypts (no corruption / half-write).
#[test]
fn discovery_chaos_fuzz_liveness_and_integrity() {
    let (_guard, url) = server_or_skip!("chaos_fuzz");
    let acct = Account::new(0xF1);
    let devices = enroll_devices(&acct, &url, 3);
    let mut rng = Rng(0xCA05_CA05_CA05_CA05);

    let mut live: Vec<NoteId> = Vec::new();
    let mut ctr: u64 = 0;

    for _ in 0..140 {
        match rng.below(7) {
            0 => {
                let d = rng.below(devices.len());
                live.push(devices[d].create_note(format!("c{}", live.len()).as_bytes()));
            }
            1 if !live.is_empty() => {
                let id = live[rng.below(live.len())];
                if let Some(d) = (0..devices.len()).find(|&i| devices[i].read_note(&id).is_some()) {
                    ctr += 1;
                    devices[d].edit_note(&id, format!("x{ctr}").as_bytes());
                }
            }
            // Known-buggy op 1: autosave re-save of a held note.
            2 if !live.is_empty() => {
                let id = live[rng.below(live.len())];
                if let Some(d) = (0..devices.len()).find(|&i| devices[i].read_note(&id).is_some()) {
                    devices[d].autosave_resave(&id);
                }
            }
            // Known-buggy op 2: empty-trash bare-unlink.
            3 if !live.is_empty() => {
                let idx = rng.below(live.len());
                let id = live[idx];
                if let Some(d) = (0..devices.len()).find(|&i| devices[i].read_note(&id).is_some()) {
                    devices[d].empty_trash_buggy(&id);
                }
                live.remove(idx);
            }
            4 if !live.is_empty() => {
                let id = live[rng.below(live.len())];
                if let Some(d) = (0..devices.len()).find(|&i| devices[i].read_note(&id).is_some()) {
                    devices[d].move_to_trash(&id);
                }
            }
            // Sync + best-effort resolve (a real client drains conflicts).
            _ => {
                let d = rng.below(devices.len());
                devices[d].sync();
                let _ = devices[d].resolve_all_conflicts();
            }
        }
    }

    // LIVENESS: the system must settle (no endless churn) even after the chaos.
    let settled = quiesce_with_resolve(&devices, 100);
    let _ = settled;
    let reached = quiesce_reached(&devices, 60);
    assert!(
        reached,
        "chaos run never reached quiescence (livelock / endless push-pull)"
    );

    // INTEGRITY: nothing on disk is corrupt — every blob still decrypts.
    for d in &devices {
        d.assert_all_blobs_decrypt();
    }
}

/// SOAK — a big, slow exploratory run (many seeds × long sequences) over the
/// SAFE op set. `#[ignore]`d for time (it is NOT a known-bug RED): run on demand
/// with `-- --ignored` to hunt for rare convergence bugs the short fuzz misses.
#[test]
#[ignore = "SOAK: slow on-demand exploratory run (not a known-bug RED) — run with --ignored"]
fn discovery_soak_fuzz_safe_ops_converge() {
    let (_guard, url) = server_or_skip!("soak_fuzz");

    for seed_ix in 0..24u64 {
        let acct = Account::new(0x01u8.wrapping_add(seed_ix as u8));
        let devices = enroll_devices(&acct, &url, 3);
        let mut rng = Rng(0x50A4_0000_0000_0001 ^ seed_ix.wrapping_mul(0x9E37_79B9_7F4A_7C15));

        let mut all: Vec<NoteId> = Vec::new();
        let mut live: Vec<(NoteId, usize)> = Vec::new();
        let mut ctr: u64 = 0;

        for _ in 0..220 {
            match rng.below(6) {
                0 => {
                    let owner = rng.below(devices.len());
                    let id = devices[owner].create_note(format!("n{}", all.len()).as_bytes());
                    all.push(id);
                    live.push((id, owner));
                }
                1 if !live.is_empty() => {
                    let (id, owner) = live[rng.below(live.len())];
                    ctr += 1;
                    devices[owner].edit_note(&id, format!("e{ctr}").as_bytes());
                }
                2 if !live.is_empty() => {
                    let (id, owner) = live[rng.below(live.len())];
                    devices[owner].move_to_trash(&id);
                }
                3 if !live.is_empty() => {
                    let idx = rng.below(live.len());
                    let (id, owner) = live[idx];
                    devices[owner].delete_routed(&id);
                    live.remove(idx);
                }
                _ => {
                    devices[rng.below(devices.len())].sync();
                }
            }
        }

        let reached = quiesce_reached(&devices, 60);
        assert!(reached, "seed {seed_ix}: never quiesced");
        assert_converged(&devices, &all);
        assert_same_blob_sets(&devices);
        assert_no_conflicts(&devices);
    }
}

/// EDGE payloads: an empty-body note and a multi-megabyte note both replicate
/// and converge (exercises the page-size / body-size boundaries of the blob
/// pipeline end to end).
#[test]
fn discovery_empty_and_large_payloads_converge() {
    let (_guard, url) = server_or_skip!("edge_payloads");
    let acct = Account::new(0xF2);
    let devices = enroll_devices(&acct, &url, 2);

    let empty = devices[0].create_note(b"");
    let big_body = vec![b'x'; 1_500_000]; // ~1.5 MB
    let big = devices[0].create_note(&big_body);
    quiesce(&devices, 12);

    assert_converged(&devices, &[empty, big]);
    assert_same_blob_sets(&devices);
    assert_eq!(devices[1].read_note(&empty).as_deref(), Some(&b""[..]));
    assert_eq!(
        devices[1].read_note(&big).map(|v| v.len()),
        Some(big_body.len())
    );
    for d in &devices {
        d.assert_all_blobs_decrypt();
    }
}

/// RAPID create → edit → delete → edit (resurrect) on one device, all before the
/// peer syncs, then converge. A burst of versions on a single id must collapse
/// to the last write everywhere (no stale-version resurrection).
#[test]
fn discovery_rapid_edit_delete_edit_converges() {
    let (_guard, url) = server_or_skip!("rapid_churn");
    let acct = Account::new(0xF3);
    let devices = enroll_devices(&acct, &url, 2);
    let a = &devices[0];

    let n = a.create_note(b"first");
    a.edit_note(&n, b"second");
    a.delete_routed(&n); // deleted: marker
    a.edit_note(&n, b"resurrected final"); // overwrite the deletion locally
    quiesce(&devices, 12);

    assert_eq!(
        devices[1].read_note(&n).as_deref(),
        Some(&b"resurrected final"[..]),
        "B must land on A's LAST write, not a stale intermediate"
    );
    assert_converged(&devices, &[n]);
    assert_same_blob_sets(&devices);
    assert_no_conflicts(&devices);
}

// ---------------------------------------------------------------------------
// Fault-injection tier (P0-4): transport faults + server crash/restart. The
// orchestrator/transport-layer complement to loop_control's re-arm unit tests.
// ---------------------------------------------------------------------------

/// A push that fails transiently (socket-level, mid-outage) must neither lose
/// nor duplicate the edit: the failed attempts leave the baseline untouched, the
/// recovered attempt pushes exactly once, and the fleet converges conflict-free.
#[test]
fn sim_push_fail_then_recover_converges() {
    use crate::plugins::sync::engine::PushError;
    use crate::plugins::sync::orchestrator::SyncCycleError;
    use crate::plugins::sync::transport::{FaultInjectingTransport, FaultMode};

    let (_guard, url) = server_or_skip!("push_fail_recover");
    let acct = Account::new(0xE1);
    let mut devices = enroll_devices(&acct, &url, 2);

    let n = devices[0].create_note(b"survives the outage");
    devices[0].sync();
    devices[1].sync();

    // The edit whose push will hit the outage.
    devices[0].edit_note(&n, b"edited during the outage");
    let inner = crate::plugins::sync::http_transport::build_transport(&url, Vec::new()).unwrap();
    devices[0].transport = Box::new(FaultInjectingTransport::fail_path(
        inner,
        "/sync/push",
        2,
        FaultMode::Network,
    ));

    // Two faulted attempts: the pull leg succeeds, the push leg fails below
    // HTTP — the exact offline-blip shape.
    for attempt in 0..2 {
        match devices[0].try_sync() {
            Err(SyncCycleError::Push(PushError::Transport(_))) => {}
            other => panic!("attempt {attempt}: expected Push(Transport), got {other:?}"),
        }
    }

    // Healed: the third attempt pushes the edit exactly once (a failed attempt
    // must not have advanced the baseline behind the server's back).
    let s = devices[0].try_sync().expect("healed cycle");
    assert_eq!(s.pushed, 1, "the stranded edit pushes exactly once");

    devices[1].sync();
    assert_eq!(
        devices[1].read_note(&n).as_deref(),
        Some(&b"edited during the outage"[..])
    );
    assert_converged(&devices, &[n]);
    assert_same_blob_sets(&devices);
    assert_no_conflicts(&devices);
    for d in &devices {
        d.assert_all_blobs_decrypt();
    }
}

/// FSStore server kill + same-port respawn (the production systemd topology):
/// tokens survive (auth continuity), cursors survive (B pulls ONLY the delta,
/// no re-download, no 410/reconcile), and the head chain extends cleanly.
#[test]
fn sim_fs_server_restart_preserves_cursor_and_head() {
    use crate::plugins::sync::orchestrator::SyncCycleError;

    let storage = std::env::temp_dir().join(format!("myne-sim-fsrestart-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&storage);
    let opts = ServerOpts {
        storage_dir: Some(storage.clone()),
        ..Default::default()
    };
    let Some((mut guard, url)) = spawn_server_with(&opts) else {
        eprintln!(
            "SKIP sim_fs_server_restart: myne-server binary not found \
             (cd myne-server && go build -o myne-server ./cmd/myne-server)"
        );
        return;
    };
    let port: u16 = url.rsplit(':').next().unwrap().parse().unwrap();

    let acct = Account::new(0xE7);
    let devices = enroll_devices(&acct, &url, 2);
    let n1 = devices[0].create_note(b"note one");
    let n2 = devices[0].create_note(b"note two");
    let n3 = devices[0].create_note(b"note three");
    devices[0].sync();
    let pulled = devices[1].sync();
    assert_eq!(pulled.pulled, 3, "B holds the full vault pre-crash");

    // The auth state is persisted by a DEBOUNCED coalescer (authpersist) — wait
    // for auth.json to land so the crash models the realistic shape (devices
    // enrolled long before the crash), not a kill inside the first debounce
    // window (whose loss is documented, accepted coalescer behavior).
    let auth_json = storage.join("auth.json");
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
    while !auth_json.exists() && std::time::Instant::now() < deadline {
        std::thread::sleep(std::time::Duration::from_millis(50));
    }
    assert!(auth_json.exists(), "authpersist flushed before the crash");

    // Crash. An edit made during the outage fails with a transport error.
    guard.kill_now();
    devices[0].edit_note(&n1, b"edited across the restart");
    match devices[0].try_sync() {
        Err(SyncCycleError::Pull(_) | SyncCycleError::Push(_)) => {}
        other => panic!("expected a transport-shaped failure, got {other:?}"),
    }

    // Respawn on the SAME port over the SAME FSStore root.
    let reopts = ServerOpts {
        addr: Some(format!("127.0.0.1:{port}")),
        storage_dir: Some(storage.clone()),
        ..Default::default()
    };
    let Some((_guard2, url2)) = spawn_server_with(&reopts) else {
        eprintln!("SKIP sim_fs_server_restart: fixed-port respawn did not come up");
        return;
    };
    assert_eq!(url2, url, "respawn re-bound the original address");

    // Auth continuity: the stored token still works — no re-enroll.
    let s_a = devices[0].try_sync().expect("A pushes after the restart");
    assert_eq!(s_a.pushed, 1, "exactly the stranded edit");
    assert!(!s_a.reconcile_ran, "no 410/reconcile — the cursor survived");

    // Cursor continuity: B pulls ONLY the delta, not the whole vault again.
    let s_b = devices[1].try_sync().expect("B pulls after the restart");
    assert_eq!(s_b.pulled, 1, "delta only — cursors survived the restart");
    assert!(!s_b.reconcile_ran);

    assert_converged(&devices, &[n1, n2, n3]);
    assert_same_blob_sets(&devices);
    assert_no_conflicts(&devices);
    for d in &devices {
        d.assert_all_blobs_decrypt();
    }
    let _ = std::fs::remove_dir_all(&storage);
}
