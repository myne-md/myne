// SPDX-License-Identifier: AGPL-3.0
//! Quick-unlock plugin commands (MYND-329, task 6).
//!
//! Extracted into `myne-core` (shared desktop↔mobile). This module carries the
//! platform-agnostic PIN path, the OS-free `*_with_dir` cores, AND the Apple
//! biometric command branch (macOS Touch ID / iOS Face ID + Touch ID via
//! `super::apple`; `HardwareUnavailable` elsewhere — decisions.md 2026-07-12).
//! Both hosts register the same six commands from this module's paths.
//!
//! Wires the `MYQ1` blob codec (`protocol::quick_unlock_blob`), the wrap-key
//! providers (`super::provider` / `super::pin`), and the failed-attempt counter
//! (`super::attempt`) into the vault runtime (`VaultRuntimeState`).
//!
//! Flow:
//! - **setup** (vault Unlocked): clone `root_key`, `provider.create()` a wrap
//!   key, wrap `root_key` into `vault.quickunlock`, write a fresh attempt file.
//! - **quick-unlock** (vault locked): read the blob, `provider.retrieve()` the
//!   wrap key, unwrap `root_key`, derive `items_key`, install the Unlocked slot.
//!   A failed attempt increments the code-enforced counter; the 5th wipes the
//!   credential and forces the full master password.
//! - **disable** / **status**.
//!
//! The `*_with_dir` cores are provider-generic and OS-free, so they unit-test
//! end-to-end with a `MockProvider` + a sealed `vault.meta` fixture. The thin
//! `#[tauri::command]` wrappers resolve the active vault dir + build the PIN
//! provider. (The macOS biometric provider + its command branch land in task 7.)
//!
//! See: ../../AGENTS.md "Secret-handling logging discipline" — `root_key`,
//! `items_key`, `wrap_key`, and the PIN are never logged.

use std::path::{Path, PathBuf};

use crate::host::HostCtx;
use protocol::quick_unlock_blob::{
    decode_quick_unlock_blob, encode_quick_unlock_blob, parse_quick_unlock_header,
    PROVIDER_KIND_BIOMETRIC, PROVIDER_KIND_PIN,
};
use protocol::VaultMeta;
use serde::Serialize;
// Tauri types serve only the cfg-gated IPC wrappers (task 79, Option B).
#[cfg(all(feature = "tauri-ipc", not(target_arch = "wasm32")))]
use crate::host::tauri_host::TauriHost;
#[cfg(all(feature = "tauri-ipc", not(target_arch = "wasm32")))]
use tauri::{AppHandle, Runtime, State};
use zeroize::Zeroizing;

use super::attempt::{
    encode_attempt_count, parse_attempt_count, AttemptOutcome, AttemptState,
    MAX_QUICK_UNLOCK_ATTEMPTS,
};
use super::error::QuickUnlockError;
use super::pin::{validate_pin, PinProvider, PinValidationError};
use super::provider::QuickUnlockProvider;
use crate::io_failure_kind::{from_io_error_kind, IoFailureKind};
use crate::plugins::vault_unlock::state::{UnlockedVault, VaultRuntimeState};
use crate::vault_id::VaultId;

/// Device-local credential file (the `MYQ1` blob).
const QUICK_UNLOCK_FILE: &str = "vault.quickunlock";
/// Device-local failed-attempt counter file (§ task 5).
const ATTEMPT_FILE: &str = "vault.quickunlock.attempts";

/// Whether quick-unlock is configured for a vault, and by which method.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct QuickUnlockStatus {
    /// `true` when a `vault.quickunlock` blob exists and parses. Pure disk
    /// truth — the Settings panel uses this to render "Configured via PIN".
    pub configured: bool,
    /// `"pin"` / `"biometric"` when configured, else `None`.
    pub method: Option<&'static str>,
    /// `true` only when quick-unlock can actually be redeemed *right now* —
    /// `configured` AND the spring-loaded session gate is open (a full
    /// master-password unlock has happened this process session). `false` on a
    /// cold start (app restart) so the Unlock screen hides the PIN field
    /// instead of offering a credential that would immediately fail
    /// `RequiresFullPassword`. Mirrors the `quick_unlock_with_dir` gate so the
    /// status and the redeem path never disagree. The pure-disk
    /// [`status_with_dir`] reports `false` (it has no session knowledge); the
    /// [`quick_unlock_status`] command layers the gate on.
    pub available: bool,
}

fn blob_path(dir: &Path) -> PathBuf {
    dir.join(QUICK_UNLOCK_FILE)
}

fn attempt_path(dir: &Path) -> PathBuf {
    dir.join(ATTEMPT_FILE)
}

fn io(e: std::io::Error) -> QuickUnlockError {
    QuickUnlockError::Io(from_io_error_kind(e.kind()))
}

fn method_label(provider_kind: u8) -> Option<&'static str> {
    match provider_kind {
        PROVIDER_KIND_PIN => Some("pin"),
        PROVIDER_KIND_BIOMETRIC => Some("biometric"),
        _ => None,
    }
}

/// Read + parse `vault.meta` from `dir`, returning the raw bytes (for the
/// `vault_meta_bytes_hash`) alongside the parsed struct.
pub fn read_meta(dir: &Path) -> Result<(Vec<u8>, VaultMeta), QuickUnlockError> {
    let bytes = std::fs::read(dir.join("vault.meta")).map_err(io)?;
    // Either generation (myne-md/myne#433). The migration DELETES
    // `vault.quickunlock` precisely so the user re-enrols under v0.2 — and this
    // parser rejecting `NTV5` is what made that re-enrolment impossible, so the
    // vault ended up with quick-unlock permanently off and no way to turn it on.
    let meta =
        protocol::parse_vault_meta_any(&bytes).map_err(|_| QuickUnlockError::InvalidVaultMeta)?;
    Ok((bytes, meta))
}

/// Read the persisted attempt counter. Absent → fresh (no failures yet);
/// present-but-corrupt → clamp to the cap (forces a wipe — fail safe).
fn read_attempt_state(dir: &Path) -> AttemptState {
    match std::fs::read(attempt_path(dir)) {
        Ok(bytes) => parse_attempt_count(&bytes)
            .unwrap_or_else(|| AttemptState::from_count(MAX_QUICK_UNLOCK_ATTEMPTS)),
        // Absent → fresh (no failures yet). Any OTHER read error (present but
        // unreadable — PermissionDenied / EIO) is fail-safe clamped to the cap,
        // matching the "present-but-corrupt → wipe" doc above and the sibling
        // blob read: an unreadable counter must never silently reset to 5 tries.
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => AttemptState::fresh(),
        Err(_) => AttemptState::from_count(MAX_QUICK_UNLOCK_ATTEMPTS),
    }
}

fn persist_attempt_state(dir: &Path, state: &AttemptState) -> Result<(), QuickUnlockError> {
    crate::atomic_write::atomic_write(&attempt_path(dir), &encode_attempt_count(state), true)
        .map_err(io)
}

/// Remove the device-local credential files, reporting the first failure.
///
/// The OS-side credential deletion (keychain item, for the biometric provider)
/// is the caller's job — the failure path holds a `provider` and calls
/// `provider.delete()`; the explicit `disable` path builds the matching provider
/// (task 7 for biometric).
///
/// **It returns the failure rather than swallowing it, and each caller decides.**
/// It used to be `-> ()` with a `let _ =` on both removals, which made "the user
/// turned quick-unlock off" and "the credential file is still on disk and still
/// unwraps the live `root_key`" indistinguishable — the same fail-open shape
/// `disable_with_dir`'s `auth_permits` comment warns about one screen up. A
/// `NotFound` is success: the file the caller wanted gone is gone, and `disable`
/// on a vault whose attempt file was never written must not fail.
pub fn wipe_files(dir: &Path) -> Result<(), IoFailureKind> {
    let mut first_failure = None;
    for path in [blob_path(dir), attempt_path(dir)] {
        if let Err(e) = std::fs::remove_file(&path) {
            if e.kind() != std::io::ErrorKind::NotFound && first_failure.is_none() {
                first_failure = Some(from_io_error_kind(e.kind()));
            }
        }
    }
    match first_failure {
        Some(kind) => Err(kind),
        None => Ok(()),
    }
}

/// [`wipe_files`] on a path whose caller cannot act on a failure: log the
/// bounded kind rather than discard it, so a credential that outlived its own
/// deletion is at least visible in the diagnostic log.
fn wipe_files_best_effort(dir: &Path, stage: &'static str) {
    if let Err(io_error_kind) = wipe_files(dir) {
        tracing::warn!(
            stage,
            io_failure_kind = ?io_error_kind,
            "quick-unlock credential file could not be removed"
        );
    }
}

/// Best-effort removal of the Apple-Keychain biometric credential for the
/// vault at `dir`. No-op off Apple targets and harmless for a PIN vault (the
/// item simply won't exist). Used by disable + invalidation so a biometric
/// credential's OS-side item does not outlive its blob.
fn cleanup_os_credential(dir: &Path) {
    #[cfg(any(target_os = "macos", target_os = "ios"))]
    if let Ok((_, meta)) = read_meta(dir) {
        // The Keychain item is keyed by VaultId, not by account_number_hash:
        // two same-account vaults (a KeepBoth backup restore) would otherwise
        // share one item and delete each other's credential.
        let id = crate::paths::vault_id_from_root(dir);
        let _ = super::apple::AppleBiometricProvider::new(meta.account_number_hash, id).delete();
    }
    #[cfg(not(any(target_os = "macos", target_os = "ios")))]
    let _ = dir;
}

/// Cross-plugin invalidation hook (MYND-329 task 8): wipe the device-local
/// quick-unlock credential — the files AND the Apple-Keychain item, if any —
/// for the vault at `dir`. Called when a security event should reset
/// quick-unlock: a **master-password change**, and the **completion of a phrase
/// recovery**, which commits a new master password by the other route. Both are
/// the same deliberate policy — a credential rotation signals "reset my
/// access", so the fast second credential is cleared even though `root_key` is
/// unchanged by either (User Story 8; `protocol.md` §9.14.4).
///
/// That `root_key` survives is exactly why this is not optional bookkeeping:
/// the quick-unlock AAD binds `account_number_hash` + `provider_kind`, neither
/// of which a rotation moves, so a credential left in place does not merely
/// dangle — it still unwraps the live `root_key`.
///
/// A best-effort no-op when nothing is configured.
///
/// **Vault deletion is NOT this function's job, and it no longer claims to be
/// covered.** It used to say "vault_delete's recursive unlink already removes the
/// files, and unlock reads the blob first, so an orphaned keychain item already
/// forces the password path", which described the defect rather than a decision:
/// the unlink removes the `MYQ1` blob and leaves the wrap key in the keychain,
/// and "unlock reads the blob first" is a statement about the unlock path, not
/// about what the erase left behind. The post-delete teardown destroys that item
/// itself (`vault_delete`'s `run_post_delete_teardown`, via
/// `super::device_secret::erase_for_vault`), on the delete-proceeded path and
/// after the directory removal. The class rule and the ordering argument are in
/// `design-notes/security/0709-per-vault-device-local-secrets-are-erased-with-the-vault.md`.
///
/// Best-effort, but no longer silent: a removal that fails is logged with its
/// bounded `IoFailureKind`, because a credential that outlived the rotation is
/// still able to unwrap the live `root_key` and nothing else would say so.
///
/// Both hosts' `VaultLifecycleHooks::invalidate_quick_unlock` delegate here.
pub fn invalidate_credential(dir: &Path) {
    cleanup_os_credential(dir);
    wipe_files_best_effort(dir, "invalidate_credential");
}

/// Configure quick-unlock for the (currently Unlocked) vault: wrap `root_key`
/// under a fresh provider wrap key into `vault.quickunlock`.
pub async fn setup_with_dir<P: QuickUnlockProvider + Send + 'static>(
    dir: &Path,
    state: &VaultRuntimeState,
    provider: P,
    account_number_hash: &[u8; 16],
) -> Result<(), QuickUnlockError> {
    // `auth_permits` gate (myne#378). This runs the provider's 256 MiB Argon2id
    // and then writes the blob; `change_password` holds the permit whole-body
    // and its LAST act is `invalidate_quick_unlock`. A setup that read before
    // that call and wrote after it re-created the credential the rotation was
    // supposed to delete — and §9.14.4 lists the password change as one of four
    // events that DELETE the credential. A raceable deletion is not a deletion.
    let _permit = match state.auth_permits().try_acquire() {
        Ok(p) => p,
        Err(_) => {
            tracing::debug!(
                stage = "auth_permits",
                error_kind = "VaultBusyAuth",
                "quick_unlock setup rejected: another auth-pipeline op in flight"
            );
            return Err(QuickUnlockError::VaultBusyAuth);
        }
    };

    let root_key = state
        .peek_unlocked_root_key_clone()
        .await
        .ok_or(QuickUnlockError::NotUnlocked)?;

    // `provider.create()` runs the PIN provider's Argon2id (256 MiB, ~1s) —
    // offload it to a blocking thread so a heavy KDF never parks an async
    // runtime worker (the `vault_unlock` spawn_blocking discipline).
    let kind = provider.kind();
    let secret = crate::task::run_blocking(move || provider.create())
        .await
        .map_err(|_| QuickUnlockError::Backend)??;

    let blob = encode_quick_unlock_blob(
        &secret.wrap_key,
        account_number_hash,
        kind,
        &secret.pin_salt,
        &root_key,
    )
    .map_err(|_| QuickUnlockError::Backend)?;

    crate::atomic_write::atomic_write(&blob_path(dir), &blob, true).map_err(io)?;
    persist_attempt_state(dir, &AttemptState::fresh())?;
    Ok(())
}

/// Report whether quick-unlock is configured for the vault at `dir`.
///
/// Pure disk truth — `available` is always `false` here because availability
/// depends on the per-session spring-loaded gate, which this OS-free core
/// cannot see. The [`quick_unlock_status`] command layers the gate on.
pub fn status_with_dir(dir: &Path) -> QuickUnlockStatus {
    match std::fs::read(blob_path(dir))
        .ok()
        .and_then(|blob| parse_quick_unlock_header(&blob).ok())
    {
        Some(header) => QuickUnlockStatus {
            configured: true,
            method: method_label(header.provider_kind),
            available: false,
        },
        None => QuickUnlockStatus {
            configured: false,
            method: None,
            available: false,
        },
    }
}

/// Whether quick-unlock can be redeemed right now. Mirrors the
/// [`quick_unlock_with_dir`] gate exactly, so the Unlock screen never offers a
/// credential that would immediately fail `RequiresFullPassword`.
///
/// **The session gate is PIN-only (MYND-641).** A configured BIOMETRIC
/// credential is available on a cold start; a PIN is not. The asymmetry is
/// argued at the gate itself — see [`requires_full_unlock_first`].
fn compute_available(
    configured: bool,
    method: Option<&str>,
    full_unlock_this_session: bool,
) -> bool {
    if !configured {
        return false;
    }
    // Anchor on method_label's own output, not a second "biometric" literal. This
    // status gate and the redeem gate (`requires_full_unlock_first`) must agree on
    // which provider is session-exempt; a drifted string here would silently
    // re-gate biometric on cold start — the MYND-641 bug returning — with no test
    // failing. One source of the label: method_label(PROVIDER_KIND_BIOMETRIC).
    if method == method_label(PROVIDER_KIND_BIOMETRIC) {
        return true;
    }
    full_unlock_this_session
}

/// Whether this provider must see a full master-password unlock this session
/// before it may be redeemed.
///
/// **PIN: yes. Biometric: no (MYND-641).**
///
/// The gate exists so a process restart cannot hand the vault back on a short
/// secret alone — the 1Password "restarting won't keep it unlocked" model, from
/// MYND-329. For a PIN that is the whole protection: six digits guarded by our
/// own five-attempt counter, and a restart is exactly the moment to demand the
/// real credential again.
///
/// A biometric credential is not that. Its wrap key lives in the Keychain under
/// `kSecAccessControlBiometryCurrentSet` + `kSecAttrAccessibleWhenUnlockedThisDeviceOnly`
/// (`super::apple`): reading it is gated by the OS on a Secure-Enclave-backed
/// prompt, it is non-exportable, and the OS invalidates the item outright if the
/// enrolled biometric set changes. That gate already survives a restart, which
/// is the model every iOS app relies on — stacking ours on top bought nothing
/// and cost the feature outright, because iOS evicts backgrounded apps so
/// aggressively that in practice EVERY launch is a cold start. A user who
/// enrolled Face ID was offered it almost never.
///
/// Decided 2026-07-30; `design-notes.md` carries the entry and the
/// `threat-model.md` A6 row records the changed post-restart window for this one
/// credential class. This narrows MYND-329's gate rather than removing it.
fn requires_full_unlock_first(provider_kind: u8) -> bool {
    provider_kind != PROVIDER_KIND_BIOMETRIC
}

/// Disable quick-unlock: remove the device-local files. OS-free — the
/// [`quick_unlock_disable`] command layers the Apple-Keychain cleanup on.
pub fn disable_with_dir(dir: &Path, state: &VaultRuntimeState) -> Result<(), QuickUnlockError> {
    // `auth_permits` gate (myne#378), BEFORE the precondition — the same
    // ordering `vault_delete_with_dir` uses, and for the same reason: never
    // report "nothing to delete" while an operation you cannot see is running.
    //
    // Disable is a credential DELETION, and the interleave that matters fails
    // OPEN: a disable landing between setup's blob write and its attempt-file
    // write would leave a live credential after the user turned the feature off.
    //
    // `Semaphore::try_acquire` is synchronous, so this fn stays sync.
    let _permit = match state.auth_permits().try_acquire() {
        Ok(p) => p,
        Err(_) => {
            tracing::debug!(
                stage = "auth_permits",
                error_kind = "VaultBusyAuth",
                "quick_unlock disable rejected: another auth-pipeline op in flight"
            );
            return Err(QuickUnlockError::VaultBusyAuth);
        }
    };

    if !blob_path(dir).exists() {
        return Err(QuickUnlockError::NotConfigured);
    }
    // Fail-CLOSED on a failed removal: the caller must not report "turned off"
    // over a credential file that is still on disk and still unwraps the live
    // `root_key`. `NotFound` inside `wipe_files` counts as success, so a vault
    // whose attempt file was never written still disables.
    wipe_files(dir).map_err(|io_error_kind| QuickUnlockError::WipeFailed { io_error_kind })?;
    Ok(())
}

/// Attempt a quick-unlock: recover `root_key` via the provider and install the
/// Unlocked slot, or count the failure (and wipe at the cap).
// Eight, and every one of them is a seam this crate deliberately does not let a
// core reach for on its own: the host, the storage, the hooks and now the
// keychain. Bundling them into a context struct would hide exactly the list a
// reviewer wants to see when asking what a credential path touches.
#[allow(clippy::too_many_arguments)]
pub async fn quick_unlock_with_dir<P: QuickUnlockProvider + Send + 'static>(
    dir: &Path,
    vault_id: VaultId,
    state: &VaultRuntimeState,
    provider: P,
    // Supplies `UnlockedVault::unlocked_at`. Threaded in with
    // phase3-web-client task 12, which changed that field from an `Instant` to
    // a host-supplied monotonic reading — `Instant::now()` panics on
    // `wasm32-unknown-unknown`. Both production callers already hold a host, so
    // this costs them nothing.
    host: &dyn crate::host::HostCtx,
    // Threaded in so a successful quick-unlock runs the same post-unlock
    // `apply_persisted_prefs` step the password path runs — see the call site
    // below for why omitting it left screen-capture protection stuck ON.
    hooks: &crate::hooks::Hooks,
    vault_io: &dyn crate::vault_io::VaultIo,
    // Threaded in for the same reason `hooks` was: the post-unlock pipeline now
    // also seals the vault's name into the device-local label store
    // (myne-md/myne#411), and a credential path that skipped it would leave the
    // LOCKED picker showing whatever the vault was called the last time some
    // OTHER path opened it.
    keychain: &dyn crate::vault_label::key::LabelKeychain,
) -> Result<(), QuickUnlockError> {
    // `auth_permits` gate — RAII guard; try_acquire, reject not queue (myne#378).
    //
    // This is a credential Argon2id that ALSO burns the §9.14.4 counter, so the
    // counter's read-modify-write and the slot install have to share one
    // critical section with every other auth op. Without it the read at
    // `read_attempt_state` straddles the KDF await, and N overlapping redeems
    // all persist the same k+1 — so the "code-enforced" five-attempt bound cost
    // one try for N wrong PINs. It also stopped a redeem installing an
    // `Unlocked` slot underneath a lifecycle op that holds the permit believing
    // it is alone, which is what made `change_password`'s closing
    // `invalidate_quick_unlock` raceable.
    let _permit = match state.auth_permits().try_acquire() {
        Ok(p) => p,
        Err(_) => {
            tracing::debug!(
                stage = "auth_permits",
                error_kind = "VaultBusyAuth",
                "quick_unlock rejected: another auth-pipeline op in flight"
            );
            return Err(QuickUnlockError::VaultBusyAuth);
        }
    };

    // Spring-loaded gate (task 9), narrowed to PIN in MYND-641: see
    // `requires_full_unlock_first` for why biometric is exempt. Read off the
    // PROVIDER, not the blob, so the check still costs no disk access — a
    // restart never consults the credential to decide whether it may be used.
    if requires_full_unlock_first(provider.kind()) && !state.has_full_unlock_this_session() {
        return Err(QuickUnlockError::RequiresFullPassword);
    }

    // A staged newer-generation `vault.meta` suspends quick-unlock entirely
    // (myne-md/myne#447), biometric included — this gate is about the vault's
    // state, not the provider's strength, so the MYND-641 narrowing above does
    // not apply.
    //
    // `MYQ1` wraps a THIRD `root_key` copy and never reads `vault.meta`, so a
    // redeem would hand back the previous generation's root and never promote
    // anything. A user who only ever uses their PIN would sit in #447's loop
    // forever while the fix worked perfectly for everyone else.
    //
    // The same variant the spring-loaded gate uses, deliberately: the remedy is
    // identical ("unlock once with your password"), the UI already routes it,
    // and the credential is intact — nothing here burns an attempt. Promotion
    // then drops `vault.quickunlock`, so the PIN is re-enrolled under the new
    // root, which is what the migrating device already does for itself.
    if crate::plugins::vault_migrate::adopt::incoming_meta_path(dir).exists() {
        tracing::info!(
            stage = "staged_meta",
            event = "quick_unlock_suspended",
            "quick-unlock suspended: a newer-generation vault.meta is staged and only \
             a full-credential unlock can adopt it"
        );
        return Err(QuickUnlockError::RequiresFullPassword);
    }

    let blob = match std::fs::read(blob_path(dir)) {
        Ok(b) => b,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            return Err(QuickUnlockError::NotConfigured)
        }
        Err(e) => return Err(io(e)),
    };

    // A structurally-corrupt blob can never unlock — wipe it and report
    // not-configured (the user re-sets quick-unlock).
    let header = match parse_quick_unlock_header(&blob) {
        Ok(h) => h,
        Err(_) => {
            let _ = provider.delete();
            wipe_files_best_effort(dir, "corrupt_blob");
            return Err(QuickUnlockError::NotConfigured);
        }
    };

    // Counter check BEFORE spending a provider call: a corrupt/over-cap counter
    // wipes immediately (fail safe).
    let mut attempts = read_attempt_state(dir);
    if attempts.must_wipe() {
        let _ = provider.delete();
        wipe_files_best_effort(dir, "attempts_over_cap");
        return Err(QuickUnlockError::AttemptsExhausted);
    }

    // Retrieve the wrap key. A cancelled prompt / unavailable hardware is NOT a
    // failed credential attempt — it does not burn the counter. The PIN
    // provider's Argon2id (256 MiB, ~1s) runs on a blocking thread so it never
    // parks an async runtime worker; the provider is handed back so the
    // failure path below can still call `delete()`.
    let pin_salt = header.pin_salt;
    let (provider, retrieve_result) = crate::task::run_blocking(move || {
        let r = provider.retrieve(&pin_salt);
        (provider, r)
    })
    .await
    .map_err(|_| QuickUnlockError::Backend)?;
    let wrap_key = retrieve_result?;

    let (meta_bytes, meta) = read_meta(dir)?;

    match decode_quick_unlock_blob(&wrap_key, &meta.account_number_hash, &blob) {
        Ok(root_key) => {
            // `MYQ1` hands back the `root_key` and stops there — the generation
            // lives in `vault.meta`'s magic, which `read_meta`'s parser consumes.
            // Deriving the `itemsKey` under the wrong one fails the AEAD open, so
            // a migrated vault refused every PIN and biometric attempt while the
            // password path branched correctly (myne-md/myne#442 follow-up).
            // An `NTV6` vault seals `itemsKey` under the GROUP tier, so the
            // root-tier derive fails there; derive the group key first and build
            // the slot with it, or the running session reads shared singletons
            // through the wrong tier.
            // `has_b2b_tail`, not a magic test: the `NTV7` generation was
            // classified as "not NTV6" here, so the root-tier derive AEAD-failed
            // and every PIN or biometric attempt on a person-born vault failed
            // while enrolment had succeeded (myne-md/myne#911 review). This is
            // the same class myne-md/myne#442 fixed for `NTV6`.
            let (items_key, group_key) = if protocol::has_b2b_tail(&meta_bytes) {
                let b2b = protocol::parse_b2b_tail_any(&meta_bytes)
                    .map_err(|_| QuickUnlockError::InvalidVaultMeta)?;
                let g = protocol::unlock_group_key_ntv6(&b2b, &protocol::OwnerKey::new(*root_key))
                    .map_err(|_| QuickUnlockError::InvalidVaultMeta)?;
                let gk = protocol::GroupKey::new(*g);
                let ik = protocol::unlock_items_key_ntv6(&b2b, &gk)
                    .map_err(|_| QuickUnlockError::InvalidVaultMeta)?;
                (ik, Some(g))
            } else {
                let version = protocol::meta_version_of(&meta_bytes)
                    .ok_or(QuickUnlockError::InvalidVaultMeta)?;
                let ik = protocol::derive_items_key_versioned(version, &root_key, &meta)
                    .map_err(|_| QuickUnlockError::InvalidVaultMeta)?;
                (ik, None)
            };
            let vault_meta_bytes_hash = crate::vault_meta_hash::vault_meta_sha256(&meta_bytes);
            // Drop every import source before the slot is installed, for the
            // reason `vault_unlock::commands` states above its own
            // unconditional call and this path did not honour: `reseal_attachment`
            // resolves its destination from the ACTIVE vault, so a source slot
            // surviving into this session would re-seal one vault's attachment
            // plaintext into a vault the user never named as an import target.
            //
            // Quick-unlock reaches the same slot install through a different
            // door, and was the ONE slot-installing path in the tree without the
            // call (myne-md/myne#464, found by review). `threat-model.md` A6 as
            // amended by this feature bounds a source vault's residency as "no
            // longer than the target vault's own session"; a slot that crosses
            // a PIN or biometric unlock is not bounded by that sentence at all,
            // only by the 30-minute TTL.
            //
            // Unconditional, and before the install rather than after it, for
            // the same two reasons: on every path that has no import source it
            // is one read-lock probe over an empty map, and putting it first
            // means no window exists in which the new slot and an old source
            // are both live.
            crate::plugins::vault_unlock::import_source::close_all(state).await;
            let switched_from = state
                .set_unlocked_locking_others(
                    vault_id,
                    UnlockedVault::owner(
                        root_key,
                        group_key,
                        items_key,
                        meta.items_key_id,
                        host.monotonic_millis(),
                        vault_meta_bytes_hash,
                    ),
                )
                .await;
            if matches!(
                switched_from,
                crate::plugins::vault_unlock::state::Slot::Unlocked(_)
            ) {
                tracing::info!(
                    event = "vault_locked",
                    from_slot_kind = "unlocked",
                    reason = "vault_switch",
                    "quick-unlock replaced the prior active vault"
                );
            }
            // Success resets the consecutive-failure count. The vault is already
            // unlocked (slot installed above), so a failure to persist the reset
            // must NOT surface as an unlock failure — best-effort; a stale counter
            // only fails safe (fewer future attempts) and recovers on next success.
            attempts.record_success();

            // NO `NTV7` to `NTV8` upgrade on this path, deliberately (myne-md/myne#938
            // review). The byte range could be dropped here: `root_key` is in hand
            // and nothing is derived. But a PIN or a biometric proves a device-local
            // secret, never the vault password, and the person wrap being removed is
            // the only door left for a user who set quick unlock and then forgot
            // their password. The upgrade therefore waits for a password unlock
            // (`vault_migrate::ntv8::UpgradeAuthority::PasswordNotProven`), and a
            // vault whose user only ever types a PIN stays on the person-wrapped
            // frame, which costs nothing: it is defence in depth, not correctness.
            if let Err(_e) = persist_attempt_state(dir, &attempts) {
                tracing::debug!(
                    stage = "persist_attempt_reset",
                    "quick-unlock succeeded; attempt-reset not persisted"
                );
            }

            // Released before the pipeline, exactly where the password path
            // releases it: `unlock_with_path` drops the permit on return and
            // `unlock_from_host` runs the pipeline outside it. The critical
            // section this permit exists for ended at the slot install; the
            // pipeline below hydrates the whole search index, and holding a
            // capacity-1 auth permit across a whole-vault walk would reject an
            // unrelated backup or change-password for its duration — and would
            // deadlock outright if a hook impl ever took the permit itself.
            drop(_permit);

            // The slot is now `Unlocked`, so this path owes the same
            // post-unlock pipeline the password path runs — persisted prefs
            // (screen-capture protection above all), search + spell hydration,
            // the rename roll-forward, the stray-blob reclaim. Quick-unlock ran
            // NONE of it until MYND-160's screen-capture regression surfaced
            // the gap; see `run_post_unlock_pipeline`'s doc for the full story.
            //
            // Best-effort end-to-end (every step swallows its own failures), so
            // the unlock the user just completed can never fail because of it.
            crate::plugins::vault_unlock::commands::run_post_unlock_pipeline(
                host, state, hooks, vault_io, keychain,
            )
            .await;

            Ok(())
        }
        Err(_) => match attempts.record_failure() {
            AttemptOutcome::Wipe => {
                let _ = provider.delete();
                wipe_files_best_effort(dir, "attempts_exhausted");
                Err(QuickUnlockError::AttemptsExhausted)
            }
            AttemptOutcome::Allowed { remaining } => {
                persist_attempt_state(dir, &attempts)?;
                Err(QuickUnlockError::WrongCredential { remaining })
            }
        },
    }
}

// ---- Tauri command wrappers (PIN + Apple biometric + status/disable) --------

fn map_pin_validation(e: PinValidationError) -> QuickUnlockError {
    match e {
        PinValidationError::TooShort => QuickUnlockError::PinTooShort,
        PinValidationError::NonDigit => QuickUnlockError::PinNotDigits,
    }
}

pub async fn active_dir(
    host: &dyn HostCtx,
    state: &VaultRuntimeState,
) -> Result<PathBuf, QuickUnlockError> {
    crate::paths::active_vault_root_io_from_host(host, state.active_vault_id().await)
        .map_err(|_| QuickUnlockError::InvalidVaultMeta)
}

/// Resolve the quick-unlock target dir for a command that may name an explicit
/// `vault_id`.
///
/// The Unlock-screen commands (status / redeem) run while NO vault is
/// `Unlocked`, so [`active_dir`]'s `active_vault_id()` is `None` and its
/// sole-vault disk heuristic ([`crate::paths::current_vault_root_from_base`])
/// resolves to the WRONG (legacy `vault/`) path the moment two or more vaults
/// exist on disk — the credential blob then appears absent and the PIN field
/// silently self-hides. The Unlock screen DOES know which locked vault it
/// targets, so it threads that id here and we resolve `<app_data_dir>/vaults/<id>/`
/// directly (non-creating). When no id is named (the Settings panel, where a
/// vault IS unlocked) we keep the active-vault path.
pub async fn target_dir(
    host: &dyn HostCtx,
    state: &VaultRuntimeState,
    vault_id: Option<&str>,
) -> Result<PathBuf, QuickUnlockError> {
    match VaultId::parse_optional(vault_id) {
        Some(id) => crate::paths::vault_root_for_id_from_host(host, id)
            .map_err(|_| QuickUnlockError::InvalidVaultMeta),
        None => active_dir(host, state).await,
    }
}

/// Configure PIN quick-unlock for the active (Unlocked) vault.
pub async fn quick_unlock_setup_pin_from_host(
    pin: String,
    host: &dyn HostCtx,
    state: &VaultRuntimeState,
    hooks: &crate::hooks::Hooks,
) -> Result<(), QuickUnlockError> {
    // MYND-351 Direction 2: this one is EDITOR-ORIGINATED (Settings → Privacy),
    // so a live scheduled backup holding the shared permit must yield first —
    // the same bridge `change_password` and `vault_delete` use. The redeem path
    // is pre-editor and deliberately does not (Model A).
    hooks.preempt_inflight_backup(state).await;
    let pin = Zeroizing::new(pin);
    validate_pin(&pin).map_err(map_pin_validation)?;
    let dir = active_dir(host, state).await?;
    let (_, meta) = read_meta(&dir)?;
    let provider = PinProvider::new(pin, meta.account_number_hash, meta.kdf_params);
    let result = setup_with_dir(&dir, state, provider, &meta.account_number_hash).await;
    if result.is_ok() {
        // A PIN blob has no Keychain consumer, so the biometric item a previous
        // enrolment left at this vault's address has none either (myne-md/myne#761).
        // Same rule the disable path follows, on the path that REPLACES rather
        // than disables.
        cleanup_os_credential(&dir);
    }
    result
}

/// IPC wrapper. Delegates; the command name and payload the frontend
/// sends are unchanged because this IS the registered command.
#[cfg(all(feature = "tauri-ipc", not(target_arch = "wasm32")))]
#[tauri::command]
pub async fn quick_unlock_setup_pin<R: Runtime>(
    pin: String,
    app: AppHandle<R>,
    state: State<'_, VaultRuntimeState>,
    hooks: State<'_, crate::hooks::Hooks>,
) -> Result<(), QuickUnlockError> {
    quick_unlock_setup_pin_from_host(pin, &TauriHost::new(app), state.inner(), hooks.inner()).await
}

/// Attempt a PIN quick-unlock of the active vault.
pub async fn quick_unlock_with_pin_from_host(
    pin: String,
    vault_id: Option<String>,
    host: &dyn HostCtx,
    state: &VaultRuntimeState,
    hooks: &crate::hooks::Hooks,
    vault_io: &dyn crate::vault_io::VaultIo,
    keychain: &dyn crate::vault_label::key::LabelKeychain,
) -> Result<(), QuickUnlockError> {
    let pin = Zeroizing::new(pin);
    let dir = target_dir(host, state, vault_id.as_deref()).await?;
    let (_, meta) = read_meta(&dir)?;
    let id = crate::paths::vault_id_from_root(&dir);
    let provider = PinProvider::new(pin, meta.account_number_hash, meta.kdf_params);
    quick_unlock_with_dir(&dir, id, state, provider, host, hooks, vault_io, keychain).await
}

/// IPC wrapper. Delegates; the command name and payload the frontend
/// sends are unchanged because this IS the registered command.
#[cfg(all(feature = "tauri-ipc", not(target_arch = "wasm32")))]
#[tauri::command]
pub async fn quick_unlock_with_pin<R: Runtime>(
    pin: String,
    vault_id: Option<String>,
    app: AppHandle<R>,
    state: State<'_, VaultRuntimeState>,
    hooks: State<'_, crate::hooks::Hooks>,
) -> Result<(), QuickUnlockError> {
    quick_unlock_with_pin_from_host(
        pin,
        vault_id,
        &TauriHost::new(app),
        state.inner(),
        hooks.inner(),
        &crate::vault_io::StdVaultIo,
        crate::vault_label::key::platform_keychain(),
    )
    .await
}

/// Configure Apple biometric quick-unlock (macOS Touch ID / iOS Face ID or
/// Touch ID) for the active (Unlocked) vault.
///
/// ⚠️ The Apple provider's biometric gating is UNVERIFIED pending biometric
/// hardware + a primitive review (see `apple.rs`). Returns
/// `HardwareUnavailable` off Apple targets.
pub async fn quick_unlock_setup_biometric_from_host(
    host: &dyn HostCtx,
    state: &VaultRuntimeState,
    hooks: &crate::hooks::Hooks,
) -> Result<(), QuickUnlockError> {
    #[cfg(any(target_os = "macos", target_os = "ios"))]
    {
        // MYND-351 Direction 2: this one is EDITOR-ORIGINATED (Settings → Privacy),
        // so a live scheduled backup holding the shared permit must yield first —
        // the same bridge `change_password` and `vault_delete` use. The redeem path
        // is pre-editor and deliberately does not (Model A).
        hooks.preempt_inflight_backup(state).await;
        let dir = active_dir(host, state).await?;
        let (_, meta) = read_meta(&dir)?;
        let id = crate::paths::vault_id_from_root(&dir);
        let provider = super::apple::AppleBiometricProvider::new(meta.account_number_hash, id);
        setup_with_dir(&dir, state, provider, &meta.account_number_hash).await
    }
    #[cfg(not(any(target_os = "macos", target_os = "ios")))]
    {
        let _ = (host, &state, hooks);
        Err(QuickUnlockError::HardwareUnavailable)
    }
}

/// IPC wrapper. Delegates; the command name and payload the frontend
/// sends are unchanged because this IS the registered command.
#[cfg(all(feature = "tauri-ipc", not(target_arch = "wasm32")))]
#[tauri::command]
pub async fn quick_unlock_setup_biometric<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, VaultRuntimeState>,
    hooks: State<'_, crate::hooks::Hooks>,
) -> Result<(), QuickUnlockError> {
    quick_unlock_setup_biometric_from_host(&TauriHost::new(app), state.inner(), hooks.inner()).await
}

/// Attempt an Apple biometric quick-unlock of the active vault. (See the setup
/// command's verification caveat.)
pub async fn quick_unlock_with_biometric_from_host(
    vault_id: Option<String>,
    host: &dyn HostCtx,
    state: &VaultRuntimeState,
    hooks: &crate::hooks::Hooks,
    vault_io: &dyn crate::vault_io::VaultIo,
    keychain: &dyn crate::vault_label::key::LabelKeychain,
) -> Result<(), QuickUnlockError> {
    #[cfg(any(target_os = "macos", target_os = "ios"))]
    {
        let dir = target_dir(host, state, vault_id.as_deref()).await?;
        let (_, meta) = read_meta(&dir)?;
        let id = crate::paths::vault_id_from_root(&dir);
        let provider = super::apple::AppleBiometricProvider::new(meta.account_number_hash, id);
        quick_unlock_with_dir(&dir, id, state, provider, host, hooks, vault_io, keychain).await
    }
    #[cfg(not(any(target_os = "macos", target_os = "ios")))]
    {
        let _ = (host, &state, &vault_id, hooks, vault_io, keychain);
        Err(QuickUnlockError::HardwareUnavailable)
    }
}

/// IPC wrapper. Delegates; the command name and payload the frontend
/// sends are unchanged because this IS the registered command.
#[cfg(all(feature = "tauri-ipc", not(target_arch = "wasm32")))]
#[tauri::command]
pub async fn quick_unlock_with_biometric<R: Runtime>(
    vault_id: Option<String>,
    app: AppHandle<R>,
    state: State<'_, VaultRuntimeState>,
    hooks: State<'_, crate::hooks::Hooks>,
) -> Result<(), QuickUnlockError> {
    quick_unlock_with_biometric_from_host(
        vault_id,
        &TauriHost::new(app),
        state.inner(),
        hooks.inner(),
        &crate::vault_io::StdVaultIo,
        crate::vault_label::key::platform_keychain(),
    )
    .await
}

/// Report quick-unlock status for the active vault.
pub async fn quick_unlock_status_from_host(
    vault_id: Option<String>,
    host: &dyn HostCtx,
    state: &VaultRuntimeState,
) -> Result<QuickUnlockStatus, QuickUnlockError> {
    let dir = target_dir(host, state, vault_id.as_deref()).await?;
    let mut status = status_with_dir(&dir);
    // Layer the session gate on — PIN-only since MYND-641. A cold start reports
    // `available: false` for a PIN so the Unlock screen hides the field rather
    // than offer a credential `quick_unlock_with_dir` would immediately reject;
    // a biometric credential stays available, which is the whole point of the
    // change (iOS makes every launch a cold start).
    status.available = compute_available(
        status.configured,
        status.method,
        state.has_full_unlock_this_session(),
    );
    Ok(status)
}

/// IPC wrapper. Delegates; the command name and payload the frontend
/// sends are unchanged because this IS the registered command.
#[cfg(all(feature = "tauri-ipc", not(target_arch = "wasm32")))]
#[tauri::command]
pub async fn quick_unlock_status<R: Runtime>(
    vault_id: Option<String>,
    app: AppHandle<R>,
    state: State<'_, VaultRuntimeState>,
) -> Result<QuickUnlockStatus, QuickUnlockError> {
    quick_unlock_status_from_host(vault_id, &TauriHost::new(app), state.inner()).await
}

/// Disable quick-unlock for the active vault (device-local files + the
/// Apple-Keychain item, if any).
pub async fn quick_unlock_disable_from_host(
    host: &dyn HostCtx,
    state: &VaultRuntimeState,
    hooks: &crate::hooks::Hooks,
) -> Result<(), QuickUnlockError> {
    // MYND-351 Direction 2: this one is EDITOR-ORIGINATED (Settings → Privacy),
    // so a live scheduled backup holding the shared permit must yield first —
    // the same bridge `change_password` and `vault_delete` use. The redeem path
    // is pre-editor and deliberately does not (Model A).
    hooks.preempt_inflight_backup(state).await;
    let dir = active_dir(host, state).await?;
    cleanup_os_credential(&dir);
    disable_with_dir(&dir, state)
}

/// IPC wrapper. Delegates; the command name and payload the frontend
/// sends are unchanged because this IS the registered command.
#[cfg(all(feature = "tauri-ipc", not(target_arch = "wasm32")))]
#[tauri::command]
pub async fn quick_unlock_disable<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, VaultRuntimeState>,
    hooks: State<'_, crate::hooks::Hooks>,
) -> Result<(), QuickUnlockError> {
    quick_unlock_disable_from_host(&TauriHost::new(app), state.inner(), hooks.inner()).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::plugins::quick_unlock::provider::{MockProvider, ProviderError};
    use crate::test_support::ScopedTempDir;
    use protocol::{
        aad_vault_items_key_wrap, aead_seal_ctx, derive_subkey, serialize_vault_meta, SubkeyRole,
    };

    const ROOT_KEY: [u8; 32] = [0x33; 32];
    const ITEMS_KEY: [u8; 32] = [0xCC; 32];
    const ACCOUNT_HASH: [u8; 16] = [0x5a; 16];

    /// No-op hooks for the `*_with_dir` cores. The post-unlock
    /// `apply_persisted_prefs` step reaches the native world only through this
    /// seam, so a `NoopHooks` keeps these tests OS-free — the screen-capture
    /// side effect itself is asserted by the tracking test below.
    fn test_hooks() -> crate::hooks::Hooks {
        std::sync::Arc::new(crate::hooks::NoopHooks)
    }

    fn test_io() -> crate::vault_io::StdVaultIo {
        crate::vault_io::StdVaultIo
    }

    /// Current-thread tokio runtime for the async `*_with_dir` cores (the crate
    /// convention — `tokio::test` is deliberately not used; cf. vault_unlock
    /// state tests).
    fn rt() -> tokio::runtime::Runtime {
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("current-thread runtime build")
    }

    /// Build a REAL sealed `vault.meta` whose `enc_items_key` decrypts to
    /// `ITEMS_KEY` under `ROOT_KEY` — so `derive_items_key` succeeds and the
    /// full setup → quick-unlock round-trip is exercised.
    fn write_sealed_meta(dir: &Path) {
        let items_key_id = [0x07u8; 16];
        let items_wrap_key = derive_subkey(&ROOT_KEY, SubkeyRole::ItemsKeyWrap);
        let aad = aad_vault_items_key_wrap(&items_key_id);
        let nonce = [0x08u8; 24];
        let sealed = aead_seal_ctx(&items_wrap_key, &nonce, &ITEMS_KEY, &aad).expect("seal");
        let mut enc_items_key = [0u8; 64];
        enc_items_key.copy_from_slice(&sealed);
        let meta = VaultMeta {
            account_number_hash: ACCOUNT_HASH,
            kdf_params: crate::test_support::FAST_TEST_KDF,
            random_salt_password: [1u8; 16],
            random_salt_recovery: [2u8; 16],
            nonce_password_wrap: [3u8; 24],
            enc_root_key_password: [4u8; 64],
            nonce_recovery_wrap: [5u8; 24],
            enc_root_key_recovery: [6u8; 64],
            items_key_id,
            items_key_nonce: nonce,
            enc_items_key,
            membership: None,
            person_binding: None,
        };
        std::fs::write(dir.join("vault.meta"), serialize_vault_meta(&meta)).expect("write meta");
    }

    /// The v0.2 (`NTV5`) twin of [`write_sealed_meta`] — the same `ITEMS_KEY`
    /// under the same `ROOT_KEY`, but wrapped through the v0.2 KEK context and
    /// the v0.2 AAD and framed with the v0.2 magic. That is byte-for-byte what
    /// the §10.4 migration leaves behind, which is the only way to reach the
    /// generation-routing this file's redeem path depends on.
    fn write_sealed_meta_v0_2(dir: &Path) {
        let items_key_id = [0x07u8; 16];
        let items_wrap_key = protocol::derive_subkey_v0_2(&ROOT_KEY, SubkeyRole::ItemsKeyWrap);
        let aad = protocol::aad_vault_items_key_wrap_v0_2(&items_key_id);
        let nonce = [0x08u8; 24];
        let sealed = aead_seal_ctx(&items_wrap_key, &nonce, &ITEMS_KEY, &aad).expect("seal");
        let mut enc_items_key = [0u8; 64];
        enc_items_key.copy_from_slice(&sealed);
        let meta = VaultMeta {
            account_number_hash: ACCOUNT_HASH,
            kdf_params: crate::test_support::FAST_TEST_KDF,
            random_salt_password: [1u8; 16],
            random_salt_recovery: [2u8; 16],
            nonce_password_wrap: [3u8; 24],
            enc_root_key_password: [4u8; 64],
            nonce_recovery_wrap: [5u8; 24],
            enc_root_key_recovery: [6u8; 64],
            items_key_id,
            items_key_nonce: nonce,
            enc_items_key,
            membership: None,
            person_binding: None,
        };
        std::fs::write(
            dir.join("vault.meta"),
            protocol::serialize_vault_meta_v0_2(&meta),
        )
        .expect("write meta");
    }

    fn unlocked_state() -> VaultRuntimeState {
        VaultRuntimeState::default()
    }

    async fn seed_unlocked(state: &VaultRuntimeState, dir: &Path) {
        // Test fixture: the origin is unspecified by contract, so a literal is
        // as valid as a reading — and no test asserts on it.
        let vault_id = crate::paths::vault_id_from_root(dir);
        state
            .set_unlocked(
                vault_id,
                UnlockedVault::owner(
                    Zeroizing::new(ROOT_KEY),
                    None,
                    Zeroizing::new(ITEMS_KEY),
                    [0x07u8; 16],
                    0,
                    [0u8; 32],
                ),
            )
            .await;
    }

    /// A `Hooks` that records the two post-unlock-pipeline steps this module's
    /// tests assert on and no-ops everything else (the `CountingHooks` pattern
    /// from the prefs tests).
    struct RecordingHooks {
        screen_capture: std::sync::Mutex<Vec<(bool, &'static str)>>,
        search_hydrations: std::sync::atomic::AtomicUsize,
    }

    impl RecordingHooks {
        fn new() -> std::sync::Arc<Self> {
            std::sync::Arc::new(Self {
                screen_capture: std::sync::Mutex::new(Vec::new()),
                search_hydrations: std::sync::atomic::AtomicUsize::new(0),
            })
        }
        fn calls(&self) -> Vec<(bool, &'static str)> {
            self.screen_capture
                .lock()
                .expect("recording hooks lock")
                .clone()
        }
        fn search_hydrations(&self) -> usize {
            self.search_hydrations
                .load(std::sync::atomic::Ordering::Relaxed)
        }
    }

    impl crate::hooks::VaultLifecycleHooks for RecordingHooks {
        fn apply_screen_capture(&self, enabled: bool, site: &'static str) {
            self.screen_capture
                .lock()
                .expect("recording hooks lock")
                .push((enabled, site));
        }

        fn hydrate_attachment_refs<'a>(
            &'a self,
            _: &'a VaultRuntimeState,
        ) -> crate::hooks::BoxFuture<'a> {
            Box::pin(std::future::ready(()))
        }
        fn hydrate_search_index<'a>(
            &'a self,
            _: &'a VaultRuntimeState,
        ) -> crate::hooks::BoxFuture<'a> {
            self.search_hydrations
                .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
            Box::pin(std::future::ready(()))
        }
        fn hydrate_spell<'a>(&'a self, _: &'a VaultRuntimeState) -> crate::hooks::BoxFuture<'a> {
            Box::pin(std::future::ready(()))
        }
        fn reclaim_stray_attachment_blobs<'a>(
            &'a self,
            _: &'a VaultRuntimeState,
        ) -> crate::hooks::BoxFuture<'a> {
            Box::pin(std::future::ready(()))
        }
        fn persist_search_index<'a>(
            &'a self,
            _: &'a VaultRuntimeState,
        ) -> crate::hooks::BoxFuture<'a> {
            Box::pin(std::future::ready(()))
        }
        fn index_note_attachments<'a>(
            &'a self,
            _: &'a VaultRuntimeState,
            _: &'a str,
            _: &'a str,
            _: &'a str,
        ) -> crate::hooks::BoxFuture<'a> {
            Box::pin(std::future::ready(()))
        }
        fn preempt_inflight_backup<'a>(
            &'a self,
            _: &'a VaultRuntimeState,
        ) -> crate::hooks::BoxFuture<'a> {
            Box::pin(std::future::ready(()))
        }
        fn zeroize_search_index(&self) {}
        fn zeroize_spell(&self) {}
        fn zeroize_vault_indices(&self) {}
        fn zeroize_attachment_refs(&self) {}
        fn abort_active_recording(&self) {}
        fn pdf_export_teardown_on_lock(&self) {}
        fn agent_teardown_on_lock(&self) {}
        fn detached_windows_teardown_on_lock(&self) {}
        fn live_session_teardown_on_lock(&self) {}
        fn clear_staged_descriptor(&self) {}
        fn search_upsert(&self, _: &str, _: &str, _: &str) {}
        fn search_remove(&self, _: &str) {}
        fn bump_local_change(&self) {}
        fn emit_snapshot_write_failed(&self, _: &str) {}
        fn emit_notes_deleted(&self, _: &str) {}
        // `effective_auto_lock_secs` deliberately not overridden: the trait's
        // default clamps (myne-md/myne#479). This body used to be the unclamped
        // `unwrap_or`, which is the exact shape that change removed from two
        // production clients, so a fixture carrying it handed the next author
        // the defect as the copyable example.
        fn hydrate_clipper_pairing(&self, _: &[protocol::PairedExtension]) {}
        fn invalidate_quick_unlock(&self, _: &std::path::Path) {}
        fn capture_snapshot(&self, _: &Path, _: &str, _: &[u8], _: u64, _: bool) -> bool {
            false
        }
        fn purge_note_snapshots(&self, _: &Path, _: &str) -> std::io::Result<usize> {
            Ok(0)
        }
    }

    /// A quick-unlock must re-apply the PERSISTED screen-capture preference,
    /// exactly like the password path does.
    ///
    /// The regression this pins: every lock re-applies
    /// `set_content_protected(true)` unconditionally (lock-on-default-ON,
    /// `decisions.md` 2026-05-27), and only the post-unlock `vault.prefs`
    /// re-read restores a user who turned protection OFF. While quick-unlock
    /// skipped that step, a lock → PIN-unlock cycle left protection ON
    /// natively while the Privacy panel — reading the same blob — kept showing
    /// the toggle off. Asserting on `false` here (not merely "some call
    /// happened") is what makes the test fail if the step is dropped again:
    /// the vault-dir-resolution fallback also calls the hook, but with `true`.
    #[test]
    fn quick_unlock_reapplies_the_persisted_screen_capture_preference() {
        rt().block_on(quick_unlock_reapplies_the_persisted_screen_capture_preference_inner())
    }
    async fn quick_unlock_reapplies_the_persisted_screen_capture_preference_inner() {
        // The post-unlock step resolves the vault dir through the HOST
        // (`<app_data_dir>/vaults/<id>/`), so the fixture has to live where the
        // resolver will look rather than at an arbitrary temp path.
        let tmp = ScopedTempDir::new("qu-prefs-reapply").unwrap();
        let host = crate::host::test_host::TestHost::new(tmp.path().to_str().expect("utf-8 path"));
        let vault_id = crate::vault_id::VaultId::mint();
        let dir = host
            .app_data_dir()
            .expect("test host app_data_dir")
            .join("vaults")
            .join(vault_id.to_string());
        std::fs::create_dir_all(&dir).expect("vault dir");
        write_sealed_meta(&dir);

        // Persist "protection OFF" + configure quick-unlock, both of which
        // require an unlocked slot.
        let setup_state = unlocked_state();
        setup_state
            .set_unlocked(
                vault_id,
                UnlockedVault::owner(
                    Zeroizing::new(ROOT_KEY),
                    None,
                    Zeroizing::new(ITEMS_KEY),
                    [0x07u8; 16],
                    0,
                    [0u8; 32],
                ),
            )
            .await;
        crate::plugins::prefs::commands::set_screen_capture_protection_with_dir(
            &dir,
            &setup_state,
            &test_hooks(),
            false,
            &test_io(),
            &host,
        )
        .await
        .expect("persist protection-off");

        let provider = MockProvider::new(PROVIDER_KIND_PIN, 0x11);
        setup_with_dir(&dir, &setup_state, provider.clone(), &ACCOUNT_HASH)
            .await
            .expect("setup");

        // A FRESH (locked) runtime quick-unlocks — the lock that got it here
        // would have forced protection back ON.
        let fresh = unlocked_state();
        fresh.mark_full_unlock_done();
        let hooks = RecordingHooks::new();
        let hooks_handle: crate::hooks::Hooks = hooks.clone();
        quick_unlock_with_dir(
            &dir,
            vault_id,
            &fresh,
            provider,
            &host,
            &hooks_handle,
            &test_io(),
            &crate::vault_label::key::UnavailableKeychain,
        )
        .await
        .expect("quick unlock");

        assert_eq!(
            hooks.calls(),
            vec![(false, "runtime_apply")],
            "quick-unlock must re-apply the persisted toggle (OFF), once"
        );
        // The prefs step is one member of the shared post-unlock pipeline, and
        // the pipeline is what quick-unlock was missing — so assert a second,
        // independent member ran too. Without this a future edit could restore
        // the prefs call alone and leave the vault searchable-by-nothing again.
        assert_eq!(
            hooks.search_hydrations(),
            1,
            "quick-unlock must run the whole post-unlock pipeline, not just prefs"
        );
    }

    /// A quick-unlock of a DIFFERENT vault drops the import sources the
    /// outgoing vault opened.
    ///
    /// The reachable path, which is what makes this a defect rather than
    /// tidiness: vault A is unlocked and holds an open source, and the user
    /// switches to vault B, which has quick-unlock configured. That switch runs
    /// `set_unlocked_locking_others` through THIS function rather than through
    /// `unlock_from_host`, and quick-unlock was the one slot-installing path in
    /// the tree that did not first call `import_source::close_all`
    /// (myne-md/myne#464, found by review). A plain lock is not the hole: it
    /// closes the sources on the way out.
    ///
    /// What it costs is the sentence `threat-model.md` A6 gained in this same
    /// feature. The source's keys stay resident into a session belonging to a
    /// vault the user never named as an import target, bounded only by the
    /// 30-minute TTL, and `reseal_attachment` resolves its destination from the
    /// ACTIVE vault, so a re-seal in that window writes one vault's attachment
    /// plaintext into another.
    ///
    /// Deleting the `close_all` line in `quick_unlock_with_dir` makes this fail.
    #[test]
    fn quick_unlock_drops_the_outgoing_vaults_import_sources() {
        rt().block_on(quick_unlock_drops_the_outgoing_vaults_import_sources_inner())
    }
    async fn quick_unlock_drops_the_outgoing_vaults_import_sources_inner() {
        let tmp = ScopedTempDir::new("qu-import-source").unwrap();
        let dir = tmp.path();
        write_sealed_meta(dir);

        let setup_state = unlocked_state();
        seed_unlocked(&setup_state, dir).await;
        let provider = MockProvider::new(PROVIDER_KIND_PIN, 0x11);
        setup_with_dir(dir, &setup_state, provider.clone(), &ACCOUNT_HASH)
            .await
            .expect("setup");

        // Vault A is unlocked and holds a source. `set_import_source` refuses
        // when nothing is unlocked, which is itself the guard that makes this
        // the only shape the hole has.
        let live = unlocked_state();
        live.mark_full_unlock_done();
        seed_unlocked(&live, dir).await;
        let source_id = crate::vault_id::VaultId::mint();
        live.set_import_source(
            source_id,
            crate::plugins::vault_unlock::state::fixture_import_source(0x41, 0x42, 0x43, 0),
        )
        .await
        .expect("source opens against an unlocked vault");

        quick_unlock_with_dir(
            dir,
            crate::paths::vault_id_from_root(dir),
            &live,
            provider,
            &crate::host::NoopHost,
            &test_hooks(),
            &test_io(),
            &crate::vault_label::key::UnavailableKeychain,
        )
        .await
        .expect("quick unlock");

        assert!(
            live.take_import_source(source_id).await.is_none(),
            "the source vault's key material must not survive a quick-unlock",
        );
    }

    #[test]
    fn quick_unlock_switch_clears_person_session() {
        rt().block_on(async {
            let source = ScopedTempDir::new("qu-person-source").unwrap();
            let target = ScopedTempDir::new("qu-person-target").unwrap();
            write_sealed_meta(source.path());
            write_sealed_meta(target.path());

            let state = unlocked_state();
            seed_unlocked(&state, source.path()).await;
            state
                .set_person_identity_and_id(
                    protocol::PersonKeyPair::generate_raw(&[1u8; 64], &[2u8; 32], &[3u8; 32]),
                    [0x44u8; 16],
                )
                .await;
            state
                .set_person_profile(
                    [0x55u8; 16],
                    Zeroizing::new([0x66u8; protocol::AEAD_KEY_LEN]),
                )
                .await;
            state.mark_full_unlock_done();

            let setup_state = unlocked_state();
            seed_unlocked(&setup_state, target.path()).await;
            let provider = MockProvider::new(PROVIDER_KIND_PIN, 0x11);
            setup_with_dir(target.path(), &setup_state, provider.clone(), &ACCOUNT_HASH)
                .await
                .expect("setup");

            quick_unlock_with_dir(
                target.path(),
                crate::paths::vault_id_from_root(target.path()),
                &state,
                provider,
                &crate::host::NoopHost,
                &test_hooks(),
                &test_io(),
                &crate::vault_label::key::UnavailableKeychain,
            )
            .await
            .expect("quick unlock");

            assert!(!state.person_identity_unlocked().await);
            assert!(state.clone_person_profile().await.is_none());
        });
    }

    #[test]
    fn setup_then_quick_unlock_round_trips_the_unlocked_slot() {
        rt().block_on(setup_then_quick_unlock_round_trips_the_unlocked_slot_inner())
    }
    async fn setup_then_quick_unlock_round_trips_the_unlocked_slot_inner() {
        let tmp = ScopedTempDir::new("qu-roundtrip").unwrap();
        let dir = tmp.path();
        write_sealed_meta(dir);

        // Setup while unlocked.
        let setup_state = unlocked_state();
        seed_unlocked(&setup_state, dir).await;
        let provider = MockProvider::new(PROVIDER_KIND_PIN, 0x11);
        setup_with_dir(dir, &setup_state, provider.clone(), &ACCOUNT_HASH)
            .await
            .expect("setup");
        assert!(blob_path(dir).exists());
        assert!(status_with_dir(dir).configured);

        // A FRESH (locked) runtime quick-unlocks from disk.
        let fresh = unlocked_state();
        fresh.mark_full_unlock_done();
        let vault_id = crate::paths::vault_id_from_root(dir);
        quick_unlock_with_dir(
            dir,
            vault_id,
            &fresh,
            provider.clone(),
            &crate::host::NoopHost,
            &test_hooks(),
            &test_io(),
            &crate::vault_label::key::UnavailableKeychain,
        )
        .await
        .expect("quick unlock");
        // The slot is now Unlocked and carries the round-tripped items_key.
        let material = fresh
            .peek_unlocked_root_key_clone()
            .await
            .expect("unlocked");
        assert_eq!(material.as_slice(), &ROOT_KEY);
    }

    /// A quick-unlock of a MIGRATED (`NTV5`) vault must reach the same slot the
    /// password path would.
    ///
    /// `MYQ1` is generation-agnostic by design — it wraps a third `root_key`
    /// copy and never reads `vault.meta` — so the redeem hands back a correct
    /// `root_key` on either generation. The `itemsKey` step is where the
    /// generation matters, and nothing in the signature says so: a parsed
    /// `VaultMeta` has no generation field, so calling `derive_items_key`
    /// (v0.1 KEK context + v0.1 AAD) compiles and reads perfectly next to a
    /// correct `read_meta`. On a v0.2 vault it fails the AEAD open, so every
    /// PIN and biometric attempt returned `InvalidVaultMeta` — while the
    /// password path two files over branched correctly. Asserting the
    /// `items_key` VALUE rather than just "unlock succeeded" is the point: it
    /// is the byte the v0.1 twin cannot produce.
    #[test]
    fn quick_unlock_derives_the_items_key_under_the_vaults_own_generation() {
        rt().block_on(quick_unlock_on_a_migrated_vault_inner())
    }
    async fn quick_unlock_on_a_migrated_vault_inner() {
        let tmp = ScopedTempDir::new("qu-v0-2").unwrap();
        let dir = tmp.path();
        write_sealed_meta_v0_2(dir);

        let setup_state = unlocked_state();
        seed_unlocked(&setup_state, dir).await;
        let provider = MockProvider::new(PROVIDER_KIND_PIN, 0x11);
        setup_with_dir(dir, &setup_state, provider.clone(), &ACCOUNT_HASH)
            .await
            .expect("setup on a migrated vault");

        let fresh = unlocked_state();
        fresh.mark_full_unlock_done();
        let vault_id = crate::paths::vault_id_from_root(dir);
        quick_unlock_with_dir(
            dir,
            vault_id,
            &fresh,
            provider.clone(),
            &crate::host::NoopHost,
            &test_hooks(),
            &test_io(),
            &crate::vault_label::key::UnavailableKeychain,
        )
        .await
        .expect("quick unlock on a migrated (NTV5) vault");

        let (items_key, items_key_id, shared) = fresh
            .peek_unlocked_attachment_material()
            .await
            .expect("unlocked");
        assert_eq!(
            shared
                .owner_root_bytes()
                .expect("an NTV5 session is root-tier")
                .as_slice(),
            &ROOT_KEY
        );
        assert_eq!(items_key.as_slice(), &ITEMS_KEY);
        assert_eq!(items_key_id, [0x07u8; 16]);
    }

    /// A quick-unlock of a PASSWORD-ONLY (`NTV8`) vault reaches the group tier
    /// and the same slot the password path would (myne-md/myne#938).
    ///
    /// This is the third generation to pass through this function, and the first
    /// two each broke it in the same place. `MYQ1` is generation-agnostic by
    /// design, so the `root_key` redeem always succeeds and the failure lands on
    /// the `itemsKey` step, which has to know the TIER: `NTV6` moved it to the
    /// group seal, `NTV7` was classified as "not `NTV6`" and AEAD-failed, and
    /// `NTV8` would repeat the second failure if the branch were still a magic
    /// test. The branch asks `has_b2b_tail`, and this test is what holds it:
    /// reverting that predicate to `magic == NTV6` makes every PIN and biometric
    /// attempt on a password-only vault fail while enrolment had succeeded.
    ///
    /// The fixture is a REAL frame from the app's own person-session builder, so
    /// the tail is the one creation actually writes rather than a hand-rolled
    /// shape that could agree with the reader by accident.
    #[test]
    fn quick_unlock_opens_a_password_only_vault_through_the_group_tier() {
        rt().block_on(quick_unlock_on_a_password_only_vault_inner())
    }
    async fn quick_unlock_on_a_password_only_vault_inner() {
        use crate::plugins::vault_creation::commands::{
            build_and_serialize_person_vault_meta, build_person_session,
        };
        use crate::plugins::vault_creation::state::CreationPerson;

        const PHRASE: &str = "abandon ability able about above absent absorb abstract absurd abuse access accident account accuse achieve acid acoustic acquire across act action actor actress actual";

        let tmp = ScopedTempDir::new("qu-ntv8").unwrap();
        let dir = tmp.path();
        let person_id = protocol::kdf::person_id_hash(PHRASE);
        let seed = protocol::kdf::derive_person_identity_seed(
            PHRASE,
            &person_id,
            &crate::test_support::FAST_TEST_KDF,
        )
        .expect("identity seed");
        let seeds = protocol::kdf::expand_person_identity_key_seeds(&seed);
        let person = CreationPerson {
            pair: protocol::PersonKeyPair::generate_raw(&seeds.kem, &seeds.ed25519, &seeds.mldsa),
            person_id,
            number: protocol::account_number_from_person_id(&person_id),
        };
        let session = build_person_session(
            crate::paths::vault_id_from_root(dir),
            "password-only-pw",
            crate::test_support::FAST_TEST_KDF,
            person,
        )
        .expect("person session");
        let (meta_bytes, group_key) =
            build_and_serialize_person_vault_meta(&session).expect("serialize NTV8");
        assert_eq!(&meta_bytes[..4], b"NTV8");
        std::fs::write(dir.join("vault.meta"), &meta_bytes).expect("write meta");

        // What the password path would reach, computed from the same frame, so
        // the assertion is on the VALUE and not on "unlock succeeded".
        let tail = protocol::parse_b2b_tail_any(&meta_bytes).expect("parse tail");
        let expected_items_key =
            protocol::unlock_items_key_ntv6(&tail, &protocol::GroupKey::new(*group_key))
                .expect("items key under the group tier");
        let expected_items_key_id = tail.base.items_key_id;

        // The enrolling session must hold the FRAME's keys, not the module's
        // `ROOT_KEY`/`ITEMS_KEY` literals: `MYQ1` seals whatever `root_key` the
        // slot holds, so seeding the fixture constants enrols a key that no
        // `NTV8` wrap opens and the redeem would fail for a reason that has
        // nothing to do with the generation under test.
        let setup_state = unlocked_state();
        setup_state
            .set_unlocked(
                crate::paths::vault_id_from_root(dir),
                UnlockedVault::owner(
                    session.root_key.clone(),
                    Some(group_key.clone()),
                    expected_items_key.clone(),
                    expected_items_key_id,
                    0,
                    [0u8; 32],
                ),
            )
            .await;
        let provider = MockProvider::new(PROVIDER_KIND_PIN, 0x11);
        setup_with_dir(dir, &setup_state, provider.clone(), &session.vault_binding)
            .await
            .expect("setup on a password-only vault");

        let fresh = unlocked_state();
        fresh.mark_full_unlock_done();
        quick_unlock_with_dir(
            dir,
            crate::paths::vault_id_from_root(dir),
            &fresh,
            provider.clone(),
            &crate::host::NoopHost,
            &test_hooks(),
            &test_io(),
            &crate::vault_label::key::UnavailableKeychain,
        )
        .await
        .expect("quick unlock on a password-only (NTV8) vault");

        let (items_key, items_key_id, shared) = fresh
            .peek_unlocked_attachment_material()
            .await
            .expect("unlocked");
        assert_eq!(items_key.as_slice(), expected_items_key.as_slice());
        assert_eq!(items_key_id, expected_items_key_id);
        // The group tier is what the running session must carry, since every
        // shared singleton is sealed under it in this generation.
        assert!(
            matches!(
                shared,
                crate::plugins::vault_unlock::state::SharedSingletonKey::Group(_)
            ),
            "an NTV8 session is group-tier and must carry the group key"
        );
        // `shared` carries the GROUP key in this generation, so the owner root
        // key is asserted on the slot itself: an `NTV8` session holds both, and
        // the one that decides the tier is the group key.
        assert!(shared.owner_root_bytes().is_none());
        assert_eq!(
            fresh
                .peek_unlocked_root_key_clone()
                .await
                .expect("root key")
                .as_slice(),
            session.root_key.as_slice()
        );
    }

    /// A PIN unlock does NOT perform the `NTV7` to `NTV8` upgrade, and this is the
    /// test that holds that (myne-md/myne#938 review, `protocol.md` §10.4.3).
    ///
    /// The upgrade drops the person wrap by TRUNCATION, and the person wrap is the
    /// only door left for a user who opened the vault with their identity phrase
    /// because they forgot the password. A six-digit PIN proves no password, so
    /// running the step here would delete that door on the strength of a code, for
    /// exactly the people least likely to notice. The upgrade waits for
    /// `UpgradeAuthority::PasswordProven`; the password path performs it, and that
    /// half is asserted in `vault_migrate::ntv8` and in `vault_unlock::commands`.
    #[test]
    fn a_pin_unlock_leaves_the_person_wrap_alone() {
        rt().block_on(async {
            use crate::plugins::vault_creation::commands::{
                build_and_serialize_person_vault_meta, build_person_session,
            };
            use crate::plugins::vault_creation::state::CreationPerson;

            const PHRASE: &str = "abandon ability able about above absent absorb abstract absurd abuse access accident account accuse achieve acid acoustic acquire across act action actor actress actual";

            let tmp = ScopedTempDir::new("qu-ntv7-upgrade").unwrap();
            let dir = tmp.path();
            let person_id = protocol::kdf::person_id_hash(PHRASE);
            let seed = protocol::kdf::derive_person_identity_seed(
                PHRASE,
                &person_id,
                &crate::test_support::FAST_TEST_KDF,
            )
            .expect("identity seed");
            let seeds = protocol::kdf::expand_person_identity_key_seeds(&seed);
            let person = CreationPerson {
                pair: protocol::PersonKeyPair::generate_raw(
                    &seeds.kem,
                    &seeds.ed25519,
                    &seeds.mldsa,
                ),
                person_id,
                number: protocol::account_number_from_person_id(&person_id),
            };
            let owner_public = person.pair.public_half();
            let session = build_person_session(
                crate::paths::vault_id_from_root(dir),
                "pin-upgrade-pw",
                crate::test_support::FAST_TEST_KDF,
                person,
            )
            .expect("person session");
            let (ntv8, group_key) =
                build_and_serialize_person_vault_meta(&session).expect("serialize NTV8");
            let parsed = protocol::parse_vault_meta_ntv8(&ntv8).expect("parse NTV8");
            // The frame a client that predates the upgrade wrote: the same tail
            // plus a real person wrap of the same root key.
            let mut rng = rand_core::UnwrapErr(crate::rng::OsRng);
            let person_wrap = protocol::seal_root_key_to_person_raw(
                &owner_public,
                &session.root_key,
                &parsed.base.items_key_id,
                &mut rng,
            )
            .expect("seal the person wrap");
            let ntv7 = protocol::serialize_vault_meta_ntv7(&protocol::PersonWrappedVaultMeta {
                base: parsed.base,
                group_key_nonce: parsed.group_key_nonce,
                enc_group_key: parsed.enc_group_key,
                group_key_epoch: parsed.group_key_epoch,
                signed_roster_envelope: parsed.signed_roster_envelope,
                person_wrap,
            })
            .expect("serialize NTV7");
            std::fs::write(dir.join("vault.meta"), &ntv7).expect("write NTV7");

            let tail = protocol::parse_b2b_tail_any(&ntv7).expect("parse tail");
            let items_key = protocol::unlock_items_key_ntv6(&tail, &protocol::GroupKey::new(*group_key))
                .expect("items key");

            let setup_state = unlocked_state();
            setup_state
                .set_unlocked(
                    crate::paths::vault_id_from_root(dir),
                    UnlockedVault::owner(
                        session.root_key.clone(),
                        Some(group_key.clone()),
                        items_key.clone(),
                        tail.base.items_key_id,
                        0,
                        [0u8; 32],
                    ),
                )
                .await;
            let provider = MockProvider::new(PROVIDER_KIND_PIN, 0x11);
            setup_with_dir(dir, &setup_state, provider.clone(), &session.vault_binding)
                .await
                .expect("setup on an NTV7 vault");

            let fresh = unlocked_state();
            fresh.mark_full_unlock_done();
            quick_unlock_with_dir(
                dir,
                crate::paths::vault_id_from_root(dir),
                &fresh,
                provider.clone(),
                &crate::host::NoopHost,
                &test_hooks(),
                &test_io(),
                &crate::vault_label::key::UnavailableKeychain,
            )
            .await
            .expect("quick unlock on an NTV7 vault");

            // The frame is UNTOUCHED, and that is the contract rather than a gap:
            // the upgrade truncates the person wrap, and a PIN proves no password.
            // Running it here would delete the only door left for a user who does
            // not remember their password, on the strength of a six-digit code
            // (myne-md/myne#938 review). The password path performs it, asserted in
            // `vault_migrate::ntv8` and in `vault_unlock::commands`' password case.
            let after = std::fs::read(dir.join("vault.meta")).expect("read meta");
            assert_eq!(
                &after[..4],
                b"NTV7",
                "a PIN unlock proves no password, so the person wrap must survive it"
            );
            assert_eq!(
                after, ntv7,
                "the frame must be byte-identical: no truncation, no rewrite"
            );
            // And the session is the one the PIN built, unchanged: same items key.
            let (redeemed_items, _id, _shared) = fresh
                .peek_unlocked_attachment_material()
                .await
                .expect("unlocked");
            assert_eq!(redeemed_items.as_slice(), items_key.as_slice());
        });
    }

    // ── myne#378: the credential path joins the single-in-flight discipline ──

    #[test]
    fn quick_unlock_rejects_when_the_auth_permit_is_held() {
        rt().block_on(async {
            let tmp = ScopedTempDir::new("qu-busy-redeem").unwrap();
            let dir = tmp.path();
            write_sealed_meta(dir);
            let setup_state = unlocked_state();
            seed_unlocked(&setup_state, dir).await;
            let good = MockProvider::new(PROVIDER_KIND_PIN, 0x11);
            setup_with_dir(dir, &setup_state, good.clone(), &ACCOUNT_HASH)
                .await
                .expect("setup");

            let fresh = unlocked_state();
            fresh.mark_full_unlock_done();
            // Another auth op holds the capacity-1 permit.
            let _held = fresh.auth_permits().acquire().await.unwrap();

            let err = quick_unlock_with_dir(
                dir,
                crate::paths::vault_id_from_root(dir),
                &fresh,
                good,
                &crate::host::NoopHost,
                &test_hooks(),
                &test_io(),
                &crate::vault_label::key::UnavailableKeychain,
            )
            .await
            .unwrap_err();

            assert_eq!(err, QuickUnlockError::VaultBusyAuth);
            // Not a credential failure: the credential survives and no attempt
            // was burned. That distinction is the whole reason the variant is
            // its own rather than folding into `Backend`.
            assert!(blob_path(dir).exists());
            assert_eq!(read_attempt_state(dir).count(), 0);
        })
    }

    /// The lost-update gate: an attempt that RUNS the credential is counted
    /// exactly once, and one that never reaches it is not counted at all.
    ///
    /// The defect was a read-modify-write straddling the KDF await — two
    /// redeems both read count 0, both ran ~1 s of Argon2id, and both persisted
    /// the same value — so five wrong PINs could cost one of the five allowed
    /// tries, which is what made §9.14.4's "code-enforced" bound weaker than a
    /// reader assumes.
    ///
    /// Expressed by HOLDING the permit rather than racing two live futures.
    /// `tokio::join!` needs tokio's `macros` feature, which would add a
    /// proc-macro crate to the graph for one test — and holding the permit is
    /// exactly the state a first redeem puts the second one in, so the property
    /// is the same and the test is deterministic rather than timing-shaped.
    #[test]
    fn every_rejected_credential_attempt_is_counted_once() {
        rt().block_on(async {
            let tmp = ScopedTempDir::new("qu-count-once").unwrap();
            let dir = tmp.path();
            write_sealed_meta(dir);
            let setup_state = unlocked_state();
            seed_unlocked(&setup_state, dir).await;
            setup_with_dir(
                dir,
                &setup_state,
                MockProvider::new(PROVIDER_KIND_PIN, 0x11),
                &ACCOUNT_HASH,
            )
            .await
            .expect("setup");

            let bad = MockProvider::new(PROVIDER_KIND_PIN, 0x22);
            let fresh = unlocked_state();
            fresh.mark_full_unlock_done();
            let id = crate::paths::vault_id_from_root(dir);
            let hooks = test_hooks();
            let io = test_io();
            let attempt = |provider: MockProvider| {
                quick_unlock_with_dir(
                    dir,
                    id,
                    &fresh,
                    provider,
                    &crate::host::NoopHost,
                    &hooks,
                    &io,
                    &crate::vault_label::key::UnavailableKeychain,
                )
            };

            // A redeem is in flight (its permit is held): the second one never
            // reaches the credential, so it must not touch the counter.
            let held = fresh.auth_permits().acquire().await.unwrap();
            assert_eq!(
                attempt(bad.clone()).await.unwrap_err(),
                QuickUnlockError::VaultBusyAuth
            );
            assert_eq!(read_attempt_state(dir).count(), 0);

            // Released: this one runs the credential, and advances the count by
            // exactly one.
            drop(held);
            assert_eq!(
                attempt(bad).await.unwrap_err(),
                QuickUnlockError::WrongCredential { remaining: 4 }
            );
            assert_eq!(read_attempt_state(dir).count(), 1);
        })
    }

    #[test]
    fn setup_rejects_when_the_auth_permit_is_held() {
        rt().block_on(async {
            let tmp = ScopedTempDir::new("qu-busy-setup").unwrap();
            let dir = tmp.path();
            write_sealed_meta(dir);
            let setup_state = unlocked_state();
            seed_unlocked(&setup_state, dir).await;
            let _held = setup_state.auth_permits().acquire().await.unwrap();

            let err = setup_with_dir(
                dir,
                &setup_state,
                MockProvider::new(PROVIDER_KIND_PIN, 0x11),
                &ACCOUNT_HASH,
            )
            .await
            .unwrap_err();

            assert_eq!(err, QuickUnlockError::VaultBusyAuth);
            // The point: no credential was written underneath a
            // `change_password` that is about to invalidate it.
            assert!(!blob_path(dir).exists());
        })
    }

    #[test]
    fn disable_rejects_when_the_auth_permit_is_held() {
        rt().block_on(async {
            let tmp = ScopedTempDir::new("qu-busy-disable").unwrap();
            let dir = tmp.path();
            write_sealed_meta(dir);
            let setup_state = unlocked_state();
            seed_unlocked(&setup_state, dir).await;
            setup_with_dir(
                dir,
                &setup_state,
                MockProvider::new(PROVIDER_KIND_PIN, 0x11),
                &ACCOUNT_HASH,
            )
            .await
            .expect("setup");

            let _held = setup_state.auth_permits().acquire().await.unwrap();
            assert_eq!(
                disable_with_dir(dir, &setup_state),
                Err(QuickUnlockError::VaultBusyAuth)
            );
            // Permit-before-precondition: the credential is untouched, and on a
            // vault with none the answer would be `VaultBusyAuth` rather than
            // `NotConfigured` — the same ordering `vault_delete` uses, and the
            // safer direction (never report "nothing to delete" while an
            // operation you cannot see is running).
            assert!(status_with_dir(dir).configured);
        })
    }

    #[test]
    fn wrong_credential_counts_then_wipes_at_the_cap() {
        rt().block_on(wrong_credential_counts_then_wipes_at_the_cap_inner())
    }
    async fn wrong_credential_counts_then_wipes_at_the_cap_inner() {
        let tmp = ScopedTempDir::new("qu-wrong").unwrap();
        let dir = tmp.path();
        write_sealed_meta(dir);

        let setup_state = unlocked_state();
        seed_unlocked(&setup_state, dir).await;
        let good = MockProvider::new(PROVIDER_KIND_PIN, 0x11);
        setup_with_dir(dir, &setup_state, good, &ACCOUNT_HASH)
            .await
            .expect("setup");

        // A provider returning a DIFFERENT wrap key → decode fails each time.
        let bad = MockProvider::new(PROVIDER_KIND_PIN, 0x22);
        let fresh = unlocked_state();
        fresh.mark_full_unlock_done();
        let vault_id = crate::paths::vault_id_from_root(dir);
        for expected_remaining in [4, 3, 2, 1] {
            let err = quick_unlock_with_dir(
                dir,
                vault_id,
                &fresh,
                bad.clone(),
                &crate::host::NoopHost,
                &test_hooks(),
                &test_io(),
                &crate::vault_label::key::UnavailableKeychain,
            )
            .await
            .unwrap_err();
            assert_eq!(
                err,
                QuickUnlockError::WrongCredential {
                    remaining: expected_remaining
                }
            );
        }
        // 5th failure wipes the credential.
        let err = quick_unlock_with_dir(
            dir,
            vault_id,
            &fresh,
            bad.clone(),
            &crate::host::NoopHost,
            &test_hooks(),
            &test_io(),
            &crate::vault_label::key::UnavailableKeychain,
        )
        .await
        .unwrap_err();
        assert_eq!(err, QuickUnlockError::AttemptsExhausted);
        assert!(!blob_path(dir).exists());
        assert!(!status_with_dir(dir).configured);
    }

    #[test]
    fn cancelled_prompt_does_not_burn_an_attempt() {
        rt().block_on(cancelled_prompt_does_not_burn_an_attempt_inner())
    }
    async fn cancelled_prompt_does_not_burn_an_attempt_inner() {
        let tmp = ScopedTempDir::new("qu-cancel").unwrap();
        let dir = tmp.path();
        write_sealed_meta(dir);
        let setup_state = unlocked_state();
        seed_unlocked(&setup_state, dir).await;
        setup_with_dir(
            dir,
            &setup_state,
            MockProvider::new(PROVIDER_KIND_BIOMETRIC, 0x11),
            &ACCOUNT_HASH,
        )
        .await
        .expect("setup");

        let cancelling =
            MockProvider::failing(PROVIDER_KIND_BIOMETRIC, ProviderError::UserCancelled);
        let fresh = unlocked_state();
        fresh.mark_full_unlock_done();
        let vault_id = crate::paths::vault_id_from_root(dir);
        // Cancel many times — never wipes, never counts.
        for _ in 0..10 {
            let err = quick_unlock_with_dir(
                dir,
                vault_id,
                &fresh,
                cancelling.clone(),
                &crate::host::NoopHost,
                &test_hooks(),
                &test_io(),
                &crate::vault_label::key::UnavailableKeychain,
            )
            .await
            .unwrap_err();
            assert_eq!(err, QuickUnlockError::Cancelled);
        }
        assert!(blob_path(dir).exists());
    }

    #[test]
    fn quick_unlock_when_not_configured_is_reported() {
        rt().block_on(quick_unlock_when_not_configured_is_reported_inner())
    }
    async fn quick_unlock_when_not_configured_is_reported_inner() {
        let tmp = ScopedTempDir::new("qu-absent").unwrap();
        let dir = tmp.path();
        write_sealed_meta(dir);
        let fresh = unlocked_state();
        fresh.mark_full_unlock_done();
        let vault_id = crate::paths::vault_id_from_root(dir);
        let provider = MockProvider::new(PROVIDER_KIND_PIN, 0x11);
        assert_eq!(
            quick_unlock_with_dir(
                dir,
                vault_id,
                &fresh,
                provider.clone(),
                &crate::host::NoopHost,
                &test_hooks(),
                &test_io(),
                &crate::vault_label::key::UnavailableKeychain,
            )
            .await
            .unwrap_err(),
            QuickUnlockError::NotConfigured
        );
        assert!(!status_with_dir(dir).configured);
    }

    #[test]
    fn disable_removes_the_credential() {
        rt().block_on(disable_removes_the_credential_inner())
    }
    async fn disable_removes_the_credential_inner() {
        let tmp = ScopedTempDir::new("qu-disable").unwrap();
        let dir = tmp.path();
        write_sealed_meta(dir);
        let setup_state = unlocked_state();
        seed_unlocked(&setup_state, dir).await;
        setup_with_dir(
            dir,
            &setup_state,
            MockProvider::new(PROVIDER_KIND_PIN, 0x11),
            &ACCOUNT_HASH,
        )
        .await
        .expect("setup");
        assert!(status_with_dir(dir).configured);

        disable_with_dir(dir, &setup_state).expect("disable");
        assert!(!status_with_dir(dir).configured);
        assert_eq!(
            disable_with_dir(dir, &setup_state),
            Err(QuickUnlockError::NotConfigured)
        );
    }

    #[test]
    fn status_available_gates_a_pin_on_the_session_but_not_biometric() {
        const PIN: Option<&str> = Some("pin");
        const BIO: Option<&str> = Some("biometric");

        // PIN, cold start: configured on disk but the session gate is closed →
        // the Unlock screen must hide the field (no `RequiresFullPassword` dead
        // end). Status mirrors the redeem-path gate.
        assert!(!compute_available(true, PIN, false));
        // PIN, after a full master-password unlock this session: an auto-lock
        // leaves the credential redeemable → the field shows.
        assert!(compute_available(true, PIN, true));

        // BIOMETRIC is available on a cold start (MYND-641). Its wrap key sits
        // behind the OS biometric gate, which survives a restart on its own —
        // and iOS evicts apps so aggressively that gating on the session made
        // Face ID unreachable in practice.
        assert!(compute_available(true, BIO, false));
        assert!(compute_available(true, BIO, true));

        // Never available when nothing is configured, whatever the method.
        assert!(!compute_available(false, PIN, true));
        assert!(!compute_available(false, BIO, false));
        assert!(!compute_available(false, None, false));
    }

    #[test]
    fn only_the_pin_provider_demands_a_full_unlock_first() {
        // The redeem-path twin of the assertions above — the two must agree, or
        // the Unlock screen offers a credential the redeem path then rejects.
        assert!(!requires_full_unlock_first(PROVIDER_KIND_BIOMETRIC));
        assert!(requires_full_unlock_first(PROVIDER_KIND_PIN));
        // An unknown kind fails CLOSED: anything that is not the biometric
        // provider keeps the gate.
        assert!(requires_full_unlock_first(0xFF));
    }

    #[test]
    fn quick_unlock_suppressed_until_full_unlock_this_session() {
        rt().block_on(quick_unlock_suppressed_until_full_unlock_this_session_inner())
    }
    async fn quick_unlock_suppressed_until_full_unlock_this_session_inner() {
        let tmp = ScopedTempDir::new("qu-springloaded").unwrap();
        let dir = tmp.path();
        write_sealed_meta(dir);
        let setup_state = unlocked_state();
        seed_unlocked(&setup_state, dir).await;
        let provider = MockProvider::new(PROVIDER_KIND_PIN, 0x11);
        setup_with_dir(dir, &setup_state, provider.clone(), &ACCOUNT_HASH)
            .await
            .expect("setup");

        // Fresh session (app restart): no full unlock yet → suppressed.
        let restarted = unlocked_state();
        let vault_id = crate::paths::vault_id_from_root(dir);
        assert_eq!(
            quick_unlock_with_dir(
                dir,
                vault_id,
                &restarted,
                provider.clone(),
                &crate::host::NoopHost,
                &test_hooks(),
                &test_io(),
                &crate::vault_label::key::UnavailableKeychain,
            )
            .await
            .unwrap_err(),
            QuickUnlockError::RequiresFullPassword
        );
        // The credential is NOT wiped by the gate (a restart must not destroy it).
        assert!(status_with_dir(dir).configured);

        // After one full-password unlock this session, quick-unlock works.
        restarted.mark_full_unlock_done();
        quick_unlock_with_dir(
            dir,
            vault_id,
            &restarted,
            provider.clone(),
            &crate::host::NoopHost,
            &test_hooks(),
            &test_io(),
            &crate::vault_label::key::UnavailableKeychain,
        )
        .await
        .expect("quick unlock after full unlock");
    }

    #[test]
    fn invalidate_credential_wipes_the_files() {
        rt().block_on(invalidate_credential_wipes_the_files_inner())
    }
    async fn invalidate_credential_wipes_the_files_inner() {
        let tmp = ScopedTempDir::new("qu-invalidate").unwrap();
        let dir = tmp.path();
        write_sealed_meta(dir);
        let setup_state = unlocked_state();
        seed_unlocked(&setup_state, dir).await;
        setup_with_dir(
            dir,
            &setup_state,
            MockProvider::new(PROVIDER_KIND_PIN, 0x11),
            &ACCOUNT_HASH,
        )
        .await
        .expect("setup");
        assert!(status_with_dir(dir).configured);

        // The password-change hook (task 8) calls this.
        invalidate_credential(dir);
        assert!(!status_with_dir(dir).configured);
        assert!(!attempt_path(dir).exists());
        // Idempotent on an already-clean vault.
        invalidate_credential(dir);
    }

    #[test]
    fn disable_reports_a_credential_file_that_survived_removal() {
        // Fail-closed. `wipe_files` used to be `-> ()` with a `let _ =` on both
        // removals, so `disable_with_dir` returned `Ok(())` — and the UI showed
        // "Quick unlock turned off" — while the credential blob was still on
        // disk and still unwrapped the live `root_key`. A non-empty DIRECTORY at
        // the blob path is the portable way to make `remove_file` fail without
        // touching permissions (macOS gives EPERM, Linux EISDIR).
        rt().block_on(async {
            let tmp = ScopedTempDir::new("qu-disable-wipe-fail").unwrap();
            let dir = tmp.path();
            write_sealed_meta(dir);
            let state = unlocked_state();
            seed_unlocked(&state, dir).await;

            // The blob path exists (so the `NotConfigured` precondition passes)
            // but cannot be unlinked.
            std::fs::create_dir_all(blob_path(dir).join("occupied")).unwrap();

            let err = disable_with_dir(dir, &state).expect_err("disable must fail closed");
            assert!(
                matches!(err, QuickUnlockError::WipeFailed { .. }),
                "expected WipeFailed, got {err:?}"
            );
            assert!(
                blob_path(dir).exists(),
                "the surviving credential is exactly what the error is about"
            );
        });
    }

    #[test]
    fn disable_succeeds_when_only_the_blob_was_written() {
        // The non-vacuity half of the test above: `NotFound` on the attempt file
        // is success, not a failure, so a vault whose attempt file was never
        // written still disables.
        rt().block_on(async {
            let tmp = ScopedTempDir::new("qu-disable-no-attempt").unwrap();
            let dir = tmp.path();
            write_sealed_meta(dir);
            let state = unlocked_state();
            seed_unlocked(&state, dir).await;
            setup_with_dir(
                dir,
                &state,
                MockProvider::new(PROVIDER_KIND_PIN, 0x11),
                &ACCOUNT_HASH,
            )
            .await
            .expect("setup");
            std::fs::remove_file(attempt_path(dir)).unwrap();

            disable_with_dir(dir, &state).expect("disable without an attempt file");
            assert!(!blob_path(dir).exists());
        });
    }

    #[test]
    fn setup_requires_unlocked_vault() {
        rt().block_on(setup_requires_unlocked_vault_inner())
    }
    async fn setup_requires_unlocked_vault_inner() {
        let tmp = ScopedTempDir::new("qu-locked").unwrap();
        let dir = tmp.path();
        write_sealed_meta(dir);
        // No seeded unlocked slot.
        let locked = unlocked_state();
        let provider = MockProvider::new(PROVIDER_KIND_PIN, 0x11);
        assert_eq!(
            setup_with_dir(dir, &locked, provider.clone(), &ACCOUNT_HASH)
                .await
                .unwrap_err(),
            QuickUnlockError::NotUnlocked
        );
    }
}
