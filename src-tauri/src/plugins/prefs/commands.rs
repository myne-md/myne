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
    decode_prefs_blob, derive_subkey, encode_prefs_blob, parse_vault_meta, EditorLayout,
    PrefsBlobError, PrefsView, SubkeyRole, VAULT_META_ACCOUNT_HASH_LEN,
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

/// Slot::Unlocked-gated setter for the `deliberate_folders` set
/// (MYND-144 — the carrier for empty / deliberately-created folders in
/// the virtual-folder model). Read-modify-write under the per-plugin
/// write mutex. **No native side-effect** (unlike
/// `set_screen_capture_protection`) — purely a disk commit, so the
/// disk-then-native ordering rule does not apply here. The caller passes
/// the full desired set; v0.1 single-device writes it verbatim
/// (union + add-wins is a Phase 2 sync-merge concern, not a v0.1
/// write-API concern). Folded-identity dedup is the caller's job; the
/// codec only sorts + exact-dedups for canonical byte-stability.
#[tauri::command]
pub async fn set_deliberate_folders<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, VaultRuntimeState>,
    folders: Vec<String>,
) -> Result<(), PrefsWriteError> {
    let dir = vault_dir(&app).map_err(PrefsWriteError::from)?;
    set_deliberate_folders_with_dir(&dir, state.inner(), folders).await
}

/// Testable core of [`set_deliberate_folders`].
pub(crate) async fn set_deliberate_folders_with_dir(
    vault_dir: &Path,
    state: &VaultRuntimeState,
    folders: Vec<String>,
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
    let count = folders.len();
    prefs.deliberate_folders = folders;

    let blob_bytes = encode_prefs_blob(&prefs_key, &account_number_hash, &prefs)
        .map_err(|_| PrefsWriteError::PrefsEncodeFailed)?;

    crate::atomic_write::atomic_write(&prefs_path, &blob_bytes, true)
        .map_err(PrefsWriteError::from)?;

    // Folder COUNT only — never the paths (folder structure is AS3
    // Sensitive; see ../../CLAUDE.md "Secret-handling logging discipline").
    tracing::info!(event = "prefs_written", field = "deliberate_folders", count,);
    Ok(())
}

/// Slot::Unlocked-gated setter for the `note_order` sequence — the manual
/// sidebar sort order for notes (an ordered list of note UUIDs). Read-
/// modify-write under the per-plugin write mutex; **no native side-effect**
/// (same shape as `set_deliberate_folders`). The caller passes the full
/// desired sequence; v0.1 single-device writes it verbatim. Unlike
/// `deliberate_folders`, the codec preserves element order — the sequence
/// IS the payload (`protocol::PrefsView::note_order`).
#[tauri::command]
pub async fn set_note_order<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, VaultRuntimeState>,
    order: Vec<String>,
) -> Result<(), PrefsWriteError> {
    let dir = vault_dir(&app).map_err(PrefsWriteError::from)?;
    set_note_order_with_dir(&dir, state.inner(), order).await
}

/// Testable core of [`set_note_order`].
pub(crate) async fn set_note_order_with_dir(
    vault_dir: &Path,
    state: &VaultRuntimeState,
    order: Vec<String>,
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
    let count = order.len();
    prefs.note_order = order;

    let blob_bytes = encode_prefs_blob(&prefs_key, &account_number_hash, &prefs)
        .map_err(|_| PrefsWriteError::PrefsEncodeFailed)?;

    crate::atomic_write::atomic_write(&prefs_path, &blob_bytes, true)
        .map_err(PrefsWriteError::from)?;

    // COUNT only — never the note IDs (note_id is a per-note vault-stable
    // correlation tag; see ../../CLAUDE.md "Secret-handling logging discipline").
    tracing::info!(event = "prefs_written", field = "note_order", count,);
    Ok(())
}

/// Slot::Unlocked-gated setter for the `folder_order` sequence — the manual
/// sidebar sort order for folders (an ordered list of canonical folder
/// display paths). Identical read-modify-write + order-preserving + no-
/// native-side-effect shape as [`set_note_order`], applied to the folder
/// ordering field.
#[tauri::command]
pub async fn set_folder_order<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, VaultRuntimeState>,
    order: Vec<String>,
) -> Result<(), PrefsWriteError> {
    let dir = vault_dir(&app).map_err(PrefsWriteError::from)?;
    set_folder_order_with_dir(&dir, state.inner(), order).await
}

/// Testable core of [`set_folder_order`].
pub(crate) async fn set_folder_order_with_dir(
    vault_dir: &Path,
    state: &VaultRuntimeState,
    order: Vec<String>,
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
    let count = order.len();
    prefs.folder_order = order;

    let blob_bytes = encode_prefs_blob(&prefs_key, &account_number_hash, &prefs)
        .map_err(|_| PrefsWriteError::PrefsEncodeFailed)?;

    crate::atomic_write::atomic_write(&prefs_path, &blob_bytes, true)
        .map_err(PrefsWriteError::from)?;

    // COUNT only — never the folder paths (folder structure is AS3 Sensitive;
    // see ../../CLAUDE.md "Secret-handling logging discipline").
    tracing::info!(event = "prefs_written", field = "folder_order", count,);
    Ok(())
}

/// Slot::Unlocked-gated setter for the `auto_lock_seconds` field (MYND-121).
/// Read-modify-write under the per-plugin write mutex. Getter is the existing
/// [`prefs_read`] (the returned `PrefsView` already carries `auto_lock_seconds`).
#[tauri::command]
pub async fn set_auto_lock_timeout<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, VaultRuntimeState>,
    seconds: u32,
) -> Result<(), PrefsWriteError> {
    let dir = vault_dir(&app).map_err(PrefsWriteError::from)?;
    set_auto_lock_timeout_with_dir(&dir, state.inner(), seconds).await
}

/// Testable core of [`set_auto_lock_timeout`]. Persists `auto_lock_seconds`
/// to `vault.prefs` (disk commit FIRST), then refreshes the idle timer's
/// cached effective timeout (the "effect"; window-free, so it lives in the
/// core rather than the wrapper — unlike `set_screen_capture_protection`
/// whose native effect needs a `WebviewWindow`). The disk-FIRST-then-effect
/// ordering still holds: a disk-write failure returns before the cache update.
///
/// The RAW user value is stored on disk; the protective-envelope clamp
/// (MYND-121 task 3) is applied only to the in-memory cache + at read time,
/// so a replayed `vault.prefs` can still only make auto-lock stricter
/// (`threat-model.md` §7 two-class taxonomy).
pub(crate) async fn set_auto_lock_timeout_with_dir(
    vault_dir: &Path,
    state: &VaultRuntimeState,
    seconds: u32,
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
    prefs.auto_lock_seconds = Some(seconds);

    let blob_bytes = encode_prefs_blob(&prefs_key, &account_number_hash, &prefs)
        .map_err(|_| PrefsWriteError::PrefsEncodeFailed)?;

    // Disk commit FIRST.
    crate::atomic_write::atomic_write(&prefs_path, &blob_bytes, true)
        .map_err(PrefsWriteError::from)?;

    // Effect SECOND (only on disk success): refresh the cached effective
    // timeout the running idle timer reads, clamped through the envelope so
    // a live change can never exceed the ceiling.
    state.set_auto_lock_timeout_secs(crate::auto_lock::effective_auto_lock_secs(Some(seconds)));

    tracing::info!(
        event = "prefs_written",
        field = "auto_lock_seconds",
        value = seconds,
    );
    Ok(())
}

/// Slot::Unlocked-gated setter for the `editor_layout` field (MYND-137) —
/// the editor three-pane sidebar widths + collapsed flags. Read-modify-write
/// under the per-plugin write mutex; **no native side-effect** (same shape as
/// `set_note_order`). The caller passes the full desired layout; v0.1
/// single-device writes it verbatim. The codec persists the RAW client value;
/// the min/max clamp + collapse policy live in the UI layer (a replayed /
/// tampered `vault.prefs` is re-clamped on the client at read time), so this
/// command only persists the choice.
#[tauri::command]
pub async fn set_editor_layout<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, VaultRuntimeState>,
    layout: EditorLayout,
) -> Result<(), PrefsWriteError> {
    let dir = vault_dir(&app).map_err(PrefsWriteError::from)?;
    set_editor_layout_with_dir(&dir, state.inner(), layout).await
}

/// Testable core of [`set_editor_layout`].
pub(crate) async fn set_editor_layout_with_dir(
    vault_dir: &Path,
    state: &VaultRuntimeState,
    layout: EditorLayout,
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
    let (left_collapsed, right_collapsed) = (layout.left_collapsed, layout.right_collapsed);
    prefs.editor_layout = Some(layout);

    let blob_bytes = encode_prefs_blob(&prefs_key, &account_number_hash, &prefs)
        .map_err(|_| PrefsWriteError::PrefsEncodeFailed)?;

    crate::atomic_write::atomic_write(&prefs_path, &blob_bytes, true)
        .map_err(PrefsWriteError::from)?;

    // Collapsed flags only — window-layout metadata (AS3-low), never note
    // content; widths are equally benign but omitted to keep the line minimal.
    tracing::info!(
        event = "prefs_written",
        field = "editor_layout",
        left_collapsed,
        right_collapsed,
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
                    deliberate_folders: Vec::new(),
                    auto_lock_seconds: None,
                    note_order: Vec::new(),
                    folder_order: Vec::new(),
                    editor_layout: None,
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

    // ---- editor_layout setter (MYND-137) ------------------------------

    #[test]
    fn set_editor_layout_rejects_when_slot_empty() {
        rt().block_on(async {
            let tmp = ScopedTempDir::new("prefs-layout-empty").expect("scoped tempdir");
            let state = VaultRuntimeState::default();
            let result = set_editor_layout_with_dir(
                tmp.path(),
                &state,
                EditorLayout {
                    left_width: 260,
                    right_width: 280,
                    left_collapsed: false,
                    right_collapsed: false,
                },
            )
            .await;
            assert!(matches!(result, Err(PrefsWriteError::SlotNotUnlocked)));
        });
    }

    #[test]
    fn editor_layout_round_trips_via_set_then_read() {
        rt().block_on(async {
            let (tmp, state) = make_temp_vault_with_unlocked_state(0x33).await;

            let layout = EditorLayout {
                left_width: 312,
                right_width: 248,
                left_collapsed: false,
                right_collapsed: true,
            };
            set_editor_layout_with_dir(tmp.path(), &state, layout)
                .await
                .expect("write must succeed");

            assert!(
                tmp.path().join("vault.prefs").exists(),
                "set_editor_layout must create vault.prefs"
            );

            let view = prefs_read_with_dir(tmp.path(), &state)
                .await
                .expect("read must succeed after write");
            assert_eq!(
                view.editor_layout,
                Some(layout),
                "editor_layout value must round-trip through disk"
            );

            // A second write overwrites (last-write-wins on the whole object).
            let layout2 = EditorLayout {
                left_width: 200,
                right_width: 460,
                left_collapsed: true,
                right_collapsed: false,
            };
            set_editor_layout_with_dir(tmp.path(), &state, layout2)
                .await
                .expect("second write must succeed");
            let view = prefs_read_with_dir(tmp.path(), &state)
                .await
                .expect("read must succeed after second write");
            assert_eq!(view.editor_layout, Some(layout2));
        });
    }

    // ---- deliberate_folders setter (MYND-144) -------------------------

    #[test]
    fn set_deliberate_folders_rejects_when_slot_empty() {
        rt().block_on(async {
            let tmp = ScopedTempDir::new("prefs-folders-empty").expect("scoped tempdir");
            let state = VaultRuntimeState::default();
            let result =
                set_deliberate_folders_with_dir(tmp.path(), &state, alloc_vec(["Projects/"])).await;
            assert!(matches!(result, Err(PrefsWriteError::SlotNotUnlocked)));
        });
    }

    // ---- auto_lock_seconds setter (MYND-121) --------------------------

    #[test]
    fn set_auto_lock_timeout_rejects_when_slot_empty() {
        rt().block_on(async {
            let tmp = ScopedTempDir::new("prefs-autolock-empty").expect("scoped tempdir");
            let state = VaultRuntimeState::default();
            let result = set_auto_lock_timeout_with_dir(tmp.path(), &state, 300).await;
            assert!(matches!(result, Err(PrefsWriteError::SlotNotUnlocked)));
        });
    }

    #[test]
    fn auto_lock_timeout_round_trips_and_caches_effective() {
        rt().block_on(async {
            let (tmp, state) = make_temp_vault_with_unlocked_state(0x33).await;

            set_auto_lock_timeout_with_dir(tmp.path(), &state, 900)
                .await
                .expect("write must succeed");

            // Disk: prefs_read returns the raw stored value.
            let view = prefs_read_with_dir(tmp.path(), &state)
                .await
                .expect("read must succeed after write");
            assert_eq!(view.auto_lock_seconds, Some(900));

            // Effect: the cached effective timeout the idle timer reads is
            // updated (900 is in-range → unchanged by the clamp).
            assert_eq!(state.auto_lock_timeout_secs(), 900);
        });
    }

    #[test]
    fn set_auto_lock_timeout_stores_raw_but_caches_clamped() {
        rt().block_on(async {
            let (tmp, state) = make_temp_vault_with_unlocked_state(0x33).await;

            // A huge value is stored RAW on disk (replay-resistance lives in
            // the read-time clamp, not the write)...
            set_auto_lock_timeout_with_dir(tmp.path(), &state, u32::MAX)
                .await
                .expect("write must succeed");
            let view = prefs_read_with_dir(tmp.path(), &state)
                .await
                .expect("read must succeed");
            assert_eq!(view.auto_lock_seconds, Some(u32::MAX));

            // ...but the cached effective timeout is clamped to the ceiling.
            assert_eq!(
                state.auto_lock_timeout_secs(),
                crate::auto_lock::AUTO_LOCK_CEILING_SECS
            );
        });
    }

    #[test]
    fn deliberate_folders_round_trip_via_set_then_read() {
        rt().block_on(async {
            let (tmp, state) = make_temp_vault_with_unlocked_state(0x33).await;

            set_deliberate_folders_with_dir(
                tmp.path(),
                &state,
                alloc_vec(["Projects/Myne/", "Archive/2025/"]),
            )
            .await
            .expect("write must succeed");

            let view = prefs_read_with_dir(tmp.path(), &state)
                .await
                .expect("read must succeed after write");
            // Canonical sort applies at encode → read-back is sorted.
            assert_eq!(
                view.deliberate_folders,
                alloc_vec(["Archive/2025/", "Projects/Myne/"]),
            );
            // screen_capture_protection untouched (defaults on).
            assert!(view.screen_capture_protection);

            // Empty set round-trips (and re-encodes byte-identical to v0.1.0).
            set_deliberate_folders_with_dir(tmp.path(), &state, Vec::new())
                .await
                .expect("clear must succeed");
            let cleared = prefs_read_with_dir(tmp.path(), &state)
                .await
                .expect("read after clear");
            assert!(cleared.deliberate_folders.is_empty());
        });
    }

    // ---- note_order / folder_order setters (reorder) ------------------

    #[test]
    fn set_note_order_rejects_when_slot_empty() {
        rt().block_on(async {
            let tmp = ScopedTempDir::new("prefs-note-order-empty").expect("scoped tempdir");
            let state = VaultRuntimeState::default();
            let result = set_note_order_with_dir(tmp.path(), &state, alloc_vec(["a", "b"])).await;
            assert!(matches!(result, Err(PrefsWriteError::SlotNotUnlocked)));
        });
    }

    #[test]
    fn note_and_folder_order_round_trip_preserving_sequence() {
        rt().block_on(async {
            let (tmp, state) = make_temp_vault_with_unlocked_state(0x33).await;

            // note_order is a sequence — element order is the payload, so it
            // round-trips VERBATIM (not sorted, unlike deliberate_folders).
            set_note_order_with_dir(tmp.path(), &state, alloc_vec(["n-zzz", "n-aaa", "n-mmm"]))
                .await
                .expect("write note_order");
            set_folder_order_with_dir(tmp.path(), &state, alloc_vec(["Zebra/", "Apple/"]))
                .await
                .expect("write folder_order");

            let view = prefs_read_with_dir(tmp.path(), &state)
                .await
                .expect("read after order writes");
            assert_eq!(view.note_order, alloc_vec(["n-zzz", "n-aaa", "n-mmm"]));
            assert_eq!(view.folder_order, alloc_vec(["Zebra/", "Apple/"]));
            // The pre-existing screen_capture default is untouched.
            assert!(view.screen_capture_protection);

            // Clearing note_order round-trips back to empty; folder_order is
            // an independent field and stays set.
            set_note_order_with_dir(tmp.path(), &state, Vec::new())
                .await
                .expect("clear note_order");
            let cleared = prefs_read_with_dir(tmp.path(), &state)
                .await
                .expect("read after clear");
            assert!(cleared.note_order.is_empty());
            assert_eq!(cleared.folder_order, alloc_vec(["Zebra/", "Apple/"]));
        });
    }

    fn alloc_vec(items: impl IntoIterator<Item = &'static str>) -> Vec<String> {
        items.into_iter().map(String::from).collect()
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
