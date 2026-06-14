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
    PrefsBlobError, PrefsView, SubkeyRole, ThemeChoice, VAULT_META_ACCOUNT_HASH_LEN,
};
use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use tauri::{AppHandle, Runtime, State};
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

/// Resolve the ACTIVE (sole-`Unlocked`) vault's root. `active_id` is read from
/// the runtime state by the calling command (`state.active_vault_id().await`) —
/// the only place with `.await` access to the slot map. SYNC-6: prefs always
/// operate on the unlocked vault, so resolving via the active id (not the
/// transitional sole-vault disk heuristic) is what keeps `vault.prefs` reads +
/// the label write targeting the correct vault once two or more exist.
fn vault_dir<R: Runtime>(
    app: &AppHandle<R>,
    active_id: Option<crate::vault_id::VaultId>,
) -> std::io::Result<PathBuf> {
    crate::paths::active_vault_root_io(app, active_id)
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
    let dir = vault_dir(&app, state.active_vault_id().await).map_err(PrefsReadError::from)?;
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

/// Internal (non-IPC) setter: record the last successful backup export
/// (MYND-58; spec §9.5.2 `last_backup_at` — drives the 30-day backup
/// reminder). Same write discipline as every IPC setter (per-plugin write
/// mutex + SYNC-6 hold guard). Best-effort at the call site: a failed
/// prefs write never demotes a verified export.
pub(crate) async fn record_last_backup_at_with_dir(
    vault_dir: &Path,
    state: &VaultRuntimeState,
    epoch_seconds: u64,
) -> Result<(), PrefsWriteError> {
    let _write_guard = write_mutex().lock().await;

    // SYNC-6 writer-guard (MYND-32): see state::hold_unlocked_root_key_and_hash.
    let (_slots_guard, root_key, _vmh) = state
        .hold_unlocked_root_key_and_hash()
        .await
        .ok_or(PrefsWriteError::SlotNotUnlocked)?;

    let account_number_hash = read_account_number_hash_for_write(&vault_dir.join("vault.meta"))?;
    let prefs_key = derive_subkey(&root_key, SubkeyRole::PrefsKey);
    let prefs_path = vault_dir.join("vault.prefs");

    let mut prefs = read_or_default(&prefs_path, &prefs_key, &account_number_hash);
    prefs.last_backup_at = Some(epoch_seconds);

    let blob_bytes = encode_prefs_blob(&prefs_key, &account_number_hash, &prefs)
        .map_err(|_| PrefsWriteError::PrefsEncodeFailed)?;

    crate::atomic_write::atomic_write(&prefs_path, &blob_bytes, true)
        .map_err(PrefsWriteError::from)?;

    tracing::info!(event = "prefs_written", field = "last_backup_at");
    Ok(())
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
    let dir = vault_dir(&app, state.active_vault_id().await).map_err(PrefsWriteError::from)?;
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

    // SYNC-6 writer-guard (MYND-32): see state::hold_unlocked_root_key_and_hash.
    let (_slots_guard, root_key, _vmh) = state
        .hold_unlocked_root_key_and_hash()
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

/// Slot::Unlocked-gated setter for the `spell_enabled` toggle (MYND-267,
/// spell-checker epic). Read-modify-write under the per-plugin write mutex; no
/// native side-effect (like `set_deliberate_folders`). Always persists an
/// explicit `Some(enabled)` — the default-ON policy (SYNC-15) is a host
/// read-time concern, not a stored value. Non-load-bearing → no clamp.
#[tauri::command]
pub async fn set_spell_enabled<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, VaultRuntimeState>,
    enabled: bool,
) -> Result<(), PrefsWriteError> {
    let dir = vault_dir(&app, state.active_vault_id().await).map_err(PrefsWriteError::from)?;
    set_spell_enabled_with_dir(&dir, state.inner(), enabled).await
}

/// Testable core of [`set_spell_enabled`].
pub(crate) async fn set_spell_enabled_with_dir(
    vault_dir: &Path,
    state: &VaultRuntimeState,
    enabled: bool,
) -> Result<(), PrefsWriteError> {
    let _write_guard = write_mutex().lock().await;

    // SYNC-6 writer-guard (MYND-32): see state::hold_unlocked_root_key_and_hash.
    let (_slots_guard, root_key, _vmh) = state
        .hold_unlocked_root_key_and_hash()
        .await
        .ok_or(PrefsWriteError::SlotNotUnlocked)?;

    let account_number_hash = read_account_number_hash_for_write(&vault_dir.join("vault.meta"))?;
    let prefs_key = derive_subkey(&root_key, SubkeyRole::PrefsKey);
    let prefs_path = vault_dir.join("vault.prefs");

    let mut prefs = read_or_default(&prefs_path, &prefs_key, &account_number_hash);
    prefs.spell_enabled = Some(enabled);

    let blob_bytes = encode_prefs_blob(&prefs_key, &account_number_hash, &prefs)
        .map_err(|_| PrefsWriteError::PrefsEncodeFailed)?;

    crate::atomic_write::atomic_write(&prefs_path, &blob_bytes, true)
        .map_err(PrefsWriteError::from)?;

    tracing::info!(
        event = "prefs_written",
        field = "spell_enabled",
        value = enabled
    );
    Ok(())
}

/// Slot::Unlocked-gated setter for the `spell_languages` set (MYND-267 /
/// SYNC-11 union). Read-modify-write under the per-plugin write mutex; no
/// native side-effect. The caller passes the full desired set; the codec
/// NFC-normalizes + sorts + exact-dedupes for canonical byte-stability
/// (folded-identity dedup is the caller's job). Non-load-bearing → no clamp.
/// Logs the COUNT only — the specific language tags are mildly fingerprintable,
/// so they stay off the log surface (mirrors `set_deliberate_folders`).
#[tauri::command]
pub async fn set_spell_languages<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, VaultRuntimeState>,
    languages: Vec<String>,
) -> Result<(), PrefsWriteError> {
    let dir = vault_dir(&app, state.active_vault_id().await).map_err(PrefsWriteError::from)?;
    set_spell_languages_with_dir(&dir, state.inner(), languages).await
}

/// Testable core of [`set_spell_languages`].
pub(crate) async fn set_spell_languages_with_dir(
    vault_dir: &Path,
    state: &VaultRuntimeState,
    languages: Vec<String>,
) -> Result<(), PrefsWriteError> {
    let _write_guard = write_mutex().lock().await;

    // SYNC-6 writer-guard (MYND-32): see state::hold_unlocked_root_key_and_hash.
    let (_slots_guard, root_key, _vmh) = state
        .hold_unlocked_root_key_and_hash()
        .await
        .ok_or(PrefsWriteError::SlotNotUnlocked)?;

    let account_number_hash = read_account_number_hash_for_write(&vault_dir.join("vault.meta"))?;
    let prefs_key = derive_subkey(&root_key, SubkeyRole::PrefsKey);
    let prefs_path = vault_dir.join("vault.prefs");

    let mut prefs = read_or_default(&prefs_path, &prefs_key, &account_number_hash);
    let count = languages.len();
    prefs.spell_languages = languages;

    let blob_bytes = encode_prefs_blob(&prefs_key, &account_number_hash, &prefs)
        .map_err(|_| PrefsWriteError::PrefsEncodeFailed)?;

    crate::atomic_write::atomic_write(&prefs_path, &blob_bytes, true)
        .map_err(PrefsWriteError::from)?;

    tracing::info!(event = "prefs_written", field = "spell_languages", count);
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
    let dir = vault_dir(&app, state.active_vault_id().await).map_err(PrefsWriteError::from)?;
    set_deliberate_folders_with_dir(&dir, state.inner(), folders).await
}

/// Testable core of [`set_deliberate_folders`].
pub(crate) async fn set_deliberate_folders_with_dir(
    vault_dir: &Path,
    state: &VaultRuntimeState,
    folders: Vec<String>,
) -> Result<(), PrefsWriteError> {
    let _write_guard = write_mutex().lock().await;

    // SYNC-6 writer-guard (MYND-32): see state::hold_unlocked_root_key_and_hash.
    let (_slots_guard, root_key, _vmh) = state
        .hold_unlocked_root_key_and_hash()
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

/// Slot::Unlocked-gated setter for the `item_order` sequence — the unified
/// manual sidebar order across the single interleaved file-tree (a flat,
/// heterogeneous list of note UUIDs + folder paths, MYND-183, superseding the
/// old `note_order` + `folder_order`). Read-modify-write under the per-plugin
/// write mutex; **no native side-effect** (same shape as
/// `set_deliberate_folders`). The caller passes the full desired sequence; v0.1
/// single-device writes it verbatim. Unlike `deliberate_folders`, the codec
/// preserves element order — the sequence IS the payload
/// (`protocol::PrefsView::item_order`).
#[tauri::command]
pub async fn set_item_order<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, VaultRuntimeState>,
    order: Vec<String>,
) -> Result<(), PrefsWriteError> {
    let dir = vault_dir(&app, state.active_vault_id().await).map_err(PrefsWriteError::from)?;
    set_item_order_with_dir(&dir, state.inner(), order).await
}

/// Testable core of [`set_item_order`].
pub(crate) async fn set_item_order_with_dir(
    vault_dir: &Path,
    state: &VaultRuntimeState,
    order: Vec<String>,
) -> Result<(), PrefsWriteError> {
    let _write_guard = write_mutex().lock().await;

    // SYNC-6 writer-guard (MYND-32): see state::hold_unlocked_root_key_and_hash.
    let (_slots_guard, root_key, _vmh) = state
        .hold_unlocked_root_key_and_hash()
        .await
        .ok_or(PrefsWriteError::SlotNotUnlocked)?;

    let account_number_hash = read_account_number_hash_for_write(&vault_dir.join("vault.meta"))?;
    let prefs_key = derive_subkey(&root_key, SubkeyRole::PrefsKey);
    let prefs_path = vault_dir.join("vault.prefs");

    let mut prefs = read_or_default(&prefs_path, &prefs_key, &account_number_hash);
    let count = order.len();
    prefs.item_order = order;

    let blob_bytes = encode_prefs_blob(&prefs_key, &account_number_hash, &prefs)
        .map_err(|_| PrefsWriteError::PrefsEncodeFailed)?;

    crate::atomic_write::atomic_write(&prefs_path, &blob_bytes, true)
        .map_err(PrefsWriteError::from)?;

    // COUNT only — never the item IDs/paths (note_id is a per-note vault-stable
    // correlation tag, folder paths are AS3 Sensitive; see ../../CLAUDE.md
    // "Secret-handling logging discipline").
    tracing::info!(event = "prefs_written", field = "item_order", count,);
    Ok(())
}

/// Slot::Unlocked-gated setter for the `daily_date_format` field (MYND-191) —
/// the daily-notes date-format string (e.g. `YYYY-MM-DD`). Read-modify-write
/// under the per-plugin write mutex; no native side-effect. Disk-first. The
/// field is non-load-bearing (cold/derivable); no protective-envelope clamp.
#[tauri::command]
pub async fn set_daily_date_format<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, VaultRuntimeState>,
    format: String,
) -> Result<(), PrefsWriteError> {
    let dir = vault_dir(&app, state.active_vault_id().await).map_err(PrefsWriteError::from)?;
    set_daily_date_format_with_dir(&dir, state.inner(), format).await
}

/// Testable core of [`set_daily_date_format`].
pub(crate) async fn set_daily_date_format_with_dir(
    vault_dir: &Path,
    state: &VaultRuntimeState,
    format: String,
) -> Result<(), PrefsWriteError> {
    let _write_guard = write_mutex().lock().await;

    // SYNC-6 writer-guard (MYND-32): see state::hold_unlocked_root_key_and_hash.
    let (_slots_guard, root_key, _vmh) = state
        .hold_unlocked_root_key_and_hash()
        .await
        .ok_or(PrefsWriteError::SlotNotUnlocked)?;

    let account_number_hash = read_account_number_hash_for_write(&vault_dir.join("vault.meta"))?;
    let prefs_key = derive_subkey(&root_key, SubkeyRole::PrefsKey);
    let prefs_path = vault_dir.join("vault.prefs");

    let mut prefs = read_or_default(&prefs_path, &prefs_key, &account_number_hash);
    prefs.daily_date_format = Some(format);

    let blob_bytes = encode_prefs_blob(&prefs_key, &account_number_hash, &prefs)
        .map_err(|_| PrefsWriteError::PrefsEncodeFailed)?;

    crate::atomic_write::atomic_write(&prefs_path, &blob_bytes, true)
        .map_err(PrefsWriteError::from)?;

    tracing::info!(event = "prefs_written", field = "daily_date_format");
    Ok(())
}

/// Slot::Unlocked-gated setter for the `daily_folder` field (MYND-191) — the
/// daily-notes folder path. Beyond writing the pointer, designating a daily
/// folder ALSO registers it as a deliberate folder (union, exact-dedup) so the
/// folder survives empty (the virtual-folder model, MYND-144). Read-modify-write
/// under the write mutex; no native side-effect; disk-first. Non-load-bearing.
#[tauri::command]
pub async fn set_daily_folder<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, VaultRuntimeState>,
    folder: String,
) -> Result<(), PrefsWriteError> {
    let dir = vault_dir(&app, state.active_vault_id().await).map_err(PrefsWriteError::from)?;
    set_daily_folder_with_dir(&dir, state.inner(), folder).await
}

/// Testable core of [`set_daily_folder`].
pub(crate) async fn set_daily_folder_with_dir(
    vault_dir: &Path,
    state: &VaultRuntimeState,
    folder: String,
) -> Result<(), PrefsWriteError> {
    let _write_guard = write_mutex().lock().await;

    // SYNC-6 writer-guard (MYND-32): see state::hold_unlocked_root_key_and_hash.
    let (_slots_guard, root_key, _vmh) = state
        .hold_unlocked_root_key_and_hash()
        .await
        .ok_or(PrefsWriteError::SlotNotUnlocked)?;

    let account_number_hash = read_account_number_hash_for_write(&vault_dir.join("vault.meta"))?;
    let prefs_key = derive_subkey(&root_key, SubkeyRole::PrefsKey);
    let prefs_path = vault_dir.join("vault.prefs");

    let mut prefs = read_or_default(&prefs_path, &prefs_key, &account_number_hash);
    prefs.daily_folder = Some(folder.clone());
    // Register as a deliberate folder so the daily folder survives empty
    // (MYND-144). Exact-dedup here; the codec sorts + exact-dedups on encode.
    if !prefs.deliberate_folders.contains(&folder) {
        prefs.deliberate_folders.push(folder);
    }

    let blob_bytes = encode_prefs_blob(&prefs_key, &account_number_hash, &prefs)
        .map_err(|_| PrefsWriteError::PrefsEncodeFailed)?;

    crate::atomic_write::atomic_write(&prefs_path, &blob_bytes, true)
        .map_err(PrefsWriteError::from)?;

    // Field name only — never the path (folder structure is AS3 Sensitive; see
    // ../../CLAUDE.md "Secret-handling logging discipline").
    tracing::info!(event = "prefs_written", field = "daily_folder");
    Ok(())
}

/// Slot::Unlocked-gated setter for the `daily_template` pointer (MYND-191) — the
/// UUIDv7 of the template to instantiate today's note from. `Some(id)` sets it;
/// `None` clears it (the canonical "blank daily note" state). Read-modify-write
/// under the write mutex; no native side-effect; disk-first. Non-load-bearing.
#[tauri::command]
pub async fn set_daily_template<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, VaultRuntimeState>,
    template_id: Option<String>,
) -> Result<(), PrefsWriteError> {
    let dir = vault_dir(&app, state.active_vault_id().await).map_err(PrefsWriteError::from)?;
    set_daily_template_with_dir(&dir, state.inner(), template_id).await
}

/// Testable core of [`set_daily_template`].
pub(crate) async fn set_daily_template_with_dir(
    vault_dir: &Path,
    state: &VaultRuntimeState,
    template_id: Option<String>,
) -> Result<(), PrefsWriteError> {
    let _write_guard = write_mutex().lock().await;

    // SYNC-6 writer-guard (MYND-32): see state::hold_unlocked_root_key_and_hash.
    let (_slots_guard, root_key, _vmh) = state
        .hold_unlocked_root_key_and_hash()
        .await
        .ok_or(PrefsWriteError::SlotNotUnlocked)?;

    let account_number_hash = read_account_number_hash_for_write(&vault_dir.join("vault.meta"))?;
    let prefs_key = derive_subkey(&root_key, SubkeyRole::PrefsKey);
    let prefs_path = vault_dir.join("vault.prefs");

    let mut prefs = read_or_default(&prefs_path, &prefs_key, &account_number_hash);
    let cleared = template_id.is_none();
    prefs.daily_template = template_id;

    let blob_bytes = encode_prefs_blob(&prefs_key, &account_number_hash, &prefs)
        .map_err(|_| PrefsWriteError::PrefsEncodeFailed)?;

    crate::atomic_write::atomic_write(&prefs_path, &blob_bytes, true)
        .map_err(PrefsWriteError::from)?;

    // Field name + set/cleared only — never the UUID (note_id is a vault-stable
    // correlation tag; see ../../CLAUDE.md "Secret-handling logging discipline").
    tracing::info!(event = "prefs_written", field = "daily_template", cleared);
    Ok(())
}

/// Slot::Unlocked-gated setter for the `favorites` sequence — the user's
/// favorited notes (an ordered list of note UUIDs surfaced in the sidebar's
/// Favorites section, MYND-183). Identical read-modify-write + order-
/// preserving + no-native-side-effect shape as [`set_item_order`], applied to
/// the favorites field.
#[tauri::command]
pub async fn set_favorites<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, VaultRuntimeState>,
    order: Vec<String>,
) -> Result<(), PrefsWriteError> {
    let dir = vault_dir(&app, state.active_vault_id().await).map_err(PrefsWriteError::from)?;
    set_favorites_with_dir(&dir, state.inner(), order).await
}

/// Testable core of [`set_favorites`].
pub(crate) async fn set_favorites_with_dir(
    vault_dir: &Path,
    state: &VaultRuntimeState,
    order: Vec<String>,
) -> Result<(), PrefsWriteError> {
    let _write_guard = write_mutex().lock().await;

    // SYNC-6 writer-guard (MYND-32): see state::hold_unlocked_root_key_and_hash.
    let (_slots_guard, root_key, _vmh) = state
        .hold_unlocked_root_key_and_hash()
        .await
        .ok_or(PrefsWriteError::SlotNotUnlocked)?;

    let account_number_hash = read_account_number_hash_for_write(&vault_dir.join("vault.meta"))?;
    let prefs_key = derive_subkey(&root_key, SubkeyRole::PrefsKey);
    let prefs_path = vault_dir.join("vault.prefs");

    let mut prefs = read_or_default(&prefs_path, &prefs_key, &account_number_hash);
    let count = order.len();
    prefs.favorites = order;

    let blob_bytes = encode_prefs_blob(&prefs_key, &account_number_hash, &prefs)
        .map_err(|_| PrefsWriteError::PrefsEncodeFailed)?;

    crate::atomic_write::atomic_write(&prefs_path, &blob_bytes, true)
        .map_err(PrefsWriteError::from)?;

    // COUNT only — never the note IDs (note_id is a per-note vault-stable
    // correlation tag; see ../../CLAUDE.md "Secret-handling logging discipline").
    tracing::info!(event = "prefs_written", field = "favorites", count,);
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
    let dir = vault_dir(&app, state.active_vault_id().await).map_err(PrefsWriteError::from)?;
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

    // SYNC-6 writer-guard (MYND-32): see state::hold_unlocked_root_key_and_hash.
    let (_slots_guard, root_key, _vmh) = state
        .hold_unlocked_root_key_and_hash()
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
/// `set_item_order`). The caller passes the full desired layout; v0.1
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
    let dir = vault_dir(&app, state.active_vault_id().await).map_err(PrefsWriteError::from)?;
    set_editor_layout_with_dir(&dir, state.inner(), layout).await
}

/// Testable core of [`set_editor_layout`].
pub(crate) async fn set_editor_layout_with_dir(
    vault_dir: &Path,
    state: &VaultRuntimeState,
    layout: EditorLayout,
) -> Result<(), PrefsWriteError> {
    let _write_guard = write_mutex().lock().await;

    // SYNC-6 writer-guard (MYND-32): see state::hold_unlocked_root_key_and_hash.
    let (_slots_guard, root_key, _vmh) = state
        .hold_unlocked_root_key_and_hash()
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

/// Static label for the theme preference, for non-secret structured
/// logging. `theme` is an AS3-low cosmetic UI preference (light / dark /
/// system), so the value itself is safe to emit (unlike the DENY-listed
/// secret material in ../../CLAUDE.md "Secret-handling logging discipline").
fn theme_label(theme: Option<ThemeChoice>) -> &'static str {
    match theme {
        None => "system",
        Some(ThemeChoice::Light) => "light",
        Some(ThemeChoice::Dark) => "dark",
    }
}

/// Slot::Unlocked-gated setter for the `theme` field (MYND-110) — the
/// user's Light / Dark / System choice. Read-modify-write under the
/// per-plugin write mutex; **no native side-effect** (same shape as
/// [`set_favorites`]). The argument is `Option<ThemeChoice>`: `None` ≡
/// **system** (clears the field so the client follows the OS
/// `prefers-color-scheme`), `Some(Light/Dark)` is an explicit choice that
/// the client maps to `<html data-theme="…">`. `theme` is a
/// **non-load-bearing** cosmetic preference — no protective-envelope clamp
/// (a tampered / replayed `vault.prefs` can at worst surface the wrong
/// color). The getter is the existing [`prefs_read`] — the returned
/// `PrefsView` already carries `theme`. Disk-first ordering is trivial
/// here (nothing is sequenced after the write).
#[tauri::command]
pub async fn set_theme<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, VaultRuntimeState>,
    theme: Option<ThemeChoice>,
) -> Result<(), PrefsWriteError> {
    let dir = vault_dir(&app, state.active_vault_id().await).map_err(PrefsWriteError::from)?;
    set_theme_with_dir(&dir, state.inner(), theme).await
}

/// Testable core of [`set_theme`].
pub(crate) async fn set_theme_with_dir(
    vault_dir: &Path,
    state: &VaultRuntimeState,
    theme: Option<ThemeChoice>,
) -> Result<(), PrefsWriteError> {
    let _write_guard = write_mutex().lock().await;

    // SYNC-6 writer-guard (MYND-32): see state::hold_unlocked_root_key_and_hash.
    let (_slots_guard, root_key, _vmh) = state
        .hold_unlocked_root_key_and_hash()
        .await
        .ok_or(PrefsWriteError::SlotNotUnlocked)?;

    let account_number_hash = read_account_number_hash_for_write(&vault_dir.join("vault.meta"))?;
    let prefs_key = derive_subkey(&root_key, SubkeyRole::PrefsKey);
    let prefs_path = vault_dir.join("vault.prefs");

    let mut prefs = read_or_default(&prefs_path, &prefs_key, &account_number_hash);
    prefs.theme = theme;

    let blob_bytes = encode_prefs_blob(&prefs_key, &account_number_hash, &prefs)
        .map_err(|_| PrefsWriteError::PrefsEncodeFailed)?;

    crate::atomic_write::atomic_write(&prefs_path, &blob_bytes, true)
        .map_err(PrefsWriteError::from)?;

    // Theme is a non-secret cosmetic preference (AS3-low) — the resolved
    // label is safe to emit.
    tracing::info!(
        event = "prefs_written",
        field = "theme",
        value = theme_label(theme),
    );
    Ok(())
}

/// Slot::Unlocked-gated setter for the `item_colors` map (MYND-184) — the
/// per-item color labels keyed by note UUID OR canonical trailing-slash folder
/// path (notes + folders both take a color). Read-modify-write under the
/// per-plugin write mutex; **no native side-effect** (same shape as
/// `set_deliberate_folders`). The caller passes the full desired map; v0.1
/// single-device writes it verbatim. Clearing a color = omit its key from the
/// map (an empty map omits the whole field on disk). Stale-key pruning
/// (deleted note/folder) is the caller's job — the codec performs no GC.
#[tauri::command]
pub async fn set_item_colors<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, VaultRuntimeState>,
    colors: std::collections::BTreeMap<String, String>,
) -> Result<(), PrefsWriteError> {
    let dir = vault_dir(&app, state.active_vault_id().await).map_err(PrefsWriteError::from)?;
    set_item_colors_with_dir(&dir, state.inner(), colors).await
}

/// Testable core of [`set_item_colors`].
pub(crate) async fn set_item_colors_with_dir(
    vault_dir: &Path,
    state: &VaultRuntimeState,
    colors: std::collections::BTreeMap<String, String>,
) -> Result<(), PrefsWriteError> {
    let _write_guard = write_mutex().lock().await;

    // SYNC-6 writer-guard (MYND-32): see state::hold_unlocked_root_key_and_hash.
    let (_slots_guard, root_key, _vmh) = state
        .hold_unlocked_root_key_and_hash()
        .await
        .ok_or(PrefsWriteError::SlotNotUnlocked)?;

    let account_number_hash = read_account_number_hash_for_write(&vault_dir.join("vault.meta"))?;
    let prefs_key = derive_subkey(&root_key, SubkeyRole::PrefsKey);
    let prefs_path = vault_dir.join("vault.prefs");

    let mut prefs = read_or_default(&prefs_path, &prefs_key, &account_number_hash);
    let count = colors.len();
    prefs.item_colors = colors;

    let blob_bytes = encode_prefs_blob(&prefs_key, &account_number_hash, &prefs)
        .map_err(|_| PrefsWriteError::PrefsEncodeFailed)?;

    crate::atomic_write::atomic_write(&prefs_path, &blob_bytes, true)
        .map_err(PrefsWriteError::from)?;

    // Entry COUNT only — never the keys (note IDs / folder paths are AS3
    // correlation tags; see ../../CLAUDE.md "Secret-handling logging discipline").
    tracing::info!(event = "prefs_written", field = "item_colors", count,);
    Ok(())
}

/// Slot::Unlocked-gated setter for the `folder_icons` map (MYND-185) — the
/// per-folder custom sidebar icons keyed by canonical trailing-slash folder
/// path. Same read-modify-write, no-native-side-effect contract as
/// [`set_item_colors`]. The caller passes the full desired map; resetting a
/// folder to its default glyph = omit its key (an empty map omits the field on
/// disk). Stale-key pruning (deleted/renamed folder) is the caller's job.
#[tauri::command]
pub async fn set_folder_icons<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, VaultRuntimeState>,
    icons: std::collections::BTreeMap<String, String>,
) -> Result<(), PrefsWriteError> {
    let dir = vault_dir(&app, state.active_vault_id().await).map_err(PrefsWriteError::from)?;
    set_folder_icons_with_dir(&dir, state.inner(), icons).await
}

/// Testable core of [`set_folder_icons`].
pub(crate) async fn set_folder_icons_with_dir(
    vault_dir: &Path,
    state: &VaultRuntimeState,
    icons: std::collections::BTreeMap<String, String>,
) -> Result<(), PrefsWriteError> {
    let _write_guard = write_mutex().lock().await;

    // SYNC-6 writer-guard (MYND-32): see state::hold_unlocked_root_key_and_hash.
    let (_slots_guard, root_key, _vmh) = state
        .hold_unlocked_root_key_and_hash()
        .await
        .ok_or(PrefsWriteError::SlotNotUnlocked)?;

    let account_number_hash = read_account_number_hash_for_write(&vault_dir.join("vault.meta"))?;
    let prefs_key = derive_subkey(&root_key, SubkeyRole::PrefsKey);
    let prefs_path = vault_dir.join("vault.prefs");

    let mut prefs = read_or_default(&prefs_path, &prefs_key, &account_number_hash);
    let count = icons.len();
    prefs.folder_icons = icons;

    let blob_bytes = encode_prefs_blob(&prefs_key, &account_number_hash, &prefs)
        .map_err(|_| PrefsWriteError::PrefsEncodeFailed)?;

    crate::atomic_write::atomic_write(&prefs_path, &blob_bytes, true)
        .map_err(PrefsWriteError::from)?;

    // Entry COUNT only — never the keys (folder paths are AS3 correlation tags).
    tracing::info!(event = "prefs_written", field = "folder_icons", count,);
    Ok(())
}

/// Slot::Unlocked-gated setter for the per-vault `label` field (MYND-205) — the
/// human-readable name the in-app vault switcher shows for this vault. `Some`
/// sets/changes it; `None` clears it (back to the neutral-fallback state).
/// Read-modify-write under the per-plugin write mutex; **no native side-effect**
/// (same disk-only shape as `set_theme`).
///
/// **Unlock-gated by construction** (SYNC-3): writing the label needs
/// `prefs_key`, which only exists while the vault is unlocked — and under
/// SYNC-1 the sole `Unlocked` slot is the active vault — so the user can only
/// rename the vault they are currently inside. After the disk write commits,
/// the decrypted label is refreshed in the per-session RAM cache so the
/// switcher (`vault_list`) reflects the rename immediately. The plaintext label
/// lives ONLY inside the AEAD-sealed `vault.prefs` at rest and in that RAM
/// cache at runtime; it is never logged (DENY-list discipline — the value is
/// the user's own input, treated as AS3-sensitive).
#[tauri::command]
pub async fn vault_set_label<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, VaultRuntimeState>,
    label: Option<String>,
) -> Result<(), PrefsWriteError> {
    let dir = vault_dir(&app, state.active_vault_id().await).map_err(PrefsWriteError::from)?;
    vault_set_label_with_dir(&dir, state.inner(), label).await
}

/// Testable core of [`vault_set_label`]. Performs the disk-side commit
/// (read-modify-write under the per-plugin write mutex) FIRST, then refreshes
/// the active vault's entry in the per-session RAM label cache (the "effect";
/// window-free, so it lives in the core rather than the wrapper — like
/// `set_auto_lock_timeout`'s idle-timer cache refresh). The disk-FIRST-then-
/// effect ordering holds: a disk-write failure returns before the cache update,
/// so the switcher never reflects a label that did not persist.
pub(crate) async fn vault_set_label_with_dir(
    vault_dir: &Path,
    state: &VaultRuntimeState,
    label: Option<String>,
) -> Result<(), PrefsWriteError> {
    let _write_guard = write_mutex().lock().await;

    // SYNC-6 writer-guard (MYND-32): see state::hold_unlocked_root_key_and_hash.
    let (_slots_guard, root_key, _vmh) = state
        .hold_unlocked_root_key_and_hash()
        .await
        .ok_or(PrefsWriteError::SlotNotUnlocked)?;

    let account_number_hash = read_account_number_hash_for_write(&vault_dir.join("vault.meta"))?;
    let prefs_key = derive_subkey(&root_key, SubkeyRole::PrefsKey);
    let prefs_path = vault_dir.join("vault.prefs");

    let mut prefs = read_or_default(&prefs_path, &prefs_key, &account_number_hash);
    let cleared = label.is_none();
    prefs.label = label.clone();

    let blob_bytes = encode_prefs_blob(&prefs_key, &account_number_hash, &prefs)
        .map_err(|_| PrefsWriteError::PrefsEncodeFailed)?;

    // Disk commit FIRST.
    crate::atomic_write::atomic_write(&prefs_path, &blob_bytes, true)
        .map_err(PrefsWriteError::from)?;

    // Effect SECOND (only on disk success): refresh the active vault's entry in
    // the per-session RAM label cache so `vault_list` reflects the rename
    // immediately. SYNC-1: the sole `Unlocked` slot is the active vault we just
    // wrote to. If a concurrent lock raced (Phase 2 only; impossible Phase 1
    // single-window), `active_vault_id` returns None and the cache update is
    // skipped — disk truth is canonical and the next unlock re-decrypts it.
    if let Some(active) = state.active_vault_id().await {
        state.set_cached_label(active, label).await;
    }

    // Field name + set/cleared only — NEVER the label value (it is the user's
    // own input, treated as AS3-sensitive; see ../../CLAUDE.md "Secret-handling
    // logging discipline").
    tracing::info!(event = "prefs_written", field = "label", cleared);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::plugins::vault_unlock::state::{fixture_unlocked_with_keys, test_vault_id};
    use crate::test_support::ScopedTempDir;
    use protocol::{encode_prefs_blob_raw, AEAD_NONCE_LEN};

    fn rt() -> tokio::runtime::Runtime {
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("current-thread runtime build")
    }

    #[test]
    fn record_last_backup_at_round_trips_through_prefs() {
        // MYND-58: the export engine's best-effort recorder writes the
        // §9.5.2 `last_backup_at` field via the standard setter discipline.
        rt().block_on(async {
            let (tmp, state) = make_temp_vault_with_unlocked_state(0x33).await;
            record_last_backup_at_with_dir(tmp.path(), &state, 1765432100)
                .await
                .expect("record");
            let view = prefs_read_with_dir(tmp.path(), &state).await.expect("read");
            assert_eq!(view.last_backup_at, Some(1765432100));
        });
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
        state.set_unlocked(test_vault_id(), unlocked).await;
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
                    folder_icons: Default::default(),
                    item_colors: Default::default(),
                    theme: None,
                    deliberate_folders: Vec::new(),
                    auto_lock_seconds: None,
                    daily_date_format: None,
                    daily_folder: None,
                    daily_template: None,
                    favorites: Vec::new(),
                    item_order: Vec::new(),
                    editor_layout: None,
                    label: None,
                    last_backup_at: None,
                    spell_enabled: None,
                    spell_languages: Vec::new(),
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

    // ---- decoration maps: item_colors / folder_icons (MYND-184/185) --

    #[test]
    fn item_colors_round_trip_via_set_then_read() {
        rt().block_on(async {
            let (tmp, state) = make_temp_vault_with_unlocked_state(0x33).await;

            let colors = std::collections::BTreeMap::from([
                (
                    String::from("0190a000-0000-7000-8000-000000000001"),
                    String::from("moss"),
                ),
                (String::from("Projects/Myne/"), String::from("slate")),
            ]);
            set_item_colors_with_dir(tmp.path(), &state, colors.clone())
                .await
                .expect("write must succeed");

            let view = prefs_read_with_dir(tmp.path(), &state)
                .await
                .expect("read after write");
            assert_eq!(view.item_colors, colors);
            // screen_capture_protection untouched (defaults on).
            assert!(view.screen_capture_protection);

            // Empty map round-trips (re-encodes byte-identical to a pre-feature blob).
            set_item_colors_with_dir(tmp.path(), &state, std::collections::BTreeMap::new())
                .await
                .expect("clear must succeed");
            let cleared = prefs_read_with_dir(tmp.path(), &state)
                .await
                .expect("read after clear");
            assert!(cleared.item_colors.is_empty());
        });
    }

    #[test]
    fn folder_icons_round_trip_via_set_then_read() {
        rt().block_on(async {
            let (tmp, state) = make_temp_vault_with_unlocked_state(0x33).await;

            let icons = std::collections::BTreeMap::from([
                (String::from("Archive/2025/"), String::from("archive")),
                (String::from("Projects/Myne/"), String::from("book")),
            ]);
            set_folder_icons_with_dir(tmp.path(), &state, icons.clone())
                .await
                .expect("write must succeed");

            let view = prefs_read_with_dir(tmp.path(), &state)
                .await
                .expect("read after write");
            assert_eq!(view.folder_icons, icons);

            set_folder_icons_with_dir(tmp.path(), &state, std::collections::BTreeMap::new())
                .await
                .expect("clear must succeed");
            let cleared = prefs_read_with_dir(tmp.path(), &state)
                .await
                .expect("read after clear");
            assert!(cleared.folder_icons.is_empty());
        });
    }

    // ---- item_order / favorites setters (MYND-183) -------------------

    #[test]
    fn set_item_order_rejects_when_slot_empty() {
        rt().block_on(async {
            let tmp = ScopedTempDir::new("prefs-item-order-empty").expect("scoped tempdir");
            let state = VaultRuntimeState::default();
            let result = set_item_order_with_dir(tmp.path(), &state, alloc_vec(["a", "b"])).await;
            assert!(matches!(result, Err(PrefsWriteError::SlotNotUnlocked)));
        });
    }

    #[test]
    fn item_order_and_favorites_round_trip_preserving_sequence() {
        rt().block_on(async {
            let (tmp, state) = make_temp_vault_with_unlocked_state(0x33).await;

            // item_order is a heterogeneous sequence (note UUIDs + folder paths)
            // — element order is the payload, so it round-trips VERBATIM (not
            // sorted, unlike deliberate_folders). A folder path is interleaved
            // between note UUIDs to exercise the heterogeneity.
            set_item_order_with_dir(tmp.path(), &state, alloc_vec(["n-zzz", "Zebra/", "n-aaa"]))
                .await
                .expect("write item_order");
            set_favorites_with_dir(tmp.path(), &state, alloc_vec(["n-zzz", "n-aaa"]))
                .await
                .expect("write favorites");

            let view = prefs_read_with_dir(tmp.path(), &state)
                .await
                .expect("read after order writes");
            assert_eq!(view.item_order, alloc_vec(["n-zzz", "Zebra/", "n-aaa"]));
            assert_eq!(view.favorites, alloc_vec(["n-zzz", "n-aaa"]));
            // The pre-existing screen_capture default is untouched.
            assert!(view.screen_capture_protection);

            // Clearing item_order round-trips back to empty; favorites is
            // an independent field and stays set.
            set_item_order_with_dir(tmp.path(), &state, Vec::new())
                .await
                .expect("clear item_order");
            let cleared = prefs_read_with_dir(tmp.path(), &state)
                .await
                .expect("read after clear");
            assert!(cleared.item_order.is_empty());
            assert_eq!(cleared.favorites, alloc_vec(["n-zzz", "n-aaa"]));
        });
    }

    fn alloc_vec(items: impl IntoIterator<Item = &'static str>) -> Vec<String> {
        items.into_iter().map(String::from).collect()
    }

    // ---- theme setter (MYND-110) --------------------------------------

    #[test]
    fn set_theme_rejects_when_slot_empty() {
        rt().block_on(async {
            let tmp = ScopedTempDir::new("prefs-theme-empty").expect("scoped tempdir");
            let state = VaultRuntimeState::default();
            let result = set_theme_with_dir(tmp.path(), &state, Some(ThemeChoice::Dark)).await;
            assert!(matches!(result, Err(PrefsWriteError::SlotNotUnlocked)));
        });
    }

    #[test]
    fn theme_round_trips_via_set_then_read() {
        rt().block_on(async {
            let (tmp, state) = make_temp_vault_with_unlocked_state(0x33).await;

            // Explicit Dark persists (disk-first) + round-trips.
            set_theme_with_dir(tmp.path(), &state, Some(ThemeChoice::Dark))
                .await
                .expect("write theme");
            assert!(
                tmp.path().join("vault.prefs").exists(),
                "set_theme must create vault.prefs"
            );
            let view = prefs_read_with_dir(tmp.path(), &state)
                .await
                .expect("read after theme write");
            assert_eq!(view.theme, Some(ThemeChoice::Dark));
            // The pre-existing screen_capture default is untouched.
            assert!(view.screen_capture_protection);

            // Switching to Light overwrites.
            set_theme_with_dir(tmp.path(), &state, Some(ThemeChoice::Light))
                .await
                .expect("write light");
            let view = prefs_read_with_dir(tmp.path(), &state)
                .await
                .expect("read after light");
            assert_eq!(view.theme, Some(ThemeChoice::Light));

            // System (None) clears the field back to "no explicit choice".
            set_theme_with_dir(tmp.path(), &state, None)
                .await
                .expect("write system");
            let view = prefs_read_with_dir(tmp.path(), &state)
                .await
                .expect("read after system");
            assert_eq!(view.theme, None);
        });
    }

    // ---- spell-check setters (MYND-267) -------------------------------

    #[test]
    fn set_spell_enabled_rejects_when_slot_empty() {
        rt().block_on(async {
            let tmp = ScopedTempDir::new("prefs-spell-empty").expect("scoped tempdir");
            let state = VaultRuntimeState::default();
            let result = set_spell_enabled_with_dir(tmp.path(), &state, true).await;
            assert!(matches!(result, Err(PrefsWriteError::SlotNotUnlocked)));
        });
    }

    #[test]
    fn spell_prefs_round_trip_via_set_then_read() {
        rt().block_on(async {
            let (tmp, state) = make_temp_vault_with_unlocked_state(0x44).await;

            // Enable persists (disk-first) + round-trips.
            set_spell_enabled_with_dir(tmp.path(), &state, true)
                .await
                .expect("write spell_enabled");
            let view = prefs_read_with_dir(tmp.path(), &state)
                .await
                .expect("read after enable");
            assert_eq!(view.spell_enabled, Some(true));
            // Pre-existing screen_capture default untouched.
            assert!(view.screen_capture_protection);

            // Languages set: codec NFC-sorts + dedupes (caller order/dupes
            // collapse to canonical form).
            set_spell_languages_with_dir(
                tmp.path(),
                &state,
                vec!["tr".to_string(), "en-US".to_string(), "tr".to_string()],
            )
            .await
            .expect("write spell_languages");
            let view = prefs_read_with_dir(tmp.path(), &state)
                .await
                .expect("read after languages");
            assert_eq!(
                view.spell_languages,
                vec!["en-US".to_string(), "tr".to_string()]
            );
            // spell_enabled still set (independent field).
            assert_eq!(view.spell_enabled, Some(true));

            // Disable overwrites.
            set_spell_enabled_with_dir(tmp.path(), &state, false)
                .await
                .expect("write disable");
            let view = prefs_read_with_dir(tmp.path(), &state)
                .await
                .expect("read after disable");
            assert_eq!(view.spell_enabled, Some(false));
        });
    }

    // ---- vault_set_label setter (MYND-205) ----------------------------

    /// Unlock-gating: with no vault unlocked, `vault_set_label` rejects with
    /// `SlotNotUnlocked` — writing the label needs `prefs_key`, which only
    /// exists for the active/sole-`Unlocked` vault (SYNC-3). This is the
    /// structural unlock-gate the danger-zone/rename surface relies on.
    #[test]
    fn vault_set_label_rejects_when_slot_empty() {
        rt().block_on(async {
            let tmp = ScopedTempDir::new("prefs-label-empty").expect("scoped tempdir");
            let state = VaultRuntimeState::default();
            let result =
                vault_set_label_with_dir(tmp.path(), &state, Some(String::from("Work"))).await;
            assert!(matches!(result, Err(PrefsWriteError::SlotNotUnlocked)));
        });
    }

    /// The label round-trips through the encrypted `vault.prefs` (disk-first),
    /// AND the per-session RAM cache is refreshed so `vault_list` reflects the
    /// rename immediately. Clearing (`None`) round-trips back to no-label and
    /// removes the cache entry.
    #[test]
    fn vault_set_label_round_trips_and_updates_cache() {
        rt().block_on(async {
            let (tmp, state) = make_temp_vault_with_unlocked_state(0x33).await;

            // Before any write, the cache holds no label for the active vault.
            assert_eq!(state.cached_label(test_vault_id()).await, None);

            // Set a label — persists on disk + caches in RAM.
            vault_set_label_with_dir(tmp.path(), &state, Some(String::from("Work")))
                .await
                .expect("write label");
            assert!(
                tmp.path().join("vault.prefs").exists(),
                "vault_set_label must create vault.prefs"
            );
            let view = prefs_read_with_dir(tmp.path(), &state)
                .await
                .expect("read after label write");
            assert_eq!(view.label, Some(String::from("Work")));
            // The pre-existing screen_capture default is untouched.
            assert!(view.screen_capture_protection);
            // RAM cache reflects the label immediately (the switcher source).
            assert_eq!(
                state.cached_label(test_vault_id()).await,
                Some(String::from("Work"))
            );

            // Rename overwrites both disk + cache.
            vault_set_label_with_dir(tmp.path(), &state, Some(String::from("Personal")))
                .await
                .expect("rename label");
            let view = prefs_read_with_dir(tmp.path(), &state)
                .await
                .expect("read after rename");
            assert_eq!(view.label, Some(String::from("Personal")));
            assert_eq!(
                state.cached_label(test_vault_id()).await,
                Some(String::from("Personal"))
            );

            // Clearing (None) removes the label on disk AND evicts the cache.
            vault_set_label_with_dir(tmp.path(), &state, None)
                .await
                .expect("clear label");
            let view = prefs_read_with_dir(tmp.path(), &state)
                .await
                .expect("read after clear");
            assert_eq!(view.label, None);
            assert_eq!(state.cached_label(test_vault_id()).await, None);
        });
    }

    /// DENY-list: the user-supplied label value must NEVER appear in any
    /// tracing payload (it is AS3-sensitive input). The emitted
    /// `prefs_written` event carries only the field name + `cleared` flag.
    #[test]
    #[tracing_test::traced_test]
    fn vault_set_label_does_not_log_the_label_value() {
        rt().block_on(async {
            let (tmp, state) = make_temp_vault_with_unlocked_state(0x33).await;
            let secret_label = "TopSecretProjectName";
            vault_set_label_with_dir(tmp.path(), &state, Some(String::from(secret_label)))
                .await
                .expect("write label");
            assert!(
                logs_contain("field=\"label\""),
                "expected the prefs_written event with field=label"
            );
            assert!(
                !logs_contain(secret_label),
                "the label value must NEVER cross the tracing boundary (DENY-list)"
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
                .set_unlocked(test_vault_id(), fixture_unlocked_with_keys(0x42, 0x99, 1))
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
