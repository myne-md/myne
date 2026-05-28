//! `prefs` Tauri command handlers (MYND-160 Task 9).
//!
//! - [`prefs_read`] — Slot::Unlocked-gated read of the `vault.prefs`
//!   blob; fall-back-to-defaults on absent / AEAD-fail / parse-fail
//!   per `docs/spec/protocol.md` § 9.5.5.
//! - [`set_screen_capture_protection`] — per-field setter under a
//!   per-plugin `tokio::sync::Mutex` so concurrent setter calls
//!   commit FIFO; **critical ordering: disk write FIRST, native
//!   side-effect SECOND** so a disk failure leaves the UI / disk
//!   consistent (MYND-160 grill Q5.2).
//!
//! See: ../../CLAUDE.md "Secret-handling logging discipline".

use super::error::{PrefsReadError, PrefsWriteError};
use crate::plugins::vault_unlock::state::VaultRuntimeState;
use protocol::{
    decode_prefs_blob, derive_subkey, encode_prefs_blob, parse_vault_meta, PrefsBlobError,
    PrefsView, SubkeyRole, VAULT_META_ACCOUNT_HASH_LEN,
};
use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use tauri::{AppHandle, Manager, Runtime, State};
use tokio::sync::Mutex;

/// Per-plugin write serialization. `OnceLock<Mutex<()>>` is lazily
/// initialized on first `set_*` call; subsequent calls reuse the
/// same lock instance. Phase 1 single-window means the practical
/// risk of concurrent writers is low (the SettingsModal serializes
/// toggle interactions at the UI level), but the mutex is structural
/// preparation for v0.2 multi-window where two SettingsModals could
/// theoretically race. Future per-field setters (`set_theme`,
/// `set_font_size`, ...) share this same mutex so cross-field
/// concurrent writes also serialize.
fn write_mutex() -> &'static Mutex<()> {
    static M: OnceLock<Mutex<()>> = OnceLock::new();
    M.get_or_init(|| Mutex::new(()))
}

/// Resolve `<app_data_dir>/vault/` for the current Tauri app.
fn vault_dir<R: Runtime>(app: &AppHandle<R>) -> std::io::Result<PathBuf> {
    let base = app
        .path()
        .app_data_dir()
        .map_err(|_| std::io::Error::other("app_data_dir resolution failed"))?;
    let dir = base.join("vault");
    Ok(dir)
}

/// Read `vault.prefs` from disk and decode under `prefs_key` + AAD
/// bound to `account_number_hash`. Returns `PrefsView::default()` on
/// any failure (absent / truncated / AEAD-fail / parse-fail) per
/// spec § 9.5.5; logs the failure category via `tracing::warn!`
/// without leaking key material or path strings.
///
/// `pub(crate)` so the future Task 10 (vault_unlock pipeline
/// integration) can share the same read-or-default discipline at the
/// unlock-time step 5 call site.
pub(crate) fn read_or_default(
    prefs_path: &Path,
    prefs_key: &[u8; 32],
    account_number_hash: &[u8; VAULT_META_ACCOUNT_HASH_LEN],
) -> PrefsView {
    let bytes = match std::fs::read(prefs_path) {
        Ok(b) => b,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            // Absent file is the standard case for pre-MYND-160 vaults
            // and for the first read after vault_create (until Task 12
            // lands eager-write). Not a warn — this is the documented
            // happy path of spec § 9.5.5.
            return PrefsView::default();
        }
        Err(e) => {
            tracing::warn!(
                event = "prefs_io_failed",
                stage = "read",
                io_kind = ?crate::io_failure_kind::from_io_error_kind(e.kind()),
                "vault.prefs read failed; falling back to defaults"
            );
            return PrefsView::default();
        }
    };

    match decode_prefs_blob(prefs_key, account_number_hash, &bytes) {
        Ok(view) => view,
        Err(cause) => {
            tracing::warn!(
                event = "prefs_decrypt_failed",
                reason = prefs_blob_error_kind(&cause),
                "vault.prefs decode failed; falling back to defaults"
            );
            PrefsView::default()
        }
    }
}

/// Closed-enum mapping from `PrefsBlobError` to a static log tag.
///
/// `PrefsBlobError` already has a `Debug` impl that emits the variant
/// name (the variants are unit-like or carry no DENY-listed payload),
/// but using the static-string helper here keeps the secret-handling
/// logging discipline visible at the call site and provides a single
/// place to evolve the mapping if a future variant ever carries
/// path-like or key-like fields.
fn prefs_blob_error_kind(e: &PrefsBlobError) -> &'static str {
    match e {
        PrefsBlobError::HeaderTooShort => "header_too_short",
        PrefsBlobError::MagicMismatch => "magic_mismatch",
        PrefsBlobError::ProtocolVersionMismatch => "protocol_version_mismatch",
        PrefsBlobError::ReservedByteNonZero => "reserved_byte_non_zero",
        PrefsBlobError::CiphertextLenOverflow => "ciphertext_len_overflow",
        PrefsBlobError::CiphertextTruncated => "ciphertext_truncated",
        PrefsBlobError::CannotDecrypt => "aead_fail",
        PrefsBlobError::PlaintextParseFailed => "plaintext_parse_failed",
        PrefsBlobError::RandomnessUnavailable => "randomness_unavailable",
        _ => "other_prefs_blob_error",
    }
}

/// Read `vault.meta` from disk and return the `account_number_hash`
/// field (offset 6, 16 bytes). Used by both `prefs_read` and
/// `set_screen_capture_protection` to construct the AAD per spec
/// § 9.5.3 — `account_number_hash` is not cached in `Slot::Unlocked`
/// (Slot stays crypto-state-only per grill Q5.1), so each prefs IPC
/// re-reads. Cost is a single ~345-byte file read + parse; acceptable
/// for the lazy/rare prefs cadence.
fn read_account_number_hash(
    vault_meta_path: &Path,
) -> Result<[u8; VAULT_META_ACCOUNT_HASH_LEN], PrefsReadError> {
    let bytes = std::fs::read(vault_meta_path)?;
    let meta = parse_vault_meta(&bytes).map_err(|_| PrefsReadError::InvalidVaultMeta)?;
    Ok(meta.account_number_hash)
}

/// Read-side helper bridging `read_account_number_hash` into the
/// write-error type. Trivial wrapper — kept separate so the error
/// surface stays asymmetric (read fails differently than write) per
/// MYND-160 grill Q3.4 + Q6.3.
fn read_account_number_hash_for_write(
    vault_meta_path: &Path,
) -> Result<[u8; VAULT_META_ACCOUNT_HASH_LEN], PrefsWriteError> {
    let bytes = std::fs::read(vault_meta_path)?;
    let meta = parse_vault_meta(&bytes).map_err(|_| PrefsWriteError::InvalidVaultMeta)?;
    Ok(meta.account_number_hash)
}

/// Slot::Unlocked-gated read of the `vault.prefs` blob.
///
/// Returns `PrefsView::default()` on any prefs-blob failure (absent /
/// AEAD-fail / parse-fail) per spec § 9.5.5; only Slot precondition
/// failures and `vault.meta` IO failures surface as `PrefsReadError`.
/// The Tauri-command wrapper resolves `app_data_dir` then delegates
/// to [`prefs_read_with_dir`] so tests can exercise the core logic
/// against a `ScopedTempDir` without spinning up a Tauri runtime.
#[tauri::command]
pub async fn prefs_read<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, VaultRuntimeState>,
) -> Result<PrefsView, PrefsReadError> {
    let dir = vault_dir(&app).map_err(PrefsReadError::from)?;
    prefs_read_with_dir(&dir, state.inner()).await
}

/// Testable core of [`prefs_read`].
pub(crate) async fn prefs_read_with_dir(
    vault_dir: &Path,
    state: &VaultRuntimeState,
) -> Result<PrefsView, PrefsReadError> {
    // Peek root_key from the Unlocked slot (ignore the
    // vault_meta_bytes_hash — prefs has no CAS anchor against it).
    let (root_key, _vmh) = state
        .peek_unlocked_root_key_and_hash_clone()
        .await
        .ok_or(PrefsReadError::SlotNotUnlocked)?;

    let account_number_hash = read_account_number_hash(&vault_dir.join("vault.meta"))?;
    let prefs_key = derive_subkey(&root_key, SubkeyRole::PrefsKey);
    let prefs_path = vault_dir.join("vault.prefs");

    Ok(read_or_default(
        &prefs_path,
        &prefs_key,
        &account_number_hash,
    ))
}

/// Slot::Unlocked-gated per-field setter for the
/// `screen_capture_protection` toggle. Acquires the per-plugin write
/// mutex, executes a read-modify-write under it, then **after** the
/// disk write succeeds calls `screen_capture::apply` for the native
/// side-effect. **Disk-then-native ordering is load-bearing**: if
/// the disk write fails, the native state is unchanged so UI / disk
/// never silently diverge (MYND-160 grill Q5.2 — story 16).
#[tauri::command]
pub async fn set_screen_capture_protection<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, VaultRuntimeState>,
    enabled: bool,
) -> Result<(), PrefsWriteError> {
    let dir = vault_dir(&app).map_err(PrefsWriteError::from)?;
    // Disk-side commit FIRST, under the mutex.
    set_screen_capture_protection_with_dir(&dir, state.inner(), enabled).await?;
    // Native side-effect SECOND, only on disk-side success.
    crate::screen_capture::apply(&app, enabled, "runtime_apply");
    Ok(())
}

/// Testable core of [`set_screen_capture_protection`]. Performs the
/// disk-side commit (read-modify-write under the per-plugin mutex)
/// but NOT the native side-effect — tests assert the disk shape
/// without needing a `WebviewWindow`. Production callers MUST pair
/// this with `screen_capture::apply` per the critical ordering rule
/// captured in the Tauri-command wrapper above.
pub(crate) async fn set_screen_capture_protection_with_dir(
    vault_dir: &Path,
    state: &VaultRuntimeState,
    enabled: bool,
) -> Result<(), PrefsWriteError> {
    let _write_guard = write_mutex().lock().await;

    let (root_key, _vmh) = state
        .peek_unlocked_root_key_and_hash_clone()
        .await
        .ok_or(PrefsWriteError::SlotNotUnlocked)?;

    let account_number_hash = read_account_number_hash_for_write(&vault_dir.join("vault.meta"))?;
    let prefs_key = derive_subkey(&root_key, SubkeyRole::PrefsKey);
    let prefs_path = vault_dir.join("vault.prefs");

    let mut prefs = read_or_default(&prefs_path, &prefs_key, &account_number_hash);
    prefs.screen_capture_protection = enabled;

    let blob_bytes = encode_prefs_blob(&prefs_key, &account_number_hash, &prefs)
        .map_err(|_| PrefsWriteError::PrefsEncodeFailed)?;

    crate::atomic_write::atomic_write(&prefs_path, &blob_bytes, true)
        .map_err(PrefsWriteError::from)?;

    tracing::info!(
        event = "prefs_written",
        field = "screen_capture_protection",
        value = enabled,
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::plugins::vault_unlock::state::fixture_unlocked_with_keys;
    use crate::test_support::ScopedTempDir;
    use protocol::{encode_prefs_blob_raw, AEAD_NONCE_LEN};

    fn rt() -> tokio::runtime::Runtime {
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("current-thread runtime build")
    }

    // ---- helpers -------------------------------------------------------

    async fn make_temp_vault_with_unlocked_state(
        seed_account_hash: u8,
    ) -> (ScopedTempDir, VaultRuntimeState) {
        let tmp = ScopedTempDir::new("prefs-it").expect("scoped tempdir");
        seed_real_vault_meta(tmp.path(), seed_account_hash);
        let state = VaultRuntimeState::default();
        // root_key matches the fixture's deterministic key material.
        // fixture_unlocked_with_keys(seed_root, seed_items, salts_seed)
        // derives root_key from `seed_root` (filling [u8; 32] with the
        // seed byte). Match that here so test assertions can recompute
        // prefs_key off the same root_key.
        let unlocked = fixture_unlocked_with_keys(0x42, 0x99, 1);
        state.set_unlocked(unlocked).await;
        (tmp, state)
    }

    /// Build a real 345-byte vault.meta blob with `account_number_hash`
    /// filled by `seed_byte` repeating. Other fields are filler bytes —
    /// the prefs code only consumes account_number_hash, so the other
    /// fields just need to parse-pass.
    fn seed_real_vault_meta(dir: &Path, seed_byte: u8) {
        let meta = protocol::VaultMeta {
            account_number_hash: [seed_byte; VAULT_META_ACCOUNT_HASH_LEN],
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
        };
        std::fs::write(
            dir.join("vault.meta"),
            protocol::serialize_vault_meta(&meta),
        )
        .expect("seed vault.meta");
    }

    /// Compute the prefs_key the same way the production codec does,
    /// so encrypt-side test fixtures can seed a vault.prefs blob that
    /// the production decoder will accept.
    fn compute_prefs_key(seed_root: u8) -> [u8; 32] {
        let root_key = [seed_root; 32];
        let derived = derive_subkey(&root_key, SubkeyRole::PrefsKey);
        *derived
    }

    // ---- Slot precondition --------------------------------------------

    #[test]
    fn prefs_read_rejects_when_slot_empty() {
        rt().block_on(async {
            let tmp = ScopedTempDir::new("prefs-empty").expect("scoped tempdir");
            let state = VaultRuntimeState::default();
            let result = prefs_read_with_dir(tmp.path(), &state).await;
            assert!(matches!(result, Err(PrefsReadError::SlotNotUnlocked)));
        });
    }

    #[test]
    fn set_screen_capture_protection_rejects_when_slot_empty() {
        rt().block_on(async {
            let tmp = ScopedTempDir::new("prefs-write-empty").expect("scoped tempdir");
            let state = VaultRuntimeState::default();
            let result = set_screen_capture_protection_with_dir(tmp.path(), &state, false).await;
            assert!(matches!(result, Err(PrefsWriteError::SlotNotUnlocked)));
        });
    }

    // ---- read fall-back-to-defaults (§ 9.5.5) -------------------------

    #[test]
    fn prefs_read_returns_default_when_vault_prefs_absent() {
        rt().block_on(async {
            let (tmp, state) = make_temp_vault_with_unlocked_state(0x33).await;
            // vault.meta is seeded, vault.prefs is absent.
            let view = prefs_read_with_dir(tmp.path(), &state)
                .await
                .expect("absent vault.prefs collapses to defaults");
            assert_eq!(view, PrefsView::default());
            assert!(
                view.screen_capture_protection,
                "default state has protection on per spec § 9.5.5"
            );
        });
    }

    #[test]
    fn prefs_read_returns_default_when_vault_prefs_tampered() {
        rt().block_on(async {
            let (tmp, state) = make_temp_vault_with_unlocked_state(0x33).await;
            // Seed a valid encrypted vault.prefs, then flip a byte.
            let prefs_key = compute_prefs_key(0x42);
            let account_hash = [0x33u8; VAULT_META_ACCOUNT_HASH_LEN];
            let mut blob = encode_prefs_blob_raw(
                &prefs_key,
                &account_hash,
                &PrefsView {
                    screen_capture_protection: false,
                },
                &[0x77; AEAD_NONCE_LEN],
            )
            .expect("encode");
            blob[40] ^= 0xFF;
            std::fs::write(tmp.path().join("vault.prefs"), &blob).expect("seed tampered prefs");

            let view = prefs_read_with_dir(tmp.path(), &state)
                .await
                .expect("tampered vault.prefs collapses to defaults");
            assert_eq!(view, PrefsView::default());
        });
    }

    // ---- round-trip via the plugin's own write+read --------------------

    #[test]
    fn round_trip_via_set_then_read() {
        rt().block_on(async {
            let (tmp, state) = make_temp_vault_with_unlocked_state(0x33).await;

            // Toggle off via the plugin.
            set_screen_capture_protection_with_dir(tmp.path(), &state, false)
                .await
                .expect("write must succeed");

            // Disk file now exists.
            assert!(
                tmp.path().join("vault.prefs").exists(),
                "set_screen_capture_protection must create vault.prefs"
            );

            // Read back via the plugin.
            let view = prefs_read_with_dir(tmp.path(), &state)
                .await
                .expect("read must succeed after write");
            assert!(
                !view.screen_capture_protection,
                "toggled-off value must round-trip"
            );

            // Toggle back on.
            set_screen_capture_protection_with_dir(tmp.path(), &state, true)
                .await
                .expect("second write must succeed");
            let view = prefs_read_with_dir(tmp.path(), &state)
                .await
                .expect("read must succeed after second write");
            assert!(
                view.screen_capture_protection,
                "toggled-on value must round-trip"
            );
        });
    }

    // ---- vault.meta IO failure surfaces ------------------------------

    #[test]
    fn prefs_read_surfaces_io_error_when_vault_meta_missing() {
        rt().block_on(async {
            let tmp = ScopedTempDir::new("prefs-no-meta").expect("scoped tempdir");
            let state = VaultRuntimeState::default();
            // Don't seed vault.meta — just set slot to unlocked.
            state
                .set_unlocked(fixture_unlocked_with_keys(0x42, 0x99, 1))
                .await;
            let result = prefs_read_with_dir(tmp.path(), &state).await;
            // vault.meta absent → Io error (NOT collapsed to defaults
            // like vault.prefs absent — vault.meta is structural).
            assert!(matches!(result, Err(PrefsReadError::Io { .. })));
        });
    }

    // ---- closed-enum helper -------------------------------------------

    #[test]
    fn prefs_blob_error_kind_maps_aead_fail_to_static_label() {
        assert_eq!(
            prefs_blob_error_kind(&PrefsBlobError::CannotDecrypt),
            "aead_fail"
        );
    }

    #[test]
    fn prefs_blob_error_kind_maps_magic_mismatch_to_static_label() {
        assert_eq!(
            prefs_blob_error_kind(&PrefsBlobError::MagicMismatch),
            "magic_mismatch"
        );
    }
}
