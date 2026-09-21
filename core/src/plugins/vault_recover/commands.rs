//! Tauri commands for the vault-recover plugin.
//!
//! - [`recover_with_phrase`] — read `vault.meta`, normalize the
//!   user-typed phrase per `protocol.md` §7.4, derive
//!   `recovery_wrap_key`, AEAD-decrypt `enc_root_key_recovery`,
//!   eager-derive `itemsKey`, populate
//!   [`super::super::vault_unlock::state::Slot::Recovering`].
//! - [`complete_recovery`] — chained-step password commit; promotes
//!   `Slot::Recovering` → `Slot::Unlocked` by rewriting `vault.meta`
//!   under a new master password (recovery-side bytes preserved per
//!   `recovery-flow.md` §4.4; atomic write per §4.2).
//!
//! See: ../../CLAUDE.md "Secret-handling logging discipline".

use super::super::vault_unlock::state::{
    RecoveringMaterial, SlotKind, UnlockedVault, VaultRuntimeState,
};
use super::error::VaultRecoveryError;
use crate::host::HostCtx;
use crate::io_failure_kind::IoFailureKind;
use crate::protocol_error_kind::protocol_error_kind;
use protocol::{VaultMeta, AEAD_KEY_LEN, AEAD_NONCE_LEN, ARGON2_SALT_LEN};
use std::path::{Path, PathBuf};
// Tauri types serve only the cfg-gated IPC wrappers (task 79, Option B). The
// `Manager` import went with them: its only use here was `app.path()`, which
// `HostCtx::app_data_dir` now provides.
#[cfg(all(feature = "tauri-ipc", not(target_arch = "wasm32")))]
use crate::host::tauri_host::TauriHost;
#[cfg(all(feature = "tauri-ipc", not(target_arch = "wasm32")))]
use tauri::{AppHandle, Runtime, State};
use zeroize::Zeroizing;

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

/// Resolve the `vault.meta` path for an OPTIONAL explicit [`VaultId`]. Local
/// rather than imported from `vault_unlock` because the return type is
/// `VaultRecoveryError`.
///
/// - `Some(id)` → `<app_data_dir>/vaults/<id>/vault.meta` — the EXPLICIT target
///   the picker (sub-feature 3) passes (SYNC-6 targeting).
/// - `None` → the sole-vault fallback (`current_vault_root_from_base`), which
///   preserves the current single-vault recovery flow.
fn vault_meta_path(
    host: &dyn HostCtx,
    vault_id: Option<crate::vault_id::VaultId>,
) -> Result<PathBuf, VaultRecoveryError> {
    // The host names its sole vault BEFORE the `None` arm's disk scan runs.
    //
    // That order is the whole point, and skipping it is silent rather than
    // loud. `current_vault_root_from_base` is a `std::fs::read_dir` scan; on
    // wasm32 it does not panic, it errors and falls through to
    // `base.join(LEGACY_VAULT_DIR_NAME)`. So this resolved `<base>/vault/`
    // while the web container is `<base>/vaults/<the constant single id>/`,
    // and the whole phrase-recovery flow this branch ships answered
    // `VaultNotFound` on the only configuration the web client has, with every
    // gate green.
    //
    // `None` IS the web arm, not an edge case: the reducer starts `vaultId`
    // null, only the >=2-vault picker sets it, and web's `vault_list` returns
    // exactly one row. `sole_vault_id` is `None` on desktop and mobile, so
    // their behaviour is unchanged and the scan still runs there.
    let root = crate::paths::active_vault_root_from_host(host, vault_id).map_err(|_| {
        VaultRecoveryError::IoError {
            io_error_kind: IoFailureKind::Other,
        }
    })?;
    Ok(root.join("vault.meta"))
}

/// Recover an existing vault with the user's BIP-39 recovery phrase.
///
/// `phrase` is wrapped in `Zeroizing<String>` on the first non-doc
/// statement; the wrapper bounds the bytes' lifetime to the
/// `spawn_blocking` closure. NFKD normalization happens inside the
/// closure via `protocol::normalize_user_phrase` per spec §7.4.
///
/// Pipeline: slot peek (rejects `VaultAlreadyUnlocked` /
/// `RecoveryAlreadyInProgress`) → `auth_permits.try_acquire` (rejects
/// `RecoveryInProgress`) → read+parse `vault.meta` → spawn_blocking
/// {normalize phrase, derive recovery wrap-key (Argon2id), AEAD-open
/// `enc_root_key_recovery`, eager-derive `items_key`} → populate
/// `Slot::Recovering`.
///
/// Error mapping follows `recovery-flow.md` §3.4 + the unlock-error
/// discipline parallel: AEAD-tag failure on `recovery_wrap_key` →
/// `InvalidCredentialOrVault` (non-distinguishing); items_key wrap
/// failure → `InvalidVaultMeta` (recovery wrap-key already verified).
pub async fn recover_with_phrase_from_host(
    vault_id: Option<String>,
    phrase: String,
    state: &VaultRuntimeState,
    host: &dyn HostCtx,
    // Threaded through since `decisions.md` 2026-08-15, when phrase recovery
    // shipped on the web client. ONE implementation rather than a `_io` twin:
    // the seam's native arm forwards to the same `std::fs` this used to call
    // directly, and it runs the call through `task::run_blocking` exactly as
    // the surrounding pipeline does, so the desktop keeps its "the read happens
    // off the runtime worker" property while the browser gets OPFS.
    io: &dyn crate::vault_io::VaultIo,
) -> Result<(), VaultRecoveryError> {
    // SYNC-6 targeting: `Some(id)` recovers exactly `vaults/<id>/`; `None`/
    // malformed → the sole-vault fallback. The parsed id keys BOTH the path
    // resolution and the slot map so they cannot diverge.
    let target = crate::vault_id::VaultId::parse_optional(vault_id.as_deref());
    let vault_path = vault_meta_path(host, target)?;
    recover_with_phrase_with_path(phrase, target, &vault_path, state, host, io).await
}

/// IPC wrapper. Delegates; the command name and payload the frontend
/// sends are unchanged because this IS the registered command.
#[cfg(all(feature = "tauri-ipc", not(target_arch = "wasm32")))]
#[tauri::command]
pub async fn recover_with_phrase<R: Runtime>(
    vault_id: Option<String>,
    phrase: String,
    state: State<'_, VaultRuntimeState>,
    app: AppHandle<R>,
) -> Result<(), VaultRecoveryError> {
    recover_with_phrase_from_host(
        vault_id,
        phrase,
        state.inner(),
        &TauriHost::new(app),
        &crate::vault_io::StdVaultIo,
    )
    .await
}

/// Testable core of [`recover_with_phrase`]. The Tauri-command wrapper
/// resolves the platform-specific `vault.meta` path and delegates here
/// so tests do not need an [`AppHandle`].
///
/// All decisions documented on [`recover_with_phrase`] apply identically.
pub(crate) async fn recover_with_phrase_with_path(
    phrase: String,
    vault_id: Option<crate::vault_id::VaultId>,
    vault_path: &Path,
    state: &VaultRuntimeState,
    // See the sibling `complete_recovery_with_path`: the duration log was
    // `Instant`-based, and `Instant::now()` panics on wasm32 (task 12).
    host: &dyn HostCtx,
    io: &dyn crate::vault_io::VaultIo,
) -> Result<(), VaultRecoveryError> {
    // Wrap immediately so any early-return path (VaultAlreadyUnlocked,
    // RecoveryAlreadyInProgress, RecoveryInProgress, IO failure, parse
    // failure) drops the wrapper and zeroes the bytes. Plain `String`
    // would drop without zeroize.
    let phrase = Zeroizing::new(phrase);

    let started_ms = host.monotonic_millis();

    // Slot-map key resolution (sub-feature 2 task 4 — explicit vault_id
    // targeting): `Some(id)` is the EXPLICIT target the IPC layer threaded.
    // sole-vault fallback until picker (sub-feature 3): `None` derives the key
    // from the resolved vault ROOT (`vault_path` is `<vault-root>/vault.meta`;
    // its parent is the root).
    let vault_id = vault_id.unwrap_or_else(|| {
        crate::paths::vault_id_from_root(vault_path.parent().unwrap_or(vault_path))
    });

    // (1) Slot peek precedes permit acquire so the cheap occupied-slot
    //     guards never block on the semaphore. The two non-Empty
    //     variants surface as distinct guard variants so the frontend
    //     can route correctly: `Unlocked` → editor, `Recovering` →
    //     password-reset form (per `recovery-flow.md` §4.1's
    //     non-dismissible chained step).
    match state.slot_kind(vault_id).await {
        SlotKind::Empty => {}
        SlotKind::Unlocked => {
            tracing::error!(
                stage = "slot_check",
                error_kind = "VaultAlreadyUnlocked",
                "recovery attempt rejected: slot is Unlocked"
            );
            return Err(VaultRecoveryError::VaultAlreadyUnlocked);
        }
        SlotKind::Recovering => {
            tracing::error!(
                stage = "slot_check",
                error_kind = "RecoveryAlreadyInProgress",
                "recovery attempt rejected: slot is already Recovering (password commit pending)"
            );
            return Err(VaultRecoveryError::RecoveryAlreadyInProgress);
        }
        SlotKind::ImportSource => {
            tracing::error!(
                stage = "slot_check",
                error_kind = "VaultOpenAsImportSource",
                "recovery attempt rejected: slot is an open vault-import source"
            );
            return Err(VaultRecoveryError::VaultOpenAsImportSource);
        }
    }

    // (2) Acquire the shared auth permit (Semaphore capacity 1).
    //     Reject, don't queue: `decisions.md` 2026-05-02 generalizes
    //     `recovery-flow.md` §3.3's "single in-flight" posture across
    //     vault_unlock + vault_recover_with_phrase +
    //     vault_complete_recovery. RAII guard releases the permit on
    //     every return path — success, every error variant, panic
    //     unwind. Held across the spawn_blocking await so concurrent
    //     auth attempts see the permit busy.
    let _permit = match state.auth_permits().try_acquire() {
        Ok(p) => p,
        Err(_) => {
            tracing::error!(
                stage = "permit_acquire",
                error_kind = "RecoveryInProgress",
                "recovery attempt rejected: another auth op in flight"
            );
            return Err(VaultRecoveryError::RecoveryInProgress);
        }
    };

    // The READ moved out of the blocking closure and onto the seam
    // (`decisions.md` 2026-08-15). It still runs off the runtime worker — the
    // seam's native arm goes through `task::run_blocking` itself — so the
    // property the old comment claimed is preserved; what changed is that OPFS
    // can answer it too. Parse, NFKD, KDF and AEAD stay inside the blocking
    // task below, which is where the CPU actually is.
    let bytes = match io.read(vault_path).await {
        Ok(bytes) => bytes,
        Err(e) => {
            // The seam's error vocabulary is closed and deliberately small, so
            // the NotFound arm is matched on the seam's own kind rather than on
            // an `io::ErrorKind`. Recovery is unreachable without a vault, and
            // saying "not found" is materially different from "the disk failed"
            // for a user who is already having a bad day.
            return Err(match e {
                crate::io_failure_kind::IoFailureKind::NotFound => {
                    tracing::error!(
                        stage = "read_meta",
                        error_kind = "VaultNotFound",
                        "vault.meta does not exist (recovery flow unreachable without a vault)"
                    );
                    VaultRecoveryError::VaultNotFound
                }
                other => {
                    tracing::error!(
                        stage = "read_meta",
                        error_kind = "IoError",
                        io_failure_kind = ?other,
                        "vault.meta read failed"
                    );
                    VaultRecoveryError::IoError {
                        io_error_kind: other,
                    }
                }
            });
        }
    };

    let join_outcome =
        crate::task::run_blocking(move || -> Result<DerivedKeys, VaultRecoveryError> {
            // Accept a v0.1 (`MYV1`) OR a migrated v0.2 (`NTV5`) vault.meta;
            // `version` selects the recovery-wrap salt domain + AAD prefix and the
            // itemsKey-wrap subkey context so a migrated vault recovers by phrase
            // without leaving the v0.2 hierarchy (§10.4.1, #420).
            let version = protocol::meta_version_of(&bytes).unwrap_or(protocol::MetaVersion::V0_1);
            let meta = protocol::parse_vault_meta_any(&bytes).map_err(|e| {
                tracing::error!(
                    stage = "parse_meta",
                    error_kind = "InvalidVaultMeta",
                    protocol_error_kind = protocol_error_kind(&e),
                    "vault.meta parse rejected"
                );
                VaultRecoveryError::InvalidVaultMeta
            })?;

            let items_key_id = meta.items_key_id;
            let root_key = derive_root_key_from_phrase(version, &phrase, &meta)?;
            // An `NTV6` vault seals `itemsKey` under the GROUP tier, so the
            // root-tier derive fails there; recover the group key first.
            // items_key derivation drops `root_key` on early-return; the slot
            // stays empty (no half-state).
            let items_key = if bytes.get(..4) == Some(protocol::VAULT_META_NTV6_MAGIC.as_slice()) {
                let b2b = protocol::parse_vault_meta_ntv6(&bytes)
                    .map_err(|_| VaultRecoveryError::InvalidVaultMeta)?;
                let g = protocol::unlock_group_key_ntv6(&b2b, &protocol::OwnerKey::new(*root_key))
                    .map_err(|_| VaultRecoveryError::InvalidVaultMeta)?;
                let gk = protocol::GroupKey::new(*g);
                protocol::unlock_items_key_ntv6(&b2b, &gk)
                    .map_err(|_| VaultRecoveryError::InvalidVaultMeta)?
            } else {
                derive_items_key(version, &root_key, &meta)?
            };
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
        // Inner `Err` was already traced at its origin; do not
        // double-trace here.
        Ok(Err(inner)) => return Err(inner),
        Err(_) => {
            tracing::error!(
                stage = "spawn_blocking_join",
                error_kind = "JoinFailure",
                "blocking task join failed"
            );
            return Err(VaultRecoveryError::JoinFailure);
        }
    };

    let now_ms = host.monotonic_millis();
    state
        .set_recovering(
            vault_id,
            RecoveringMaterial {
                root_key,
                items_key,
                items_key_id,
                recovered_at: now_ms,
            },
        )
        .await;

    // Success event. Coarse `duration_ms` only — no account
    // identifier, no path, no key material. Per ALLOW-list in
    // `src-tauri/CLAUDE.md` "Secret-handling logging discipline".
    // `duration_ms` rounded down to 10ms granularity per
    // `decisions.md` 2026-05-06 "Tracing event-name pattern" entry.
    tracing::info!(
        event = "vault_recovered_with_phrase",
        duration_ms = (now_ms.saturating_sub(started_ms) / 10) * 10,
        "vault recovered successfully (Slot::Recovering populated, awaiting password commit)"
    );

    Ok(())
}

/// Commit a new master password after a successful recovery.
///
/// Promotes `Slot::Recovering` → `Slot::Unlocked` per
/// `recovery-flow.md` §4.1's non-dismissible mandatory chained step.
/// The slot MUST be `Recovering`; any other variant returns
/// `VaultRecoveryRequiresActiveSession`.
///
/// `new_password` is wrapped in `Zeroizing<String>` on the first
/// non-doc statement.
///
/// Pipeline: slot peek → `auth_permits.try_acquire` →
/// `state.take_recovering()` (slot becomes Empty; material owned)
/// → spawn_blocking {fresh CSPRNG salt + nonce, read+parse `vault.meta`,
/// `protocol::rewrite_vault_meta_password_side`, `atomic_write`
/// per §4.2 tempfile+fsync+rename} → on success the closure returns
/// the recovering material so the post-join code can `set_unlocked`.
///
/// On any failure path the recovering material drops + zeroizes; the
/// slot stays `Empty`; `vault.meta` on disk is unchanged (atomic
/// rename is the gate). The user must restart from
/// `recover_with_phrase`, but the original password still works
/// because the rewrite never landed.
///
/// **`vault_status` is NOT part of the happy path.** Frontend
/// navigates directly to the editor on `Ok(())`; a defensive
/// `vault_status` round-trip would be paranoia (`decisions.md`
/// 2026-05-02 — IPC contract pins `Slot::Unlocked` as success).
/// `vault_status` is for boot + post-WebView-reload routing only.
pub async fn complete_recovery_from_host(
    vault_id: Option<String>,
    new_password: String,
    state: &VaultRuntimeState,
    hooks: &crate::hooks::Hooks,
    host: &dyn HostCtx,
    // Threaded through since `decisions.md` 2026-08-15. Same reasoning as its
    // sibling: one implementation, the seam's native arm forwarding to the same
    // `atomic_write` that owned durability before, so "no behaviour change on
    // desktop" stays checkable by reading rather than only by running.
    io: &dyn crate::vault_io::VaultIo,
    // The post-unlock pipeline below now also seals the vault's name into the
    // device-local label store (myne-md/myne#411). Recovery ends with an
    // unlocked vault like every other credential path, so it owes the same
    // write.
    keychain: &dyn crate::vault_label::key::LabelKeychain,
) -> Result<(), VaultRecoveryError> {
    // SYNC-6 targeting: `Some(id)` commits against exactly `vaults/<id>/`;
    // `None`/malformed → resolution below. The resolved id keys BOTH the
    // path resolution and the slot map so they cannot diverge.
    let target = crate::vault_id::VaultId::parse_optional(vault_id.as_deref());
    // MYND-220 (VR-18): a RESUMED reset (post-WebView-reload) carries no
    // UI-side id — the runtime owns recovery identity, so resolve the sole
    // `Recovering` slot BEFORE the transitional sole-on-disk heuristic
    // (`current_vault_root_from_base` falls through to the legacy `vault/`
    // path at ≥2 vaults and would miss the Recovering vault entirely,
    // bouncing the user in a `VaultRecoveryRequiresActiveSession` loop
    // mid-recovery). Cold single-vault resets keep the old fallback via
    // `vault_meta_path(None)` when no slot is Recovering (defensive — the
    // command is only reachable with a Recovering slot in normal flow).
    let target = match target {
        Some(id) => Some(id),
        None => state.recovering_vault_id().await,
    };
    let vault_path = vault_meta_path(host, target)?;
    complete_recovery_with_path(new_password, target, &vault_path, state, hooks, host, io).await?;

    // MYND-160 fix: a post-recovery slot transition to Unlocked owes the same
    // post-unlock pipeline as every other credential path — persisted prefs
    // (user story 11), search hydration, and the steps this call site used to
    // omit (spell, AI vectors, the rename roll-forward, the stray-blob
    // reclaim). Best-effort post-pipeline hook; failure does not propagate
    // (`vault_complete_recovery`'s `Ok(())` is already committed by this
    // point). See `run_post_unlock_pipeline` for why the steps live in one
    // shared function rather than inline per path.
    crate::plugins::vault_unlock::commands::run_post_unlock_pipeline(
        host, state, hooks,
        // The threaded seam, not `StdVaultIo`: that concrete type is
        // `#[cfg(not(wasm32))]`, so hardcoding it here compiled on desktop and
        // broke the wasm build the moment this path stopped being gated out
        // (`decisions.md` 2026-08-15).
        io, keychain,
    )
    .await;

    // F1: recovery reset just rewrote the password-side wrap of `vault.meta`
    // (root_key preserved). Best-effort push it so a second device derives
    // root_key against the NEW password wrap, not the stale server copy — same
    // rationale and non-blocking posture as the change-password path. Offline
    // leaves the `vault.meta-dirty` marker for the sync loop's meta phase.
    // Host-only: the post-change `vault.meta` push rides the raw-TLS sync
    // transport, which does not exist on wasm — the browser's transport is
    // `fetch` + `EventSource` (phase3-web-client task 84). Deliberately NOT
    // no-opped on the wasm arm: task 88 requires `change_password` on web to
    // be gated behind a **server-acknowledged** push, so silently skipping it
    // here would build exactly the failure that task exists to prevent.
    #[cfg(all(feature = "tauri-ipc", not(target_arch = "wasm32")))]
    let _ = crate::plugins::sync::commands::push_vault_meta_now_from_host(host, state).await;

    Ok(())
}

/// IPC wrapper. Delegates; the command name and payload the frontend
/// sends are unchanged because this IS the registered command.
#[cfg(all(feature = "tauri-ipc", not(target_arch = "wasm32")))]
#[tauri::command]
pub async fn complete_recovery<R: Runtime>(
    vault_id: Option<String>,
    new_password: String,
    state: State<'_, VaultRuntimeState>,
    hooks: State<'_, crate::hooks::Hooks>,
    app: AppHandle<R>,
) -> Result<(), VaultRecoveryError> {
    complete_recovery_from_host(
        vault_id,
        new_password,
        state.inner(),
        hooks.inner(),
        &TauriHost::new(app),
        &crate::vault_io::StdVaultIo,
        crate::vault_label::key::platform_keychain(),
    )
    .await
}

/// Testable core of [`complete_recovery`]. The Tauri-command wrapper
/// resolves the platform-specific `vault.meta` path and delegates here
/// so tests do not need an [`AppHandle`].
///
/// All decisions documented on [`complete_recovery`] apply identically.
pub(crate) async fn complete_recovery_with_path(
    new_password: String,
    vault_id: Option<crate::vault_id::VaultId>,
    vault_path: &Path,
    state: &VaultRuntimeState,
    // Needed only for the quick-unlock invalidation at the tail. It is taken
    // HERE rather than in the caller so the invalidation runs while the
    // `auth_permits` guard below is still held — see the call site's comment.
    hooks: &crate::hooks::Hooks,
    // Supplies `UnlockedVault::unlocked_at` and the duration log, both of which
    // were `Instant`-based until phase3-web-client task 12 — `Instant::now()`
    // panics on wasm32. This path SHIPS on web since `decisions.md` 2026-08-15;
    // the note above about it being "decided absent on web" no longer holds.
    host: &dyn HostCtx,
    io: &dyn crate::vault_io::VaultIo,
) -> Result<(), VaultRecoveryError> {
    // Wrap immediately so any early-return path drops the wrapper and
    // zeroes the bytes.
    let new_password = Zeroizing::new(new_password);
    let started_ms = host.monotonic_millis();

    // (0) Backend min-length floor — structural belt+suspenders against
    //     frontend bypass per `decisions.md` 2026-05-06 "Auth-pipeline
    //     backend MIN_PASSWORD_LEN floor; project-wide retroactive".
    //     Fires BEFORE slot peek + permit acquire so a weak-password
    //     submit does not consume the shared `auth_permits` slot.
    //     Cross-plugin shared variant name with
    //     `AppError::WeakNewPassword` (vault_creation) per Q6 of the
    //     MYND-22 grilling.
    if protocol::password_policy::validate_min_length(&new_password).is_err() {
        tracing::error!(
            stage = "weak_new_password",
            error_kind = "WeakNewPassword",
            "complete_recovery rejected: new password below MIN_PASSWORD_LEN"
        );
        return Err(VaultRecoveryError::WeakNewPassword);
    }

    // Slot-map key resolution (sub-feature 2 task 4 — explicit vault_id
    // targeting): `Some(id)` is the EXPLICIT target the IPC layer threaded.
    // sole-vault fallback until picker (sub-feature 3): `None` derives the key
    // from the resolved vault ROOT (`vault_path` is `<vault-root>/vault.meta`;
    // its parent is the root).
    let vault_id = vault_id.unwrap_or_else(|| {
        crate::paths::vault_id_from_root(vault_path.parent().unwrap_or(vault_path))
    });

    // (1) Slot peek — must be Recovering.
    match state.slot_kind(vault_id).await {
        SlotKind::Recovering => {}
        // An import source slot joins the reject arm: `complete_recovery`
        // requires a Recovering slot for THIS vault, and a read context over
        // the same id is not one.
        SlotKind::Empty | SlotKind::Unlocked | SlotKind::ImportSource => {
            tracing::error!(
                stage = "slot_check",
                error_kind = "VaultRecoveryRequiresActiveSession",
                "complete_recovery rejected: slot is not Recovering"
            );
            return Err(VaultRecoveryError::VaultRecoveryRequiresActiveSession);
        }
    }

    // (2) Acquire shared auth permit (RAII guard).
    let _permit = match state.auth_permits().try_acquire() {
        Ok(p) => p,
        Err(_) => {
            tracing::error!(
                stage = "permit_acquire",
                error_kind = "RecoveryInProgress",
                "complete_recovery rejected: another auth op in flight"
            );
            return Err(VaultRecoveryError::RecoveryInProgress);
        }
    };

    // (3) Snapshot `root_key` from the still-Recovering slot via a
    //     read-lock CLONE. Slot stays Recovering across the Argon2id
    //     work — this is the (p) post-Argon2id slot peek pattern
    //     (MYND-22 grilling Q4): if `vault_lock` fires mid-Argon2id
    //     and drops Slot::Recovering → Slot::Empty, the post-await
    //     `take_recovering()` (step 5) returns None and we bail with
    //     `RecoveryAbortedByLock` without touching vault.meta.
    //
    //     Vacuous-by-affordance-absence today (recovery UI shows no
    //     Cancel during decrypting per recovery-flow.md §3.3) but
    //     contract-correct if a Cancel affordance ever ships;
    //     symmetric with `vault_change_password::commit`'s
    //     `VaultLockedDuringChange`. See `decisions.md` 2026-05-06
    //     entry "vault_complete_recovery post-Argon2id slot peek
    //     symmetric retrofit".
    //
    //     The clone is a stack-bound 32-byte copy (Phase 1 A7 side-
    //     channel out of scope); the original Zeroizing<[u8; 32]>
    //     stays in the slot, the clone moves into the spawn_blocking
    //     closure and zeroizes on closure exit.
    let root_key_snapshot: Zeroizing<[u8; AEAD_KEY_LEN]> =
        match state.peek_recovering_root_key_clone().await {
            Some(rk) => rk,
            None => {
                // Race between step (1) `slot_kind` peek and now —
                // possible because `slot_kind` releases the read lock
                // before returning. Surface as the existing variant.
                tracing::error!(
                    stage = "snapshot_recovering",
                    error_kind = "VaultRecoveryRequiresActiveSession",
                    "complete_recovery race: slot was Recovering at peek but not now"
                );
                return Err(VaultRecoveryError::VaultRecoveryRequiresActiveSession);
            }
        };

    let vault_path_for_write = vault_path.to_path_buf();

    // The read moved out of the derive closure and onto the seam
    // (`decisions.md` 2026-08-15). Ordering is unchanged in the way that
    // matters: this still happens AFTER the slot was taken and BEFORE any
    // Argon2id work, so a vault.meta that vanished mid-recovery is still caught
    // here rather than after a two-second derivation.
    let meta_bytes = match io.read(vault_path).await {
        Ok(bytes) => bytes,
        Err(e) => {
            return Err(match e {
                IoFailureKind::NotFound => {
                    tracing::error!(
                        stage = "read_meta",
                        error_kind = "VaultNotFound",
                        "vault.meta vanished mid-recovery"
                    );
                    VaultRecoveryError::VaultNotFound
                }
                other => {
                    tracing::error!(
                        stage = "read_meta",
                        error_kind = "IoError",
                        io_failure_kind = ?other,
                        "vault.meta read failed during complete_recovery"
                    );
                    VaultRecoveryError::IoError {
                        io_error_kind: other,
                    }
                }
            });
        }
    };

    // (4) Run the Argon2id-bound derivation pipeline in spawn_blocking.
    //     Returns the freshly-built vault.meta bytes WITHOUT writing
    //     them to disk — disk write is conditional on the post-Argon2id
    //     slot peek (step 5).
    let derive_outcome =
        crate::task::run_blocking(move || -> Result<Vec<u8>, VaultRecoveryError> {
            // (a) Fresh CSPRNG salt + nonce.
            let mut fresh_salt = [0u8; ARGON2_SALT_LEN];
            getrandom::getrandom(&mut fresh_salt).map_err(|_| {
                tracing::error!(
                    stage = "csprng_salt_nonce",
                    error_kind = "IoError",
                    "OS CSPRNG failed for fresh password salt"
                );
                VaultRecoveryError::IoError {
                    io_error_kind: IoFailureKind::Other,
                }
            })?;
            let mut fresh_nonce = [0u8; AEAD_NONCE_LEN];
            getrandom::getrandom(&mut fresh_nonce).map_err(|_| {
                tracing::error!(
                    stage = "csprng_salt_nonce",
                    error_kind = "IoError",
                    "OS CSPRNG failed for fresh password nonce"
                );
                VaultRecoveryError::IoError {
                    io_error_kind: IoFailureKind::Other,
                }
            })?;

            // (b) The existing vault.meta, read through the seam before this
            //     closure was entered (see `meta_bytes` above).
            let bytes: Vec<u8> = meta_bytes;

            // (c) Parse — v0.1 (`MYV1`) or migrated v0.2 (`NTV5`); the rewrite below
            //     stays in the same generation.
            let version = protocol::meta_version_of(&bytes).unwrap_or(protocol::MetaVersion::V0_1);
            let parsed = protocol::parse_vault_meta_any(&bytes).map_err(|e| {
                tracing::error!(
                    stage = "parse_meta",
                    error_kind = "InvalidVaultMeta",
                    protocol_error_kind = protocol_error_kind(&e),
                    "vault.meta parse failed during complete_recovery"
                );
                VaultRecoveryError::InvalidVaultMeta
            })?;

            // (d) Rewrite the password side. Helper preserves
            //     `parsed.kdf_params` internally so the new wrap-key
            //     uses the same security parameters the vault was
            //     created under (parameter upgrade is a separate Phase
            //     2+ feature decision).
            let rewrite = if bytes.get(..4) == Some(protocol::VAULT_META_NTV6_MAGIC.as_slice()) {
                // An `NTV6` rewrite must carry the B2B tail; the versioned v0.2
                // rewrite would re-serialize as `NTV5` and drop it.
                let b2b = protocol::parse_vault_meta_ntv6(&bytes)
                    .map_err(|_| VaultRecoveryError::InvalidVaultMeta)?;
                protocol::rewrite_vault_meta_password_side_ntv6(
                    &b2b,
                    &root_key_snapshot,
                    new_password.as_str(),
                    &fresh_salt,
                    &fresh_nonce,
                )
            } else {
                protocol::rewrite_vault_meta_password_side_versioned(
                    version,
                    &parsed,
                    &root_key_snapshot,
                    new_password.as_str(),
                    &fresh_salt,
                    &fresh_nonce,
                )
            };
            let new_bytes = rewrite.map_err(|e| {
                tracing::error!(
                    stage = "vault_meta_rewrite",
                    error_kind = "InvalidVaultMeta",
                    protocol_error_kind = protocol_error_kind(&e),
                    "vault.meta rewrite failed during complete_recovery"
                );
                // KdfFailure / AeadFailure here are theoretically
                // unreachable (params come from a parsed vault.meta;
                // seal step has fixed AAD width). If the underlying
                // primitives reject, surface as InvalidVaultMeta —
                // user-facing CTA "vault unreadable" is a partial fit
                // and matches the unlock-error-discipline parallel
                // (`decisions.md` 2026-05-02).
                VaultRecoveryError::InvalidVaultMeta
            })?;

            Ok(new_bytes)
        })
        .await;

    let new_bytes = match derive_outcome {
        Ok(Ok(b)) => b,
        Ok(Err(inner)) => return Err(inner),
        Err(_) => {
            tracing::error!(
                stage = "spawn_blocking_join",
                error_kind = "JoinFailure",
                "blocking derivation task join failed during complete_recovery"
            );
            return Err(VaultRecoveryError::JoinFailure);
        }
    };

    // (5) Post-Argon2id slot peek (option p). Take the recovering
    //     material now — if it is gone, `vault_lock` (or another
    //     slot-dropping action) fired during the derivation window;
    //     bail without disk write.
    let recovering = match state.take_recovering(vault_id).await {
        Some(m) => m,
        None => {
            tracing::warn!(
                stage = "post_argon2id_slot_peek",
                error_kind = "RecoveryAbortedByLock",
                "vault_lock fired mid-Argon2id during complete_recovery; bailing without disk write"
            );
            return Err(VaultRecoveryError::RecoveryAbortedByLock);
        }
    };

    // (6) Atomic write + SHA-256 of the freshly-written bytes in a
    //     second spawn_blocking. The hash becomes the
    //     `Slot::Unlocked.vault_meta_bytes_hash` CAS anchor for
    //     `vault_change_password` per `decisions.md` 2026-05-06 entry;
    //     captured AFTER atomic_write succeeds so it pins what is
    //     actually on disk, not the in-memory blob.
    //
    //     If atomic_write fails here, `recovering` (held in this
    //     async scope) drops on early-return — Zeroizing wipes the
    //     keys. The slot is currently Empty (we just took); the user
    //     must restart from A8d.
    //     The write goes through the IO SEAM, not `crate::atomic_write`.
    //
    //     `atomic_write` cannot succeed on wasm32 and does not pretend it can:
    //     `finalize_atomic`'s wasm arm returns `ErrorKind::Unsupported` by
    //     design, with a comment saying a caller reaching it has bypassed the
    //     double buffer. `vault.meta` is a `Doubled` container in OPFS, so a
    //     plain-path write would not be findable by the web reader even if it
    //     landed. Threading the seam through the READ and leaving the one WRITE
    //     on the native helper is how the chained password reset would have
    //     failed AFTER Argon2id, with the slot already consumed and the vault
    //     still on the old password.
    //
    //     Its native arm forwards to the same `atomic_write(.., replace)` this
    //     line used to call, so desktop and mobile durability is unchanged and
    //     stays checkable by reading `StdVaultIo::write`.
    io.write(
        &vault_path_for_write,
        &new_bytes,
        crate::vault_io::WriteOpts::default(),
    )
    .await
    .map_err(|io_kind| {
        tracing::error!(
            stage = "tempfile_rename",
            error_kind = "IoError",
            io_failure_kind = ?io_kind,
            "atomic write of new vault.meta failed during complete_recovery"
        );
        VaultRecoveryError::IoError {
            io_error_kind: io_kind,
        }
    })?;

    // (f) SHA-256 of the freshly-written bytes. Captured AFTER the write
    //     succeeds so it pins what is actually stored, not the in-memory blob.
    let vault_meta_bytes_hash = crate::vault_meta_hash::vault_meta_sha256(&new_bytes);

    // (7) Promote Slot::Recovering material → Slot::Unlocked.
    // Host clock (phase3-web-client task 12): `unlocked_at` is a monotonic
    // millisecond reading, because `Instant::now()` panics on wasm32. This path
    // is decided absent on web, but it shares the `UnlockedVault` type.
    let now_ms = host.monotonic_millis();
    // An `NTV6` vault's session carries the group tier, so the shared
    // singletons derive from the group key rather than the root key.
    let group_key = if new_bytes.get(..4) == Some(protocol::VAULT_META_NTV6_MAGIC.as_slice()) {
        let b2b = protocol::parse_vault_meta_ntv6(&new_bytes)
            .map_err(|_| VaultRecoveryError::InvalidVaultMeta)?;
        Some(
            protocol::unlock_group_key_ntv6(&b2b, &protocol::OwnerKey::new(*recovering.root_key))
                .map_err(|_| VaultRecoveryError::InvalidVaultMeta)?,
        )
    } else {
        None
    };
    state
        .set_unlocked(
            vault_id,
            UnlockedVault::owner(
                recovering.root_key,
                group_key,
                recovering.items_key,
                recovering.items_key_id,
                now_ms,
                vault_meta_bytes_hash,
            ),
        )
        .await;

    // Success event. Coarse `duration_ms` only — no account
    // identifier, no path, no key material. Per ALLOW-list in
    // `src-tauri/CLAUDE.md` "Secret-handling logging discipline".
    // `duration_ms` rounded down to 10ms granularity per
    // `decisions.md` 2026-05-06 "Tracing event-name pattern" entry.
    // Event name `vault_recovery_completed` follows the project-wide
    // `vault_<verb_past>` discipline that pins by example for the
    // future `vault_password_changed` (MYND-22 plugin tasks).
    tracing::info!(
        event = "vault_recovery_completed",
        duration_ms = (now_ms.saturating_sub(started_ms) / 10) * 10,
        "post-recovery password commit succeeded; slot is Unlocked"
    );

    // `protocol.md` §9.14.4: committing a new master password invalidates any
    // device-local quick-unlock credential for this vault. Completing a
    // recovery IS such a commit (§7.3; `recovery-flow.md` §4) — and it is the
    // stronger signal of the two, because the user reached it by losing the
    // password rather than by choosing to rotate it.
    //
    // Without this, a pre-recovery PIN or Face ID kept working afterwards.
    // `root_key` is preserved by both rotation paths and the quick-unlock AAD
    // binds only `account_number_hash` + `provider_kind`, neither of which
    // moves, so the stale credential does not dangle — it still unwraps the
    // live `root_key`. The user watches the old password stop working and
    // reasonably concludes access was revoked.
    //
    // Placed here, as the LAST act inside the `auth_permits` guard, for the
    // reason `quick_unlock::commands::invalidate_credential` documents: the
    // permit is what stops a concurrent `setup_with_dir` from re-creating the
    // credential this just deleted. A raceable deletion is not a deletion.
    // That is also why `hooks` is threaded down to this function rather than
    // invalidating in `complete_recovery_from_host`, where the permit has
    // already been released.
    //
    // Best-effort and silent, matching the change-password path: absence of a
    // credential is a no-op, and the user re-enrols from Settings.
    if let Some(vault_dir) = vault_path.parent() {
        hooks.invalidate_quick_unlock(vault_dir);
    }

    Ok(())
}

/// Resolve a user-supplied account-number to the [`VaultId`] of the on-disk
/// vault whose `vault.meta` header `account_number_hash` matches — the
/// OPTIONAL multi-vault recovery selector (SYNC-12).
///
/// Returns `Some(<canonical VaultId string>)` for the first matching vault,
/// `None` for EVERY failure mode (malformed account-number OR no on-disk
/// match) — the single non-distinguishing result per `account-number.md` §5.
/// The caller (recovery selection stage) treats `Some` as "advance to phrase
/// entry against this vault" and `None` as a single generic "invalid account
/// number" — it cannot tell a typo from a no-match.
///
/// **Selection only — NO cryptographic change.** This reads only the plaintext
/// `account_number_hash` header field (`protocol.md` §9.3 offset 6): NO
/// decrypt, NO unlock, NO Argon2id, and it acquires NO `auth_permits` (it is
/// not an Argon2id path). `account_number_hash` already binds both Argon2id
/// salts (`protocol.md` §3.1); picking a vault by it just chooses WHICH
/// `vault.meta` the unchanged recovery pipeline subsequently reads.
///
/// **Logging discipline.** `account_number_hash` bytes are DENY-listed
/// (`src-tauri/CLAUDE.md`). This command emits NONE of them — nor the parsed
/// account-number, nor any per-vault hash, nor the resolved `VaultId`, nor a
/// path — via `tracing`/IPC/format. It returns a bare `Option<String>`.
pub async fn resolve_vault_by_account_number_from_host(
    account_number: String,
    host: &dyn HostCtx,
) -> Result<Option<String>, VaultRecoveryError> {
    let base = host
        .app_data_dir()
        .map_err(|_| VaultRecoveryError::IoError {
            io_error_kind: IoFailureKind::Other,
        })?;
    Ok(
        super::account_number_select::resolve_vault_by_account_number(&base, &account_number)
            .map(|id| id.to_string()),
    )
}

/// IPC wrapper. Delegates; the command name and payload the frontend
/// sends are unchanged because this IS the registered command.
#[cfg(all(feature = "tauri-ipc", not(target_arch = "wasm32")))]
#[tauri::command]
pub async fn resolve_vault_by_account_number<R: Runtime>(
    account_number: String,
    app: AppHandle<R>,
) -> Result<Option<String>, VaultRecoveryError> {
    resolve_vault_by_account_number_from_host(account_number, &TauriHost::new(app)).await
}

/// Step (a)+(b) of the spawn_blocking pipeline: NFKD-normalize the
/// raw phrase bytes, derive `recovery_wrap_key` via Argon2id, AEAD-open
/// `enc_root_key_recovery`. Borrows the phrase as `&str`; no clone, no
/// format-arg, no log of phrase contents.
///
/// `AeadFailure` from the AEAD-open is the §3.4 non-distinguishing tag
/// (`InvalidCredentialOrVault` — covers wrong phrase AND tampered
/// recovery section indistinguishably). `KdfFailure` and any other
/// `ProtocolError` precede AEAD verification or arise from structural
/// `vault.meta` corruption; both surface as `InvalidVaultMeta`, leaking
/// no phrase-conditional information.
pub(crate) fn derive_root_key_from_phrase(
    version: protocol::MetaVersion,
    phrase: &str,
    meta: &VaultMeta,
) -> Result<Zeroizing<[u8; AEAD_KEY_LEN]>, VaultRecoveryError> {
    // (a) NFKD + lowercase + trim + whitespace coalesce per §7.4. The
    // returned `Zeroizing<String>` is the `phrase_normalized` form; it
    // wipes on drop at end of this function.
    let normalized = protocol::normalize_user_phrase(phrase);
    tracing::debug!(stage = "phrase_normalize", "phrase normalized for KDF");

    // (b) Recovery wrap-key derivation. We use the
    // `from_normalized` variant so we feed the spec §7.4
    // `phrase_normalized` bytes directly to Argon2id WITHOUT a
    // BIP-39 wordlist lookup — wordlist validation here would leak
    // membership signal per `recovery-flow.md` §3.2. Invalid phrases
    // produce a wrap key that fails AEAD-tag verification on
    // `enc_root_key_recovery` downstream.
    protocol::validate_kdf_params(&meta.kdf_params).map_err(|e| {
        tracing::error!(
            stage = "kdf_params_range",
            protocol_error_kind = protocol_error_kind(&e),
            "kdf params outside accepted range"
        );
        phrase_or_meta(e)
    })?;

    let wrap_key = if version == protocol::MetaVersion::V0_2 {
        protocol::derive_recovery_wrap_key_from_normalized_v0_2(
            normalized.as_str(),
            &meta.random_salt_recovery,
            &meta.account_number_hash,
            &meta.kdf_params,
        )
    } else {
        protocol::derive_recovery_wrap_key_from_normalized(
            normalized.as_str(),
            &meta.random_salt_recovery,
            &meta.account_number_hash,
            &meta.kdf_params,
        )
    }
    .map_err(|e| {
        tracing::error!(
            stage = "phrase_kdf",
            protocol_error_kind = protocol_error_kind(&e),
            "recovery wrap-key derivation failed"
        );
        phrase_or_meta(e)
    })?;

    let aad = if version == protocol::MetaVersion::V0_2 {
        protocol::aad_recovery_wrap_v0_2(&meta.kdf_params)
    } else {
        protocol::aad_recovery_wrap(&meta.kdf_params)
    };
    open_32_byte_secret(
        &wrap_key,
        &meta.nonce_recovery_wrap,
        &meta.enc_root_key_recovery,
        &aad,
        "root_unwrap_recovery",
        phrase_or_meta,
    )
}

/// Error mapping for the recovery-wrap pipeline (KDF + root_key
/// AEAD-open). `AeadFailure` is the §3.4 non-distinguishing tag
/// (`InvalidCredentialOrVault`); everything else is structural and
/// surfaces as `InvalidVaultMeta`.
fn phrase_or_meta(e: protocol::ProtocolError) -> VaultRecoveryError {
    match e {
        protocol::ProtocolError::AeadFailure => VaultRecoveryError::InvalidCredentialOrVault,
        _ => VaultRecoveryError::InvalidVaultMeta,
    }
}

/// Step (c) of the spawn_blocking pipeline: derive `itemsKey_wrap_key`
/// via the canonical `derive_subkey` helper (HKDF-SHA-256 with the
/// registered `ItemsKeyWrap` role context string per `protocol.md`
/// §3.4) and AEAD-open `enc_items_key`.
///
/// **Error mapping is intentionally distinct from
/// [`derive_root_key_from_phrase`].** AEAD-tag failure here is mapped
/// to `InvalidVaultMeta`, NOT `InvalidCredentialOrVault`, because the
/// recovery wrap-key has already verified by the time this is called —
/// distinguishing items_key wrap failure leaks nothing about
/// credential validity (`decisions.md` 2026-05-02 unlock-error
/// discipline applies here in parallel).
pub(crate) fn derive_items_key(
    version: protocol::MetaVersion,
    root_key: &[u8; AEAD_KEY_LEN],
    meta: &VaultMeta,
) -> Result<Zeroizing<[u8; AEAD_KEY_LEN]>, VaultRecoveryError> {
    let items_wrap_key =
        protocol::derive_subkey_versioned(version, root_key, protocol::SubkeyRole::ItemsKeyWrap);
    let aad = if version == protocol::MetaVersion::V0_2 {
        protocol::aad_vault_items_key_wrap_v0_2(&meta.items_key_id)
    } else {
        protocol::aad_vault_items_key_wrap(&meta.items_key_id)
    };
    open_32_byte_secret(
        &items_wrap_key,
        &meta.items_key_nonce,
        &meta.enc_items_key,
        &aad,
        "items_key_unwrap_recovery",
        // AEAD failure here is post-recovery-wrap-verification, so it
        // does NOT collapse into `InvalidCredentialOrVault` — the
        // recovery wrap already verified, and distinguishing this
        // blob's failure leaks no credential information. Single map
        // to `InvalidVaultMeta`.
        |_| VaultRecoveryError::InvalidVaultMeta,
    )
}

/// AEAD-open a 32-byte secret blob under `wrap_key` + `nonce` + `aad`,
/// emit a stage-tagged tracing record on failure, and copy the
/// plaintext into a fresh `Zeroizing<[u8; AEAD_KEY_LEN]>`. Used by
/// both `derive_root_key_from_phrase` and `derive_items_key` — the
/// AEAD-open + length-check + copy pattern is the single shared shape
/// for every 32-byte unwrap on the recovery path. Mirror of
/// `vault_unlock::commands::open_32_byte_secret` (different error
/// type).
fn open_32_byte_secret(
    wrap_key: &[u8; AEAD_KEY_LEN],
    nonce: &[u8; AEAD_NONCE_LEN],
    sealed: &[u8],
    aad: &[u8],
    stage: &'static str,
    map_err: impl FnOnce(protocol::ProtocolError) -> VaultRecoveryError,
) -> Result<Zeroizing<[u8; AEAD_KEY_LEN]>, VaultRecoveryError> {
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::plugins::vault_creation::commands::{build_and_serialize_vault_meta, build_session};
    use crate::plugins::vault_unlock::state::{
        fixture_recovering_with_keys, fixture_unlocked_with_keys, test_vault_id, Slot,
    };
    use crate::test_support::{ScratchVault, FAST_TEST_KDF};

    fn noop_hooks() -> crate::hooks::Hooks {
        std::sync::Arc::new(crate::hooks::NoopHooks)
    }

    fn rt() -> tokio::runtime::Runtime {
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("current-thread runtime build")
    }

    fn scratch_vault() -> ScratchVault {
        ScratchVault::new("recover_test")
    }

    /// Seed a real `vault.meta` via `vault_creation::build_session`
    /// plus `build_and_serialize_vault_meta`. Returns the bytes, the
    /// original session-side `root_key`, and the freshly-generated
    /// recovery phrase as a single ASCII space-joined string.
    fn seed_vault_meta(
        password: &str,
    ) -> ([u8; protocol::VAULT_META_LEN], [u8; AEAD_KEY_LEN], String) {
        let session = build_session(crate::vault_id::VaultId::mint(), password, FAST_TEST_KDF)
            .expect("build_session");
        let original_root_key: [u8; AEAD_KEY_LEN] = *session.root_key;
        let phrase_string: String = (*session.phrase.join_normalized()).to_string();
        let bytes = build_and_serialize_vault_meta(&session).expect("serialize vault.meta");
        (bytes, original_root_key, phrase_string)
    }

    #[test]
    fn round_trip_recover_recovers_original_root_key() {
        rt().block_on(async {
            let scratch = scratch_vault();
            let (meta_bytes, original_root_key, phrase) = seed_vault_meta("pw");
            scratch.write_meta(&meta_bytes);

            let state = VaultRuntimeState::default();
            recover_with_phrase_with_path(
                phrase,
                None,
                scratch.path(),
                &state,
                &crate::host::NoopHost,
                &crate::vault_io::StdVaultIo,
            )
            .await
            .expect("recover with correct phrase");

            // Slot is now Recovering; both keys derived eagerly.
            let taken = state.take(test_vault_id()).await;
            match taken {
                Slot::Recovering {
                    root_key,
                    items_key: _,
                    items_key_id: _,
                    recovered_at: _,
                } => {
                    assert_eq!(*root_key, original_root_key);
                }
                _ => panic!("expected Slot::Recovering after recover_with_phrase success"),
            }
        });
    }

    #[test]
    fn recover_with_explicit_vault_id_keys_the_recovering_slot_under_that_id() {
        // SYNC-6 targeting (task 4): an EXPLICIT `Some(id)` keys the Recovering
        // slot under exactly that id, NOT the path-derived legacy sentinel the
        // `None` fallback would use.
        use crate::plugins::vault_unlock::state::test_vault_id_b;
        rt().block_on(async {
            let scratch = scratch_vault();
            let (meta_bytes, original_root_key, phrase) = seed_vault_meta("pw");
            scratch.write_meta(&meta_bytes);

            let explicit = test_vault_id_b();
            assert_ne!(explicit, test_vault_id(), "explicit id must be non-legacy");

            let state = VaultRuntimeState::default();
            recover_with_phrase_with_path(
                phrase,
                Some(explicit),
                scratch.path(),
                &state,
                &crate::host::NoopHost,
                &crate::vault_io::StdVaultIo,
            )
            .await
            .expect("recover with explicit vault_id");

            // The Recovering entry is keyed under the EXPLICIT id.
            assert_eq!(state.slot_kind(explicit).await, SlotKind::Recovering);
            match state.take(explicit).await {
                Slot::Recovering { root_key, .. } => assert_eq!(*root_key, original_root_key),
                _ => panic!("expected Slot::Recovering under the explicit id"),
            }
            // The path-derived legacy key has NO entry.
            assert_eq!(
                state.slot_kind(test_vault_id()).await,
                SlotKind::Empty,
                "explicit-id targeting must NOT key the path-derived legacy sentinel"
            );
        });
    }

    // ---- multi-vault recovery routing (MYND-206) -----------------------
    //
    // Two DISTINCT vaults on disk, each with its own vault.meta + recovery
    // phrase. The recovery selection stage hands the chosen VaultId to the
    // targeting layer (`Some(id)`); these tests prove the chosen vault's
    // vault.meta drives the pipeline, the wrong-vault phrase is
    // non-distinguishing, and exactly one Argon2id permit is held per attempt.

    #[test]
    fn vault_b_selection_feeds_vault_bs_meta_not_vault_as() {
        // Selecting vault B (passing B's id + B's path) recovers B's root_key
        // and keys the Recovering slot under B's id. Vault A's slot stays
        // Empty — no cross-vault bleed.
        use crate::plugins::vault_unlock::state::test_vault_id_b;
        rt().block_on(async {
            let scratch_a = ScratchVault::new("recover_route_a");
            let scratch_b = ScratchVault::new("recover_route_b");
            let (meta_a, root_key_a, _phrase_a) = seed_vault_meta("pw-a");
            let (meta_b, root_key_b, phrase_b) = seed_vault_meta("pw-b");
            scratch_a.write_meta(&meta_a);
            scratch_b.write_meta(&meta_b);
            // Two independently-generated vaults must have distinct root keys.
            assert_ne!(root_key_a, root_key_b, "fixtures must be distinct vaults");

            let id_a = test_vault_id();
            let id_b = test_vault_id_b();

            let state = VaultRuntimeState::default();
            // Recover with B's phrase against B's id + B's path.
            recover_with_phrase_with_path(
                phrase_b,
                Some(id_b),
                scratch_b.path(),
                &state,
                &crate::host::NoopHost,
                &crate::vault_io::StdVaultIo,
            )
            .await
            .expect("B's phrase recovers B's vault.meta");

            // B's slot holds B's root_key; A's slot is untouched.
            assert_eq!(state.slot_kind(id_b).await, SlotKind::Recovering);
            match state.take(id_b).await {
                Slot::Recovering { root_key, .. } => assert_eq!(*root_key, root_key_b),
                _ => panic!("expected Slot::Recovering under vault B's id"),
            }
            assert_eq!(
                state.slot_kind(id_a).await,
                SlotKind::Empty,
                "selecting vault B must not populate vault A's slot"
            );
        });
    }

    #[test]
    fn wrong_vault_phrase_is_non_distinguishing() {
        // Vault A's phrase entered against vault B (B's id + B's path) fails
        // the AEAD tag on B's recovery wrap-key → the SAME
        // `InvalidCredentialOrVault` a typo produces (spec §3.4
        // non-distinguishing). No slot populated, no counter, permit released.
        use crate::plugins::vault_unlock::state::test_vault_id_b;
        rt().block_on(async {
            let scratch_b = ScratchVault::new("recover_wrong_b");
            // A's phrase, B's vault.meta on disk.
            let (_meta_a, _root_a, phrase_a) = seed_vault_meta("pw-a");
            let (meta_b, _root_b, _phrase_b) = seed_vault_meta("pw-b");
            scratch_b.write_meta(&meta_b);

            let id_b = test_vault_id_b();
            let state = VaultRuntimeState::default();

            let result =
                recover_with_phrase_with_path(phrase_a, Some(id_b), scratch_b.path(), &state, &crate::host::NoopHost, &crate::vault_io::StdVaultIo).await;
            assert!(
                matches!(result, Err(VaultRecoveryError::InvalidCredentialOrVault)),
                "wrong-vault phrase must map to the same non-distinguishing variant as a typo; got {result:?}"
            );
            // No slot populated for either vault.
            assert_eq!(state.slot_kind(id_b).await, SlotKind::Empty);
            assert_eq!(state.slot_kind(test_vault_id()).await, SlotKind::Empty);
            // Permit released by RAII drop — exactly one Argon2id ran, no leak.
            assert_eq!(state.auth_permits().available_permits(), 1);
        });
    }

    #[test]
    fn single_vault_recovery_uses_sole_vault_fallback() {
        // 1-vault parity (story 7): the recovery flow skips the picker +
        // account-number step and recovers against the sole vault via the
        // `None` (sole-vault fallback) targeting — exactly the pre-multi-vault
        // single-vault behavior. The slot keys under the path-derived id.
        rt().block_on(async {
            let scratch = scratch_vault();
            let (meta_bytes, original_root_key, phrase) = seed_vault_meta("pw");
            scratch.write_meta(&meta_bytes);

            let state = VaultRuntimeState::default();
            // `None` = sole-vault fallback — no VaultId selection was made.
            recover_with_phrase_with_path(
                phrase,
                None,
                scratch.path(),
                &state,
                &crate::host::NoopHost,
                &crate::vault_io::StdVaultIo,
            )
            .await
            .expect("single-vault recovery via sole-vault fallback");

            assert_eq!(state.slot_kind(test_vault_id()).await, SlotKind::Recovering);
            match state.take(test_vault_id()).await {
                Slot::Recovering { root_key, .. } => assert_eq!(*root_key, original_root_key),
                _ => panic!("expected Slot::Recovering under the sole-vault id"),
            }
            // One Argon2id permit, released after.
            assert_eq!(state.auth_permits().available_permits(), 1);
        });
    }

    #[test]
    fn wrong_phrase_returns_invalid_credential_or_vault() {
        rt().block_on(async {
            let scratch = scratch_vault();
            let (meta_bytes, _, _) = seed_vault_meta("pw");
            scratch.write_meta(&meta_bytes);

            let state = VaultRuntimeState::default();
            // 24 valid BIP-39 words but the wrong phrase for this
            // vault. Must produce a normalized form that fails AEAD-tag
            // verification on the recovery wrap-key.
            let wrong_phrase = "abandon abandon abandon abandon abandon abandon \
                                abandon abandon abandon abandon abandon abandon \
                                abandon abandon abandon abandon abandon abandon \
                                abandon abandon abandon abandon abandon art";
            let result = recover_with_phrase_with_path(
                wrong_phrase.to_string(),
                None,
                scratch.path(),
                &state,
                &crate::host::NoopHost,
                &crate::vault_io::StdVaultIo,
            )
            .await;
            assert!(matches!(
                result,
                Err(VaultRecoveryError::InvalidCredentialOrVault)
            ));
            assert_eq!(state.slot_kind(test_vault_id()).await, SlotKind::Empty);
        });
    }

    #[test]
    fn nfkd_normalization_lets_correct_phrase_succeed_with_full_width_substitution() {
        // Realistic password-manager paste: full-width digits are
        // unlikely in BIP-39 wordlist phrases (BIP-39 words are pure
        // ASCII letters), but full-width letters and U+00A0 separators
        // are real failure modes for non-NFKD-aware parsers.
        //
        // We exercise the NFKD pipeline by replacing the SPACE between
        // the first two words with U+00A0 (NO-BREAK SPACE). The phrase
        // semantically is identical post-NFKD; recovery must succeed.
        rt().block_on(async {
            let scratch = scratch_vault();
            let (meta_bytes, original_root_key, phrase) = seed_vault_meta("pw");
            scratch.write_meta(&meta_bytes);

            // Replace the first ASCII space with U+00A0.
            let mutated = phrase.replacen(' ', "\u{00A0}", 1);
            assert_ne!(mutated, phrase, "must actually contain U+00A0 now");

            let state = VaultRuntimeState::default();
            recover_with_phrase_with_path(
                mutated,
                None,
                scratch.path(),
                &state,
                &crate::host::NoopHost,
                &crate::vault_io::StdVaultIo,
            )
            .await
            .expect("NFKD-normalized phrase must recover successfully");

            let taken = state.take(test_vault_id()).await;
            match taken {
                Slot::Recovering { root_key, .. } => {
                    assert_eq!(*root_key, original_root_key);
                }
                _ => panic!("expected Slot::Recovering"),
            }
        });
    }

    #[test]
    fn missing_vault_meta_returns_vault_not_found() {
        rt().block_on(async {
            let scratch = scratch_vault();
            // Do NOT write_meta — vault.meta absent.
            assert!(!scratch.path().exists());

            let state = VaultRuntimeState::default();
            let result = recover_with_phrase_with_path(
                "anything anything anything".to_string(),
                None,
                scratch.path(),
                &state,
                &crate::host::NoopHost,
                &crate::vault_io::StdVaultIo,
            )
            .await;
            assert!(matches!(result, Err(VaultRecoveryError::VaultNotFound)));
            assert_eq!(state.slot_kind(test_vault_id()).await, SlotKind::Empty);
        });
    }

    #[test]
    fn items_key_tampering_returns_invalid_vault_meta_not_credential_error() {
        // Spec §9.3: enc_items_key occupies offsets 281..345.
        // Mutating any byte invalidates the AEAD tag on the items_key
        // wrap. Because the recovery wrap-key has ALREADY verified by
        // the time this stage runs, the failure must NOT collapse into
        // `InvalidCredentialOrVault`.
        rt().block_on(async {
            let scratch = scratch_vault();
            let (mut meta_bytes, _, phrase) = seed_vault_meta("pw");
            // Flip one bit in the first byte of enc_items_key.
            meta_bytes[281] ^= 0x01;
            scratch.write_meta(&meta_bytes);

            let state = VaultRuntimeState::default();
            let result = recover_with_phrase_with_path(
                phrase,
                None,
                scratch.path(),
                &state,
                &crate::host::NoopHost,
                &crate::vault_io::StdVaultIo,
            )
            .await;
            match result {
                Err(VaultRecoveryError::InvalidVaultMeta) => {}
                Err(VaultRecoveryError::InvalidCredentialOrVault) => {
                    panic!(
                        "items_key tampering must NOT surface as InvalidCredentialOrVault — \
                         the recovery wrap-key has already verified at this stage"
                    );
                }
                other => panic!("expected InvalidVaultMeta, got {other:?}"),
            }
            assert_eq!(state.slot_kind(test_vault_id()).await, SlotKind::Empty);
        });
    }

    #[test]
    fn parse_fail_bad_magic_returns_invalid_vault_meta() {
        rt().block_on(async {
            let scratch = scratch_vault();
            let (mut bytes, _, phrase) = seed_vault_meta("pw");
            bytes[0..4].copy_from_slice(b"XXXX");
            scratch.write_meta(&bytes);

            let state = VaultRuntimeState::default();
            let result = recover_with_phrase_with_path(
                phrase,
                None,
                scratch.path(),
                &state,
                &crate::host::NoopHost,
                &crate::vault_io::StdVaultIo,
            )
            .await;
            assert!(matches!(result, Err(VaultRecoveryError::InvalidVaultMeta)));
            assert_eq!(state.slot_kind(test_vault_id()).await, SlotKind::Empty);
        });
    }

    #[test]
    fn parse_fail_truncated_length_returns_invalid_vault_meta() {
        rt().block_on(async {
            let scratch = scratch_vault();
            let (bytes, _, phrase) = seed_vault_meta("pw");
            // One byte short of VAULT_META_LEN.
            scratch.write_meta(&bytes[..protocol::VAULT_META_LEN - 1]);

            let state = VaultRuntimeState::default();
            let result = recover_with_phrase_with_path(
                phrase,
                None,
                scratch.path(),
                &state,
                &crate::host::NoopHost,
                &crate::vault_io::StdVaultIo,
            )
            .await;
            assert!(matches!(result, Err(VaultRecoveryError::InvalidVaultMeta)));
            assert_eq!(state.slot_kind(test_vault_id()).await, SlotKind::Empty);
        });
    }

    #[test]
    fn vault_already_unlocked_rejects_recovery() {
        rt().block_on(async {
            let scratch = scratch_vault();
            let (bytes, _, phrase) = seed_vault_meta("pw");
            scratch.write_meta(&bytes);

            let state = VaultRuntimeState::default();
            // Pre-populate Unlocked with a distinguishable byte
            // pattern; recovery must reject without perturbing the
            // existing slot.
            state
                .set_unlocked(
                    test_vault_id(),
                    fixture_unlocked_with_keys(0x42, 0x13, 0x99),
                )
                .await;

            let result = recover_with_phrase_with_path(
                phrase,
                None,
                scratch.path(),
                &state,
                &crate::host::NoopHost,
                &crate::vault_io::StdVaultIo,
            )
            .await;
            assert!(matches!(
                result,
                Err(VaultRecoveryError::VaultAlreadyUnlocked)
            ));

            // Existing Unlocked slot is untouched.
            let taken = state.take(test_vault_id()).await;
            match taken {
                Slot::Unlocked(uv) => {
                    assert_eq!(
                        **uv.owner_root_key().expect("owner"),
                        [0x42u8; AEAD_KEY_LEN]
                    );
                }
                _ => panic!("existing Unlocked slot was perturbed"),
            }
        });
    }

    #[test]
    fn slot_already_recovering_rejects_recovery() {
        rt().block_on(async {
            let scratch = scratch_vault();
            let (bytes, _, phrase) = seed_vault_meta("pw");
            scratch.write_meta(&bytes);

            let state = VaultRuntimeState::default();
            // Pre-populate Recovering with a distinguishable byte
            // pattern; recovery must reject without perturbing the
            // existing recovery state.
            state
                .set_recovering(
                    test_vault_id(),
                    fixture_recovering_with_keys(0xAA, 0xBB, 0xCC),
                )
                .await;

            let result = recover_with_phrase_with_path(
                phrase,
                None,
                scratch.path(),
                &state,
                &crate::host::NoopHost,
                &crate::vault_io::StdVaultIo,
            )
            .await;
            assert!(matches!(
                result,
                Err(VaultRecoveryError::RecoveryAlreadyInProgress)
            ));

            // Existing Recovering slot is untouched.
            assert_eq!(state.slot_kind(test_vault_id()).await, SlotKind::Recovering);
        });
    }

    #[test]
    fn recovery_in_progress_returns_guard_when_permit_held() {
        // Mirrors the unlock plugin's `unlock_in_progress_returns_guard_when_permit_held`
        // — recovery shares the auth_permits semaphore with vault_unlock.
        rt().block_on(async {
            let scratch = scratch_vault();
            let (bytes, _, phrase) = seed_vault_meta("pw");
            scratch.write_meta(&bytes);

            let state = VaultRuntimeState::default();
            assert_eq!(state.slot_kind(test_vault_id()).await, SlotKind::Empty);

            let held_permit = state
                .auth_permits()
                .try_acquire()
                .expect("first acquire on fresh state");
            assert_eq!(state.auth_permits().available_permits(), 0);

            let result = recover_with_phrase_with_path(
                phrase.clone(),
                None,
                scratch.path(),
                &state,
                &crate::host::NoopHost,
                &crate::vault_io::StdVaultIo,
            )
            .await;
            assert!(matches!(
                result,
                Err(VaultRecoveryError::RecoveryInProgress)
            ));
            assert_eq!(state.slot_kind(test_vault_id()).await, SlotKind::Empty);

            drop(held_permit);
            assert_eq!(state.auth_permits().available_permits(), 1);

            recover_with_phrase_with_path(
                phrase,
                None,
                scratch.path(),
                &state,
                &crate::host::NoopHost,
                &crate::vault_io::StdVaultIo,
            )
            .await
            .expect("retry after permit released succeeds");
            assert_eq!(state.slot_kind(test_vault_id()).await, SlotKind::Recovering);
            assert_eq!(state.auth_permits().available_permits(), 1);
        });
    }

    #[test]
    fn vault_already_unlocked_does_not_consume_permit() {
        // Load-bearing peek-before-permit ordering: the cheap rejection
        // paths must not touch the semaphore even when the permit is
        // exhausted.
        rt().block_on(async {
            let scratch = scratch_vault();
            let (bytes, _, phrase) = seed_vault_meta("pw");
            scratch.write_meta(&bytes);

            let state = VaultRuntimeState::default();
            state
                .set_unlocked(
                    test_vault_id(),
                    fixture_unlocked_with_keys(0x42, 0x13, 0x99),
                )
                .await;

            let _held_permit = state
                .auth_permits()
                .try_acquire()
                .expect("first acquire on fresh state");
            assert_eq!(state.auth_permits().available_permits(), 0);

            let result = recover_with_phrase_with_path(
                phrase,
                None,
                scratch.path(),
                &state,
                &crate::host::NoopHost,
                &crate::vault_io::StdVaultIo,
            )
            .await;
            // Peek catches it before try_acquire runs.
            assert!(matches!(
                result,
                Err(VaultRecoveryError::VaultAlreadyUnlocked)
            ));
            assert_eq!(state.auth_permits().available_permits(), 0);
        });
    }

    #[test]
    fn failed_recovery_releases_permit_for_retry() {
        // RAII guard regression test: a failed recovery (any error
        // path that consumed the permit) must release the permit when
        // the function returns, so the next attempt is not stuck on
        // RecoveryInProgress.
        rt().block_on(async {
            let scratch = scratch_vault();
            let (bytes, _, correct_phrase) = seed_vault_meta("pw");
            scratch.write_meta(&bytes);

            let state = VaultRuntimeState::default();

            // Wrong-phrase attempt: consumes permit (try_acquire
            // succeeds) → Argon2id runs → AEAD-open fails →
            // InvalidCredentialOrVault → permit released by RAII drop.
            let wrong_phrase = "abandon abandon abandon abandon abandon abandon \
                                abandon abandon abandon abandon abandon abandon \
                                abandon abandon abandon abandon abandon abandon \
                                abandon abandon abandon abandon abandon art";
            let r1 = recover_with_phrase_with_path(
                wrong_phrase.to_string(),
                None,
                scratch.path(),
                &state,
                &crate::host::NoopHost,
                &crate::vault_io::StdVaultIo,
            )
            .await;
            assert!(matches!(
                r1,
                Err(VaultRecoveryError::InvalidCredentialOrVault)
            ));
            assert_eq!(
                state.auth_permits().available_permits(),
                1,
                "permit must be released after failed recovery — not stuck on RecoveryInProgress"
            );

            // Retry with correct phrase — must succeed.
            recover_with_phrase_with_path(
                correct_phrase,
                None,
                scratch.path(),
                &state,
                &crate::host::NoopHost,
                &crate::vault_io::StdVaultIo,
            )
            .await
            .expect("retry after wrong-phrase failure works");
            assert_eq!(state.slot_kind(test_vault_id()).await, SlotKind::Recovering);
            assert_eq!(state.auth_permits().available_permits(), 1);
        });
    }

    // ---- complete_recovery ---------------------------------------------
    //
    // Chained-step password commit. Promotes Slot::Recovering →
    // Slot::Unlocked by rewriting vault.meta's password side with a
    // fresh CSPRNG salt + nonce + the user's new master password.
    // Recovery-side is byte-preserved per spec § 4.4. End-to-end tests
    // build via vault_creation, recover via vault_recover_with_phrase,
    // commit via complete_recovery, and verify the new password unlocks
    // while the original password is rejected.

    /// Build a fresh state in `Slot::Recovering` by running the full A8d
    /// pipeline against a freshly-seeded vault. Returns the populated
    /// state, the vault.meta path, the original password, the original
    /// recovery phrase (so post-A8f recovery-still-works tests can run),
    /// and the bytes of the original vault.meta (so the on-disk
    /// preservation invariant can be diffed).
    async fn seed_recovering_state_via_full_a8d(
        password: &str,
    ) -> (
        VaultRuntimeState,
        ScratchVault,
        String,
        String,
        [u8; protocol::VAULT_META_LEN],
    ) {
        let scratch = scratch_vault();
        let (meta_bytes, _root_key, phrase) = seed_vault_meta(password);
        scratch.write_meta(&meta_bytes);

        let state = VaultRuntimeState::default();
        recover_with_phrase_with_path(
            phrase.clone(),
            None,
            scratch.path(),
            &state,
            &crate::host::NoopHost,
            &crate::vault_io::StdVaultIo,
        )
        .await
        .expect("seed: A8d must succeed against the seeded vault");
        assert_eq!(state.slot_kind(test_vault_id()).await, SlotKind::Recovering);

        (state, scratch, password.to_string(), phrase, meta_bytes)
    }

    /// `complete_recovery` must reject a sub-floor new password with
    /// `WeakNewPassword` BEFORE consuming the `auth_permits` slot or
    /// running Argon2id. See `decisions.md` 2026-05-06 entry
    /// "Auth-pipeline backend MIN_PASSWORD_LEN floor; project-wide
    /// retroactive".
    #[test]
    fn complete_recovery_rejects_weak_new_password_pre_argon2id() {
        rt().block_on(async {
            let (state, scratch, _orig_pw, _phrase, orig_bytes) =
                seed_recovering_state_via_full_a8d("orig-pw").await;

            // 11 chars — below MIN_PASSWORD_LEN of 12.
            let weak_pw = "a".repeat(11);
            let started = std::time::Instant::now();
            let result = complete_recovery_with_path(
                weak_pw,
                None,
                scratch.path(),
                &state,
                &noop_hooks(),
                &crate::host::NoopHost,
                &crate::vault_io::StdVaultIo,
            )
            .await;
            let elapsed = started.elapsed();

            assert!(
                matches!(result, Err(VaultRecoveryError::WeakNewPassword)),
                "expected WeakNewPassword, got {result:?}"
            );

            // Disk untouched — vault.meta byte-equal to the original.
            let after_bytes = std::fs::read(scratch.path()).expect("vault.meta exists");
            assert_eq!(
                &after_bytes[..],
                &orig_bytes[..],
                "vault.meta must be unchanged on weak-password reject (no atomic_write fired)"
            );

            // Slot stays Recovering — gate fired before slot peek's
            // potential mutations and before take_recovering. User can
            // retry with a stronger password.
            assert_eq!(state.slot_kind(test_vault_id()).await, SlotKind::Recovering);

            // Permit released — gate fires before permit acquire.
            assert_eq!(state.auth_permits().available_permits(), 1);

            // Sanity: rejection is fast (< 100ms even on cold hardware) —
            // proves Argon2id was NOT invoked.
            assert!(
                elapsed.as_millis() < 200,
                "weak-password reject must be sub-Argon2id fast; got {}ms",
                elapsed.as_millis()
            );
        });
    }

    #[test]
    fn complete_recovery_round_trip_promotes_recovering_to_unlocked() {
        rt().block_on(async {
            let (state, scratch, _orig_pw, _phrase, _orig_bytes) =
                seed_recovering_state_via_full_a8d("orig-pw").await;

            complete_recovery_with_path(
                "new-password-12".to_string(),
                None,
                scratch.path(),
                &state,
                &noop_hooks(),
                &crate::host::NoopHost,
                &crate::vault_io::StdVaultIo,
            )
            .await
            .expect("A8f must succeed when slot is Recovering");

            assert_eq!(state.slot_kind(test_vault_id()).await, SlotKind::Unlocked);
            // Permit released after success.
            assert_eq!(state.auth_permits().available_permits(), 1);
        });
    }

    /// `Slot::Unlocked.vault_meta_bytes_hash` must equal SHA-256 of
    /// the freshly-rewritten vault.meta bytes after `complete_recovery`
    /// promotes Slot::Recovering → Slot::Unlocked. The hash pins the
    /// NEW disk state (not the original) so a subsequent
    /// `vault_change_password` CAS check sees a coherent anchor. See
    /// `decisions.md` 2026-05-06 entry "Slot::Unlocked anchor field
    /// for vault.meta CAS".
    #[test]
    fn complete_recovery_populates_slot_meta_bytes_hash_with_new_disk_bytes() {
        rt().block_on(async {
            let (state, scratch, _orig_pw, _phrase, orig_bytes) =
                seed_recovering_state_via_full_a8d("orig-pw").await;

            complete_recovery_with_path(
                "new-password-12".to_string(),
                None,
                scratch.path(),
                &state,
                &noop_hooks(),
                &crate::host::NoopHost,
                &crate::vault_io::StdVaultIo,
            )
            .await
            .expect("A8f");

            let new_disk_bytes = std::fs::read(scratch.path()).expect("vault.meta exists");
            let expected_hash = crate::vault_meta_hash::vault_meta_sha256(&new_disk_bytes);

            let unlocked = state.take(test_vault_id()).await.unwrap_unlocked();
            assert_eq!(
                unlocked.vault_meta_bytes_hash, expected_hash,
                "slot.vault_meta_bytes_hash must equal SHA-256 of the rewritten vault.meta bytes"
            );

            // The hash must NOT match the original (pre-rewrite) bytes —
            // verifying we captured the post-rewrite state, not stale.
            let original_hash = crate::vault_meta_hash::vault_meta_sha256(orig_bytes.as_slice());
            assert_ne!(
                unlocked.vault_meta_bytes_hash, original_hash,
                "slot hash must reflect post-rewrite bytes, not the pre-rewrite original"
            );
        });
    }

    #[test]
    fn complete_recovery_preserves_recovery_side_byte_byte() {
        // recovery-flow.md § 4.4: random_salt_recovery,
        // nonce_recovery_wrap, enc_root_key_recovery byte-preserved on
        // disk after A8f.
        rt().block_on(async {
            let (state, scratch, _orig_pw, _phrase, orig_bytes) =
                seed_recovering_state_via_full_a8d("orig-pw").await;

            complete_recovery_with_path(
                "new-password-12".to_string(),
                None,
                scratch.path(),
                &state,
                &noop_hooks(),
                &crate::host::NoopHost,
                &crate::vault_io::StdVaultIo,
            )
            .await
            .expect("A8f");

            let new_bytes = std::fs::read(scratch.path()).expect("vault.meta exists");
            assert_eq!(
                new_bytes.len(),
                protocol::VAULT_META_LEN,
                "rewritten vault.meta must be the canonical 345 bytes"
            );
            // Recovery-side fields per spec § 9.3:
            assert_eq!(
                &new_bytes[49..65],
                &orig_bytes[49..65],
                "random_salt_recovery @ 49..65 must byte-equal original"
            );
            assert_eq!(
                &new_bytes[153..177],
                &orig_bytes[153..177],
                "nonce_recovery_wrap @ 153..177 must byte-equal original"
            );
            assert_eq!(
                &new_bytes[177..241],
                &orig_bytes[177..241],
                "enc_root_key_recovery @ 177..241 must byte-equal original"
            );
            // items_key block also byte-preserved.
            assert_eq!(
                &new_bytes[241..345],
                &orig_bytes[241..345],
                "items_key_id + items_key_nonce + enc_items_key @ 241..345 must byte-equal original"
            );
        });
    }

    #[test]
    fn complete_recovery_invalidates_the_quick_unlock_credential() {
        // `protocol.md` §9.14.4: a master-password commit deletes the
        // device-local quick-unlock credential. Completing a recovery IS such
        // a commit — and the sibling of the test above: that one proves the
        // old PASSWORD is dead, this one proves the fast second credential
        // minted under it is dead too. Without this, "forgot password →
        // recovered" left a pre-recovery PIN or Face ID still opening the
        // vault, because `root_key` is preserved and the quick-unlock AAD
        // binds nothing that a rotation moves.
        rt().block_on(async {
            let (state, scratch, _orig_pw, _phrase, _orig_bytes) =
                seed_recovering_state_via_full_a8d("orig-pw").await;
            let counter = std::sync::Arc::new(std::sync::atomic::AtomicU64::new(0));
            let watch = std::sync::Arc::new(crate::hooks::test_hooks::CountingHooks::new(
                counter.clone(),
            ));
            let hooks: crate::hooks::Hooks = watch.clone();

            complete_recovery_with_path(
                "new-password-12".to_string(),
                None,
                scratch.path(),
                &state,
                &hooks,
                &crate::host::NoopHost,
                &crate::vault_io::StdVaultIo,
            )
            .await
            .expect("A8f");

            let seen = watch.quick_unlock_invalidations();
            assert_eq!(
                seen.len(),
                1,
                "recovery completion must invalidate exactly once"
            );
            assert_eq!(
                seen[0],
                scratch.path().parent().expect("vault dir"),
                "the hook receives the vault ROOT, not the vault.meta path"
            );
        });
    }

    #[test]
    fn a_failed_recovery_leaves_the_quick_unlock_credential_alone() {
        // The invalidation is a consequence of committing a new password, not
        // of attempting one. A rejected weak password never reaches the
        // rewrite, so deleting the credential there would destroy a working
        // convenience gate over a typo.
        rt().block_on(async {
            let (state, scratch, _orig_pw, _phrase, _orig_bytes) =
                seed_recovering_state_via_full_a8d("orig-pw").await;
            let counter = std::sync::Arc::new(std::sync::atomic::AtomicU64::new(0));
            let watch = std::sync::Arc::new(crate::hooks::test_hooks::CountingHooks::new(
                counter.clone(),
            ));
            let hooks: crate::hooks::Hooks = watch.clone();

            let result = complete_recovery_with_path(
                "a".repeat(11),
                None,
                scratch.path(),
                &state,
                &hooks,
                &crate::host::NoopHost,
                &crate::vault_io::StdVaultIo,
            )
            .await;

            assert!(result.is_err(), "a weak password is rejected");
            assert!(
                watch.quick_unlock_invalidations().is_empty(),
                "a refused recovery must not touch the credential"
            );
        });
    }

    #[test]
    fn complete_recovery_old_password_no_longer_unlocks() {
        // After A8f commits "new-password-12", `vault_unlock("orig-pw")` MUST
        // return `InvalidCredentialOrVault` — the new password fully
        // replaces the old. This is the central security property of
        // the recovery flow ("forgot password" → "vault recovered" →
        // "old credential is dead").
        use super::super::super::vault_unlock::commands::unlock_with_path;
        use super::super::super::vault_unlock::error::VaultUnlockError;
        rt().block_on(async {
            let (state, scratch, orig_pw, _phrase, _orig_bytes) =
                seed_recovering_state_via_full_a8d("orig-pw").await;

            complete_recovery_with_path(
                "new-password-12".to_string(),
                None,
                scratch.path(),
                &state,
                &noop_hooks(),
                &crate::host::NoopHost,
                &crate::vault_io::StdVaultIo,
            )
            .await
            .expect("A8f");

            // Lock to clear Slot::Unlocked; otherwise unlock_with_path
            // rejects with VaultAlreadyUnlocked before reaching the
            // password-verification stage.
            let _ = state.take(test_vault_id()).await;
            assert_eq!(state.slot_kind(test_vault_id()).await, SlotKind::Empty);

            // Try the original password — must fail.
            let result = unlock_with_path(
                orig_pw,
                None,
                scratch.path(),
                &state,
                &crate::vault_io::StdVaultIo,
                &crate::host::NoopHost,
            )
            .await;
            assert!(
                matches!(result, Err(VaultUnlockError::InvalidCredentialOrVault)),
                "original password must no longer unlock after A8f; got {result:?}"
            );
        });
    }

    #[test]
    fn complete_recovery_new_password_unlocks_via_vault_unlock() {
        // The flip side of the previous test: the new password set by
        // A8f MUST successfully unlock the vault on a subsequent
        // `vault_unlock` call (after lock to clear Slot::Unlocked).
        use super::super::super::vault_unlock::commands::unlock_with_path;
        rt().block_on(async {
            let (state, scratch, _orig_pw, _phrase, _orig_bytes) =
                seed_recovering_state_via_full_a8d("orig-pw").await;

            complete_recovery_with_path(
                "new-password-12".to_string(),
                None,
                scratch.path(),
                &state,
                &noop_hooks(),
                &crate::host::NoopHost,
                &crate::vault_io::StdVaultIo,
            )
            .await
            .expect("A8f");

            let _ = state.take(test_vault_id()).await;
            unlock_with_path(
                "new-password-12".to_string(),
                None,
                scratch.path(),
                &state,
                &crate::vault_io::StdVaultIo,
                &crate::host::NoopHost,
            )
            .await
            .expect("new password must unlock the rewritten vault.meta");
            assert_eq!(state.slot_kind(test_vault_id()).await, SlotKind::Unlocked);
        });
    }

    #[test]
    fn complete_recovery_phrase_still_recovers_after_a8f() {
        // recovery-flow.md § 4.4 byte-preservation invariant ⇒ the
        // recovery phrase must still be able to recover the vault even
        // after a password commit (the recovery wrap-key bytes never
        // changed). This test exercises the round-trip end-to-end.
        rt().block_on(async {
            let (state, scratch, _orig_pw, phrase, _orig_bytes) =
                seed_recovering_state_via_full_a8d("orig-pw").await;

            complete_recovery_with_path(
                "new-password-12".to_string(),
                None,
                scratch.path(),
                &state,
                &noop_hooks(),
                &crate::host::NoopHost,
                &crate::vault_io::StdVaultIo,
            )
            .await
            .expect("A8f");

            // Lock to clear Slot::Unlocked, then re-recover with the
            // original phrase.
            let _ = state.take(test_vault_id()).await;
            recover_with_phrase_with_path(
                phrase,
                None,
                scratch.path(),
                &state,
                &crate::host::NoopHost,
                &crate::vault_io::StdVaultIo,
            )
            .await
            .expect("phrase must still recover after A8f");
            assert_eq!(state.slot_kind(test_vault_id()).await, SlotKind::Recovering);
        });
    }

    #[test]
    fn complete_recovery_rejects_when_slot_is_empty() {
        rt().block_on(async {
            let scratch = scratch_vault();
            let (bytes, _, _) = seed_vault_meta("orig-pw");
            scratch.write_meta(&bytes);

            let state = VaultRuntimeState::default();
            assert_eq!(state.slot_kind(test_vault_id()).await, SlotKind::Empty);

            let result = complete_recovery_with_path(
                "new-password-12".to_string(),
                None,
                scratch.path(),
                &state,
                &noop_hooks(),
                &crate::host::NoopHost,
                &crate::vault_io::StdVaultIo,
            )
            .await;
            assert!(matches!(
                result,
                Err(VaultRecoveryError::VaultRecoveryRequiresActiveSession)
            ));

            // vault.meta on disk is unchanged.
            let on_disk = std::fs::read(scratch.path()).expect("vault.meta exists");
            assert_eq!(
                on_disk,
                &bytes[..],
                "vault.meta must not be rewritten when complete_recovery rejects"
            );
        });
    }

    #[test]
    fn complete_recovery_rejects_when_slot_is_unlocked() {
        rt().block_on(async {
            let scratch = scratch_vault();
            let (bytes, _, _) = seed_vault_meta("orig-pw");
            scratch.write_meta(&bytes);

            let state = VaultRuntimeState::default();
            state
                .set_unlocked(
                    test_vault_id(),
                    fixture_unlocked_with_keys(0xAB, 0xCD, 0xEF),
                )
                .await;

            let result = complete_recovery_with_path(
                "new-password-12".to_string(),
                None,
                scratch.path(),
                &state,
                &noop_hooks(),
                &crate::host::NoopHost,
                &crate::vault_io::StdVaultIo,
            )
            .await;
            assert!(matches!(
                result,
                Err(VaultRecoveryError::VaultRecoveryRequiresActiveSession)
            ));

            // Existing Unlocked slot is untouched.
            assert_eq!(state.slot_kind(test_vault_id()).await, SlotKind::Unlocked);
            // vault.meta unchanged on disk.
            let on_disk = std::fs::read(scratch.path()).expect("vault.meta exists");
            assert_eq!(on_disk, &bytes[..]);
        });
    }

    #[test]
    fn complete_recovery_rejects_when_permit_held() {
        rt().block_on(async {
            let (state, scratch, _orig_pw, _phrase, _orig_bytes) =
                seed_recovering_state_via_full_a8d("orig-pw").await;

            // Manually hold the auth permit (simulates a concurrent
            // unlock or recover_with_phrase in flight).
            let _held = state
                .auth_permits()
                .try_acquire()
                .expect("permit available pre-hold");
            assert_eq!(state.auth_permits().available_permits(), 0);

            let result = complete_recovery_with_path(
                "new-password-12".to_string(),
                None,
                scratch.path(),
                &state,
                &noop_hooks(),
                &crate::host::NoopHost,
                &crate::vault_io::StdVaultIo,
            )
            .await;
            assert!(matches!(
                result,
                Err(VaultRecoveryError::RecoveryInProgress)
            ));
            // Slot is still Recovering (not consumed by the rejected
            // attempt).
            assert_eq!(state.slot_kind(test_vault_id()).await, SlotKind::Recovering);
        });
    }

    #[test]
    fn complete_recovery_filesystem_failure_leaves_vault_meta_unchanged() {
        // Simulate a filesystem failure by removing the parent
        // directory between `seed_recovering_state_via_full_a8d` (which
        // populates vault.meta on disk) and `complete_recovery`. The
        // load-bearing assertion is "no half-state survives the
        // failure" — vault.meta is not partially written.
        //
        // After the post-Argon2id slot peek (option p) retrofit
        // (`decisions.md` 2026-05-06), the slot semantics on failure
        // depend on WHICH stage failed:
        //   - Failures BEFORE the post-Argon2id slot peek (read_meta,
        //     parse_meta, vault_meta_rewrite) leave the slot in
        //     `Recovering` because we have not taken yet — the user
        //     can retry without re-running A8d.
        //   - Failures AFTER the slot peek (atomic_write,
        //     spawn_blocking_join on the write task) leave the slot
        //     `Empty` because we took post-Argon2id.
        //
        // In this test the parent directory removal kills both reads
        // and writes; either failure path is acceptable, both
        // coherent with the new flow.
        rt().block_on(async {
            let (state, scratch, _orig_pw, _phrase, _orig_bytes) =
                seed_recovering_state_via_full_a8d("orig-pw").await;

            // Remove the parent dir to force atomic_write to fail.
            std::fs::remove_dir_all(&scratch.dir).expect("remove parent dir");

            let result =
                complete_recovery_with_path(
                    "new-password-12".to_string(),
                    None,
                    scratch.path(),
                    &state,
                    &noop_hooks(),
                    &crate::host::NoopHost,
                    &crate::vault_io::StdVaultIo,
                )
                .await;
            // Either IoError (read_meta / atomic_write failed) or
            // VaultNotFound (vault.meta was removed alongside the dir).
            assert!(
                matches!(
                    result,
                    Err(VaultRecoveryError::IoError { .. } | VaultRecoveryError::VaultNotFound)
                ),
                "expected IoError or VaultNotFound, got {result:?}"
            );

            // Slot must be coherent with the failure-stage rule above:
            // pre-Argon2id failure → Recovering (retryable);
            // post-Argon2id failure → Empty (must restart from A8d).
            let slot_kind_after = state.slot_kind(test_vault_id()).await;
            assert!(
                matches!(slot_kind_after, SlotKind::Recovering | SlotKind::Empty),
                "slot must be Recovering (pre-Argon2id failure) or Empty (post-Argon2id failure), got {slot_kind_after:?}"
            );
            // Permit released by RAII drop regardless of failure stage.
            assert_eq!(state.auth_permits().available_permits(), 1);
        });
    }
}
