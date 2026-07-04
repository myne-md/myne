// SPDX-License-Identifier: AGPL-3.0
//! Quick-unlock plugin commands (MYND-329, task 6).
//!
//! Extracted into `myne-core` (shared desktop↔mobile). This module carries the
//! platform-agnostic PIN path + the OS-free `*_with_dir` cores; the macOS
//! biometric provider and its command branch stay in the desktop crate and
//! layer over these `pub` cores. Mobile registers only the PIN commands.
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
//! See: ../../CLAUDE.md "Secret-handling logging discipline" — `root_key`,
//! `items_key`, `wrap_key`, and the PIN are never logged.

use std::path::{Path, PathBuf};
use std::time::Instant;

use protocol::quick_unlock_blob::{
    decode_quick_unlock_blob, encode_quick_unlock_blob, parse_quick_unlock_header,
    PROVIDER_KIND_BIOMETRIC, PROVIDER_KIND_PIN,
};
use protocol::{derive_items_key, parse_vault_meta, VaultMeta};
use serde::Serialize;
use tauri::{AppHandle, Runtime, State};
use zeroize::Zeroizing;

use super::attempt::{
    encode_attempt_count, parse_attempt_count, AttemptOutcome, AttemptState,
    MAX_QUICK_UNLOCK_ATTEMPTS,
};
use super::error::QuickUnlockError;
use super::pin::{validate_pin, PinProvider, PinValidationError};
use super::provider::QuickUnlockProvider;
use crate::io_failure_kind::from_io_error_kind;
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
    let meta = parse_vault_meta(&bytes).map_err(|_| QuickUnlockError::InvalidVaultMeta)?;
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

/// Remove the device-local credential files. The OS-side credential deletion
/// (keychain item, for the biometric provider) is the caller's job — the
/// failure path holds a `provider` and calls `provider.delete()`; the explicit
/// `disable` path builds the matching provider (task 7 for biometric).
pub fn wipe_files(dir: &Path) {
    let _ = std::fs::remove_file(blob_path(dir));
    let _ = std::fs::remove_file(attempt_path(dir));
}

/// Cross-plugin invalidation hook (MYND-329 task 8): wipe the device-local
/// quick-unlock credential for the vault at `dir`. Called when a security event
/// should reset quick-unlock — currently a **master-password change** (a
/// deliberate defense-in-depth policy: a password change signals "reset my
/// access", so the fast second credential is cleared even though `root_key` is
/// unchanged by the rotation — User Story 8). A best-effort no-op when nothing
/// is configured. Vault deletion needs no call here — `vault_delete`'s recursive
/// unlink already removes these files (User Story 12). The biometric provider's
/// keychain item, if any, is orphaned (harmless — unlock reads the blob first,
/// so its absence already forces the password path).
///
/// OS-free: this core only unlinks the device-local files. The desktop crate
/// wraps this with its macOS-keychain cleanup (`cleanup_os_credential`) so a
/// biometric credential's OS-side item is also removed; mobile (PIN-only) uses
/// this directly.
pub fn invalidate_credential(dir: &Path) {
    wipe_files(dir);
}

/// Configure quick-unlock for the (currently Unlocked) vault: wrap `root_key`
/// under a fresh provider wrap key into `vault.quickunlock`.
pub async fn setup_with_dir<P: QuickUnlockProvider + Send + 'static>(
    dir: &Path,
    state: &VaultRuntimeState,
    provider: P,
    account_number_hash: &[u8; 16],
) -> Result<(), QuickUnlockError> {
    let root_key = state
        .peek_unlocked_root_key_clone()
        .await
        .ok_or(QuickUnlockError::NotUnlocked)?;

    // `provider.create()` runs the PIN provider's Argon2id (256 MiB, ~1s) —
    // offload it to a blocking thread so a heavy KDF never parks an async
    // runtime worker (the `vault_unlock` spawn_blocking discipline).
    let kind = provider.kind();
    let secret = tokio::task::spawn_blocking(move || provider.create())
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

/// Whether quick-unlock can be redeemed right now: a credential exists AND the
/// spring-loaded session gate is open. Mirrors the `quick_unlock_with_dir` gate
/// (a cold start has no full unlock yet, so quick-unlock is suppressed) so the
/// Unlock screen never offers a PIN that would immediately fail
/// `RequiresFullPassword`.
fn compute_available(configured: bool, full_unlock_this_session: bool) -> bool {
    configured && full_unlock_this_session
}

/// Disable quick-unlock: remove the device-local files. (Biometric keychain
/// removal is wired in task 7 via the matching provider's `delete`.)
pub fn disable_with_dir(dir: &Path) -> Result<(), QuickUnlockError> {
    if !blob_path(dir).exists() {
        return Err(QuickUnlockError::NotConfigured);
    }
    wipe_files(dir);
    Ok(())
}

/// Attempt a quick-unlock: recover `root_key` via the provider and install the
/// Unlocked slot, or count the failure (and wipe at the cap).
pub async fn quick_unlock_with_dir<P: QuickUnlockProvider + Send + 'static>(
    dir: &Path,
    vault_id: VaultId,
    state: &VaultRuntimeState,
    provider: P,
) -> Result<(), QuickUnlockError> {
    // Spring-loaded gate (task 9): quick-unlock is permitted only after a full
    // master-password unlock has happened THIS session. A fresh process (app
    // restart) has not, so this forces one full-password unlock first — the
    // 1Password "restarting won't keep it unlocked" model. Checked before any
    // disk read so a restart never even consults the credential.
    if !state.has_full_unlock_this_session() {
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
            wipe_files(dir);
            return Err(QuickUnlockError::NotConfigured);
        }
    };

    // Counter check BEFORE spending a provider call: a corrupt/over-cap counter
    // wipes immediately (fail safe).
    let mut attempts = read_attempt_state(dir);
    if attempts.must_wipe() {
        let _ = provider.delete();
        wipe_files(dir);
        return Err(QuickUnlockError::AttemptsExhausted);
    }

    // Retrieve the wrap key. A cancelled prompt / unavailable hardware is NOT a
    // failed credential attempt — it does not burn the counter. The PIN
    // provider's Argon2id (256 MiB, ~1s) runs on a blocking thread so it never
    // parks an async runtime worker; the provider is handed back so the
    // failure path below can still call `delete()`.
    let pin_salt = header.pin_salt;
    let (provider, retrieve_result) = tokio::task::spawn_blocking(move || {
        let r = provider.retrieve(&pin_salt);
        (provider, r)
    })
    .await
    .map_err(|_| QuickUnlockError::Backend)?;
    let wrap_key = retrieve_result?;

    let (meta_bytes, meta) = read_meta(dir)?;

    match decode_quick_unlock_blob(&wrap_key, &meta.account_number_hash, &blob) {
        Ok(root_key) => {
            let items_key = derive_items_key(&root_key, &meta)
                .map_err(|_| QuickUnlockError::InvalidVaultMeta)?;
            let vault_meta_bytes_hash = crate::vault_meta_hash::vault_meta_sha256(&meta_bytes);
            state
                .set_unlocked_locking_others(
                    vault_id,
                    UnlockedVault {
                        root_key,
                        items_key,
                        items_key_id: meta.items_key_id,
                        unlocked_at: Instant::now(),
                        vault_meta_bytes_hash,
                    },
                )
                .await;
            // Success resets the consecutive-failure count. The vault is already
            // unlocked (slot installed above), so a failure to persist the reset
            // must NOT surface as an unlock failure — best-effort; a stale counter
            // only fails safe (fewer future attempts) and recovers on next success.
            attempts.record_success();
            if let Err(_e) = persist_attempt_state(dir, &attempts) {
                tracing::debug!(
                    stage = "persist_attempt_reset",
                    "quick-unlock succeeded; attempt-reset not persisted"
                );
            }
            Ok(())
        }
        Err(_) => match attempts.record_failure() {
            AttemptOutcome::Wipe => {
                let _ = provider.delete();
                wipe_files(dir);
                Err(QuickUnlockError::AttemptsExhausted)
            }
            AttemptOutcome::Allowed { remaining } => {
                persist_attempt_state(dir, &attempts)?;
                Err(QuickUnlockError::WrongCredential { remaining })
            }
        },
    }
}

// ---- Tauri command wrappers (PIN path; biometric branch lands in task 7) ----

fn map_pin_validation(e: PinValidationError) -> QuickUnlockError {
    match e {
        PinValidationError::TooShort => QuickUnlockError::PinTooShort,
        PinValidationError::NonDigit => QuickUnlockError::PinNotDigits,
    }
}

pub async fn active_dir<R: Runtime>(
    app: &AppHandle<R>,
    state: &VaultRuntimeState,
) -> Result<PathBuf, QuickUnlockError> {
    crate::paths::active_vault_root_io(app, state.active_vault_id().await)
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
pub async fn target_dir<R: Runtime>(
    app: &AppHandle<R>,
    state: &VaultRuntimeState,
    vault_id: Option<&str>,
) -> Result<PathBuf, QuickUnlockError> {
    match VaultId::parse_optional(vault_id) {
        Some(id) => {
            crate::paths::vault_root_for_id(app, id).map_err(|_| QuickUnlockError::InvalidVaultMeta)
        }
        None => active_dir(app, state).await,
    }
}

/// Configure PIN quick-unlock for the active (Unlocked) vault.
#[tauri::command]
pub async fn quick_unlock_setup_pin<R: Runtime>(
    pin: String,
    app: AppHandle<R>,
    state: State<'_, VaultRuntimeState>,
) -> Result<(), QuickUnlockError> {
    let pin = Zeroizing::new(pin);
    validate_pin(&pin).map_err(map_pin_validation)?;
    let dir = active_dir(&app, &state).await?;
    let (_, meta) = read_meta(&dir)?;
    let provider = PinProvider::new(pin, meta.account_number_hash, meta.kdf_params);
    setup_with_dir(&dir, &state, provider, &meta.account_number_hash).await
}

/// Attempt a PIN quick-unlock of the active vault.
#[tauri::command]
pub async fn quick_unlock_with_pin<R: Runtime>(
    pin: String,
    vault_id: Option<String>,
    app: AppHandle<R>,
    state: State<'_, VaultRuntimeState>,
) -> Result<(), QuickUnlockError> {
    let pin = Zeroizing::new(pin);
    let dir = target_dir(&app, &state, vault_id.as_deref()).await?;
    let (_, meta) = read_meta(&dir)?;
    let id = crate::paths::vault_id_from_root(&dir);
    let provider = PinProvider::new(pin, meta.account_number_hash, meta.kdf_params);
    quick_unlock_with_dir(&dir, id, &state, provider).await
}

/// Report quick-unlock status for the active vault.
#[tauri::command]
pub async fn quick_unlock_status<R: Runtime>(
    vault_id: Option<String>,
    app: AppHandle<R>,
    state: State<'_, VaultRuntimeState>,
) -> Result<QuickUnlockStatus, QuickUnlockError> {
    let dir = target_dir(&app, &state, vault_id.as_deref()).await?;
    let mut status = status_with_dir(&dir);
    // Layer the spring-loaded session gate on: a cold start (no full unlock yet)
    // reports `available: false` so the Unlock screen hides the PIN field rather
    // than offer a credential that `quick_unlock_with_dir` would immediately
    // reject with `RequiresFullPassword`.
    status.available = compute_available(status.configured, state.has_full_unlock_this_session());
    Ok(status)
}

/// Disable quick-unlock for the active vault.
#[tauri::command]
pub async fn quick_unlock_disable<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, VaultRuntimeState>,
) -> Result<(), QuickUnlockError> {
    // OS-free disable: unlink the device-local files. The desktop crate's
    // `quick_unlock_disable` additionally cleans the macOS keychain item.
    let dir = active_dir(&app, &state).await?;
    disable_with_dir(&dir)
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
        };
        std::fs::write(dir.join("vault.meta"), serialize_vault_meta(&meta)).expect("write meta");
    }

    fn unlocked_state() -> VaultRuntimeState {
        VaultRuntimeState::default()
    }

    async fn seed_unlocked(state: &VaultRuntimeState, dir: &Path) {
        let vault_id = crate::paths::vault_id_from_root(dir);
        state
            .set_unlocked(
                vault_id,
                UnlockedVault {
                    root_key: Zeroizing::new(ROOT_KEY),
                    items_key: Zeroizing::new(ITEMS_KEY),
                    items_key_id: [0x07u8; 16],
                    unlocked_at: Instant::now(),
                    vault_meta_bytes_hash: [0u8; 32],
                },
            )
            .await;
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
        quick_unlock_with_dir(dir, vault_id, &fresh, provider.clone())
            .await
            .expect("quick unlock");
        // The slot is now Unlocked and carries the round-tripped items_key.
        let material = fresh
            .peek_unlocked_root_key_clone()
            .await
            .expect("unlocked");
        assert_eq!(material.as_slice(), &ROOT_KEY);
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
            let err = quick_unlock_with_dir(dir, vault_id, &fresh, bad.clone())
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
        let err = quick_unlock_with_dir(dir, vault_id, &fresh, bad.clone())
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
            let err = quick_unlock_with_dir(dir, vault_id, &fresh, cancelling.clone())
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
            quick_unlock_with_dir(dir, vault_id, &fresh, provider.clone())
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

        disable_with_dir(dir).expect("disable");
        assert!(!status_with_dir(dir).configured);
        assert_eq!(disable_with_dir(dir), Err(QuickUnlockError::NotConfigured));
    }

    #[test]
    fn status_available_requires_both_configured_and_open_gate() {
        // Cold start: configured on disk but the session gate is closed → the
        // Unlock screen must hide the PIN field (no `RequiresFullPassword` dead
        // end). This is the bug fix: status now mirrors the redeem-path gate.
        assert!(!compute_available(true, false));
        // After a full master-password unlock this session, an auto-lock leaves
        // the credential redeemable → the PIN field shows.
        assert!(compute_available(true, true));
        // Never available when nothing is configured.
        assert!(!compute_available(false, true));
        assert!(!compute_available(false, false));
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
            quick_unlock_with_dir(dir, vault_id, &restarted, provider.clone())
                .await
                .unwrap_err(),
            QuickUnlockError::RequiresFullPassword
        );
        // The credential is NOT wiped by the gate (a restart must not destroy it).
        assert!(status_with_dir(dir).configured);

        // After one full-password unlock this session, quick-unlock works.
        restarted.mark_full_unlock_done();
        quick_unlock_with_dir(dir, vault_id, &restarted, provider.clone())
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
