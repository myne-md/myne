//! Tauri commands for the vault-unlock plugin.
//!
//! - [`unlock`] — read `vault.meta`, derive `password_wrap_key`
//!   (Argon2id), AEAD-decrypt `enc_root_key_password`, eager-derive
//!   plus AEAD-decrypt the singleton `itemsKey`, populate the
//!   single-slot [`super::state::VaultRuntimeState`].
//! - [`lock`] — companion: drop the slot, zeroize the keys, return
//!   `Ok(())`. Param-less, idempotent.
//!
//! Design history: `agent-tooling/features/vault-unlock-password/`
//! (PRD + task log) and the grilling session referenced from
//! `super::mod.rs`.
//!
//! See: ../../CLAUDE.md "Secret-handling logging discipline".

use super::error::{VaultStatusError, VaultUnlockError};
use super::state::{UnlockedVault, VaultRuntimeState};
use crate::io_failure_kind::{from_io_error_kind, IoFailureKind};
use protocol::{VaultMeta, AEAD_KEY_LEN, AEAD_NONCE_LEN};
use serde::Serialize;
use std::path::{Path, PathBuf};
use std::time::Instant;
use tauri::{AppHandle, Manager, Runtime, State};
use zeroize::Zeroizing;

/// Map a `protocol::ProtocolError` variant to a `'static` string for
/// structured logging. **Static-only by design**: passing the
/// `ProtocolError` itself to `tracing::error!(...)` via `?e` would
/// also yield the variant name (all variants are unit), but using a
/// helper keeps the discipline explicit — emit only bounded enum
/// names, never values. See `src-tauri/CLAUDE.md` "Secret-handling
/// logging discipline".
fn protocol_error_kind(e: &protocol::ProtocolError) -> &'static str {
    match e {
        protocol::ProtocolError::InvalidPassword => "InvalidPassword",
        protocol::ProtocolError::PasswordTooShort => "PasswordTooShort",
        protocol::ProtocolError::KdfFailure => "KdfFailure",
        protocol::ProtocolError::AeadFailure => "AeadFailure",
        protocol::ProtocolError::InvalidVaultMeta => "InvalidVaultMeta",
        protocol::ProtocolError::AccountNumberInvalid => "AccountNumberInvalid",
        protocol::ProtocolError::Csprng => "Csprng",
    }
}

/// Bundle returned by the spawn_blocking pipeline closure: both
/// derived keys (Zeroizing-wrapped; bytes wipe on drop, including
/// the early-return paths inside the closure when items_key
/// derivation fails) plus the `items_key_id` UUID parsed out of
/// `vault.meta` (not secret-bearing; copy is cheap).
struct DerivedKeys {
    root_key: Zeroizing<[u8; AEAD_KEY_LEN]>,
    items_key: Zeroizing<[u8; AEAD_KEY_LEN]>,
    items_key_id: [u8; 16],
}

/// Resolve `<app_data_dir>/vault/vault.meta` for the running app.
///
/// Distinct from `crate::paths::vault_dir` (which lives in the
/// `vault_creation` plugin's error-type universe). This helper returns
/// `VaultUnlockError` so callers in this plugin do not need a cross-
/// plugin error conversion.
///
/// Does NOT call `create_dir_all` — unlock is a read-only operation;
/// if the vault directory does not exist, the subsequent `fs::read`
/// will return `NotFound`, which the caller maps to
/// [`VaultUnlockError::VaultNotFound`].
fn vault_meta_path<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf, VaultUnlockError> {
    let base = app
        .path()
        .app_data_dir()
        .map_err(|_| VaultUnlockError::IoError {
            io_error_kind: IoFailureKind::Other,
        })?;
    Ok(base.join("vault").join("vault.meta"))
}

/// Open an existing vault with the user's master password.
///
/// On the first line, `password` is moved into a [`Zeroizing<String>`]
/// whose lifetime is bounded by the `spawn_blocking` closure: when the
/// closure ends (success or failure), the wrapper drops and the
/// password's bytes are wiped. The inner derivation helpers borrow
/// `&str` — no clone, no format-arg, no log of the password.
///
/// Internal sequence (permit-first per grilling Q5 +
/// `decisions.md` 2026-05-02 Phase 1 unlock UI semantics):
///
/// 1. Slot peek (cheap read-lock). If the vault is already unlocked,
///    return [`VaultUnlockError::VaultAlreadyUnlocked`] immediately —
///    fast-path observable, never blocks on the permit.
/// 2. `Semaphore::try_acquire` (capacity 1). If another unlock is in
///    flight, return [`VaultUnlockError::UnlockInProgress`] without
///    queueing (rejection posture per `recovery-flow.md` §3.3 — no
///    queue, no sleep-based throttle). The permit is held by an RAII
///    guard for the entire critical section; drops on any return path.
/// 3. Read `<app_data_dir>/vault/vault.meta`.
///    - Missing file → [`VaultUnlockError::VaultNotFound`].
///    - Other IO error → [`VaultUnlockError::IoError`] with
///      bounded [`IoFailureKind`].
/// 4. Parse the bytes via `protocol::parse_vault_meta`.
///    - Reject → [`VaultUnlockError::InvalidVaultMeta`].
/// 5. `tokio::task::spawn_blocking` runs the full key-derivation
///    pipeline (microseconds-fast steps colocated with the ~1 s
///    Argon2id step for code locality):
///    - (a) `derive_root_key` — Argon2id + AEAD-open password wrap.
///      AEAD-tag failure → `InvalidCredentialOrVault` (§7.3).
///    - (b) `derive_items_key` — HKDF subkey + AEAD-open items_key
///      blob. AEAD-tag failure → `InvalidVaultMeta` (per
///      `decisions.md` 2026-05-02 — Task 11). On failure the
///      `root_key` Zeroizing drops on early-return and the slot
///      stays empty (no half-state).
/// 6. Populate [`super::state::VaultRuntimeState`]'s slot with the
///    fully-verified [`UnlockedVault`]. Permit is still held; drops
///    when the function returns.
#[tauri::command]
pub async fn unlock<R: Runtime>(
    password: String,
    state: State<'_, VaultRuntimeState>,
    app: AppHandle<R>,
) -> Result<(), VaultUnlockError> {
    let vault_path = vault_meta_path(&app)?;
    unlock_with_path(password, &vault_path, state.inner()).await
}

/// Testable core of [`unlock`]. The Tauri-command wrapper resolves
/// the platform-specific `vault.meta` path and delegates here so
/// tests do not need an [`AppHandle`].
///
/// All decisions documented on [`unlock`] apply identically.
pub(crate) async fn unlock_with_path(
    password: String,
    vault_path: &Path,
    state: &VaultRuntimeState,
) -> Result<(), VaultUnlockError> {
    // Wrap immediately so any early-return path (VaultAlreadyUnlocked,
    // UnlockInProgress, IO failure, parse failure) drops the wrapper
    // and zeroes the bytes. Plain `String` would drop without zeroize.
    let password = Zeroizing::new(password);

    let started = Instant::now();

    // (1) Slot peek precedes permit acquire so the cheap "already
    //     unlocked" guard never blocks on the semaphore (grilling Q5).
    if state.peek_is_some().await {
        tracing::error!(
            stage = "slot_check",
            error_kind = "VaultAlreadyUnlocked",
            "unlock attempt rejected: slot already populated"
        );
        return Err(VaultUnlockError::VaultAlreadyUnlocked);
    }

    // (2) Acquire the unlock permit (Semaphore capacity 1). Reject,
    //     don't queue: `decisions.md` 2026-05-02 (Phase 1 unlock UI
    //     semantics) extends `recovery-flow.md` §3.3's "single
    //     in-flight" posture to vault_unlock. The RAII guard releases
    //     the permit on every return path — success, every error
    //     variant, panic unwind. Held across the spawn_blocking
    //     await so a concurrent unlock attempt sees the permit busy.
    let _permit = match state.unlock_permits().try_acquire() {
        Ok(p) => p,
        Err(_) => {
            tracing::error!(
                stage = "permit_acquire",
                error_kind = "UnlockInProgress",
                "unlock attempt rejected: another unlock in flight"
            );
            return Err(VaultUnlockError::UnlockInProgress);
        }
    };

    // Own the path so it can move into spawn_blocking (the closure
    // captures by-value). Cheap one-allocation clone.
    let vault_path = vault_path.to_path_buf();

    let join_outcome =
        tokio::task::spawn_blocking(move || -> Result<DerivedKeys, VaultUnlockError> {
            // IO + parse + KDF + AEAD all run inside the blocking
            // task: this frees the runtime worker across the whole
            // pipeline (Windows / cold-disk / antivirus latency
            // doesn't stall the async runtime).
            let bytes = std::fs::read(&vault_path).map_err(|e| {
                if e.kind() == std::io::ErrorKind::NotFound {
                    tracing::error!(
                        stage = "read_meta",
                        error_kind = "VaultNotFound",
                        "vault.meta does not exist (first-run UX routes to creation flow)"
                    );
                    VaultUnlockError::VaultNotFound
                } else {
                    let io_kind = from_io_error_kind(e.kind());
                    tracing::error!(
                        stage = "read_meta",
                        error_kind = "IoError",
                        io_failure_kind = ?io_kind,
                        "vault.meta read failed"
                    );
                    VaultUnlockError::IoError {
                        io_error_kind: io_kind,
                    }
                }
            })?;

            let meta = protocol::parse_vault_meta(&bytes).map_err(|e| {
                tracing::error!(
                    stage = "parse_meta",
                    error_kind = "InvalidVaultMeta",
                    protocol_error_kind = protocol_error_kind(&e),
                    "vault.meta parse rejected"
                );
                VaultUnlockError::InvalidVaultMeta
            })?;

            let items_key_id = meta.items_key_id;
            let root_key = derive_root_key(&password, &meta)?;
            // items_key derivation drops `root_key` on early-return;
            // the slot stays empty (no half-state).
            let items_key = derive_items_key(&root_key, &meta)?;
            Ok(DerivedKeys {
                root_key,
                items_key,
                items_key_id,
            })
        })
        .await;

    let DerivedKeys {
        root_key,
        items_key,
        items_key_id,
    } = match join_outcome {
        Ok(Ok(keys)) => keys,
        // Inner `Err` was already traced at its origin (read_meta /
        // parse_meta / password_kdf / root_unwrap / items_key_unwrap);
        // do not double-trace here.
        Ok(Err(inner)) => return Err(inner),
        Err(_) => {
            tracing::error!(
                stage = "spawn_blocking_join",
                error_kind = "JoinFailure",
                "blocking task join failed"
            );
            return Err(VaultUnlockError::JoinFailure);
        }
    };

    let now = Instant::now();
    state
        .set(UnlockedVault {
            root_key,
            items_key,
            items_key_id,
            unlocked_at: now,
        })
        .await;

    // Success event. Coarse `duration_ms` only — no account
    // identifier, no path, no key material. Per ALLOW-list in
    // `src-tauri/CLAUDE.md` "Secret-handling logging discipline".
    tracing::info!(
        event = "vault_unlocked",
        duration_ms = now.duration_since(started).as_millis() as u64,
        "vault unlocked successfully"
    );

    Ok(())
}

/// Step (a) of the spawn_blocking pipeline: derive `password_wrap_key`
/// via Argon2id and AEAD-open `enc_root_key_password`. Borrows the
/// password as `&str`; no clone, no format-arg, no log.
///
/// `AeadFailure` from the AEAD-open is the §7.3 non-distinguishing
/// tag (`InvalidCredentialOrVault` — covers wrong password AND
/// tampered password section indistinguishably). `KdfFailure` and
/// any other `ProtocolError` precede AEAD verification or arise
/// from structural vault.meta corruption; both surface as
/// `InvalidVaultMeta`, leaking no password-conditional information.
fn derive_root_key(
    password: &str,
    meta: &VaultMeta,
) -> Result<Zeroizing<[u8; AEAD_KEY_LEN]>, VaultUnlockError> {
    let wrap_key = protocol::derive_password_wrap_key(
        password,
        &meta.random_salt_password,
        &meta.account_number_hash,
        &meta.kdf_params,
    )
    .map_err(|e| {
        tracing::error!(
            stage = "password_kdf",
            protocol_error_kind = protocol_error_kind(&e),
            "password wrap-key derivation failed"
        );
        password_or_meta(e)
    })?;

    let aad = protocol::aad_password_wrap(&meta.kdf_params);
    open_32_byte_secret(
        &wrap_key,
        &meta.nonce_password_wrap,
        &meta.enc_root_key_password,
        &aad,
        "root_unwrap",
        password_or_meta,
    )
}

/// Error mapping for the password-wrap pipeline (KDF + root_key
/// AEAD-open). `AeadFailure` is the §7.3 non-distinguishing tag
/// (`InvalidCredentialOrVault`); everything else is structural and
/// surfaces as `InvalidVaultMeta`.
fn password_or_meta(e: protocol::ProtocolError) -> VaultUnlockError {
    match e {
        protocol::ProtocolError::AeadFailure => VaultUnlockError::InvalidCredentialOrVault,
        _ => VaultUnlockError::InvalidVaultMeta,
    }
}

/// Step (b) of the spawn_blocking pipeline: derive
/// `itemsKey_wrap_key` via the canonical `derive_subkey` helper
/// (HKDF-SHA-256 with the registered `ItemsKeyWrap` role context
/// string per `protocol.md` §3.4) and AEAD-open `enc_items_key`.
///
/// **Error mapping is intentionally distinct from
/// [`derive_root_key`].** AEAD-tag failure here is mapped to
/// `InvalidVaultMeta`, NOT `InvalidCredentialOrVault`, because the
/// password wrap-key has already verified by the time this is
/// called — distinguishing items_key wrap failure leaks nothing
/// about credential validity (`decisions.md` 2026-05-02 "Phase 1
/// unlock error discipline"). User-facing CTA is uniform with parse
/// errors: "vault file unreadable, restore from a backup".
fn derive_items_key(
    root_key: &[u8; AEAD_KEY_LEN],
    meta: &VaultMeta,
) -> Result<Zeroizing<[u8; AEAD_KEY_LEN]>, VaultUnlockError> {
    let items_wrap_key = protocol::derive_subkey(root_key, protocol::SubkeyRole::ItemsKeyWrap);
    let aad = protocol::aad_items_key_wrap(&meta.items_key_id);
    open_32_byte_secret(
        &items_wrap_key,
        &meta.items_key_nonce,
        &meta.enc_items_key,
        &aad,
        "items_key_unwrap",
        // AEAD failure here is post-password-verification, so it
        // does NOT collapse into `InvalidCredentialOrVault` — the
        // password wrap already verified, and distinguishing this
        // blob's failure leaks no credential information. Single
        // map to `InvalidVaultMeta` per `decisions.md` 2026-05-02.
        |_| VaultUnlockError::InvalidVaultMeta,
    )
}

/// AEAD-open a 32-byte secret blob under `wrap_key` + `nonce` + `aad`,
/// emit a stage-tagged tracing record on failure, and copy the
/// plaintext into a fresh `Zeroizing<[u8; AEAD_KEY_LEN]>`. Used by
/// both `derive_root_key` and `derive_items_key` — the AEAD-open +
/// length-check + copy pattern is the single shared shape for every
/// 32-byte unwrap on the unlock path.
fn open_32_byte_secret(
    wrap_key: &[u8; AEAD_KEY_LEN],
    nonce: &[u8; AEAD_NONCE_LEN],
    sealed: &[u8],
    aad: &[u8],
    stage: &'static str,
    map_err: impl FnOnce(protocol::ProtocolError) -> VaultUnlockError,
) -> Result<Zeroizing<[u8; AEAD_KEY_LEN]>, VaultUnlockError> {
    let plaintext = protocol::aead_open_ctx(wrap_key, nonce, sealed, aad).map_err(|e| {
        tracing::error!(
            stage,
            protocol_error_kind = protocol_error_kind(&e),
            "AEAD-open failed"
        );
        map_err(e)
    })?;
    debug_assert_eq!(plaintext.len(), AEAD_KEY_LEN);
    let mut buf = Zeroizing::new([0u8; AEAD_KEY_LEN]);
    buf.copy_from_slice(&plaintext);
    Ok(buf)
}

/// Close the unlocked vault — drops the [`UnlockedVault`] slot.
///
/// Param-less + idempotent: returns `Ok(())` regardless of whether
/// the slot was occupied. When the slot WAS occupied, dropping the
/// taken `UnlockedVault` runs `Zeroize` on its `root_key` and
/// `items_key` (per the [`Zeroizing`] wrappers in
/// [`super::state::UnlockedVault`]).
///
/// **Async despite "sync" wording in the priority plan / PRD task
/// description.** [`tokio::sync::RwLock`] is async-aware (PRD
/// section "State Tauri-side" picked it for compatibility with the
/// async unlock path). The `.await` on `state.take()` resolves in
/// microseconds — the write lock is held only long enough to
/// `.take()` the option's value. No spawn_blocking, no heavy
/// compute; the spirit of the "sync" wording is preserved (no
/// runtime worker pool dispatch, no IO).
///
/// **TOCTOU note (grilling Q5 + decisions.md 2026-05-02):** If
/// `vault_lock` is called while `vault_unlock` is mid-Argon2id —
/// unlock has acquired the permit but not yet populated the slot —
/// the slot is `None` and this lock is a no-op; then unlock
/// completes and populates the slot, so the user's lock intent is
/// silently swallowed. **Phase 1 mitigation is UI-side**: B4c
/// (Furkan, separate task) hides the Lock affordance during the
/// `decrypting` state, so the user cannot form the wrong intent in
/// the first place. A Rust-side "lock requested" signal that
/// step 6 of `unlock_with_path` checks before populating the slot
/// is a Phase 2+ deeper fix; not required for v0.1.
#[tauri::command]
pub async fn lock(state: State<'_, VaultRuntimeState>) -> Result<(), VaultUnlockError> {
    lock_with_state(state.inner()).await
}

/// Testable core of [`lock`]. The Tauri-command wrapper resolves
/// the [`State`] borrow and delegates here so tests do not need a
/// [`AppHandle`].
pub(crate) async fn lock_with_state(state: &VaultRuntimeState) -> Result<(), VaultUnlockError> {
    // Drop runs Zeroize on the slot's keys.
    let _ = state.take().await;
    Ok(())
}

// ---- Boot-time probe + unlocked-state probe (Task 1 of `app-state-machine`) ---
//
// `vault_status` is the read-only `vault.meta` probe used by App.tsx
// at boot to choose the initial Stage (welcome vs unlock vs corrupted).
// `vault_is_unlocked` exposes `VaultRuntimeState::peek_is_some()` to
// the frontend so guarded stages (Editor) can do a Rust-side reality
// check at mount time. Both are read-only; neither holds the unlock
// permit, neither performs Argon2id.
//
// Design context: `agent-tooling/sessions/grill/2026-05-02-app-state-machine.md`
// Q9 (vault_status imzası) + PRD `agent-tooling/features/app-state-machine/prd.md`.

/// Result of [`vault_status`] — boot-time probe of `vault.meta`.
///
/// Three-state minimal enum (Q9 α=1 + β=i):
/// - `Exists`: `vault.meta` parses cleanly via [`protocol::parse_vault_meta`].
///   Frontend routes to the unlock stage.
/// - `Missing`: file does not exist (`std::io::ErrorKind::NotFound` on
///   read). Frontend routes to the welcome stage.
/// - `Corrupted`: the file exists but `parse_vault_meta` rejected the
///   bytes (magic / length / kdf_id / reserved-byte mismatch). IO
///   failures do **NOT** surface as `Corrupted` — they surface via
///   [`VaultStatusError::IoError`] (β=i: IO failure ≠ corruption; the
///   distinction matters for log triage, even though the frontend
///   fail-closed UI branches the same way).
#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(tag = "kind")]
pub enum VaultStatus {
    Exists,
    Missing,
    Corrupted,
}

/// Probe `<app_data_dir>/vault/vault.meta` and classify it.
///
/// Read-only: does not hold the unlock permit, does not call into
/// Argon2id, does not populate or peek [`VaultRuntimeState`]. Safe to
/// invoke at boot before any unlock attempt.
///
/// Internal sequence (mirrors [`unlock_with_path`]'s read-and-parse
/// pipeline shape):
/// 1. Resolve `vault.meta` path. Path-resolution failures map to
///    `VaultStatusError::IoError { Other }`.
/// 2. `tokio::task::spawn_blocking` reads + parses (filesystem +
///    `parse_vault_meta` are both blocking work):
///    - Read `NotFound` → `Ok(VaultStatus::Missing)` (canonical
///      no-vault case; not an IO error).
///    - Read other `io::Error` → `Err(VaultStatusError::IoError)` with
///      bounded [`IoFailureKind`].
///    - `parse_vault_meta` Ok → `Ok(VaultStatus::Exists)`.
///    - `parse_vault_meta` Err → `Ok(VaultStatus::Corrupted)`.
/// 3. `JoinFailure` from the spawn_blocking handle → fold into
///    `IoError { Other }` (no separate variant — the boundary contract
///    only surfaces IO-class failures).
#[tauri::command]
pub async fn vault_status<R: Runtime>(app: AppHandle<R>) -> Result<VaultStatus, VaultStatusError> {
    let vault_path = vault_meta_path(&app).map_err(|_| VaultStatusError::IoError {
        io_error_kind: IoFailureKind::Other,
    })?;
    vault_status_with_path(&vault_path).await
}

/// Testable core of [`vault_status`]. The Tauri-command wrapper
/// resolves the platform-specific `vault.meta` path and delegates here
/// so tests do not need an [`AppHandle`].
///
/// All decisions documented on [`vault_status`] apply identically.
pub(crate) async fn vault_status_with_path(
    vault_path: &Path,
) -> Result<VaultStatus, VaultStatusError> {
    let vault_path = vault_path.to_path_buf();

    let join_outcome =
        tokio::task::spawn_blocking(move || -> Result<VaultStatus, VaultStatusError> {
            let bytes = match std::fs::read(&vault_path) {
                Ok(b) => b,
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                    // Canonical no-vault case — frontend routes to
                    // welcome (create flow). Not an IO error; do not
                    // log (this is the expected first-run path).
                    return Ok(VaultStatus::Missing);
                }
                Err(e) => {
                    let io_kind = from_io_error_kind(e.kind());
                    tracing::error!(
                        stage = "status_check",
                        error_kind = "IoError",
                        io_failure_kind = ?io_kind,
                        "vault.meta probe read failed"
                    );
                    return Err(VaultStatusError::IoError {
                        io_error_kind: io_kind,
                    });
                }
            };
            match protocol::parse_vault_meta(&bytes) {
                Ok(_) => Ok(VaultStatus::Exists),
                Err(e) => {
                    tracing::error!(
                        stage = "status_check",
                        result = "Corrupted",
                        protocol_error_kind = protocol_error_kind(&e),
                        "vault.meta probe rejected by parse_vault_meta"
                    );
                    Ok(VaultStatus::Corrupted)
                }
            }
        })
        .await;

    match join_outcome {
        Ok(inner) => inner,
        Err(_) => {
            tracing::error!(
                stage = "status_check",
                error_kind = "JoinFailure",
                "blocking task join failed during vault_status"
            );
            Err(VaultStatusError::IoError {
                io_error_kind: IoFailureKind::Other,
            })
        }
    }
}

/// Read-only probe of [`VaultRuntimeState`]'s slot.
///
/// Returns `true` when the slot is populated (an [`UnlockedVault`] is
/// present), `false` otherwise. Used by the frontend's Editor mount
/// guard (Q5β-1 belt+suspenders): when Stage = `editor` mounts but the
/// slot is empty, the React state ↔ Rust state disagreement is
/// detected here and the component renders `<FailClosedError reason="invalid-state" />`.
///
/// Cheap: a single read-lock peek; no IO, no Argon2id, no permit.
/// Idempotent: callable from any stage at any time without side effects.
///
/// Error type is [`VaultStatusError`] for type-mirror consistency with
/// [`vault_status`] — in practice this command cannot fail (the
/// [`tokio::sync::RwLock`] read is infallible). The `Result` shape is
/// retained so the Tauri IPC contract for the two probe commands is
/// uniform on the frontend side.
#[tauri::command]
pub async fn vault_is_unlocked(
    state: State<'_, VaultRuntimeState>,
) -> Result<bool, VaultStatusError> {
    vault_is_unlocked_with_state(state.inner()).await
}

/// Testable core of [`vault_is_unlocked`]. The Tauri-command wrapper
/// resolves the [`State`] borrow and delegates here so tests do not
/// need a [`AppHandle`].
pub(crate) async fn vault_is_unlocked_with_state(
    state: &VaultRuntimeState,
) -> Result<bool, VaultStatusError> {
    Ok(state.peek_is_some().await)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::plugins::vault_creation::commands::{build_and_serialize_vault_meta, build_session};
    use protocol::KdfParams;

    /// Fast Argon2id parameters for tests (RFC 9106 minimum). Mirrors
    /// `protocol::kdf::tests::FAST_TEST_KDF_PARAMS`. DEFAULT params
    /// would add ~1–2 s per test; FAST_TEST_KDF runs in microseconds.
    /// Production never uses these — `DEFAULT_V0_1_KDF_PARAMS` is the
    /// only set that reaches `derive_password_wrap_key` at runtime.
    const FAST_TEST_KDF: KdfParams = KdfParams {
        m_kib: 8,
        t: 1,
        p: 1,
        argon2_version: 0x13,
    };

    fn rt() -> tokio::runtime::Runtime {
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("current-thread runtime build")
    }

    /// Build a unique scratch directory under the OS temp dir and a
    /// path to its `vault.meta`. Caller writes the bytes; the
    /// `RemoveOnDrop` guard cleans up when it falls out of scope.
    struct ScratchVault {
        dir: PathBuf,
        meta_path: PathBuf,
    }

    impl ScratchVault {
        fn new() -> Self {
            let dir =
                std::env::temp_dir().join(format!("myne_unlock_test_{}", uuid::Uuid::new_v4()));
            std::fs::create_dir_all(&dir).expect("create scratch dir");
            let meta_path = dir.join("vault.meta");
            Self { dir, meta_path }
        }

        fn path(&self) -> &Path {
            &self.meta_path
        }

        fn write_meta(&self, bytes: &[u8]) {
            std::fs::write(&self.meta_path, bytes).expect("write vault.meta");
        }
    }

    impl Drop for ScratchVault {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.dir);
        }
    }

    /// Seed a real `vault.meta` via `vault_creation::build_session`
    /// + `build_and_serialize_vault_meta`. Returns the bytes plus
    ///   the original session-side `root_key` so tests can assert
    ///   post-unlock equality.
    fn seed_vault_meta(password: &str) -> ([u8; protocol::VAULT_META_LEN], [u8; AEAD_KEY_LEN]) {
        let session = build_session(password, FAST_TEST_KDF).expect("build_session");
        let original_root_key: [u8; AEAD_KEY_LEN] = *session.root_key;
        let bytes = build_and_serialize_vault_meta(&session).expect("serialize vault.meta");
        (bytes, original_root_key)
    }

    #[test]
    fn round_trip_unlock_recovers_original_root_key() {
        rt().block_on(async {
            let scratch = ScratchVault::new();
            let (meta_bytes, original_root_key) = seed_vault_meta("correct horse battery staple");
            scratch.write_meta(&meta_bytes);

            let state = VaultRuntimeState::default();
            unlock_with_path(
                "correct horse battery staple".to_string(),
                scratch.path(),
                &state,
            )
            .await
            .expect("unlock with correct password");

            // Slot is occupied with the original root_key bytes.
            let unlocked = state.take().await.expect("slot populated post-unlock");
            assert_eq!(*unlocked.root_key, original_root_key);
        });
    }

    #[test]
    fn wrong_password_returns_invalid_credential_or_vault() {
        rt().block_on(async {
            let scratch = ScratchVault::new();
            let (meta_bytes, _) = seed_vault_meta("the right password");
            scratch.write_meta(&meta_bytes);

            let state = VaultRuntimeState::default();
            let result =
                unlock_with_path("the wrong password".to_string(), scratch.path(), &state).await;

            assert!(matches!(
                result,
                Err(VaultUnlockError::InvalidCredentialOrVault)
            ));
            // Failed unlock leaves slot empty.
            assert!(!state.peek_is_some().await);
        });
    }

    #[test]
    fn missing_vault_meta_returns_vault_not_found() {
        rt().block_on(async {
            let scratch = ScratchVault::new();
            // Do NOT call write_meta — vault.meta is absent.
            assert!(!scratch.path().exists());

            let state = VaultRuntimeState::default();
            let result = unlock_with_path("anything".to_string(), scratch.path(), &state).await;

            assert!(matches!(result, Err(VaultUnlockError::VaultNotFound)));
            assert!(!state.peek_is_some().await);
        });
    }

    #[test]
    fn successful_unlock_populates_slot_with_unwrapped_items_key() {
        // Stronger than a non-zero check: the items_key the unlock
        // command parks in the slot must match what an independent
        // derivation from the same vault.meta + root_key produces.
        // If unlock's items_key path diverges from the protocol
        // crate's canonical primitives (wrong subkey role, wrong
        // AAD, wrong nonce field, wrong blob slice) this catches it.
        rt().block_on(async {
            let scratch = ScratchVault::new();
            let (meta_bytes, original_root_key) = seed_vault_meta("pw");
            scratch.write_meta(&meta_bytes);

            let parsed = protocol::parse_vault_meta(&meta_bytes).expect("parse seed");

            // Independent items_key derivation from the same root_key
            // using the same protocol primitives the unlock command
            // calls. Verifies the unlock command does not introduce
            // any spurious transformation in the items_key path.
            let items_wrap_key =
                protocol::derive_subkey(&original_root_key, protocol::SubkeyRole::ItemsKeyWrap);
            let aad = protocol::aad_items_key_wrap(&parsed.items_key_id);
            let expected_items_key = protocol::aead_open_ctx(
                &items_wrap_key,
                &parsed.items_key_nonce,
                &parsed.enc_items_key,
                &aad,
            )
            .expect("independent items_key unwrap");

            let state = VaultRuntimeState::default();
            unlock_with_path("pw".to_string(), scratch.path(), &state)
                .await
                .expect("unlock");

            let unlocked = state.take().await.expect("slot populated");
            assert_eq!(unlocked.items_key_id, parsed.items_key_id);
            assert_eq!(
                unlocked.items_key.as_slice(),
                expected_items_key.as_slice(),
                "items_key in slot must match independent derivation"
            );
        });
    }

    #[test]
    fn items_key_tampering_returns_invalid_vault_meta_not_credential_error() {
        // Spec §9.3: enc_items_key occupies offsets 281..345 (64 B).
        // Mutating any byte invalidates the AEAD tag on the items_key
        // wrap. Because the password wrap-key has ALREADY verified by
        // the time this stage runs, the failure must NOT collapse
        // into `InvalidCredentialOrVault` — that would leak post-
        // password-verification information as if it were a
        // credential mismatch (see grilling Q4 + Task 11
        // decisions.md entry).
        rt().block_on(async {
            let scratch = ScratchVault::new();
            let (mut meta_bytes, _) = seed_vault_meta("pw");
            // Flip one bit in the first byte of enc_items_key.
            meta_bytes[281] ^= 0x01;
            scratch.write_meta(&meta_bytes);

            let state = VaultRuntimeState::default();
            let result = unlock_with_path("pw".to_string(), scratch.path(), &state).await;

            match result {
                Err(VaultUnlockError::InvalidVaultMeta) => {} // expected
                Err(VaultUnlockError::InvalidCredentialOrVault) => {
                    panic!(
                        "items_key tampering must NOT surface as InvalidCredentialOrVault — \
                         the password wrap-key has already verified at this stage; \
                         distinguishing items_key wrap failure does not leak credential validity"
                    );
                }
                other => panic!("expected InvalidVaultMeta, got {other:?}"),
            }

            // Slot stays empty: root_key was successfully unwrapped
            // inside spawn_blocking, then dropped on the items_key
            // failure early-return. No half-state.
            assert!(
                !state.peek_is_some().await,
                "items_key failure must leave slot empty (no half-state)"
            );
        });
    }

    // ---- Parse-error matrix (Task 4) -------------------------------
    //
    // Each test below targets one branch of `protocol::parse_vault_meta`
    // (spec §9.3). All branches must surface as `InvalidVaultMeta` —
    // the single user-facing category for structural vault.meta
    // corruption per `decisions.md` 2026-05-02 (Phase 1 unlock error
    // discipline, Task 11). None of these branches may collapse into
    // `InvalidCredentialOrVault`: they precede password derivation and
    // reveal nothing password-conditional.

    /// Run an unlock attempt against `tampered_bytes` and assert the
    /// failure mode is exactly `InvalidVaultMeta` with the slot empty.
    /// Used by the parse-error matrix tests below.
    async fn assert_invalid_vault_meta_on_bytes(tampered_bytes: &[u8]) {
        let scratch = ScratchVault::new();
        scratch.write_meta(tampered_bytes);

        let state = VaultRuntimeState::default();
        let result = unlock_with_path("pw".to_string(), scratch.path(), &state).await;

        match result {
            Err(VaultUnlockError::InvalidVaultMeta) => {} // expected
            Err(VaultUnlockError::InvalidCredentialOrVault) => {
                panic!(
                    "parse error must NOT surface as InvalidCredentialOrVault — \
                     it precedes password derivation and reveals no \
                     password-conditional information"
                );
            }
            other => panic!("expected InvalidVaultMeta, got {other:?}"),
        }
        assert!(
            !state.peek_is_some().await,
            "parse failure must leave slot empty"
        );
    }

    #[test]
    fn parse_fail_bad_magic_returns_invalid_vault_meta() {
        // Spec §9.3: bytes[0..4] = b"MYV1". Replace with arbitrary
        // non-magic bytes; parse_vault_meta rejects.
        rt().block_on(async {
            let (mut bytes, _) = seed_vault_meta("pw");
            bytes[0..4].copy_from_slice(b"XXXX");
            assert_invalid_vault_meta_on_bytes(&bytes).await;
        });
    }

    #[test]
    fn parse_fail_truncated_length_returns_invalid_vault_meta() {
        // Spec §9.3: vault.meta is exactly VAULT_META_LEN (345) bytes.
        // One short triggers the length check before any field is read.
        rt().block_on(async {
            let (bytes, _) = seed_vault_meta("pw");
            assert_eq!(bytes.len(), protocol::VAULT_META_LEN);
            // Slice off the trailing byte → 344 bytes.
            assert_invalid_vault_meta_on_bytes(&bytes[..protocol::VAULT_META_LEN - 1]).await;
        });
    }

    #[test]
    fn parse_fail_overlong_length_returns_invalid_vault_meta() {
        // Length-classification mirror of the truncation case: any
        // size != VAULT_META_LEN must reject. One byte too many.
        rt().block_on(async {
            let (bytes, _) = seed_vault_meta("pw");
            let mut overlong = bytes.to_vec();
            overlong.push(0u8);
            assert_invalid_vault_meta_on_bytes(&overlong).await;
        });
    }

    #[test]
    fn parse_fail_bad_protocol_version_returns_invalid_vault_meta() {
        // Spec §9.3 offset 4: protocol_version = 0x01 for v0.1.
        // Anything else is forward-incompatible-by-design (§10).
        rt().block_on(async {
            let (mut bytes, _) = seed_vault_meta("pw");
            bytes[4] = 0x02;
            assert_invalid_vault_meta_on_bytes(&bytes).await;
        });
    }

    #[test]
    fn parse_fail_nonzero_reserved_byte_returns_invalid_vault_meta() {
        // Spec §9.3 offset 5: reserved MUST be 0x00. Non-zero is a
        // forward-compat anchor for future minor revisions; v0.1
        // parsers reject non-zero by construction.
        rt().block_on(async {
            let (mut bytes, _) = seed_vault_meta("pw");
            bytes[5] = 0x01;
            assert_invalid_vault_meta_on_bytes(&bytes).await;
        });
    }

    #[test]
    fn parse_fail_invalid_kdf_block_returns_invalid_vault_meta() {
        // Spec §9.3 offset 22: kdf_id MUST be 0x01 (Argon2id, the
        // only value accepted in v0.1). 0xFF triggers the
        // parse_kdf_params branch inside parse_vault_meta.
        rt().block_on(async {
            let (mut bytes, _) = seed_vault_meta("pw");
            bytes[22] = 0xFF;
            assert_invalid_vault_meta_on_bytes(&bytes).await;
        });
    }

    // ---- IO error matrix (Task 4) ----------------------------------

    /// Permission-denied IO test (Unix-only).
    ///
    /// Windows has no portable equivalent: `fs::set_permissions` on
    /// a regular file is largely a no-op for permissions-blocking
    /// purposes there, and the test would not reliably trigger
    /// `ErrorKind::PermissionDenied`. The non-Unix coverage of
    /// `IoError` mapping is exercised by the From-impl unit test in
    /// `error.rs::tests::from_io_error_maps_via_closed_enum`, which
    /// synthesizes a permission-denied `io::Error` directly.
    ///
    /// Skipped automatically when running as root (mode-000 does not
    /// block reads for the superuser); CI runs unprivileged.
    #[cfg(unix)]
    #[test]
    fn permission_denied_returns_io_error_with_permission_denied_kind() {
        use std::os::unix::fs::PermissionsExt;

        rt().block_on(async {
            let scratch = ScratchVault::new();
            let (bytes, _) = seed_vault_meta("pw");
            scratch.write_meta(&bytes);

            // Strip all permissions on the file itself. Parent
            // directory keeps its w+x bits so `remove_dir_all` can
            // unlink the file at cleanup time without needing read.
            let mut perms = std::fs::metadata(scratch.path())
                .expect("stat scratch file")
                .permissions();
            perms.set_mode(0o000);
            std::fs::set_permissions(scratch.path(), perms).expect("chmod 000");

            let state = VaultRuntimeState::default();
            let result = unlock_with_path("pw".to_string(), scratch.path(), &state).await;

            // Restore readability for cleanup BEFORE asserting (so a
            // panicking assert still leaves the dir cleanable).
            let mut perms = std::fs::metadata(scratch.path())
                .expect("stat after unlock")
                .permissions();
            perms.set_mode(0o644);
            std::fs::set_permissions(scratch.path(), perms).expect("chmod 644 cleanup");

            match result {
                Err(VaultUnlockError::IoError {
                    io_error_kind: IoFailureKind::PermissionDenied,
                }) => {} // expected
                // Running as root or on a filesystem that ignores
                // mode bits (e.g. some FUSE mounts) — the read
                // succeeded so we got a `VaultUnlockError::Invalid…`
                // instead. Tolerate: the permission-denied branch
                // is also covered by the `error.rs` From-impl test.
                Ok(()) => eprintln!(
                    "permission_denied test ran with effective read access; \
                     skipping assertion (CI must run unprivileged)"
                ),
                other => panic!("expected IoError(PermissionDenied), got {other:?}"),
            }
            assert!(
                !state.peek_is_some().await,
                "IO failure must leave slot empty"
            );
        });
    }

    // ---- Concurrency guards (Task 5) -------------------------------
    //
    // VaultAlreadyUnlocked + UnlockInProgress are the two structural
    // guards on the `unlock_with_path` critical section. Order is
    // load-bearing: slot peek precedes permit acquire (grilling Q5)
    // so the cheap "already unlocked" path is fast-path observable
    // and never consumes a permit.

    use super::super::state::fixture_unlocked_with_keys;

    #[test]
    fn vault_already_unlocked_returns_guard_when_slot_occupied() {
        rt().block_on(async {
            let scratch = ScratchVault::new();
            let (bytes, _) = seed_vault_meta("pw");
            scratch.write_meta(&bytes);

            let state = VaultRuntimeState::default();
            // Simulate "already unlocked" by populating the slot
            // directly with a fixture distinguishable by byte pattern
            // (so we can assert the existing slot is unchanged).
            state
                .set(fixture_unlocked_with_keys(0x42, 0x13, 0x99))
                .await;

            let result = unlock_with_path("pw".to_string(), scratch.path(), &state).await;

            assert!(matches!(
                result,
                Err(VaultUnlockError::VaultAlreadyUnlocked)
            ));

            // Existing slot is untouched: the same fixture bytes
            // come back from take(). The unlock attempt did NOT
            // overwrite or perturb it.
            let existing = state.take().await.expect("slot still populated");
            assert_eq!(*existing.root_key, [0x42u8; AEAD_KEY_LEN]);
            assert_eq!(*existing.items_key, [0x13u8; AEAD_KEY_LEN]);
            assert_eq!(existing.items_key_id, [0x99u8; 16]);
        });
    }

    #[test]
    fn vault_already_unlocked_does_not_consume_permit() {
        // Tests the load-bearing ordering invariant: slot peek
        // precedes permit acquire. The fast-path return of
        // VaultAlreadyUnlocked must not touch the semaphore — even
        // when the permit is exhausted, the guard fires correctly
        // because we never reach try_acquire.
        rt().block_on(async {
            let scratch = ScratchVault::new();
            let (bytes, _) = seed_vault_meta("pw");
            scratch.write_meta(&bytes);

            let state = VaultRuntimeState::default();
            state
                .set(fixture_unlocked_with_keys(0x55, 0x66, 0x77))
                .await;

            // Manually hold the unlock permit. If unlock_with_path
            // tried try_acquire BEFORE peek, this would surface as
            // UnlockInProgress instead of VaultAlreadyUnlocked.
            let _held_permit = state
                .unlock_permits()
                .try_acquire()
                .expect("first acquire on fresh state");
            assert_eq!(state.unlock_permits().available_permits(), 0);

            let result = unlock_with_path("pw".to_string(), scratch.path(), &state).await;

            // Peek catches it before try_acquire runs.
            assert!(matches!(
                result,
                Err(VaultUnlockError::VaultAlreadyUnlocked)
            ));
            // Permit count is still 0 — the held permit is exactly
            // one, and unlock_with_path did NOT consume an additional
            // one (which would've been impossible anyway, but the
            // test asserts the early-return path was taken).
            assert_eq!(state.unlock_permits().available_permits(), 0);
        });
    }

    #[test]
    fn unlock_in_progress_returns_guard_when_permit_held() {
        // Deterministic substitute for "two concurrent unlocks": the
        // test holds the permit manually, simulating an in-flight
        // unlock at any of its post-acquire stages. A concurrent
        // unlock attempt must reject with UnlockInProgress without
        // queueing or sleeping. No tokio::time::sleep, no race —
        // pure structural verification of try_acquire's reject path.
        rt().block_on(async {
            let scratch = ScratchVault::new();
            let (bytes, _) = seed_vault_meta("pw");
            scratch.write_meta(&bytes);

            let state = VaultRuntimeState::default();
            assert!(!state.peek_is_some().await);

            // Simulate "in-flight unlock" by holding the permit.
            let held_permit = state
                .unlock_permits()
                .try_acquire()
                .expect("first acquire on fresh state");
            assert_eq!(state.unlock_permits().available_permits(), 0);

            // While held, a fresh unlock attempt rejects cleanly.
            let result = unlock_with_path("pw".to_string(), scratch.path(), &state).await;
            assert!(matches!(result, Err(VaultUnlockError::UnlockInProgress)));
            // The slot stayed empty — no half-state.
            assert!(!state.peek_is_some().await);

            // Release the held permit; subsequent unlock succeeds
            // (proving the guard is purely structural, not stateful
            // beyond permit availability).
            drop(held_permit);
            assert_eq!(state.unlock_permits().available_permits(), 1);

            unlock_with_path("pw".to_string(), scratch.path(), &state)
                .await
                .expect("retry after permit released succeeds");

            // Permit released after successful unlock too.
            assert_eq!(state.unlock_permits().available_permits(), 1);
        });
    }

    #[test]
    fn failed_unlock_releases_permit_for_retry() {
        // Regression guard for the RAII drop semantics: a failed
        // unlock (any error path that consumed the permit) must
        // release the permit when the function returns, so the next
        // attempt is not stuck on UnlockInProgress.
        rt().block_on(async {
            let scratch = ScratchVault::new();
            let (bytes, _) = seed_vault_meta("right pw");
            scratch.write_meta(&bytes);

            let state = VaultRuntimeState::default();

            // Wrong-password attempt: consumes permit (try_acquire
            // succeeds) → Argon2id runs → AEAD-open fails →
            // InvalidCredentialOrVault → permit released by RAII
            // drop on function return.
            let r1 = unlock_with_path("wrong pw".to_string(), scratch.path(), &state).await;
            assert!(matches!(
                r1,
                Err(VaultUnlockError::InvalidCredentialOrVault)
            ));
            assert_eq!(
                state.unlock_permits().available_permits(),
                1,
                "permit must be released after failed unlock — not stuck on UnlockInProgress"
            );

            // Retry with the right password — must succeed (would
            // hit UnlockInProgress if the permit had leaked).
            unlock_with_path("right pw".to_string(), scratch.path(), &state)
                .await
                .expect("retry after wrong-password failure works");

            // Permit released after successful unlock too.
            assert_eq!(state.unlock_permits().available_permits(), 1);
        });
    }

    // ---- vault_lock command (Task 6 — A8e bundle) -------------------
    //
    // `lock_with_state` is the testable inner of the `lock` Tauri
    // command. Param-less, idempotent, returns `Ok(())` on every
    // path — locked → no-op; unlocked → drop slot.

    // Note: "lock on already-locked is no-op" is covered by the
    // `lock_is_idempotent_across_repeated_calls` test below — its
    // first iteration starts with the slot already empty after the
    // initial drop.

    #[test]
    fn lock_when_unlocked_drops_slot() {
        rt().block_on(async {
            let state = VaultRuntimeState::default();
            // Populate the slot directly with a fixture.
            state
                .set(fixture_unlocked_with_keys(0x77, 0x88, 0x99))
                .await;
            assert!(state.peek_is_some().await);

            lock_with_state(&state)
                .await
                .expect("lock on populated slot returns Ok");

            assert!(
                !state.peek_is_some().await,
                "lock must drop the slot — Zeroizing fields wipe on the taken UnlockedVault's drop"
            );
        });
    }

    #[test]
    fn lock_is_idempotent_across_repeated_calls() {
        // Idempotency property: calling lock N times produces the
        // same final state (slot empty) regardless of the starting
        // state. Acceptance criterion explicitly mentions 10
        // consecutive calls.
        rt().block_on(async {
            let state = VaultRuntimeState::default();
            // Start with the slot populated.
            state
                .set(fixture_unlocked_with_keys(0x01, 0x02, 0x03))
                .await;

            for i in 0..10 {
                lock_with_state(&state)
                    .await
                    .unwrap_or_else(|_| panic!("lock call #{i} must succeed"));
                assert!(
                    !state.peek_is_some().await,
                    "slot must remain empty after lock call #{i}"
                );
            }
        });
    }

    #[test]
    fn lock_then_unlock_cycle_produces_fresh_unlocked_state() {
        // The lock-then-unlock cycle must NOT carry stale state
        // from the prior session into the new one. After lock, the
        // slot is empty; after a subsequent real unlock, the slot
        // is populated with the freshly-derived root_key from
        // vault.meta — distinct from any pre-existing fixture
        // bytes.
        rt().block_on(async {
            let scratch = ScratchVault::new();
            let (bytes, original_root_key) = seed_vault_meta("pw");
            scratch.write_meta(&bytes);

            let state = VaultRuntimeState::default();
            // Pre-existing "previous session" — distinguishable
            // bytes (0x11) so we can prove the next unlock
            // overwrites them with the real derived root_key.
            state
                .set(fixture_unlocked_with_keys(0x11, 0x12, 0x13))
                .await;

            // Lock — drops the fixture; slot empties.
            lock_with_state(&state).await.expect("lock");
            assert!(!state.peek_is_some().await);

            // Real unlock from the seeded vault.meta. Pays the
            // full Argon2id (FAST_TEST_KDF) + AEAD-open pipeline.
            unlock_with_path("pw".to_string(), scratch.path(), &state)
                .await
                .expect("unlock after lock succeeds");

            // The slot now carries the FRESH root_key from
            // vault.meta, NOT the prior fixture's 0x11 bytes.
            let unlocked = state.take().await.expect("slot populated");
            assert_eq!(*unlocked.root_key, original_root_key);
            assert_ne!(
                *unlocked.root_key, [0x11u8; AEAD_KEY_LEN],
                "fresh unlock must overwrite the prior session's root_key"
            );
        });
    }

    // ---- vault_status command (Task 1 of `app-state-machine`) -------
    //
    // Three-state probe: Exists | Missing | Corrupted, plus IO failure
    // surface as `Err(VaultStatusError::IoError)`. Mirrors the existing
    // `parse_fail_*` matrix on the unlock command but at the read +
    // parse layer only — no Argon2id, no slot interaction.

    #[test]
    fn vault_status_returns_missing_when_vault_meta_absent() {
        // First-run UX path: file does not exist → Ok(Missing).
        // NotFound is special-cased; not surfaced as IoError.
        rt().block_on(async {
            let scratch = ScratchVault::new();
            assert!(!scratch.path().exists());

            let result = vault_status_with_path(scratch.path()).await;
            assert_eq!(result, Ok(VaultStatus::Missing));
        });
    }

    #[test]
    fn vault_status_returns_exists_for_valid_vault_meta() {
        // Round-trip: a vault.meta freshly produced by
        // `build_and_serialize_vault_meta` parses cleanly, so the
        // probe classifies it as Exists.
        rt().block_on(async {
            let scratch = ScratchVault::new();
            let (bytes, _) = seed_vault_meta("pw");
            scratch.write_meta(&bytes);

            let result = vault_status_with_path(scratch.path()).await;
            assert_eq!(result, Ok(VaultStatus::Exists));
        });
    }

    /// Run the probe against `tampered_bytes` and assert it surfaces
    /// as `Ok(VaultStatus::Corrupted)` — the canonical "file present
    /// but unparsable" classification. IO failure must NOT collapse
    /// into Corrupted; that path is exercised by
    /// `vault_status_returns_io_error_on_permission_denied` below.
    async fn assert_corrupted_on_bytes(tampered_bytes: &[u8]) {
        let scratch = ScratchVault::new();
        scratch.write_meta(tampered_bytes);

        let result = vault_status_with_path(scratch.path()).await;
        assert_eq!(
            result,
            Ok(VaultStatus::Corrupted),
            "tampered vault.meta must surface as Corrupted, got {result:?}"
        );
    }

    #[test]
    fn vault_status_corrupted_on_bad_magic() {
        // Spec §9.3: bytes[0..4] = b"MYV1". Replace with arbitrary
        // non-magic bytes; parse_vault_meta rejects.
        rt().block_on(async {
            let (mut bytes, _) = seed_vault_meta("pw");
            bytes[0..4].copy_from_slice(b"XXXX");
            assert_corrupted_on_bytes(&bytes).await;
        });
    }

    #[test]
    fn vault_status_corrupted_on_truncated_length() {
        // Spec §9.3: vault.meta is exactly VAULT_META_LEN (345) bytes.
        // One short triggers the length check before any field is read.
        rt().block_on(async {
            let (bytes, _) = seed_vault_meta("pw");
            assert_eq!(bytes.len(), protocol::VAULT_META_LEN);
            assert_corrupted_on_bytes(&bytes[..protocol::VAULT_META_LEN - 1]).await;
        });
    }

    #[test]
    fn vault_status_corrupted_on_overlong_length() {
        // Length-classification mirror of truncation: any size !=
        // VAULT_META_LEN must reject. One byte too many.
        rt().block_on(async {
            let (bytes, _) = seed_vault_meta("pw");
            let mut overlong = bytes.to_vec();
            overlong.push(0u8);
            assert_corrupted_on_bytes(&overlong).await;
        });
    }

    #[test]
    fn vault_status_corrupted_on_bad_protocol_version() {
        // Spec §9.3 offset 4: protocol_version = 0x01 for v0.1.
        // Anything else is forward-incompatible-by-design (§10).
        rt().block_on(async {
            let (mut bytes, _) = seed_vault_meta("pw");
            bytes[4] = 0x02;
            assert_corrupted_on_bytes(&bytes).await;
        });
    }

    #[test]
    fn vault_status_corrupted_on_nonzero_reserved_byte() {
        // Spec §9.3 offset 5: reserved MUST be 0x00. v0.1 parsers
        // reject non-zero by construction (forward-compat anchor).
        rt().block_on(async {
            let (mut bytes, _) = seed_vault_meta("pw");
            bytes[5] = 0x01;
            assert_corrupted_on_bytes(&bytes).await;
        });
    }

    #[test]
    fn vault_status_corrupted_on_invalid_kdf_block() {
        // Spec §9.3 offset 22: kdf_id MUST be 0x01 (Argon2id, the
        // only value accepted in v0.1). 0xFF triggers the
        // parse_kdf_params branch inside parse_vault_meta.
        rt().block_on(async {
            let (mut bytes, _) = seed_vault_meta("pw");
            bytes[22] = 0xFF;
            assert_corrupted_on_bytes(&bytes).await;
        });
    }

    /// Permission-denied IO test (Unix-only).
    ///
    /// Mirrors the unlock command's `permission_denied_returns_io_error_with_permission_denied_kind`
    /// test. Skipped automatically when running as root (mode-000 does
    /// not block reads for the superuser); CI runs unprivileged.
    #[cfg(unix)]
    #[test]
    fn vault_status_returns_io_error_on_permission_denied() {
        use std::os::unix::fs::PermissionsExt;

        rt().block_on(async {
            let scratch = ScratchVault::new();
            let (bytes, _) = seed_vault_meta("pw");
            scratch.write_meta(&bytes);

            let mut perms = std::fs::metadata(scratch.path())
                .expect("stat scratch file")
                .permissions();
            perms.set_mode(0o000);
            std::fs::set_permissions(scratch.path(), perms).expect("chmod 000");

            let result = vault_status_with_path(scratch.path()).await;

            // Restore readability for cleanup BEFORE asserting (so a
            // panicking assert still leaves the dir cleanable).
            let mut perms = std::fs::metadata(scratch.path())
                .expect("stat after probe")
                .permissions();
            perms.set_mode(0o644);
            std::fs::set_permissions(scratch.path(), perms).expect("chmod 644 cleanup");

            match result {
                Err(VaultStatusError::IoError {
                    io_error_kind: IoFailureKind::PermissionDenied,
                }) => {} // expected
                Ok(VaultStatus::Exists) => eprintln!(
                    "permission_denied test ran with effective read access; \
                     skipping assertion (CI must run unprivileged)"
                ),
                other => panic!("expected IoError(PermissionDenied), got {other:?}"),
            }
        });
    }

    // ---- vault_is_unlocked command (Task 1 of `app-state-machine`) --
    //
    // Read-only peek of VaultRuntimeState's slot. Used by Editor mount
    // guard (Q5β-1 belt+suspenders).

    use super::super::state::fixture_unlocked_with_keys as status_fixture_unlocked_with_keys;

    #[test]
    fn vault_is_unlocked_returns_false_on_fresh_state() {
        rt().block_on(async {
            let state = VaultRuntimeState::default();
            let result = vault_is_unlocked_with_state(&state).await;
            assert_eq!(result, Ok(false));
        });
    }

    #[test]
    fn vault_is_unlocked_returns_true_when_slot_populated() {
        rt().block_on(async {
            let state = VaultRuntimeState::default();
            state
                .set(status_fixture_unlocked_with_keys(0x42, 0x13, 0x99))
                .await;
            let result = vault_is_unlocked_with_state(&state).await;
            assert_eq!(result, Ok(true));
        });
    }

    #[test]
    fn vault_is_unlocked_returns_false_after_take() {
        // Lock cycle parity: after the slot is drained (vault_lock
        // semantics), the probe must immediately surface false.
        rt().block_on(async {
            let state = VaultRuntimeState::default();
            state
                .set(status_fixture_unlocked_with_keys(0x77, 0x88, 0x99))
                .await;
            assert_eq!(vault_is_unlocked_with_state(&state).await, Ok(true));

            let _ = state.take().await; // simulate vault_lock
            assert_eq!(vault_is_unlocked_with_state(&state).await, Ok(false));
        });
    }
}
