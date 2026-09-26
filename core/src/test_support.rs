//! Cross-plugin test fixtures.
//!
//! The vault-creation, vault-unlock, and vault-recover plugins each
//! exercise the same on-disk shape — a `vault.meta` file under a
//! short-lived temp directory, sealed with an Argon2id parameter set
//! that runs in microseconds rather than the production ~1 s.
//!
//! This module hosts the shared pieces. Per-plugin test files still
//! own the bits that genuinely differ (e.g. each plugin's `seed_*`
//! helpers return different tuples depending on which side of the
//! flow they exercise).

use protocol::KdfParams;
use std::path::{Path, PathBuf};

/// Fast Argon2id parameters for tests — pinned to the `validate_kdf_params`
/// memory floor (`MIN_KDF_M_KIB` = 8 MiB) so vaults built with these still
/// pass the unlock/recover/change-password range gate, while staying ~32×
/// cheaper than production (256 MiB). Production never uses these —
/// `protocol::DEFAULT_V0_1_KDF_PARAMS` is the only set used at runtime.
pub const FAST_TEST_KDF: KdfParams = KdfParams {
    m_kib: protocol::MIN_KDF_M_KIB,
    t: 1,
    p: 1,
    argon2_version: 0x13,
};

/// Scoped temp directory holding a single `vault.meta`. Caller writes
/// the bytes via [`Self::write_meta`]; the `Drop` impl removes the
/// directory tree at end of scope.
pub struct ScratchVault {
    pub dir: PathBuf,
    meta_path: PathBuf,
}

impl ScratchVault {
    pub fn new(label: &str) -> Self {
        let dir = std::env::temp_dir().join(format!("myne_{label}_{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).expect("create scratch dir");
        let meta_path = dir.join("vault.meta");
        Self { dir, meta_path }
    }

    pub fn path(&self) -> &Path {
        &self.meta_path
    }

    pub fn write_meta(&self, bytes: &[u8]) {
        std::fs::write(&self.meta_path, bytes).expect("write vault.meta");
    }
}

impl Drop for ScratchVault {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

/// Generic self-cleaning scratch directory for tests that don't need
/// `ScratchVault`'s vault-meta convenience. Creates a unique-named dir
/// under `std::env::temp_dir()` and removes it on drop. Avoids pulling
/// `tempfile` as a dev-dep just to provide the same shape (TB9
/// minimal-dep posture).
pub struct ScopedTempDir {
    path: PathBuf,
}

impl ScopedTempDir {
    pub fn new(label: &str) -> std::io::Result<Self> {
        // UUID suffix (not a timestamp) so parallel tests sharing a label never
        // collide on one directory — a collision lets one test's `Drop`
        // `remove_dir_all` delete another's `vault.meta` mid-run. Mirrors the
        // sibling `ScratchVault::new` above.
        let path = std::env::temp_dir().join(format!("myne-test-{label}-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&path)?;
        Ok(Self { path })
    }

    pub fn path(&self) -> &Path {
        &self.path
    }
}

impl Drop for ScopedTempDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.path);
    }
}

/// Write a REAL, structurally-parseable 345-byte `vault.meta` into `dir`
/// with `account_number_hash` = `seed_byte` repeating (filler key material;
/// parse-passes, never unlock-passes). Shared by the prefs + backup test
/// suites — the restore validator's stage-5 parse needs a real header.
pub fn seed_real_vault_meta(dir: &Path, seed_byte: u8) {
    let meta = protocol::VaultMeta {
        account_number_hash: [seed_byte; 16],
        kdf_params: protocol::DEFAULT_V0_1_KDF_PARAMS,
        random_salt_password: [1u8; 16],
        random_salt_recovery: [2u8; 16],
        nonce_password_wrap: [3u8; 24],
        enc_root_key_password: [4u8; 64],
        nonce_recovery_wrap: [5u8; 24],
        enc_root_key_recovery: [6u8; 64],
        items_key_id: [7u8; 16],
        items_key_nonce: [8u8; 24],
        enc_items_key: [9u8; 64],
        membership: None,
        person_binding: None,
    };
    std::fs::write(
        dir.join("vault.meta"),
        protocol::serialize_vault_meta(&meta),
    )
    .expect("seed vault.meta");
}

/// Drive an async body to completion on a throwaway current-thread runtime.
///
/// # Why a test helper needs to exist at all
///
/// phase3-web-client task 86 made the sync engine `async` — `run_sync_cycle`
/// and every sidecar reader now go through the storage seam, and the seam is
/// async because OPFS handle acquisition is. The engine's test suites are
/// deliberately **synchronous**: the two-device scenarios and the simulation
/// harness drive a deterministic timeline step by step, and rewriting them as
/// async would have buried a behavioural diff in mechanical noise.
///
/// So each step is driven on a runtime, and the construction lives here rather
/// than at ~30 call sites, for a reason beyond tidiness:
/// `scripts/check-core-task-seam.mjs` bans `tokio::runtime::` throughout
/// `core/` — correctly, since wasm32 has no runtime to build. This module
/// compiles only under `test` / `test-support`, so it is the one honest place
/// for the exception, and the guard grants exactly one entry rather than one per
/// harness.
///
/// A **current-thread** runtime specifically: the callers are synchronous test
/// bodies that own their thread, and a multi-thread runtime would add worker
/// threads whose scheduling the deterministic scenarios do not want.
pub fn block_on<F: std::future::Future>(f: F) -> F::Output {
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("current-thread runtime build")
        .block_on(f)
}

/// A [`crate::vault_io::VaultIo`] that routes container-mode paths through
/// [`crate::double_buffer`], exactly as the browser's OPFS arm does.
///
/// # Why this exists
///
/// The container's own crash tests drive `write_next_faulting` directly against
/// a raw store, which proves the ALGORITHM. What they cannot show is the thing
/// task 86's criterion actually asks for — that a sidecar's own reader
/// (`read_sync_state`, `read_config`, …) sees "the previous copy" after a torn
/// write rather than a default or an error — because those readers call
/// `io.read(path)` and a raw store hands them the plain path.
///
/// This is the missing middle: the same routing decision `OpfsVaultIo` makes
/// (`is_container` → container; otherwise → the file), over a real temp
/// directory, so the sidecar readers can be driven end to end on the host.
///
/// It is NOT a fake. Every byte goes through `crate::double_buffer` and lands on
/// disk through [`crate::vault_io::StdVaultIo`]; only the *choice* of layout is
/// reproduced here rather than imported from the wasm crate, which `myne-core`
/// cannot depend on.
#[derive(Debug, Default, Clone, Copy)]
pub struct ContainerVaultIo;

#[cfg_attr(not(target_arch = "wasm32"), async_trait::async_trait)]
#[cfg_attr(target_arch = "wasm32", async_trait::async_trait(?Send))]
impl crate::vault_io::VaultIo for ContainerVaultIo {
    async fn read(&self, path: &Path) -> crate::vault_io::IoResult<Vec<u8>> {
        let name = path.to_string_lossy();
        if crate::double_buffer::is_container(&name) {
            let mut found =
                crate::double_buffer::candidates(&crate::vault_io::StdVaultIo, path).await?;
            return if found.is_empty() {
                Err(crate::io_failure_kind::IoFailureKind::NotFound)
            } else {
                Ok(found.remove(0))
            };
        }
        crate::vault_io::StdVaultIo.read(path).await
    }

    async fn read_candidates(&self, path: &Path) -> crate::vault_io::IoResult<Vec<Vec<u8>>> {
        let name = path.to_string_lossy();
        if crate::double_buffer::is_container(&name) {
            return crate::double_buffer::candidates(&crate::vault_io::StdVaultIo, path).await;
        }
        match self.read(path).await {
            Ok(bytes) => Ok(vec![bytes]),
            Err(crate::io_failure_kind::IoFailureKind::NotFound) => Ok(Vec::new()),
            Err(e) => Err(e),
        }
    }

    async fn read_prefix(&self, path: &Path, len: usize) -> crate::vault_io::IoResult<Vec<u8>> {
        // Container-aware, matching the OPFS arm — and this helper carried the
        // SAME wrong assumption the production code did, which is why no test
        // in `core` ever saw the bug: a raw prefix read of `notes/<uuid>.myn`
        // finds nothing, because the bytes live at `<path>.a` behind an 8-byte
        // generation frame. `note_nonce`'s scan `continue`s past any note whose
        // header will not read, so the unsynced set came back empty forever and
        // a browser pushed nothing it wrote.
        //
        // The recursion the old comment feared does not happen: `slot_generations`
        // calls this with the SLOT path (`<base>.a`), and a slot path is not a
        // container (`mode_for` matches on the `.myn` suffix, which `.myn.a`
        // does not have), so it takes the raw arm below and terminates.
        let name = path.to_string_lossy();
        if crate::double_buffer::is_container(&name) {
            let found =
                crate::double_buffer::candidates(&crate::vault_io::StdVaultIo, path).await?;
            let Some(first) = found.into_iter().next() else {
                return Err(crate::io_failure_kind::IoFailureKind::NotFound);
            };
            return Ok(first.into_iter().take(len).collect());
        }
        crate::vault_io::StdVaultIo.read_prefix(path, len).await
    }

    async fn write(
        &self,
        path: &Path,
        bytes: &[u8],
        opts: crate::vault_io::WriteOpts,
    ) -> crate::vault_io::IoResult<()> {
        let name = path.to_string_lossy();
        match crate::double_buffer::mode_for(&name) {
            crate::double_buffer::Mode::Doubled => {
                crate::double_buffer::write_next(&crate::vault_io::StdVaultIo, path, bytes).await
            }
            crate::double_buffer::Mode::SingleLive => {
                crate::double_buffer::write_single_live(&crate::vault_io::StdVaultIo, path, bytes)
                    .await
            }
            crate::double_buffer::Mode::Plain => {
                crate::vault_io::StdVaultIo.write(path, bytes, opts).await
            }
        }
    }

    async fn remove_file(&self, path: &Path) -> crate::vault_io::IoResult<()> {
        let name = path.to_string_lossy();
        if crate::double_buffer::is_container(&name) {
            return crate::double_buffer::remove_all(&crate::vault_io::StdVaultIo, path).await;
        }
        crate::vault_io::StdVaultIo.remove_file(path).await
    }

    async fn remove_dir_all(&self, path: &Path) -> crate::vault_io::IoResult<()> {
        crate::vault_io::StdVaultIo.remove_dir_all(path).await
    }

    async fn create_dir_all(&self, path: &Path) -> crate::vault_io::IoResult<()> {
        crate::vault_io::StdVaultIo.create_dir_all(path).await
    }

    async fn read_dir(
        &self,
        path: &Path,
    ) -> crate::vault_io::IoResult<Vec<crate::vault_io::DirEntry>> {
        // Slot suffixes mapped back and de-duplicated, as the OPFS arm does —
        // without this a `notes/` listing invents a note whose id ends `.myn.a`.
        let raw = crate::vault_io::StdVaultIo.read_dir(path).await?;
        let mut out: Vec<crate::vault_io::DirEntry> = Vec::with_capacity(raw.len());
        for e in raw {
            let name = crate::double_buffer::strip_slot_suffix(&e.name)
                .map(|b| b.to_string())
                .unwrap_or(e.name);
            if !out.iter().any(|x| x.name == name) {
                out.push(crate::vault_io::DirEntry {
                    name,
                    is_dir: e.is_dir,
                });
            }
        }
        Ok(out)
    }

    async fn exists(&self, path: &Path) -> crate::vault_io::IoResult<bool> {
        let name = path.to_string_lossy();
        if crate::double_buffer::is_container(&name) {
            return Ok(
                !crate::double_buffer::candidates(&crate::vault_io::StdVaultIo, path)
                    .await?
                    .is_empty(),
            );
        }
        crate::vault_io::StdVaultIo.exists(path).await
    }

    async fn is_dir(&self, path: &Path) -> crate::vault_io::IoResult<bool> {
        crate::vault_io::StdVaultIo.is_dir(path).await
    }

    async fn rename(&self, from: &Path, to: &Path) -> crate::vault_io::IoResult<()> {
        crate::vault_io::StdVaultIo.rename(from, to).await
    }
}

/// A [`crate::hooks::VaultLifecycleHooks`] that records the teardown calls it
/// receives, in order, and no-ops everything else.
///
/// Shared rather than per-plugin because more than one slot-drop path owes the
/// SAME teardown vector, and the whole value of the assertion is that the paths
/// are compared against one another: `lock_from_host` (the manual + auto lock)
/// and the change-password force-relock each drop `Slot::Unlocked` to `Empty`,
/// and `spec/protocol.md` §9.8.5 (`vault.indices`) and §9.17.5
/// (`vault.embeddings`) both say the decrypted material is zeroized at **every**
/// such site. A recorder private to one test module cannot express that.
///
/// It also records hooks a given path deliberately does NOT call —
/// `persist_search_index` and `apply_screen_capture` among them — so a
/// whole-vector equality pins their ABSENCE as much as the presence of the ones
/// that are owed.
///
/// **What it cannot see**, stated here so no test built on it claims more than
/// it proves: this is a test double. It observes which hooks a core path FIRES,
/// never what a real client's hook body DOES. A client that implements a hook as
/// an empty body satisfies every assertion built on this recorder — which is
/// exactly how myne-md/myne#454 shipped. `scripts/check-lock-teardown.mjs`
/// covers that half; the two are complementary and neither subsumes the other.
pub struct RecordingHooks {
    calls: std::sync::Mutex<Vec<&'static str>>,
    /// Optional REAL index this recorder wipes in `zeroize_vault_indices`, the
    /// way a client's hook body does. Present, a test can assert the resulting
    /// STATE (the index is empty) rather than only the recorded call — the
    /// stronger of the two available assertions, per the repo's own rule.
    indices: Option<std::sync::Arc<crate::plugins::vault_indices::state::VaultIndicesState>>,
}

impl RecordingHooks {
    pub fn new() -> std::sync::Arc<Self> {
        std::sync::Arc::new(Self {
            calls: std::sync::Mutex::new(Vec::new()),
            indices: None,
        })
    }

    /// A recorder that also does what a client's `zeroize_vault_indices` body
    /// does: `clear()` a real [`VaultIndicesState`]. Lets a slot-drop test
    /// assert the index is EMPTY afterwards, not merely that a hook fired.
    pub fn with_indices(
        indices: std::sync::Arc<crate::plugins::vault_indices::state::VaultIndicesState>,
    ) -> std::sync::Arc<Self> {
        std::sync::Arc::new(Self {
            calls: std::sync::Mutex::new(Vec::new()),
            indices: Some(indices),
        })
    }

    fn record(&self, name: &'static str) {
        self.calls.lock().expect("recording hooks mutex").push(name);
    }

    /// Everything recorded so far, oldest first.
    pub fn calls(&self) -> Vec<&'static str> {
        self.calls.lock().expect("recording hooks mutex").clone()
    }
}

impl crate::hooks::VaultLifecycleHooks for RecordingHooks {
    fn hydrate_attachment_refs<'a>(
        &'a self,
        _: &'a crate::plugins::vault_unlock::state::VaultRuntimeState,
    ) -> crate::hooks::BoxFuture<'a> {
        Box::pin(std::future::ready(()))
    }
    fn hydrate_search_index<'a>(
        &'a self,
        _: &'a crate::plugins::vault_unlock::state::VaultRuntimeState,
    ) -> crate::hooks::BoxFuture<'a> {
        Box::pin(std::future::ready(()))
    }
    fn hydrate_spell<'a>(
        &'a self,
        _: &'a crate::plugins::vault_unlock::state::VaultRuntimeState,
    ) -> crate::hooks::BoxFuture<'a> {
        Box::pin(std::future::ready(()))
    }
    fn reclaim_stray_attachment_blobs<'a>(
        &'a self,
        _: &'a crate::plugins::vault_unlock::state::VaultRuntimeState,
    ) -> crate::hooks::BoxFuture<'a> {
        Box::pin(std::future::ready(()))
    }
    fn persist_search_index<'a>(
        &'a self,
        _: &'a crate::plugins::vault_unlock::state::VaultRuntimeState,
    ) -> crate::hooks::BoxFuture<'a> {
        self.record("persist_search_index");
        Box::pin(std::future::ready(()))
    }
    fn hydrate_ai_vectors<'a>(
        &'a self,
        _: &'a crate::plugins::vault_unlock::state::VaultRuntimeState,
    ) -> crate::hooks::BoxFuture<'a> {
        Box::pin(std::future::ready(()))
    }
    fn index_note_attachments<'a>(
        &'a self,
        _: &'a crate::plugins::vault_unlock::state::VaultRuntimeState,
        _: &'a str,
        _: &'a str,
        _: &'a str,
    ) -> crate::hooks::BoxFuture<'a> {
        Box::pin(std::future::ready(()))
    }
    fn zeroize_search_index(&self) {
        self.record("zeroize_search_index");
    }
    fn zeroize_spell(&self) {
        self.record("zeroize_spell");
    }
    fn zeroize_vault_indices(&self) {
        self.record("zeroize_vault_indices");
        // Stand in for a client's hook body when the test supplied a real
        // index, so the assertion can be about the index rather than about
        // this recorder.
        if let Some(indices) = &self.indices {
            indices.clear();
        }
    }
    fn zeroize_attachment_refs(&self) {
        self.record("zeroize_attachment_refs");
    }
    fn abort_active_recording(&self) {
        self.record("abort_active_recording");
    }
    fn pdf_export_teardown_on_lock(&self) {
        self.record("pdf_export_teardown_on_lock");
    }
    fn agent_teardown_on_lock(&self) {
        self.record("agent_teardown_on_lock");
    }
    fn detached_windows_teardown_on_lock(&self) {
        self.record("detached_windows_teardown_on_lock");
    }
    fn clear_staged_descriptor(&self) {
        self.record("clear_staged_descriptor");
    }
    fn apply_screen_capture(&self, _: bool, _: &'static str) {
        self.record("apply_screen_capture");
    }
    fn search_upsert(&self, _: &str, _: &str, _: &str) {}
    fn search_remove(&self, _: &str) {}
    fn ai_note_changed(&self, _: &str, _: &str) {}
    fn ai_note_deleted(&self, _: &str) {}
    fn ai_policy_changed(&self, _: bool, _: &[String]) {}
    fn bump_local_change(&self) {}
    fn emit_snapshot_write_failed(&self, _: &str) {}
    fn emit_notes_deleted(&self, _: &str) {
        self.record("emit_notes_deleted");
    }
    // `effective_auto_lock_secs` deliberately not overridden: the trait's
    // default clamps (myne-md/myne#479). This body used to be the unclamped
    // `unwrap_or`, which is the exact shape that change removed from two
    // production clients, so a fixture carrying it handed the next author
    // the defect as the copyable example.
    fn hydrate_clipper_pairing(&self, _: &[protocol::PairedExtension]) {}
    fn preempt_inflight_backup<'a>(
        &'a self,
        _: &'a crate::plugins::vault_unlock::state::VaultRuntimeState,
    ) -> crate::hooks::BoxFuture<'a> {
        Box::pin(std::future::ready(()))
    }
    fn invalidate_quick_unlock(&self, _: &Path) {}
    fn capture_snapshot(&self, _: &Path, _: &str, _: &[u8], _: u64, _: bool) -> bool {
        false
    }
    fn purge_note_snapshots(&self, _: &Path, _: &str) -> std::io::Result<usize> {
        Ok(0)
    }
}
