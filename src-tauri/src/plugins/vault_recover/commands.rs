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
use crate::io_failure_kind::{from_io_error_kind, IoFailureKind};
use protocol::{VaultMeta, AEAD_KEY_LEN, AEAD_NONCE_LEN, ARGON2_SALT_LEN};
use std::path::{Path, PathBuf};
use std::time::Instant;
use tauri::{AppHandle, Manager, Runtime, State};
use zeroize::Zeroizing;

/// Map a `protocol::ProtocolError` variant to a `'static` string for
/// structured logging. A new variant compile-fails this match —
/// drift-detecting per `src-tauri/CLAUDE.md` "Closed-enum mapping rule".
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

/// Resolve `<app_data_dir>/vault/vault.meta`. Local rather than imported
/// from `vault_unlock` because the return type is `VaultRecoveryError`.
fn vault_meta_path<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf, VaultRecoveryError> {
    let base = app
        .path()
        .app_data_dir()
        .map_err(|_| VaultRecoveryError::IoError {
            io_error_kind: IoFailureKind::Other,
        })?;
    Ok(base.join("vault").join("vault.meta"))
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
#[tauri::command]
pub async fn recover_with_phrase<R: Runtime>(
    phrase: String,
    state: State<'_, VaultRuntimeState>,
    app: AppHandle<R>,
) -> Result<(), VaultRecoveryError> {
    let vault_path = vault_meta_path(&app)?;
    recover_with_phrase_with_path(phrase, &vault_path, state.inner()).await
}

/// Testable core of [`recover_with_phrase`]. The Tauri-command wrapper
/// resolves the platform-specific `vault.meta` path and delegates here
/// so tests do not need an [`AppHandle`].
///
/// All decisions documented on [`recover_with_phrase`] apply identically.
pub(crate) async fn recover_with_phrase_with_path(
    phrase: String,
    vault_path: &Path,
    state: &VaultRuntimeState,
) -> Result<(), VaultRecoveryError> {
    // Wrap immediately so any early-return path (VaultAlreadyUnlocked,
    // RecoveryAlreadyInProgress, RecoveryInProgress, IO failure, parse
    // failure) drops the wrapper and zeroes the bytes. Plain `String`
    // would drop without zeroize.
    let phrase = Zeroizing::new(phrase);

    let started = Instant::now();

    // (1) Slot peek precedes permit acquire so the cheap occupied-slot
    //     guards never block on the semaphore. The two non-Empty
    //     variants surface as distinct guard variants so the frontend
    //     can route correctly: `Unlocked` → editor, `Recovering` →
    //     password-reset form (per `recovery-flow.md` §4.1's
    //     non-dismissible chained step).
    match state.slot_kind().await {
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

    // Own the path so it can move into spawn_blocking (the closure
    // captures by-value). Cheap one-allocation clone.
    let vault_path = vault_path.to_path_buf();

    let join_outcome =
        tokio::task::spawn_blocking(move || -> Result<DerivedKeys, VaultRecoveryError> {
            // IO + parse + NFKD + KDF + AEAD all run inside the
            // blocking task: this frees the runtime worker across
            // the whole pipeline (Windows / cold-disk / antivirus
            // latency doesn't stall the async runtime).
            let bytes = std::fs::read(&vault_path).map_err(|e| {
                if e.kind() == std::io::ErrorKind::NotFound {
                    tracing::error!(
                        stage = "read_meta",
                        error_kind = "VaultNotFound",
                        "vault.meta does not exist (recovery flow unreachable without a vault)"
                    );
                    VaultRecoveryError::VaultNotFound
                } else {
                    let io_kind = from_io_error_kind(e.kind());
                    tracing::error!(
                        stage = "read_meta",
                        error_kind = "IoError",
                        io_failure_kind = ?io_kind,
                        "vault.meta read failed"
                    );
                    VaultRecoveryError::IoError {
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
                VaultRecoveryError::InvalidVaultMeta
            })?;

            let items_key_id = meta.items_key_id;
            let root_key = derive_root_key_from_phrase(&phrase, &meta)?;
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

    let now = Instant::now();
    state
        .set_recovering(RecoveringMaterial {
            root_key,
            items_key,
            items_key_id,
            recovered_at: now,
        })
        .await;

    // Success event. Coarse `duration_ms` only — no account
    // identifier, no path, no key material. Per ALLOW-list in
    // `src-tauri/CLAUDE.md` "Secret-handling logging discipline".
    tracing::info!(
        event = "vault_recovered_with_phrase",
        duration_ms = now.duration_since(started).as_millis() as u64,
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
#[tauri::command]
pub async fn complete_recovery<R: Runtime>(
    new_password: String,
    state: State<'_, VaultRuntimeState>,
    app: AppHandle<R>,
) -> Result<(), VaultRecoveryError> {
    let vault_path = vault_meta_path(&app)?;
    complete_recovery_with_path(new_password, &vault_path, state.inner()).await
}

/// Testable core of [`complete_recovery`]. The Tauri-command wrapper
/// resolves the platform-specific `vault.meta` path and delegates here
/// so tests do not need an [`AppHandle`].
///
/// All decisions documented on [`complete_recovery`] apply identically.
pub(crate) async fn complete_recovery_with_path(
    new_password: String,
    vault_path: &Path,
    state: &VaultRuntimeState,
) -> Result<(), VaultRecoveryError> {
    // Wrap immediately so any early-return path drops the wrapper and
    // zeroes the bytes.
    let new_password = Zeroizing::new(new_password);
    let started = Instant::now();

    // (1) Slot peek — must be Recovering.
    match state.slot_kind().await {
        SlotKind::Recovering => {}
        SlotKind::Empty | SlotKind::Unlocked => {
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

    // (3) Take the recovering material — slot becomes Empty here.
    //     If a race occurred (e.g. concurrent vault_lock between peek
    //     and take), surface as VaultRecoveryRequiresActiveSession.
    let recovering = match state.take_recovering().await {
        Some(m) => m,
        None => {
            tracing::error!(
                stage = "take_recovering",
                error_kind = "VaultRecoveryRequiresActiveSession",
                "complete_recovery race: slot was Recovering at peek but Empty at take"
            );
            return Err(VaultRecoveryError::VaultRecoveryRequiresActiveSession);
        }
    };

    let vault_path = vault_path.to_path_buf();

    // (4) Run the password-commit pipeline in spawn_blocking. Returns
    //     the recovering material (passed through) on success so the
    //     post-join code can promote it into Slot::Unlocked.
    let join_outcome =
        tokio::task::spawn_blocking(move || -> Result<RecoveringMaterial, VaultRecoveryError> {
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

            // (b) Read existing vault.meta.
            let bytes = std::fs::read(&vault_path).map_err(|e| {
                if e.kind() == std::io::ErrorKind::NotFound {
                    tracing::error!(
                        stage = "read_meta",
                        error_kind = "VaultNotFound",
                        "vault.meta vanished mid-recovery"
                    );
                    VaultRecoveryError::VaultNotFound
                } else {
                    let io_kind = from_io_error_kind(e.kind());
                    tracing::error!(
                        stage = "read_meta",
                        error_kind = "IoError",
                        io_failure_kind = ?io_kind,
                        "vault.meta read failed during complete_recovery"
                    );
                    VaultRecoveryError::IoError {
                        io_error_kind: io_kind,
                    }
                }
            })?;

            // (c) Parse.
            let parsed = protocol::parse_vault_meta(&bytes).map_err(|e| {
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
            let new_bytes = protocol::rewrite_vault_meta_password_side(
                &parsed,
                &recovering.root_key,
                new_password.as_str(),
                &fresh_salt,
                &fresh_nonce,
            )
            .map_err(|e| {
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

            // (e) Atomic write — tempfile + fsync + rename per §4.2.
            //     A failure here leaves vault.meta on disk with the
            //     original password still in effect; the user can
            //     re-attempt recovery.
            crate::atomic_write::atomic_write(&vault_path, &new_bytes).map_err(|e| {
                let io_kind = from_io_error_kind(e.kind());
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

            Ok(recovering)
        })
        .await;

    let recovering = match join_outcome {
        Ok(Ok(m)) => m,
        Ok(Err(inner)) => return Err(inner),
        Err(_) => {
            tracing::error!(
                stage = "spawn_blocking_join",
                error_kind = "JoinFailure",
                "blocking task join failed during complete_recovery"
            );
            return Err(VaultRecoveryError::JoinFailure);
        }
    };

    // (5) Promote Slot::Recovering material → Slot::Unlocked.
    let now = Instant::now();
    state
        .set_unlocked(UnlockedVault {
            root_key: recovering.root_key,
            items_key: recovering.items_key,
            items_key_id: recovering.items_key_id,
            unlocked_at: now,
        })
        .await;

    // Success event. Coarse `duration_ms` only — no account
    // identifier, no path, no key material. Per ALLOW-list in
    // `src-tauri/CLAUDE.md` "Secret-handling logging discipline".
    tracing::info!(
        event = "vault_recovery_completed",
        duration_ms = now.duration_since(started).as_millis() as u64,
        "post-recovery password commit succeeded; slot is Unlocked"
    );

    Ok(())
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
fn derive_root_key_from_phrase(
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
    let wrap_key = protocol::derive_recovery_wrap_key_from_normalized(
        normalized.as_str(),
        &meta.random_salt_recovery,
        &meta.account_number_hash,
        &meta.kdf_params,
    )
    .map_err(|e| {
        tracing::error!(
            stage = "phrase_kdf",
            protocol_error_kind = protocol_error_kind(&e),
            "recovery wrap-key derivation failed"
        );
        phrase_or_meta(e)
    })?;

    let aad = protocol::aad_recovery_wrap(&meta.kdf_params);
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
fn derive_items_key(
    root_key: &[u8; AEAD_KEY_LEN],
    meta: &VaultMeta,
) -> Result<Zeroizing<[u8; AEAD_KEY_LEN]>, VaultRecoveryError> {
    let items_wrap_key = protocol::derive_subkey(root_key, protocol::SubkeyRole::ItemsKeyWrap);
    let aad = protocol::aad_items_key_wrap(&meta.items_key_id);
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
        fixture_recovering_with_keys, fixture_unlocked_with_keys, Slot,
    };
    use crate::test_support::{ScratchVault, FAST_TEST_KDF};

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
        let session = build_session(password, FAST_TEST_KDF).expect("build_session");
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
            recover_with_phrase_with_path(phrase, scratch.path(), &state)
                .await
                .expect("recover with correct phrase");

            // Slot is now Recovering; both keys derived eagerly.
            let taken = state.take().await;
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
            let result =
                recover_with_phrase_with_path(wrong_phrase.to_string(), scratch.path(), &state)
                    .await;
            assert!(matches!(
                result,
                Err(VaultRecoveryError::InvalidCredentialOrVault)
            ));
            assert_eq!(state.slot_kind().await, SlotKind::Empty);
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
            recover_with_phrase_with_path(mutated, scratch.path(), &state)
                .await
                .expect("NFKD-normalized phrase must recover successfully");

            let taken = state.take().await;
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
                scratch.path(),
                &state,
            )
            .await;
            assert!(matches!(result, Err(VaultRecoveryError::VaultNotFound)));
            assert_eq!(state.slot_kind().await, SlotKind::Empty);
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
            let result = recover_with_phrase_with_path(phrase, scratch.path(), &state).await;
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
            assert_eq!(state.slot_kind().await, SlotKind::Empty);
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
            let result = recover_with_phrase_with_path(phrase, scratch.path(), &state).await;
            assert!(matches!(result, Err(VaultRecoveryError::InvalidVaultMeta)));
            assert_eq!(state.slot_kind().await, SlotKind::Empty);
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
            let result = recover_with_phrase_with_path(phrase, scratch.path(), &state).await;
            assert!(matches!(result, Err(VaultRecoveryError::InvalidVaultMeta)));
            assert_eq!(state.slot_kind().await, SlotKind::Empty);
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
                .set_unlocked(fixture_unlocked_with_keys(0x42, 0x13, 0x99))
                .await;

            let result = recover_with_phrase_with_path(phrase, scratch.path(), &state).await;
            assert!(matches!(
                result,
                Err(VaultRecoveryError::VaultAlreadyUnlocked)
            ));

            // Existing Unlocked slot is untouched.
            let taken = state.take().await;
            match taken {
                Slot::Unlocked(uv) => {
                    assert_eq!(*uv.root_key, [0x42u8; AEAD_KEY_LEN]);
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
                .set_recovering(fixture_recovering_with_keys(0xAA, 0xBB, 0xCC))
                .await;

            let result = recover_with_phrase_with_path(phrase, scratch.path(), &state).await;
            assert!(matches!(
                result,
                Err(VaultRecoveryError::RecoveryAlreadyInProgress)
            ));

            // Existing Recovering slot is untouched.
            assert_eq!(state.slot_kind().await, SlotKind::Recovering);
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
            assert_eq!(state.slot_kind().await, SlotKind::Empty);

            let held_permit = state
                .auth_permits()
                .try_acquire()
                .expect("first acquire on fresh state");
            assert_eq!(state.auth_permits().available_permits(), 0);

            let result =
                recover_with_phrase_with_path(phrase.clone(), scratch.path(), &state).await;
            assert!(matches!(
                result,
                Err(VaultRecoveryError::RecoveryInProgress)
            ));
            assert_eq!(state.slot_kind().await, SlotKind::Empty);

            drop(held_permit);
            assert_eq!(state.auth_permits().available_permits(), 1);

            recover_with_phrase_with_path(phrase, scratch.path(), &state)
                .await
                .expect("retry after permit released succeeds");
            assert_eq!(state.slot_kind().await, SlotKind::Recovering);
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
                .set_unlocked(fixture_unlocked_with_keys(0x42, 0x13, 0x99))
                .await;

            let _held_permit = state
                .auth_permits()
                .try_acquire()
                .expect("first acquire on fresh state");
            assert_eq!(state.auth_permits().available_permits(), 0);

            let result = recover_with_phrase_with_path(phrase, scratch.path(), &state).await;
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
            let r1 =
                recover_with_phrase_with_path(wrong_phrase.to_string(), scratch.path(), &state)
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
            recover_with_phrase_with_path(correct_phrase, scratch.path(), &state)
                .await
                .expect("retry after wrong-phrase failure works");
            assert_eq!(state.slot_kind().await, SlotKind::Recovering);
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
        recover_with_phrase_with_path(phrase.clone(), scratch.path(), &state)
            .await
            .expect("seed: A8d must succeed against the seeded vault");
        assert_eq!(state.slot_kind().await, SlotKind::Recovering);

        (state, scratch, password.to_string(), phrase, meta_bytes)
    }

    #[test]
    fn complete_recovery_round_trip_promotes_recovering_to_unlocked() {
        rt().block_on(async {
            let (state, scratch, _orig_pw, _phrase, _orig_bytes) =
                seed_recovering_state_via_full_a8d("orig-pw").await;

            complete_recovery_with_path("new-pw".to_string(), scratch.path(), &state)
                .await
                .expect("A8f must succeed when slot is Recovering");

            assert_eq!(state.slot_kind().await, SlotKind::Unlocked);
            // Permit released after success.
            assert_eq!(state.auth_permits().available_permits(), 1);
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

            complete_recovery_with_path("new-pw".to_string(), scratch.path(), &state)
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
    fn complete_recovery_old_password_no_longer_unlocks() {
        // After A8f commits "new-pw", `vault_unlock("orig-pw")` MUST
        // return `InvalidCredentialOrVault` — the new password fully
        // replaces the old. This is the central security property of
        // the recovery flow ("forgot password" → "vault recovered" →
        // "old credential is dead").
        use super::super::super::vault_unlock::commands::unlock_with_path;
        use super::super::super::vault_unlock::error::VaultUnlockError;
        rt().block_on(async {
            let (state, scratch, orig_pw, _phrase, _orig_bytes) =
                seed_recovering_state_via_full_a8d("orig-pw").await;

            complete_recovery_with_path("new-pw".to_string(), scratch.path(), &state)
                .await
                .expect("A8f");

            // Lock to clear Slot::Unlocked; otherwise unlock_with_path
            // rejects with VaultAlreadyUnlocked before reaching the
            // password-verification stage.
            let _ = state.take().await;
            assert_eq!(state.slot_kind().await, SlotKind::Empty);

            // Try the original password — must fail.
            let result = unlock_with_path(orig_pw, scratch.path(), &state).await;
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

            complete_recovery_with_path("new-pw".to_string(), scratch.path(), &state)
                .await
                .expect("A8f");

            let _ = state.take().await;
            unlock_with_path("new-pw".to_string(), scratch.path(), &state)
                .await
                .expect("new password must unlock the rewritten vault.meta");
            assert_eq!(state.slot_kind().await, SlotKind::Unlocked);
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

            complete_recovery_with_path("new-pw".to_string(), scratch.path(), &state)
                .await
                .expect("A8f");

            // Lock to clear Slot::Unlocked, then re-recover with the
            // original phrase.
            let _ = state.take().await;
            recover_with_phrase_with_path(phrase, scratch.path(), &state)
                .await
                .expect("phrase must still recover after A8f");
            assert_eq!(state.slot_kind().await, SlotKind::Recovering);
        });
    }

    #[test]
    fn complete_recovery_rejects_when_slot_is_empty() {
        rt().block_on(async {
            let scratch = scratch_vault();
            let (bytes, _, _) = seed_vault_meta("orig-pw");
            scratch.write_meta(&bytes);

            let state = VaultRuntimeState::default();
            assert_eq!(state.slot_kind().await, SlotKind::Empty);

            let result =
                complete_recovery_with_path("new-pw".to_string(), scratch.path(), &state).await;
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
                .set_unlocked(fixture_unlocked_with_keys(0xAB, 0xCD, 0xEF))
                .await;

            let result =
                complete_recovery_with_path("new-pw".to_string(), scratch.path(), &state).await;
            assert!(matches!(
                result,
                Err(VaultRecoveryError::VaultRecoveryRequiresActiveSession)
            ));

            // Existing Unlocked slot is untouched.
            assert_eq!(state.slot_kind().await, SlotKind::Unlocked);
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

            let result =
                complete_recovery_with_path("new-pw".to_string(), scratch.path(), &state).await;
            assert!(matches!(
                result,
                Err(VaultRecoveryError::RecoveryInProgress)
            ));
            // Slot is still Recovering (not consumed by the rejected
            // attempt).
            assert_eq!(state.slot_kind().await, SlotKind::Recovering);
        });
    }

    #[test]
    fn complete_recovery_filesystem_failure_leaves_vault_meta_unchanged() {
        // Simulate a filesystem write failure by removing the parent
        // directory between `seed_recovering_state_via_full_a8d` (which
        // populates vault.meta on disk) and `complete_recovery`. The
        // atomic_write step will fail; A8f must surface IoError and
        // leave the slot Empty (recovering material drops + zeroizes).
        // The original vault.meta is also gone in this exotic scenario,
        // but the test's load-bearing assertion is "no half-state
        // survives the failure".
        rt().block_on(async {
            let (state, scratch, _orig_pw, _phrase, _orig_bytes) =
                seed_recovering_state_via_full_a8d("orig-pw").await;

            // Remove the parent dir to force atomic_write to fail.
            std::fs::remove_dir_all(&scratch.dir).expect("remove parent dir");

            let result =
                complete_recovery_with_path("new-pw".to_string(), scratch.path(), &state).await;
            // Either IoError (read_meta / atomic_write failed) or
            // VaultNotFound (vault.meta was removed alongside the dir).
            assert!(
                matches!(
                    result,
                    Err(VaultRecoveryError::IoError { .. } | VaultRecoveryError::VaultNotFound)
                ),
                "expected IoError or VaultNotFound, got {result:?}"
            );

            // Slot is Empty regardless — the recovering material was
            // taken before spawn_blocking and dropped on the failure
            // path. No half-state survived.
            assert_eq!(state.slot_kind().await, SlotKind::Empty);
            // Permit released by RAII drop.
            assert_eq!(state.auth_permits().available_permits(), 1);
        });
    }
}
