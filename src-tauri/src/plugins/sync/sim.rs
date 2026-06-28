//! Multi-device sync **simulation harness** (Phase 1 of the sync test-env work).
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
impl Drop for ServerGuard {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

fn server_binary() -> Option<PathBuf> {
    if let Ok(p) = std::env::var("MYNE_E2E_SERVER") {
        let p = PathBuf::from(p);
        return p.exists().then_some(p);
    }
    // `cargo test` CWD = the crate dir (src-tauri/); the server is a sibling.
    let p = PathBuf::from("../myne-server/myne-server");
    p.exists().then_some(p)
}

/// Spawn an ephemeral in-memory server; return (guard, base_url). Per-call
/// unique portfile dir so concurrent tests don't race. Rate limit is lifted —
/// these tests exercise sync correctness, not abuse throttling.
fn spawn_server() -> Option<(ServerGuard, String)> {
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
    let child = std::process::Command::new(&bin)
        .env("MYNE_SERVER_ADDR", "127.0.0.1:0")
        .env("MYNE_SERVER_PORTFILE", &portfile)
        .env("MYNE_RATELIMIT_BURST", "1000000")
        .env("MYNE_RATELIMIT_REFILL", "1000000")
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

fn hex(bytes: &[u8]) -> String {
    let mut s = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        s.push_str(&format!("{b:02x}"));
    }
    s
}

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
    username: String,
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
            username: format!("MY-SIM-{seed:02X}"),
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
            enroll::register_verifier(
                t.as_ref(),
                &acct.account_hash,
                &acct.username,
                &acct.secret(),
            )
            .unwrap();
        }
        let device_id = enroll::generate_device_id();
        let out = enroll::enroll(
            t.as_ref(),
            &acct.account_hash,
            &acct.username,
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
        let _ = add_pending_tombstone(&self.vault_dir, &Self::id_hex(id));
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
            let _ = add_pending_tombstone(&self.vault_dir, &Self::id_hex(id));
        }
    }

    /// One full sync cycle (pull → detect → push), the wired engine loop.
    fn sync(&self) -> SyncSummary {
        run_sync_cycle(
            self.transport.as_ref(),
            &self.acct.root_key,
            self.acct.account_hash,
            self.device_id,
            &self.token,
            &self.notes_dir,
            &self.vault_dir,
            true,
        )
        .expect("sync cycle")
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
        list_pending_conflicts(&self.vault_dir)
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
                read_staged_conflict_blob(&self.vault_dir, &id_hex),
            ) {
                if let Ok(dec) =
                    decode_note(&blob, &idb, &self.acct.items_key, &self.acct.items_key_id)
                {
                    copies.push(self.create_note(dec.plaintext()));
                }
            }
            let _ = resolve_conflict(&self.vault_dir, &id_hex);
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
        let _ = resolve_conflict(&self.vault_dir, &Self::id_hex(id));
    }

    /// Decrypt the remote revision staged as a keep-both conflict for `id`
    /// (the bytes the notes layer would turn into a "conflict copy"). `None` if
    /// nothing is staged for that note.
    fn read_staged_conflict(&self, id: &NoteId) -> Option<Vec<u8>> {
        let blob = read_staged_conflict_blob(&self.vault_dir, &Self::id_hex(id))?;
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
