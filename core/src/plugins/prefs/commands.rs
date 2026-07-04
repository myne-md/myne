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
    PrefsBlobError, PrefsView, SavedView, SubkeyRole, ThemeChoice, VAULT_META_ACCOUNT_HASH_LEN,
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
pub fn write_mutex() -> &'static Mutex<()> {
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
pub fn read_or_default(
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

/// Shared read-modify-write core for every `Slot::Unlocked`-gated prefs setter
/// (SYNC-6, MYND-32). Every `set_*_with_dir` below wrapped the SAME skeleton:
/// take the per-plugin write mutex → hold the SYNC-6 root-key guard → derive the
/// prefs key → read-or-default the current `vault.prefs` → apply the field
/// mutation → re-encode → atomically persist. This centralises that skeleton;
/// callers supply only `mutate` (the field-specific edit) and keep their own
/// success `tracing::info!(event = "prefs_written", field = …)` line (the field
/// name — and whether its value is loggable — is per-setter) plus any native
/// side-effect. **Ordering contract (MYND-160 grill Q5.2):** this persists to
/// disk BEFORE returning, so a caller's native side-effect runs on the
/// `.await?`-success path — disk write FIRST, native side-effect SECOND.
async fn update_prefs_with_dir(
    vault_dir: &Path,
    state: &VaultRuntimeState,
    mutate: impl FnOnce(&mut PrefsView),
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
    mutate(&mut prefs);

    let blob_bytes = encode_prefs_blob(&prefs_key, &account_number_hash, &prefs)
        .map_err(|_| PrefsWriteError::PrefsEncodeFailed)?;

    crate::atomic_write::atomic_write(&prefs_path, &blob_bytes, true)
        .map_err(PrefsWriteError::from)?;

    Ok(())
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
pub async fn prefs_read_with_dir(
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
pub async fn record_last_backup_at_with_dir(
    vault_dir: &Path,
    state: &VaultRuntimeState,
    epoch_seconds: u64,
) -> Result<(), PrefsWriteError> {
    update_prefs_with_dir(vault_dir, state, |prefs| {
        prefs.last_backup_at = Some(epoch_seconds);
    })
    .await?;

    tracing::info!(event = "prefs_written", field = "last_backup_at");
    Ok(())
}

/// Internal (non-IPC) setter: persist the browser-clipper pairing-token
/// registry snapshot to the `paired_extensions` prefs field (MYND-443,
/// `ext-foundation-handoff` task 7). Same write discipline as every IPC setter
/// (per-plugin write mutex + SYNC-6 hold guard). The caller passes the full
/// desired record set (`registry.to_paired_extensions()`); the codec sorts +
/// canonicalizes on encode. Called after a successful `pairing_accept` (a token
/// was issued) and after a revoke, so pairing survives a restart and a
/// revocation is durable.
///
/// Logs the record COUNT only — a token value + an extension id are vault-stable
/// correlation tags (see ../../CLAUDE.md "Secret-handling logging discipline").
/// The token VALUES never reach the log surface.
pub async fn persist_paired_extensions_with_dir(
    vault_dir: &Path,
    state: &VaultRuntimeState,
    records: Vec<protocol::PairedExtension>,
) -> Result<(), PrefsWriteError> {
    let count = records.len();
    update_prefs_with_dir(vault_dir, state, |prefs| {
        prefs.paired_extensions = records;
    })
    .await?;

    // COUNT only — never a token value / extension id (AS-low correlation tags).
    tracing::info!(event = "prefs_written", field = "paired_extensions", count);
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
    hooks: State<'_, crate::hooks::Hooks>,
    enabled: bool,
) -> Result<(), PrefsWriteError> {
    let dir = vault_dir(&app, state.active_vault_id().await).map_err(PrefsWriteError::from)?;
    // Disk-side commit FIRST, under the mutex.
    set_screen_capture_protection_with_dir(&dir, state.inner(), enabled).await?;
    // Native side-effect SECOND, only on disk-side success (desktop-only;
    // mobile no-op through the hook).
    hooks.apply_screen_capture(enabled, "runtime_apply");
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
    update_prefs_with_dir(vault_dir, state, |prefs| {
        prefs.screen_capture_protection = enabled;
    })
    .await?;

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
    update_prefs_with_dir(vault_dir, state, |prefs| {
        prefs.spell_enabled = Some(enabled);
    })
    .await?;

    tracing::info!(
        event = "prefs_written",
        field = "spell_enabled",
        value = enabled
    );
    Ok(())
}

/// Slot::Unlocked-gated setter for the `editor_line_numbers` toggle
/// (editor-line-numbers, MYND-314). Read-modify-write under the per-plugin write
/// mutex; no native side-effect (like `set_spell_enabled`). Always persists an
/// explicit `Some(enabled)` — the default-OFF policy (prose-first) is a host
/// read-time concern, not a stored value. Non-load-bearing → no clamp.
#[tauri::command]
pub async fn set_editor_line_numbers<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, VaultRuntimeState>,
    enabled: bool,
) -> Result<(), PrefsWriteError> {
    let dir = vault_dir(&app, state.active_vault_id().await).map_err(PrefsWriteError::from)?;
    set_editor_line_numbers_with_dir(&dir, state.inner(), enabled).await
}

/// Testable core of [`set_editor_line_numbers`].
pub(crate) async fn set_editor_line_numbers_with_dir(
    vault_dir: &Path,
    state: &VaultRuntimeState,
    enabled: bool,
) -> Result<(), PrefsWriteError> {
    update_prefs_with_dir(vault_dir, state, |prefs| {
        prefs.editor_line_numbers = Some(enabled);
    })
    .await?;

    tracing::info!(
        event = "prefs_written",
        field = "editor_line_numbers",
        value = enabled
    );
    Ok(())
}

/// Slot::Unlocked-gated setter for the `archive_disabled` toggle (archive-disable,
/// MYND-…). Read-modify-write under the per-plugin write mutex; no native
/// side-effect (like `set_editor_line_numbers`). Always persists an explicit
/// `Some(enabled)` — the default-OFF policy (archiving enabled) is a host
/// read-time concern, not a stored value. Non-load-bearing → no clamp. The
/// auto-unarchive of existing archived notes when the toggle flips ON is a
/// WebView-side orchestration concern (runs before this setter); this command
/// only persists the flag.
#[tauri::command]
pub async fn set_archive_disabled<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, VaultRuntimeState>,
    enabled: bool,
) -> Result<(), PrefsWriteError> {
    let dir = vault_dir(&app, state.active_vault_id().await).map_err(PrefsWriteError::from)?;
    set_archive_disabled_with_dir(&dir, state.inner(), enabled).await
}

/// Testable core of [`set_archive_disabled`].
pub(crate) async fn set_archive_disabled_with_dir(
    vault_dir: &Path,
    state: &VaultRuntimeState,
    enabled: bool,
) -> Result<(), PrefsWriteError> {
    update_prefs_with_dir(vault_dir, state, |prefs| {
        prefs.archive_disabled = Some(enabled);
    })
    .await?;

    tracing::info!(
        event = "prefs_written",
        field = "archive_disabled",
        value = enabled
    );
    Ok(())
}

/// Slot::Unlocked-gated setter for the `active_workspace` slot id (MYND-308) —
/// the workspace slot the editor restores on unlock, or `None` to clear back to
/// the host default. Read-modify-write under the per-plugin write mutex; no
/// native side-effect. A free `Option<String>` stored verbatim (the
/// `set_custom_theme` precedent class); non-load-bearing → no clamp.
#[tauri::command]
pub async fn set_active_workspace<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, VaultRuntimeState>,
    value: Option<String>,
) -> Result<(), PrefsWriteError> {
    let dir = vault_dir(&app, state.active_vault_id().await).map_err(PrefsWriteError::from)?;
    set_typography_field_with_dir(&dir, state.inner(), "active_workspace", |p| {
        p.active_workspace = value;
    })
    .await
}

/// Slot::Unlocked-gated setter for the `editor_default_view_mode` preset
/// (MYND-299) — `live`/`reading`/`source`, or `None` to clear to the host
/// default. Read-modify-write under the write mutex; no native side-effect. A
/// free `Option<String>` (the `set_editor_content_width` precedent class); the
/// enum interpretation + unknown→default fallback live on the client.
#[tauri::command]
pub async fn set_editor_default_view_mode<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, VaultRuntimeState>,
    value: Option<String>,
) -> Result<(), PrefsWriteError> {
    let dir = vault_dir(&app, state.active_vault_id().await).map_err(PrefsWriteError::from)?;
    set_typography_field_with_dir(&dir, state.inner(), "editor_default_view_mode", |p| {
        p.editor_default_view_mode = value;
    })
    .await
}

/// Slot::Unlocked-gated setter for the `editor_focus_dim_inactive` toggle
/// (MYND-348). Read-modify-write under the per-plugin write mutex; no native
/// side-effect (like `set_editor_line_numbers`). Always persists an explicit
/// `Some(enabled)` — the host applies the default focus-mode policy at read time.
/// Non-load-bearing → no clamp.
#[tauri::command]
pub async fn set_editor_focus_dim_inactive<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, VaultRuntimeState>,
    enabled: bool,
) -> Result<(), PrefsWriteError> {
    let dir = vault_dir(&app, state.active_vault_id().await).map_err(PrefsWriteError::from)?;
    set_editor_focus_dim_inactive_with_dir(&dir, state.inner(), enabled).await
}

/// Testable core of [`set_editor_focus_dim_inactive`].
pub(crate) async fn set_editor_focus_dim_inactive_with_dir(
    vault_dir: &Path,
    state: &VaultRuntimeState,
    enabled: bool,
) -> Result<(), PrefsWriteError> {
    update_prefs_with_dir(vault_dir, state, |prefs| {
        prefs.editor_focus_dim_inactive = Some(enabled);
    })
    .await?;

    tracing::info!(
        event = "prefs_written",
        field = "editor_focus_dim_inactive",
        value = enabled
    );
    Ok(())
}

/// Slot::Unlocked-gated setter for the `editor_focus_typewriter` toggle
/// (MYND-348). Read-modify-write under the per-plugin write mutex; no native
/// side-effect (like `set_editor_line_numbers`). Always persists an explicit
/// `Some(enabled)` — the host applies the default focus-mode policy at read time.
/// Non-load-bearing → no clamp.
#[tauri::command]
pub async fn set_editor_focus_typewriter<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, VaultRuntimeState>,
    enabled: bool,
) -> Result<(), PrefsWriteError> {
    let dir = vault_dir(&app, state.active_vault_id().await).map_err(PrefsWriteError::from)?;
    set_editor_focus_typewriter_with_dir(&dir, state.inner(), enabled).await
}

/// Testable core of [`set_editor_focus_typewriter`].
pub(crate) async fn set_editor_focus_typewriter_with_dir(
    vault_dir: &Path,
    state: &VaultRuntimeState,
    enabled: bool,
) -> Result<(), PrefsWriteError> {
    update_prefs_with_dir(vault_dir, state, |prefs| {
        prefs.editor_focus_typewriter = Some(enabled);
    })
    .await?;

    tracing::info!(
        event = "prefs_written",
        field = "editor_focus_typewriter",
        value = enabled
    );
    Ok(())
}

/// Slot::Unlocked-gated setter for the `show_note_timestamps` toggle
/// (sidebar-note-timestamps feature). Read-modify-write under the per-plugin
/// write mutex; no native side-effect (like `set_spell_enabled`). The field is a
/// plain `bool` (default `true`), so this stores the value directly (no `Some`
/// wrap); the codec omits it on disk when `true`, so toggling back ON re-encodes
/// byte-identical to a pre-feature vault.prefs. Non-load-bearing → no clamp.
#[tauri::command]
pub async fn set_show_note_timestamps<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, VaultRuntimeState>,
    enabled: bool,
) -> Result<(), PrefsWriteError> {
    let dir = vault_dir(&app, state.active_vault_id().await).map_err(PrefsWriteError::from)?;
    set_show_note_timestamps_with_dir(&dir, state.inner(), enabled).await
}

/// Testable core of [`set_show_note_timestamps`].
pub(crate) async fn set_show_note_timestamps_with_dir(
    vault_dir: &Path,
    state: &VaultRuntimeState,
    enabled: bool,
) -> Result<(), PrefsWriteError> {
    update_prefs_with_dir(vault_dir, state, |prefs| {
        prefs.show_note_timestamps = enabled;
    })
    .await?;

    tracing::info!(
        event = "prefs_written",
        field = "show_note_timestamps",
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
    let count = languages.len();
    update_prefs_with_dir(vault_dir, state, |prefs| {
        prefs.spell_languages = languages;
    })
    .await?;

    tracing::info!(event = "prefs_written", field = "spell_languages", count);
    Ok(())
}

/// Slot::Unlocked-gated setter for ONE command's keymap override (hotkeys
/// epic, MYND-304). Three states via `Option<Vec<String>>`:
/// - `Some(non-empty)` → override the command to those chords;
/// - `Some(empty)` → explicit-unbind (the `[]` state — the command has no shortcut);
/// - `None` → remove the override entry (revert to the in-code default).
///
/// Read-modify-write under the per-plugin write mutex; no native side-effect.
/// The codec NFC-sorts + exact-dedupes each chord set on encode (set-canonical),
/// so the caller passes the raw desired set. **Non-load-bearing** (a tampered /
/// replayed value can at worst rebind or drop a shortcut; every command stays
/// reachable via the palette) — no protective-envelope clamp. Logs the
/// remove/set discriminator + chord count only — never the command id or the
/// chord strings (a user's specific binding is mildly fingerprintable, like
/// `spell_languages`). Inherits the main-window-only invariant of the other
/// `set_*` setters.
#[tauri::command]
pub async fn set_keymap_binding<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, VaultRuntimeState>,
    command_id: String,
    chords: Option<Vec<String>>,
) -> Result<(), PrefsWriteError> {
    let dir = vault_dir(&app, state.active_vault_id().await).map_err(PrefsWriteError::from)?;
    set_keymap_binding_with_dir(&dir, state.inner(), command_id, chords).await
}

/// Testable core of [`set_keymap_binding`].
pub(crate) async fn set_keymap_binding_with_dir(
    vault_dir: &Path,
    state: &VaultRuntimeState,
    command_id: String,
    chords: Option<Vec<String>>,
) -> Result<(), PrefsWriteError> {
    let removed = chords.is_none();
    let count = chords.as_ref().map(Vec::len).unwrap_or(0);
    update_prefs_with_dir(vault_dir, state, |prefs| match chords {
        Some(c) => {
            prefs.keymap.insert(command_id, c);
        }
        None => {
            prefs.keymap.remove(&command_id);
        }
    })
    .await?;

    tracing::info!(event = "prefs_written", field = "keymap", removed, count);
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
pub async fn set_deliberate_folders_with_dir(
    vault_dir: &Path,
    state: &VaultRuntimeState,
    folders: Vec<String>,
) -> Result<(), PrefsWriteError> {
    let count = folders.len();
    update_prefs_with_dir(vault_dir, state, |prefs| {
        prefs.deliberate_folders = folders;
    })
    .await?;

    // Folder COUNT only — never the paths (folder structure is AS3
    // Sensitive; see ../../CLAUDE.md "Secret-handling logging discipline").
    tracing::info!(event = "prefs_written", field = "deliberate_folders", count,);
    Ok(())
}

/// Slot::Unlocked-gated setter for the `ai_enabled` AI opt-in toggle (local-ai
/// epic, ai-ux-surface MYND-408, SYNC-12). Read-modify-write under the
/// per-plugin write mutex; **no native side-effect** (same shape as
/// `set_deliberate_folders`). Per-vault + encrypted in `vault.prefs` (the
/// at-rest "uses AI" fingerprint never leaks).
#[tauri::command]
pub async fn set_ai_enabled<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, VaultRuntimeState>,
    hooks: State<'_, crate::hooks::Hooks>,
    enabled: bool,
) -> Result<(), PrefsWriteError> {
    let dir = vault_dir(&app, state.active_vault_id().await).map_err(PrefsWriteError::from)?;
    // Disk-side commit FIRST, under the mutex.
    set_ai_enabled_with_dir(&dir, state.inner(), enabled).await?;
    // Reflect the new policy into the AI runtime SECOND (desktop-only; mobile
    // no-op). Read back the authoritative post-write policy so both the opt-in
    // and the current exclusion set are consistent (SYNC-14).
    if let Ok(view) = prefs_read_with_dir(&dir, state.inner()).await {
        hooks.ai_policy_changed(view.ai_enabled, &view.ai_excluded_folders);
    }
    Ok(())
}

/// Testable core of [`set_ai_enabled`].
pub(crate) async fn set_ai_enabled_with_dir(
    vault_dir: &Path,
    state: &VaultRuntimeState,
    enabled: bool,
) -> Result<(), PrefsWriteError> {
    update_prefs_with_dir(vault_dir, state, |prefs| {
        prefs.ai_enabled = enabled;
    })
    .await?;

    tracing::info!(event = "prefs_written", field = "ai_enabled", enabled);
    Ok(())
}

/// Slot::Unlocked-gated setter for the `ai_excluded_folders` set (local-ai
/// epic, ai-ux-surface MYND-408, SYNC-14) — folders the AI never reads/indexes.
/// Same canonical set encoding as `deliberate_folders`; direct mirror of
/// [`set_deliberate_folders`] (read-modify-write, no native side-effect).
#[tauri::command]
pub async fn set_ai_excluded_folders<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, VaultRuntimeState>,
    hooks: State<'_, crate::hooks::Hooks>,
    folders: Vec<String>,
) -> Result<(), PrefsWriteError> {
    let dir = vault_dir(&app, state.active_vault_id().await).map_err(PrefsWriteError::from)?;
    // Disk-side commit FIRST, under the mutex.
    set_ai_excluded_folders_with_dir(&dir, state.inner(), folders).await?;
    // Reflect the new exclusion set into the AI runtime SECOND: purge any
    // now-excluded note from the resident store + persisted blob (SYNC-14).
    // Read back the authoritative policy (opt-in may be off).
    if let Ok(view) = prefs_read_with_dir(&dir, state.inner()).await {
        hooks.ai_policy_changed(view.ai_enabled, &view.ai_excluded_folders);
    }
    Ok(())
}

/// Testable core of [`set_ai_excluded_folders`].
pub(crate) async fn set_ai_excluded_folders_with_dir(
    vault_dir: &Path,
    state: &VaultRuntimeState,
    folders: Vec<String>,
) -> Result<(), PrefsWriteError> {
    let count = folders.len();
    update_prefs_with_dir(vault_dir, state, |prefs| {
        prefs.ai_excluded_folders = folders;
    })
    .await?;

    // Folder COUNT only — never the paths (AS3 Sensitive; see the
    // `set_deliberate_folders` note + ../../CLAUDE.md logging discipline).
    tracing::info!(
        event = "prefs_written",
        field = "ai_excluded_folders",
        count
    );
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
    let count = order.len();
    update_prefs_with_dir(vault_dir, state, |prefs| {
        prefs.item_order = order;
    })
    .await?;

    // COUNT only — never the item IDs/paths (note_id is a per-note vault-stable
    // correlation tag, folder paths are AS3 Sensitive; see ../../CLAUDE.md
    // "Secret-handling logging discipline").
    tracing::info!(event = "prefs_written", field = "item_order", count,);
    Ok(())
}

/// Slot::Unlocked-gated setter for the `hidden_bar_items` set — the bottom-bar
/// element ids the user chose to hide via the bar's right-click menu (bottom-bar
/// customization). Read-modify-write under the per-plugin write mutex; **no
/// native side-effect** (same shape as `set_item_order`). The caller passes the
/// full desired set; the codec canonicalizes it (sorted + exact-deduped) on
/// encode (`protocol::PrefsView::hidden_bar_items`). An empty set is the default
/// (bar fully visible) and encodes to byte-identical-to-pre-feature.
#[tauri::command]
pub async fn set_hidden_bar_items<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, VaultRuntimeState>,
    items: Vec<String>,
) -> Result<(), PrefsWriteError> {
    let dir = vault_dir(&app, state.active_vault_id().await).map_err(PrefsWriteError::from)?;
    set_hidden_bar_items_with_dir(&dir, state.inner(), items).await
}

/// Testable core of [`set_hidden_bar_items`].
pub(crate) async fn set_hidden_bar_items_with_dir(
    vault_dir: &Path,
    state: &VaultRuntimeState,
    items: Vec<String>,
) -> Result<(), PrefsWriteError> {
    let count = items.len();
    update_prefs_with_dir(vault_dir, state, |prefs| {
        prefs.hidden_bar_items = items;
    })
    .await?;

    // COUNT only — the ids are a non-secret closed UI vocabulary, but stay
    // consistent with the other prefs setters' count-only discipline.
    tracing::info!(event = "prefs_written", field = "hidden_bar_items", count,);
    Ok(())
}

/// Slot::Unlocked-gated save/edit (upsert-by-id) of one saved view (MYND-273,
/// Saved Views epic). Read-modify-write under the per-plugin write mutex; **no
/// native side-effect** (same shape as `set_item_order`). "Save" and "edit" are
/// one operation: the view REPLACES any existing entry with the same `id`, else
/// it is appended (so editing never creates a duplicate). The 64 KiB §9.5.4
/// prefs cap is enforced by `encode_prefs_blob` BEFORE the atomic write, so an
/// over-cap save fails `PrefsEncodeFailed` and leaves the on-disk prefs
/// untouched (story 13). Logs the view COUNT only — a view's name / filter /
/// referenced property is AS3-Sensitive and never reaches the log surface (see
/// ../../CLAUDE.md "Secret-handling logging discipline").
#[tauri::command]
pub async fn upsert_saved_view<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, VaultRuntimeState>,
    view: SavedView,
) -> Result<(), PrefsWriteError> {
    let dir = vault_dir(&app, state.active_vault_id().await).map_err(PrefsWriteError::from)?;
    upsert_saved_view_with_dir(&dir, state.inner(), view).await
}

/// Testable core of [`upsert_saved_view`].
pub(crate) async fn upsert_saved_view_with_dir(
    vault_dir: &Path,
    state: &VaultRuntimeState,
    view: SavedView,
) -> Result<(), PrefsWriteError> {
    let mut count = 0usize;
    update_prefs_with_dir(vault_dir, state, |prefs| {
        // Upsert by id: replace in place, else append. No duplicate ids.
        match prefs.saved_views.iter_mut().find(|v| v.id == view.id) {
            Some(existing) => *existing = view,
            None => prefs.saved_views.push(view),
        }
        count = prefs.saved_views.len();
    })
    .await?;

    // COUNT only — never a view name / filter / property (AS3-Sensitive).
    tracing::info!(event = "prefs_written", field = "saved_views", count);
    Ok(())
}

/// Slot::Unlocked-gated delete of one saved view by `id` (MYND-273). Removes the
/// view from `saved_views` AND prunes that id from `view_order` (so a deleted
/// view leaves no dangling display-order entry). Read-modify-write under the
/// per-plugin write mutex; no native side-effect. Deleting an absent id is a
/// no-op success (idempotent). Logs the post-delete view COUNT only.
#[tauri::command]
pub async fn delete_saved_view<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, VaultRuntimeState>,
    id: String,
) -> Result<(), PrefsWriteError> {
    let dir = vault_dir(&app, state.active_vault_id().await).map_err(PrefsWriteError::from)?;
    delete_saved_view_with_dir(&dir, state.inner(), id).await
}

/// Testable core of [`delete_saved_view`].
pub(crate) async fn delete_saved_view_with_dir(
    vault_dir: &Path,
    state: &VaultRuntimeState,
    id: String,
) -> Result<(), PrefsWriteError> {
    let mut count = 0usize;
    update_prefs_with_dir(vault_dir, state, |prefs| {
        prefs.saved_views.retain(|v| v.id != id);
        // Prune the id from the display order too (no dangling entry).
        prefs.view_order.retain(|vid| *vid != id);
        count = prefs.saved_views.len();
    })
    .await?;

    // COUNT only — never the view id (AS3-Sensitive correlation surface).
    tracing::info!(event = "prefs_written", field = "saved_views", count);
    Ok(())
}

/// Slot::Unlocked-gated setter for the `view_order` sequence (MYND-273) — the
/// saved-view display order (SYNC-10). Read-modify-write under the per-plugin
/// write mutex; **no native side-effect**. The caller passes the full desired
/// sequence; the codec preserves element order VERBATIM (the sequence is the
/// payload — same discipline as `set_item_order`). Stale-id pruning is the
/// caller's job; the codec performs no GC (mirroring `favorites`). Logs the
/// COUNT only.
#[tauri::command]
pub async fn set_view_order<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, VaultRuntimeState>,
    order: Vec<String>,
) -> Result<(), PrefsWriteError> {
    let dir = vault_dir(&app, state.active_vault_id().await).map_err(PrefsWriteError::from)?;
    set_view_order_with_dir(&dir, state.inner(), order).await
}

/// Testable core of [`set_view_order`].
pub(crate) async fn set_view_order_with_dir(
    vault_dir: &Path,
    state: &VaultRuntimeState,
    order: Vec<String>,
) -> Result<(), PrefsWriteError> {
    let count = order.len();
    update_prefs_with_dir(vault_dir, state, |prefs| {
        prefs.view_order = order;
    })
    .await?;

    // COUNT only — never the view ids (AS3-Sensitive correlation surface).
    tracing::info!(event = "prefs_written", field = "view_order", count);
    Ok(())
}

/// Slot::Unlocked-gated setter for the `bar_items_order` sequence (MYND
/// bottom-bar customization) — the bottom-bar item display order. Read-modify-
/// write under the per-plugin write mutex; **no native side-effect** (same shape
/// as `set_view_order`). The caller passes the full desired sequence of
/// right-cluster bar element ids; the codec preserves element order VERBATIM
/// (the sequence is the payload). Unknown-id pruning is the caller's job; the
/// codec performs no GC. Logs the COUNT only.
#[tauri::command]
pub async fn set_bar_items_order<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, VaultRuntimeState>,
    order: Vec<String>,
) -> Result<(), PrefsWriteError> {
    let dir = vault_dir(&app, state.active_vault_id().await).map_err(PrefsWriteError::from)?;
    set_bar_items_order_with_dir(&dir, state.inner(), order).await
}

/// Testable core of [`set_bar_items_order`].
pub(crate) async fn set_bar_items_order_with_dir(
    vault_dir: &Path,
    state: &VaultRuntimeState,
    order: Vec<String>,
) -> Result<(), PrefsWriteError> {
    let count = order.len();
    update_prefs_with_dir(vault_dir, state, |prefs| {
        prefs.bar_items_order = order;
    })
    .await?;

    // COUNT only — the bar element ids are fixed UI affordance names, but keep
    // the count-only discipline uniform with the other prefs setters.
    tracing::info!(event = "prefs_written", field = "bar_items_order", count);
    Ok(())
}

/// Slot::Unlocked-gated setter for the `right_panel_active_tab` slot id
/// (right-panel tabs) — the right sidebar tab the editor restores, or `None` to
/// clear back to the host default. Read-modify-write under the per-plugin write
/// mutex; no native side-effect. A free `Option<String>` stored verbatim (the
/// `set_active_workspace` precedent class); non-load-bearing → no clamp.
#[tauri::command]
pub async fn set_right_panel_active_tab<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, VaultRuntimeState>,
    value: Option<String>,
) -> Result<(), PrefsWriteError> {
    let dir = vault_dir(&app, state.active_vault_id().await).map_err(PrefsWriteError::from)?;
    set_typography_field_with_dir(&dir, state.inner(), "right_panel_active_tab", |p| {
        p.right_panel_active_tab = value;
    })
    .await
}

/// Slot::Unlocked-gated setter for the `right_panel_hidden_tabs` set (right-panel
/// tabs). Read-modify-write under the per-plugin write mutex; **no native
/// side-effect** (same shape as `set_hidden_bar_items`). The caller passes the
/// full desired set; the codec canonicalizes it (sorted + exact-deduped) on
/// encode. An empty set is the default (every tab visible) and encodes to
/// byte-identical-to-pre-feature.
#[tauri::command]
pub async fn set_right_panel_hidden_tabs<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, VaultRuntimeState>,
    items: Vec<String>,
) -> Result<(), PrefsWriteError> {
    let dir = vault_dir(&app, state.active_vault_id().await).map_err(PrefsWriteError::from)?;
    set_right_panel_hidden_tabs_with_dir(&dir, state.inner(), items).await
}

/// Testable core of [`set_right_panel_hidden_tabs`].
pub(crate) async fn set_right_panel_hidden_tabs_with_dir(
    vault_dir: &Path,
    state: &VaultRuntimeState,
    items: Vec<String>,
) -> Result<(), PrefsWriteError> {
    let count = items.len();
    update_prefs_with_dir(vault_dir, state, |prefs| {
        prefs.right_panel_hidden_tabs = items;
    })
    .await?;

    // COUNT only — the tab ids are a non-secret closed UI vocabulary, but stay
    // consistent with the other prefs setters' count-only discipline.
    tracing::info!(
        event = "prefs_written",
        field = "right_panel_hidden_tabs",
        count,
    );
    Ok(())
}

/// Slot::Unlocked-gated setter for the `right_panel_tab_order` sequence
/// (right-panel tabs) — the right sidebar tab display order. Read-modify-write
/// under the per-plugin write mutex; **no native side-effect** (same shape as
/// `set_bar_items_order`). The caller passes the full desired sequence of tab
/// ids; the codec preserves element order VERBATIM. Unknown-id pruning is the
/// caller's job; the codec performs no GC. Logs the COUNT only.
#[tauri::command]
pub async fn set_right_panel_tab_order<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, VaultRuntimeState>,
    order: Vec<String>,
) -> Result<(), PrefsWriteError> {
    let dir = vault_dir(&app, state.active_vault_id().await).map_err(PrefsWriteError::from)?;
    set_right_panel_tab_order_with_dir(&dir, state.inner(), order).await
}

/// Testable core of [`set_right_panel_tab_order`].
pub(crate) async fn set_right_panel_tab_order_with_dir(
    vault_dir: &Path,
    state: &VaultRuntimeState,
    order: Vec<String>,
) -> Result<(), PrefsWriteError> {
    let count = order.len();
    update_prefs_with_dir(vault_dir, state, |prefs| {
        prefs.right_panel_tab_order = order;
    })
    .await?;

    // COUNT only — the tab ids are fixed UI affordance names, but keep the
    // count-only discipline uniform with the other prefs setters.
    tracing::info!(
        event = "prefs_written",
        field = "right_panel_tab_order",
        count
    );
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
    update_prefs_with_dir(vault_dir, state, |prefs| {
        prefs.daily_date_format = Some(format);
    })
    .await?;

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
    update_prefs_with_dir(vault_dir, state, |prefs| {
        prefs.daily_folder = Some(folder.clone());
        // Register as a deliberate folder so the daily folder survives empty
        // (MYND-144). Exact-dedup here; the codec sorts + exact-dedups on encode.
        if !prefs.deliberate_folders.contains(&folder) {
            prefs.deliberate_folders.push(folder);
        }
    })
    .await?;

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
    let cleared = template_id.is_none();
    update_prefs_with_dir(vault_dir, state, |prefs| {
        prefs.daily_template = template_id;
    })
    .await?;

    // Field name + set/cleared only — never the UUID (note_id is a vault-stable
    // correlation tag; see ../../CLAUDE.md "Secret-handling logging discipline").
    tracing::info!(event = "prefs_written", field = "daily_template", cleared);
    Ok(())
}

/// Slot::Unlocked-gated setter for the new-note default-location pair (MYND-462,
/// "Files" settings panel) — `new_note_location` (the mode: root/current/specific)
/// + `new_note_location_folder` (the target folder when mode == "specific"). Set
/// atomically in one disk write so the mode and target never desync. When a
/// folder is supplied it is ALSO registered as a deliberate folder (union,
/// exact-dedup) so the target survives empty (the `set_daily_folder` discipline,
/// MYND-144). The caller passes `folder = None` whenever `location != "specific"`.
/// Read-modify-write under the write mutex; no native side-effect; disk-first;
/// non-load-bearing.
#[tauri::command]
pub async fn set_new_note_location<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, VaultRuntimeState>,
    location: Option<String>,
    folder: Option<String>,
) -> Result<(), PrefsWriteError> {
    let dir = vault_dir(&app, state.active_vault_id().await).map_err(PrefsWriteError::from)?;
    set_new_note_location_with_dir(&dir, state.inner(), location, folder).await
}

/// Testable core of [`set_new_note_location`].
pub(crate) async fn set_new_note_location_with_dir(
    vault_dir: &Path,
    state: &VaultRuntimeState,
    location: Option<String>,
    folder: Option<String>,
) -> Result<(), PrefsWriteError> {
    update_prefs_with_dir(vault_dir, state, |prefs| {
        prefs.new_note_location = location;
        prefs.new_note_location_folder = folder.clone();
        // When a specific target folder is named, register it as a deliberate folder
        // so it survives empty (MYND-144) — exactly like set_daily_folder.
        if let Some(folder) = folder {
            if !prefs.deliberate_folders.contains(&folder) {
                prefs.deliberate_folders.push(folder);
            }
        }
    })
    .await?;

    // Field name only — never the path (folder structure is AS3 Sensitive; see
    // ../../CLAUDE.md "Secret-handling logging discipline").
    tracing::info!(event = "prefs_written", field = "new_note_location");
    Ok(())
}

/// Shared read-modify-write core for the four editor-typography string presets
/// (editor-typography: `editor_text_size` / `editor_line_spacing` /
/// `editor_content_width` / `editor_font_family`). Each is a free
/// `Option<String>` enum where `None` clears to the canonical default (omitted
/// on disk, byte-identical to an untouched vault) and `Some(v)` stores the
/// chosen preset — the enum interpretation + unknown→default fallback live on
/// the client (the `set_theme` precedent class). Disk-first; no native
/// side-effect; non-load-bearing (no protective-envelope clamp).
async fn set_typography_field_with_dir(
    vault_dir: &Path,
    state: &VaultRuntimeState,
    field_label: &'static str,
    mutate: impl FnOnce(&mut PrefsView),
) -> Result<(), PrefsWriteError> {
    update_prefs_with_dir(vault_dir, state, mutate).await?;

    // Field name only — never the value (a typography preset is not secret, but
    // the field-name-only discipline is uniform across prefs setters).
    tracing::info!(event = "prefs_written", field = field_label);
    Ok(())
}

/// Slot::Unlocked-gated setter for the `editor_text_size` preset
/// (editor-typography) — `sm`/`md`/`lg`/`xl`, or `None` to clear to the `md`
/// default. Read-modify-write under the write mutex; no native side-effect.
#[tauri::command]
pub async fn set_editor_text_size<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, VaultRuntimeState>,
    value: Option<String>,
) -> Result<(), PrefsWriteError> {
    let dir = vault_dir(&app, state.active_vault_id().await).map_err(PrefsWriteError::from)?;
    set_typography_field_with_dir(&dir, state.inner(), "editor_text_size", |p| {
        p.editor_text_size = value;
    })
    .await
}

/// Slot::Unlocked-gated setter for the `editor_line_spacing` preset
/// (editor-typography) — `tight`/`normal`/`relaxed`, or `None` to clear.
#[tauri::command]
pub async fn set_editor_line_spacing<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, VaultRuntimeState>,
    value: Option<String>,
) -> Result<(), PrefsWriteError> {
    let dir = vault_dir(&app, state.active_vault_id().await).map_err(PrefsWriteError::from)?;
    set_typography_field_with_dir(&dir, state.inner(), "editor_line_spacing", |p| {
        p.editor_line_spacing = value;
    })
    .await
}

/// Slot::Unlocked-gated setter for the `editor_content_width` preset
/// (editor-typography) — `narrow`/`normal`/`wide`/`full`, or `None` to clear.
#[tauri::command]
pub async fn set_editor_content_width<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, VaultRuntimeState>,
    value: Option<String>,
) -> Result<(), PrefsWriteError> {
    let dir = vault_dir(&app, state.active_vault_id().await).map_err(PrefsWriteError::from)?;
    set_typography_field_with_dir(&dir, state.inner(), "editor_content_width", |p| {
        p.editor_content_width = value;
    })
    .await
}

/// Slot::Unlocked-gated setter for the `editor_font_family` preset
/// (editor-typography) — `mono`/`sans`, or `None` to clear to the `mono` default.
#[tauri::command]
pub async fn set_editor_font_family<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, VaultRuntimeState>,
    value: Option<String>,
) -> Result<(), PrefsWriteError> {
    let dir = vault_dir(&app, state.active_vault_id().await).map_err(PrefsWriteError::from)?;
    set_typography_field_with_dir(&dir, state.inner(), "editor_font_family", |p| {
        p.editor_font_family = value;
    })
    .await
}

/// Slot::Unlocked-gated setter for the startup-open pair (MYND-462, "Files"
/// settings panel) — `startup_open` (the mode: last/empty/specific) +
/// `startup_open_note` (the target note UUID when mode == "specific"). Set
/// atomically in one disk write (via the shared typography core) so the mode and
/// target never desync. No deliberate-folder side-effect (a note pointer, not a
/// folder). The caller passes `note = None` whenever `mode != "specific"`.
/// Disk-first; non-load-bearing.
#[tauri::command]
pub async fn set_startup_open<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, VaultRuntimeState>,
    mode: Option<String>,
    note: Option<String>,
) -> Result<(), PrefsWriteError> {
    let dir = vault_dir(&app, state.active_vault_id().await).map_err(PrefsWriteError::from)?;
    set_startup_open_with_dir(&dir, state.inner(), mode, note).await
}

/// Testable core of [`set_startup_open`]. Writes the `startup_open` mode +
/// `startup_open_note` target atomically via the shared typography core.
pub(crate) async fn set_startup_open_with_dir(
    vault_dir: &Path,
    state: &VaultRuntimeState,
    mode: Option<String>,
    note: Option<String>,
) -> Result<(), PrefsWriteError> {
    set_typography_field_with_dir(vault_dir, state, "startup_open", |p| {
        p.startup_open = mode;
        p.startup_open_note = note;
    })
    .await
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
    let count = order.len();
    update_prefs_with_dir(vault_dir, state, |prefs| {
        prefs.favorites = order;
    })
    .await?;

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
    hooks: State<'_, crate::hooks::Hooks>,
    seconds: u32,
) -> Result<(), PrefsWriteError> {
    let dir = vault_dir(&app, state.active_vault_id().await).map_err(PrefsWriteError::from)?;
    set_auto_lock_timeout_with_dir(&dir, state.inner(), hooks.inner(), seconds).await
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
pub async fn set_auto_lock_timeout_with_dir(
    vault_dir: &Path,
    state: &VaultRuntimeState,
    hooks: &crate::hooks::Hooks,
    seconds: u32,
) -> Result<(), PrefsWriteError> {
    update_prefs_with_dir(vault_dir, state, |prefs| {
        prefs.auto_lock_seconds = Some(seconds);
    })
    .await?;

    // Effect SECOND (only on disk success): refresh the cached effective
    // timeout the running idle timer reads, clamped through the envelope so
    // a live change can never exceed the ceiling. The clamp is desktop-only
    // (auto_lock stays in the desktop crate) and is threaded via the hook.
    state.set_auto_lock_timeout_secs(hooks.effective_auto_lock_secs(Some(seconds)));

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
    let (left_collapsed, right_collapsed) = (layout.left_collapsed, layout.right_collapsed);
    update_prefs_with_dir(vault_dir, state, |prefs| {
        prefs.editor_layout = Some(layout);
    })
    .await?;

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
/// amoled / system), so the value itself is safe to emit (unlike the
/// DENY-listed secret material in ../../CLAUDE.md "Secret-handling logging
/// discipline").
fn theme_label(theme: Option<ThemeChoice>) -> &'static str {
    match theme {
        None => "system",
        Some(ThemeChoice::Light) => "light",
        Some(ThemeChoice::Dark) => "dark",
        Some(ThemeChoice::Amoled) => "amoled",
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
    update_prefs_with_dir(vault_dir, state, |prefs| {
        prefs.theme = theme;
    })
    .await?;

    // Theme is a non-secret cosmetic preference (AS3-low) — the resolved
    // label is safe to emit.
    tracing::info!(
        event = "prefs_written",
        field = "theme",
        value = theme_label(theme),
    );
    Ok(())
}

/// Slot::Unlocked-gated setter for the `custom_theme` field (custom-themes
/// epic, MYND-297) — the active custom-theme name (the file-stem of a theme
/// under `app_config_dir/themes/`). `Some(name)` selects a custom theme (takes
/// precedence over `theme` host-side); `None` clears it (the client falls back
/// to the built-in `theme`). Read-modify-write under the per-plugin write
/// mutex; **no native side-effect**, disk-first (same shape as [`set_theme`]).
/// `custom_theme` is a **non-load-bearing** cosmetic preference — no
/// protective-envelope clamp (a tampered/replayed value at worst selects a
/// different or absent palette; the apply layer validates the file + falls back
/// to a built-in theme on any failure). The name is `is_valid_theme_name`-
/// constrained at the themes-plugin file boundary (MYND-297 read/delete); this
/// setter stores the string verbatim.
#[tauri::command]
pub async fn set_custom_theme<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, VaultRuntimeState>,
    custom_theme: Option<String>,
) -> Result<(), PrefsWriteError> {
    let dir = vault_dir(&app, state.active_vault_id().await).map_err(PrefsWriteError::from)?;
    set_custom_theme_with_dir(&dir, state.inner(), custom_theme).await
}

/// Testable core of [`set_custom_theme`].
pub(crate) async fn set_custom_theme_with_dir(
    vault_dir: &Path,
    state: &VaultRuntimeState,
    custom_theme: Option<String>,
) -> Result<(), PrefsWriteError> {
    let is_set = custom_theme.is_some();
    update_prefs_with_dir(vault_dir, state, |prefs| {
        prefs.custom_theme = custom_theme;
    })
    .await?;

    // The custom-theme NAME is user-authored cosmetic data; emit only whether a
    // custom theme is now selected or cleared, never the name itself.
    tracing::info!(
        event = "prefs_written",
        field = "custom_theme",
        set = is_set
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
    let count = colors.len();
    update_prefs_with_dir(vault_dir, state, |prefs| {
        prefs.item_colors = colors;
    })
    .await?;

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
    let count = icons.len();
    update_prefs_with_dir(vault_dir, state, |prefs| {
        prefs.folder_icons = icons;
    })
    .await?;

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
    let cleared = label.is_none();
    update_prefs_with_dir(vault_dir, state, |prefs| {
        prefs.label = label.clone();
    })
    .await?;

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

/// Slot::Unlocked-gated setter for the per-vault `icon` field (vault-icons) —
/// the curated switcher glyph name shown beside this vault's name. `Some`
/// sets/changes it; `None` clears it (back to the neutral-wordmark state). The
/// twin of [`vault_set_label`]: read-modify-write under the per-plugin write
/// mutex, **no native side-effect** (disk-only, like `set_theme`).
///
/// **Unlock-gated by construction** (SYNC-3): writing the icon needs
/// `prefs_key`, which only exists while the vault is unlocked — and under SYNC-1
/// the sole `Unlocked` slot is the active vault — so the user can only re-icon
/// the vault they are currently inside. After the disk write commits, the
/// decrypted icon is refreshed in the per-session RAM cache so the switcher
/// (`vault_list`) reflects the change immediately. The glyph name lives ONLY
/// inside the AEAD-sealed `vault.prefs` at rest and in that RAM cache at runtime.
#[tauri::command]
pub async fn vault_set_icon<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, VaultRuntimeState>,
    icon: Option<String>,
) -> Result<(), PrefsWriteError> {
    let dir = vault_dir(&app, state.active_vault_id().await).map_err(PrefsWriteError::from)?;
    vault_set_icon_with_dir(&dir, state.inner(), icon).await
}

/// Testable core of [`vault_set_icon`]. Performs the disk-side commit
/// (read-modify-write under the per-plugin write mutex) FIRST, then refreshes
/// the active vault's entry in the per-session RAM icon cache (the "effect") —
/// same disk-FIRST-then-effect ordering as [`vault_set_label_with_dir`], so the
/// switcher never reflects an icon that did not persist.
pub(crate) async fn vault_set_icon_with_dir(
    vault_dir: &Path,
    state: &VaultRuntimeState,
    icon: Option<String>,
) -> Result<(), PrefsWriteError> {
    let cleared = icon.is_none();
    update_prefs_with_dir(vault_dir, state, |prefs| {
        prefs.icon = icon.clone();
    })
    .await?;

    // Effect SECOND (only on disk success): refresh the active vault's entry in
    // the per-session RAM icon cache so `vault_list` reflects the change
    // immediately. SYNC-1: the sole `Unlocked` slot is the active vault we just
    // wrote to; a concurrent lock race (Phase 2 only) makes `active_vault_id`
    // return None and the cache update is skipped — disk truth is canonical.
    if let Some(active) = state.active_vault_id().await {
        state.set_cached_icon(active, icon).await;
    }

    // Field name + set/cleared only — the glyph name is a curated, closed-set
    // value (not free user text), but we keep parity with label's discipline
    // and never log the value itself.
    tracing::info!(event = "prefs_written", field = "icon", cleared);
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

    /// A `Hooks` whose `effective_auto_lock_secs` is a no-op (returns the value
    /// unchanged) — the core has no desktop clamp range. The clamp-WIRING
    /// assertion lives desktop-side (`auto_lock` owns the clamp + its tests).
    fn noop_hooks() -> crate::hooks::Hooks {
        std::sync::Arc::new(crate::hooks::NoopHooks)
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
                    ai_enabled: false,
                    ai_excluded_folders: Vec::new(),
                    bar_items_order: Vec::new(),
                    show_note_timestamps: true,
                    folder_icons: Default::default(),
                    hidden_bar_items: Vec::new(),
                    icon: None,
                    item_colors: Default::default(),
                    theme: None,
                    deliberate_folders: Vec::new(),
                    auto_lock_seconds: None,
                    custom_theme: None,
                    daily_date_format: None,
                    daily_folder: None,
                    daily_template: None,
                    favorites: Vec::new(),
                    item_order: Vec::new(),
                    keymap: Default::default(),
                    active_workspace: None,
                    archive_disabled: None,
                    editor_layout: None,
                    editor_line_numbers: None,
                    editor_content_width: None,
                    editor_default_view_mode: None,
                    editor_focus_dim_inactive: None,
                    editor_focus_typewriter: None,
                    editor_font_family: None,
                    editor_line_spacing: None,
                    editor_text_size: None,
                    label: None,
                    last_backup_at: None,
                    new_note_location: None,
                    new_note_location_folder: None,
                    paired_extensions: Vec::new(),
                    right_panel_active_tab: None,
                    right_panel_hidden_tabs: Vec::new(),
                    right_panel_tab_order: Vec::new(),
                    spell_enabled: None,
                    spell_languages: Vec::new(),
                    startup_open: None,
                    startup_open_note: None,
                    saved_views: Vec::new(),
                    view_order: Vec::new(),
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
            let result =
                set_auto_lock_timeout_with_dir(tmp.path(), &state, &noop_hooks(), 300).await;
            assert!(matches!(result, Err(PrefsWriteError::SlotNotUnlocked)));
        });
    }

    #[test]
    fn auto_lock_timeout_round_trips_and_caches_effective() {
        rt().block_on(async {
            let (tmp, state) = make_temp_vault_with_unlocked_state(0x33).await;

            set_auto_lock_timeout_with_dir(tmp.path(), &state, &noop_hooks(), 900)
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

    // The clamp-WIRING test (`set_auto_lock_timeout_stores_raw_but_caches_clamped`)
    // asserts the cached effective timeout is clamped to the desktop ceiling. The
    // clamp is desktop-only (`auto_lock`), so that test lives desktop-side
    // (`src-tauri/src/plugins/prefs/mod.rs` tests) where a real clamping hook is
    // available; the clamp function itself is unit-tested in `auto_lock.rs`.

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

    // ---- AI prefs setters (local-ai, ai-ux-surface MYND-408) ----------

    #[test]
    fn ai_prefs_round_trip_via_set_then_read() {
        rt().block_on(async {
            let (tmp, state) = make_temp_vault_with_unlocked_state(0x51).await;

            // Defaults: AI off, no exclusions.
            let base = prefs_read_with_dir(tmp.path(), &state).await.expect("read");
            assert!(!base.ai_enabled);
            assert!(base.ai_excluded_folders.is_empty());

            // Enable + set exclusions (unsorted input).
            set_ai_enabled_with_dir(tmp.path(), &state, true)
                .await
                .expect("enable must succeed");
            set_ai_excluded_folders_with_dir(
                tmp.path(),
                &state,
                alloc_vec(["Private/", "Archive/2025/"]),
            )
            .await
            .expect("set exclusions must succeed");

            let view = prefs_read_with_dir(tmp.path(), &state)
                .await
                .expect("read after write");
            assert!(view.ai_enabled);
            // Canonical sort applies at encode → read-back is sorted.
            assert_eq!(
                view.ai_excluded_folders,
                alloc_vec(["Archive/2025/", "Private/"]),
            );
            // Unrelated fields untouched (defaults on).
            assert!(view.screen_capture_protection);

            // Disable + clear → back to defaults (byte-identical to pre-field).
            set_ai_enabled_with_dir(tmp.path(), &state, false)
                .await
                .expect("disable must succeed");
            set_ai_excluded_folders_with_dir(tmp.path(), &state, Vec::new())
                .await
                .expect("clear must succeed");
            let cleared = prefs_read_with_dir(tmp.path(), &state)
                .await
                .expect("read after clear");
            assert!(!cleared.ai_enabled);
            assert!(cleared.ai_excluded_folders.is_empty());
        });
    }

    // ---- "Files" panel setters (MYND-462) -----------------------------

    #[test]
    fn set_new_note_location_rejects_when_slot_empty() {
        rt().block_on(async {
            let tmp = ScopedTempDir::new("prefs-newnote-empty").expect("scoped tempdir");
            let state = VaultRuntimeState::default();
            let result =
                set_new_note_location_with_dir(tmp.path(), &state, Some("root".to_string()), None)
                    .await;
            assert!(matches!(result, Err(PrefsWriteError::SlotNotUnlocked)));
        });
    }

    #[test]
    fn set_startup_open_rejects_when_slot_empty() {
        rt().block_on(async {
            let tmp = ScopedTempDir::new("prefs-startup-empty").expect("scoped tempdir");
            let state = VaultRuntimeState::default();
            let result =
                set_startup_open_with_dir(tmp.path(), &state, Some("last".to_string()), None).await;
            assert!(matches!(result, Err(PrefsWriteError::SlotNotUnlocked)));
        });
    }

    #[test]
    fn new_note_location_specific_registers_deliberate_folder() {
        rt().block_on(async {
            let (tmp, state) = make_temp_vault_with_unlocked_state(0x44).await;

            // "specific" mode with a target folder: the pair round-trips AND the
            // folder is registered as a deliberate folder so it survives empty.
            set_new_note_location_with_dir(
                tmp.path(),
                &state,
                Some("specific".to_string()),
                Some("Inbox/".to_string()),
            )
            .await
            .expect("write must succeed");

            let view = prefs_read_with_dir(tmp.path(), &state)
                .await
                .expect("read must succeed after write");
            assert_eq!(view.new_note_location.as_deref(), Some("specific"));
            assert_eq!(view.new_note_location_folder.as_deref(), Some("Inbox/"));
            assert!(view.deliberate_folders.contains(&"Inbox/".to_string()));

            // Switching back to "root" clears the target (caller passes None).
            set_new_note_location_with_dir(tmp.path(), &state, Some("root".to_string()), None)
                .await
                .expect("second write must succeed");
            let view = prefs_read_with_dir(tmp.path(), &state)
                .await
                .expect("read after second write");
            assert_eq!(view.new_note_location.as_deref(), Some("root"));
            assert_eq!(view.new_note_location_folder, None);
            // The deliberate folder persists (designating then un-designating a
            // folder does not delete it — the daily_folder discipline).
            assert!(view.deliberate_folders.contains(&"Inbox/".to_string()));
        });
    }

    #[test]
    fn startup_open_specific_round_trips_through_disk() {
        rt().block_on(async {
            let (tmp, state) = make_temp_vault_with_unlocked_state(0x45).await;

            set_startup_open_with_dir(
                tmp.path(),
                &state,
                Some("specific".to_string()),
                Some("0192f1a0-0000-7000-8000-000000000000".to_string()),
            )
            .await
            .expect("write must succeed");

            let view = prefs_read_with_dir(tmp.path(), &state)
                .await
                .expect("read must succeed after write");
            assert_eq!(view.startup_open.as_deref(), Some("specific"));
            assert_eq!(
                view.startup_open_note.as_deref(),
                Some("0192f1a0-0000-7000-8000-000000000000")
            );

            // "empty" mode clears the note pointer (caller passes None).
            set_startup_open_with_dir(tmp.path(), &state, Some("empty".to_string()), None)
                .await
                .expect("second write must succeed");
            let view = prefs_read_with_dir(tmp.path(), &state)
                .await
                .expect("read after second write");
            assert_eq!(view.startup_open.as_deref(), Some("empty"));
            assert_eq!(view.startup_open_note, None);
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

    // ---- hidden_bar_items setter (bottom-bar customization) -----------

    #[test]
    fn set_hidden_bar_items_rejects_when_slot_empty() {
        rt().block_on(async {
            let tmp = ScopedTempDir::new("prefs-hidden-bar-empty").expect("scoped tempdir");
            let state = VaultRuntimeState::default();
            let result =
                set_hidden_bar_items_with_dir(tmp.path(), &state, alloc_vec(["graph"])).await;
            assert!(matches!(result, Err(PrefsWriteError::SlotNotUnlocked)));
        });
    }

    #[test]
    fn hidden_bar_items_round_trips_as_canonicalized_set() {
        rt().block_on(async {
            let (tmp, state) = make_temp_vault_with_unlocked_state(0x44).await;

            // hidden_bar_items is a SET — the codec sorts + dedupes on encode,
            // so an out-of-order, duplicated input reads back canonicalized.
            set_hidden_bar_items_with_dir(
                tmp.path(),
                &state,
                alloc_vec(["word-count", "graph", "graph"]),
            )
            .await
            .expect("write hidden_bar_items");

            let view = prefs_read_with_dir(tmp.path(), &state)
                .await
                .expect("read after hidden_bar_items write");
            assert_eq!(view.hidden_bar_items, alloc_vec(["graph", "word-count"]));
            assert!(view.screen_capture_protection);

            // Clearing round-trips back to empty (bar fully visible default).
            set_hidden_bar_items_with_dir(tmp.path(), &state, Vec::new())
                .await
                .expect("clear hidden_bar_items");
            let cleared = prefs_read_with_dir(tmp.path(), &state)
                .await
                .expect("read after clear");
            assert!(cleared.hidden_bar_items.is_empty());
        });
    }

    // ---- saved-view CRUD (MYND-273) -----------------------------------

    fn test_view(id: &str, name: &str) -> SavedView {
        use protocol::{FilterNode, ViewType};
        SavedView {
            id: String::from(id),
            name: String::from(name),
            view_type: ViewType::Cards,
            filters: FilterNode::InFolder {
                path: String::from("Books/"),
            },
            sort: None,
            group_by: None,
            columns: alloc_vec(["author"]),
            card_size: Some(300),
            image: Some(String::from("image")),
            image_aspect_ratio: Some(String::from("1.65")),
        }
    }

    #[test]
    fn upsert_saved_view_rejects_when_slot_empty() {
        rt().block_on(async {
            let tmp = ScopedTempDir::new("prefs-sv-empty").expect("scoped tempdir");
            let state = VaultRuntimeState::default();
            let result = upsert_saved_view_with_dir(tmp.path(), &state, test_view("v1", "A")).await;
            assert!(matches!(result, Err(PrefsWriteError::SlotNotUnlocked)));
        });
    }

    #[test]
    fn upsert_saved_view_round_trips_and_edits_by_id() {
        rt().block_on(async {
            let (tmp, state) = make_temp_vault_with_unlocked_state(0x44).await;

            // Save v1 → read returns it.
            upsert_saved_view_with_dir(tmp.path(), &state, test_view("v1", "Books"))
                .await
                .expect("save v1");
            let view = prefs_read_with_dir(tmp.path(), &state).await.expect("read");
            assert_eq!(view.saved_views.len(), 1);
            assert_eq!(view.saved_views[0].name, "Books");

            // Edit v1 (same id, new name) → still one view, updated (no duplicate).
            upsert_saved_view_with_dir(tmp.path(), &state, test_view("v1", "Reading"))
                .await
                .expect("edit v1");
            let view = prefs_read_with_dir(tmp.path(), &state).await.expect("read");
            assert_eq!(view.saved_views.len(), 1);
            assert_eq!(view.saved_views[0].name, "Reading");

            // Save a second view → two distinct entries.
            upsert_saved_view_with_dir(tmp.path(), &state, test_view("v2", "Films"))
                .await
                .expect("save v2");
            let view = prefs_read_with_dir(tmp.path(), &state).await.expect("read");
            assert_eq!(view.saved_views.len(), 2);
            // The pre-existing screen_capture default is untouched.
            assert!(view.screen_capture_protection);
        });
    }

    // The browser-clipper paired-extension persistence acceptance tests
    // (`paired_extensions_persist_and_read_round_trip_valid_and_revoked` +
    // `paired_extensions_persist_rejects_when_slot_empty`) exercise the core
    // `persist_paired_extensions_with_dir` path but build/validate the records
    // through the desktop-only `clipper::token::TokenRegistry`, so they live
    // desktop-side (`src-tauri/src/plugins/prefs/mod.rs` tests). The protocol
    // round-trip of the `paired_extensions` field is covered in `protocol`.

    #[test]
    fn upsert_over_cap_fails_and_leaves_prior_prefs_intact() {
        // Story 13: a save whose encoded prefs exceeds the 64 KiB §9.5.4 cap
        // fails PrefsEncodeFailed BEFORE the atomic write — the prior on-disk
        // view set is untouched.
        rt().block_on(async {
            let (tmp, state) = make_temp_vault_with_unlocked_state(0x45).await;
            upsert_saved_view_with_dir(tmp.path(), &state, test_view("v1", "Small"))
                .await
                .expect("save small");

            // A view with a >64 KiB name blows the cap on encode.
            let mut huge = test_view("v2", "");
            huge.name = "x".repeat(70 * 1024);
            let result = upsert_saved_view_with_dir(tmp.path(), &state, huge).await;
            assert!(matches!(result, Err(PrefsWriteError::PrefsEncodeFailed)));

            // Prior prefs intact: still exactly the one small view.
            let view = prefs_read_with_dir(tmp.path(), &state).await.expect("read");
            assert_eq!(view.saved_views.len(), 1);
            assert_eq!(view.saved_views[0].id, "v1");
        });
    }

    #[test]
    fn delete_and_set_view_order_reject_when_slot_empty() {
        rt().block_on(async {
            let tmp = ScopedTempDir::new("prefs-sv-del-empty").expect("scoped tempdir");
            let state = VaultRuntimeState::default();
            assert!(matches!(
                delete_saved_view_with_dir(tmp.path(), &state, String::from("v1")).await,
                Err(PrefsWriteError::SlotNotUnlocked)
            ));
            assert!(matches!(
                set_view_order_with_dir(tmp.path(), &state, alloc_vec(["v1"])).await,
                Err(PrefsWriteError::SlotNotUnlocked)
            ));
        });
    }

    #[test]
    fn delete_saved_view_removes_and_prunes_view_order() {
        rt().block_on(async {
            let (tmp, state) = make_temp_vault_with_unlocked_state(0x46).await;
            upsert_saved_view_with_dir(tmp.path(), &state, test_view("v1", "A"))
                .await
                .expect("save v1");
            upsert_saved_view_with_dir(tmp.path(), &state, test_view("v2", "B"))
                .await
                .expect("save v2");
            set_view_order_with_dir(tmp.path(), &state, alloc_vec(["v2", "v1"]))
                .await
                .expect("order");

            // Delete v1 → gone from saved_views AND pruned from view_order.
            delete_saved_view_with_dir(tmp.path(), &state, String::from("v1"))
                .await
                .expect("delete v1");
            let view = prefs_read_with_dir(tmp.path(), &state).await.expect("read");
            assert_eq!(view.saved_views.len(), 1);
            assert_eq!(view.saved_views[0].id, "v2");
            assert_eq!(view.view_order, alloc_vec(["v2"]));

            // Deleting an absent id is an idempotent no-op success.
            delete_saved_view_with_dir(tmp.path(), &state, String::from("ghost"))
                .await
                .expect("delete absent is ok");
            let view = prefs_read_with_dir(tmp.path(), &state).await.expect("read");
            assert_eq!(view.saved_views.len(), 1);
        });
    }

    #[test]
    fn set_view_order_preserves_sequence_verbatim_no_gc() {
        rt().block_on(async {
            let (tmp, state) = make_temp_vault_with_unlocked_state(0x47).await;
            // A reorder over ids that don't (yet) exist is tolerated — no codec GC.
            set_view_order_with_dir(tmp.path(), &state, alloc_vec(["v3", "v1", "v3"]))
                .await
                .expect("set order");
            let view = prefs_read_with_dir(tmp.path(), &state).await.expect("read");
            assert_eq!(view.view_order, alloc_vec(["v3", "v1", "v3"]));
        });
    }

    // ---- bar_items_order setter (bottom-bar reorder) ------------------

    #[test]
    fn set_bar_items_order_rejects_when_slot_empty() {
        rt().block_on(async {
            let tmp = ScopedTempDir::new("prefs-bar-order-empty").expect("scoped tempdir");
            let state = VaultRuntimeState::default();
            let result =
                set_bar_items_order_with_dir(tmp.path(), &state, alloc_vec(["graph"])).await;
            assert!(matches!(result, Err(PrefsWriteError::SlotNotUnlocked)));
        });
    }

    #[test]
    fn set_bar_items_order_preserves_sequence_verbatim() {
        rt().block_on(async {
            let (tmp, state) = make_temp_vault_with_unlocked_state(0x49).await;
            // Sequence semantics — order is the payload, preserved verbatim
            // (NOT sorted/deduped, unlike the hidden_bar_items set).
            set_bar_items_order_with_dir(
                tmp.path(),
                &state,
                alloc_vec(["word-count", "graph", "tags", "view-mode"]),
            )
            .await
            .expect("set order");
            let view = prefs_read_with_dir(tmp.path(), &state).await.expect("read");
            assert_eq!(
                view.bar_items_order,
                alloc_vec(["word-count", "graph", "tags", "view-mode"])
            );

            // Clearing round-trips back to empty.
            set_bar_items_order_with_dir(tmp.path(), &state, Vec::new())
                .await
                .expect("clear order");
            let cleared = prefs_read_with_dir(tmp.path(), &state).await.expect("read");
            assert!(cleared.bar_items_order.is_empty());
        });
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

    #[test]
    fn set_custom_theme_rejects_when_slot_empty() {
        rt().block_on(async {
            let tmp = ScopedTempDir::new("prefs-custom-theme-empty").expect("scoped tempdir");
            let state = VaultRuntimeState::default();
            let result =
                set_custom_theme_with_dir(tmp.path(), &state, Some(String::from("solarized")))
                    .await;
            assert!(matches!(result, Err(PrefsWriteError::SlotNotUnlocked)));
        });
    }

    #[test]
    fn custom_theme_round_trips_and_coexists_with_theme() {
        rt().block_on(async {
            let (tmp, state) = make_temp_vault_with_unlocked_state(0x33).await;

            // Select a custom theme (disk-first) + round-trip.
            set_custom_theme_with_dir(tmp.path(), &state, Some(String::from("solarized-dark")))
                .await
                .expect("write custom_theme");
            let view = prefs_read_with_dir(tmp.path(), &state)
                .await
                .expect("read after custom_theme write");
            assert_eq!(view.custom_theme.as_deref(), Some("solarized-dark"));

            // A built-in theme can be set alongside it; both persist (precedence
            // — custom_theme winning — is resolved client-side).
            set_theme_with_dir(tmp.path(), &state, Some(ThemeChoice::Dark))
                .await
                .expect("write theme");
            let view = prefs_read_with_dir(tmp.path(), &state)
                .await
                .expect("read after theme write");
            assert_eq!(view.custom_theme.as_deref(), Some("solarized-dark"));
            assert_eq!(view.theme, Some(ThemeChoice::Dark));

            // Clearing custom_theme (None) drops the field back to "no custom".
            set_custom_theme_with_dir(tmp.path(), &state, None)
                .await
                .expect("clear custom_theme");
            let view = prefs_read_with_dir(tmp.path(), &state)
                .await
                .expect("read after clear");
            assert_eq!(view.custom_theme, None);
            assert_eq!(view.theme, Some(ThemeChoice::Dark));
        });
    }

    // ---- editor-typography setters ------------------------------------

    #[test]
    fn set_editor_text_size_rejects_when_slot_empty() {
        rt().block_on(async {
            let tmp = ScopedTempDir::new("prefs-typo-empty").expect("scoped tempdir");
            let state = VaultRuntimeState::default();
            let result =
                set_typography_field_with_dir(tmp.path(), &state, "editor_text_size", |p| {
                    p.editor_text_size = Some(String::from("lg"));
                })
                .await;
            assert!(matches!(result, Err(PrefsWriteError::SlotNotUnlocked)));
        });
    }

    #[test]
    fn typography_presets_round_trip_via_set_then_read() {
        rt().block_on(async {
            let (tmp, state) = make_temp_vault_with_unlocked_state(0x44).await;

            set_typography_field_with_dir(tmp.path(), &state, "editor_text_size", |p| {
                p.editor_text_size = Some(String::from("lg"));
            })
            .await
            .expect("write text size");
            set_typography_field_with_dir(tmp.path(), &state, "editor_font_family", |p| {
                p.editor_font_family = Some(String::from("sans"));
            })
            .await
            .expect("write font family");
            assert!(tmp.path().join("vault.prefs").exists());

            let view = prefs_read_with_dir(tmp.path(), &state)
                .await
                .expect("read after typography write");
            assert_eq!(view.editor_text_size.as_deref(), Some("lg"));
            assert_eq!(view.editor_font_family.as_deref(), Some("sans"));
            // Pre-existing defaults untouched.
            assert!(view.screen_capture_protection);

            // None clears the field back to the default (omitted on disk).
            set_typography_field_with_dir(tmp.path(), &state, "editor_text_size", |p| {
                p.editor_text_size = None;
            })
            .await
            .expect("clear text size");
            let view = prefs_read_with_dir(tmp.path(), &state)
                .await
                .expect("read after clear");
            assert_eq!(view.editor_text_size, None);
            assert_eq!(view.editor_font_family.as_deref(), Some("sans"));
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

    // ---- show_note_timestamps setter (sidebar-note-timestamps) --------

    #[test]
    fn set_show_note_timestamps_rejects_when_slot_empty() {
        rt().block_on(async {
            let tmp = ScopedTempDir::new("prefs-timestamps-empty").expect("scoped tempdir");
            let state = VaultRuntimeState::default();
            let result = set_show_note_timestamps_with_dir(tmp.path(), &state, false).await;
            assert!(matches!(result, Err(PrefsWriteError::SlotNotUnlocked)));
        });
    }

    #[test]
    fn show_note_timestamps_round_trips_via_set_then_read() {
        rt().block_on(async {
            let (tmp, state) = make_temp_vault_with_unlocked_state(0x45).await;

            // Default (no write yet) reads back as `true` (visible).
            let view = prefs_read_with_dir(tmp.path(), &state)
                .await
                .expect("read default");
            assert!(view.show_note_timestamps);

            // Turn OFF persists (disk-first) + round-trips.
            set_show_note_timestamps_with_dir(tmp.path(), &state, false)
                .await
                .expect("write off");
            let view = prefs_read_with_dir(tmp.path(), &state)
                .await
                .expect("read after off");
            assert!(!view.show_note_timestamps);
            // Pre-existing screen_capture default untouched.
            assert!(view.screen_capture_protection);

            // Turn back ON overwrites (re-encodes byte-identical to pre-feature).
            set_show_note_timestamps_with_dir(tmp.path(), &state, true)
                .await
                .expect("write on");
            let view = prefs_read_with_dir(tmp.path(), &state)
                .await
                .expect("read after on");
            assert!(view.show_note_timestamps);
        });
    }

    // ---- editor_line_numbers setter (editor-line-numbers, MYND-314) ---

    #[test]
    fn set_editor_line_numbers_rejects_when_slot_empty() {
        rt().block_on(async {
            let tmp = ScopedTempDir::new("prefs-line-numbers-empty").expect("scoped tempdir");
            let state = VaultRuntimeState::default();
            let result = set_editor_line_numbers_with_dir(tmp.path(), &state, true).await;
            assert!(matches!(result, Err(PrefsWriteError::SlotNotUnlocked)));
        });
    }

    #[test]
    fn editor_line_numbers_round_trips_via_set_then_read() {
        rt().block_on(async {
            let (tmp, state) = make_temp_vault_with_unlocked_state(0x46).await;

            // Default (no write yet) reads back as `None` (host default-OFF).
            let view = prefs_read_with_dir(tmp.path(), &state)
                .await
                .expect("read default");
            assert_eq!(view.editor_line_numbers, None);

            // Turn ON persists (disk-first) + round-trips.
            set_editor_line_numbers_with_dir(tmp.path(), &state, true)
                .await
                .expect("write on");
            let view = prefs_read_with_dir(tmp.path(), &state)
                .await
                .expect("read after on");
            assert_eq!(view.editor_line_numbers, Some(true));
            // Pre-existing screen_capture default untouched.
            assert!(view.screen_capture_protection);

            // Turn OFF overwrites (explicit Some(false), not back to None).
            set_editor_line_numbers_with_dir(tmp.path(), &state, false)
                .await
                .expect("write off");
            let view = prefs_read_with_dir(tmp.path(), &state)
                .await
                .expect("read after off");
            assert_eq!(view.editor_line_numbers, Some(false));
        });
    }

    // ---- archive_disabled setter (archive-disable, MYND-…) ------------

    #[test]
    fn set_archive_disabled_rejects_when_slot_empty() {
        rt().block_on(async {
            let tmp = ScopedTempDir::new("prefs-archive-disabled-empty").expect("scoped tempdir");
            let state = VaultRuntimeState::default();
            let result = set_archive_disabled_with_dir(tmp.path(), &state, true).await;
            assert!(matches!(result, Err(PrefsWriteError::SlotNotUnlocked)));
        });
    }

    #[test]
    fn archive_disabled_round_trips_via_set_then_read() {
        rt().block_on(async {
            let (tmp, state) = make_temp_vault_with_unlocked_state(0x47).await;

            // Default (no write yet) reads back as `None` (host default-OFF —
            // archiving enabled).
            let view = prefs_read_with_dir(tmp.path(), &state)
                .await
                .expect("read default");
            assert_eq!(view.archive_disabled, None);

            // Turn ON persists (disk-first) + round-trips.
            set_archive_disabled_with_dir(tmp.path(), &state, true)
                .await
                .expect("write on");
            let view = prefs_read_with_dir(tmp.path(), &state)
                .await
                .expect("read after on");
            assert_eq!(view.archive_disabled, Some(true));
            // Pre-existing screen_capture default untouched.
            assert!(view.screen_capture_protection);

            // Turn OFF overwrites (explicit Some(false), not back to None).
            set_archive_disabled_with_dir(tmp.path(), &state, false)
                .await
                .expect("write off");
            let view = prefs_read_with_dir(tmp.path(), &state)
                .await
                .expect("read after off");
            assert_eq!(view.archive_disabled, Some(false));
        });
    }

    // ---- batch editor setters (MYND-308 / MYND-299 / MYND-348) --------

    #[test]
    fn set_editor_focus_dim_inactive_rejects_when_slot_empty() {
        rt().block_on(async {
            let tmp = ScopedTempDir::new("prefs-focus-dim-empty").expect("scoped tempdir");
            let state = VaultRuntimeState::default();
            let result = set_editor_focus_dim_inactive_with_dir(tmp.path(), &state, true).await;
            assert!(matches!(result, Err(PrefsWriteError::SlotNotUnlocked)));
        });
    }

    #[test]
    fn set_editor_focus_typewriter_rejects_when_slot_empty() {
        rt().block_on(async {
            let tmp = ScopedTempDir::new("prefs-focus-tw-empty").expect("scoped tempdir");
            let state = VaultRuntimeState::default();
            let result = set_editor_focus_typewriter_with_dir(tmp.path(), &state, true).await;
            assert!(matches!(result, Err(PrefsWriteError::SlotNotUnlocked)));
        });
    }

    #[test]
    fn editor_focus_toggles_round_trip_via_set_then_read() {
        rt().block_on(async {
            let (tmp, state) = make_temp_vault_with_unlocked_state(0x47).await;

            // Default (no write yet) reads back as `None`.
            let view = prefs_read_with_dir(tmp.path(), &state)
                .await
                .expect("read default");
            assert_eq!(view.editor_focus_dim_inactive, None);
            assert_eq!(view.editor_focus_typewriter, None);

            // Enable both persists (disk-first) + round-trips.
            set_editor_focus_dim_inactive_with_dir(tmp.path(), &state, true)
                .await
                .expect("write dim on");
            set_editor_focus_typewriter_with_dir(tmp.path(), &state, false)
                .await
                .expect("write typewriter off");
            let view = prefs_read_with_dir(tmp.path(), &state)
                .await
                .expect("read after writes");
            assert_eq!(view.editor_focus_dim_inactive, Some(true));
            assert_eq!(view.editor_focus_typewriter, Some(false));
            // Pre-existing screen_capture default untouched.
            assert!(view.screen_capture_protection);
        });
    }

    #[test]
    fn active_workspace_and_default_view_mode_round_trip_via_set_then_read() {
        rt().block_on(async {
            let (tmp, state) = make_temp_vault_with_unlocked_state(0x48).await;

            // Set both string fields (via the shared typography core, the
            // command wrappers' read-modify-write helper).
            set_typography_field_with_dir(tmp.path(), &state, "active_workspace", |p| {
                p.active_workspace = Some(String::from("ws-7"));
            })
            .await
            .expect("write active_workspace");
            set_typography_field_with_dir(tmp.path(), &state, "editor_default_view_mode", |p| {
                p.editor_default_view_mode = Some(String::from("reading"));
            })
            .await
            .expect("write default view mode");

            let view = prefs_read_with_dir(tmp.path(), &state)
                .await
                .expect("read after writes");
            assert_eq!(view.active_workspace.as_deref(), Some("ws-7"));
            assert_eq!(view.editor_default_view_mode.as_deref(), Some("reading"));
            assert!(view.screen_capture_protection);

            // None clears active_workspace back to the default (omitted on disk).
            set_typography_field_with_dir(tmp.path(), &state, "active_workspace", |p| {
                p.active_workspace = None;
            })
            .await
            .expect("clear active_workspace");
            let view = prefs_read_with_dir(tmp.path(), &state)
                .await
                .expect("read after clear");
            assert_eq!(view.active_workspace, None);
            assert_eq!(view.editor_default_view_mode.as_deref(), Some("reading"));
        });
    }

    // ---- set_keymap_binding setter (hotkeys epic, MYND-304) -----------

    #[test]
    fn set_keymap_binding_rejects_when_slot_empty() {
        rt().block_on(async {
            let tmp = ScopedTempDir::new("prefs-keymap-empty").expect("scoped tempdir");
            let state = VaultRuntimeState::default();
            let result = set_keymap_binding_with_dir(
                tmp.path(),
                &state,
                "graph.show".to_string(),
                Some(vec!["Mod-Shift-g".to_string()]),
            )
            .await;
            assert!(matches!(result, Err(PrefsWriteError::SlotNotUnlocked)));
        });
    }

    #[test]
    fn keymap_binding_round_trips_three_states() {
        rt().block_on(async {
            let (tmp, state) = make_temp_vault_with_unlocked_state(0x4B).await;

            // Default (no write yet) reads back as an empty keymap.
            let view = prefs_read_with_dir(tmp.path(), &state)
                .await
                .expect("read default");
            assert!(view.keymap.is_empty());

            // Override: Some(non-empty) persists; codec NFC-sorts + dedupes the
            // chord set (caller order/dupes collapse to canonical form).
            set_keymap_binding_with_dir(
                tmp.path(),
                &state,
                "app.command-palette".to_string(),
                Some(vec![
                    "Mod-p".to_string(),
                    "Mod-k".to_string(),
                    "Mod-p".to_string(),
                ]),
            )
            .await
            .expect("write override");
            let view = prefs_read_with_dir(tmp.path(), &state)
                .await
                .expect("read after override");
            assert_eq!(
                view.keymap.get("app.command-palette"),
                Some(&vec!["Mod-k".to_string(), "Mod-p".to_string()])
            );
            // Pre-existing screen_capture default untouched.
            assert!(view.screen_capture_protection);

            // Explicit-unbind: Some(empty) persists `[]` (distinct from absent).
            set_keymap_binding_with_dir(
                tmp.path(),
                &state,
                "vault.lock".to_string(),
                Some(Vec::new()),
            )
            .await
            .expect("write unbind");
            let view = prefs_read_with_dir(tmp.path(), &state)
                .await
                .expect("read after unbind");
            assert_eq!(view.keymap.get("vault.lock"), Some(&Vec::<String>::new()));
            // The earlier override is independent + untouched.
            assert_eq!(
                view.keymap.get("app.command-palette"),
                Some(&vec!["Mod-k".to_string(), "Mod-p".to_string()])
            );

            // Remove: None drops the entry (revert to the code default).
            set_keymap_binding_with_dir(
                tmp.path(),
                &state,
                "app.command-palette".to_string(),
                None,
            )
            .await
            .expect("write remove");
            let view = prefs_read_with_dir(tmp.path(), &state)
                .await
                .expect("read after remove");
            assert!(!view.keymap.contains_key("app.command-palette"));
            // The unbind entry survives the unrelated remove.
            assert_eq!(view.keymap.get("vault.lock"), Some(&Vec::<String>::new()));
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

    // ---- vault_set_icon setter (vault-icons) ---------------------------

    /// Unlock-gating: with no vault unlocked, `vault_set_icon` rejects with
    /// `SlotNotUnlocked` (writing the icon needs `prefs_key`, only present for
    /// the active/sole-`Unlocked` vault). Same structural gate as the label.
    #[test]
    fn vault_set_icon_rejects_when_slot_empty() {
        rt().block_on(async {
            let tmp = ScopedTempDir::new("prefs-icon-empty").expect("scoped tempdir");
            let state = VaultRuntimeState::default();
            let result =
                vault_set_icon_with_dir(tmp.path(), &state, Some(String::from("book"))).await;
            assert!(matches!(result, Err(PrefsWriteError::SlotNotUnlocked)));
        });
    }

    /// The icon round-trips through the encrypted `vault.prefs` (disk-first),
    /// AND the per-session RAM icon cache is refreshed so `vault_list` reflects
    /// the change immediately. Clearing (`None`) round-trips back to no-icon and
    /// evicts the cache entry — the switcher falls back to the neutral wordmark.
    #[test]
    fn vault_set_icon_round_trips_and_updates_cache() {
        rt().block_on(async {
            let (tmp, state) = make_temp_vault_with_unlocked_state(0x33).await;

            // Before any write, the cache holds no icon for the active vault.
            assert_eq!(state.cached_icon(test_vault_id()).await, None);

            // Set an icon — persists on disk + caches in RAM.
            vault_set_icon_with_dir(tmp.path(), &state, Some(String::from("book")))
                .await
                .expect("write icon");
            assert!(
                tmp.path().join("vault.prefs").exists(),
                "vault_set_icon must create vault.prefs"
            );
            let view = prefs_read_with_dir(tmp.path(), &state)
                .await
                .expect("read after icon write");
            assert_eq!(view.icon, Some(String::from("book")));
            // The pre-existing screen_capture default is untouched.
            assert!(view.screen_capture_protection);
            // RAM cache reflects the icon immediately (the switcher source).
            assert_eq!(
                state.cached_icon(test_vault_id()).await,
                Some(String::from("book"))
            );

            // Changing the icon overwrites both disk + cache.
            vault_set_icon_with_dir(tmp.path(), &state, Some(String::from("code")))
                .await
                .expect("change icon");
            let view = prefs_read_with_dir(tmp.path(), &state)
                .await
                .expect("read after change");
            assert_eq!(view.icon, Some(String::from("code")));
            assert_eq!(
                state.cached_icon(test_vault_id()).await,
                Some(String::from("code"))
            );

            // Clearing (None) removes the icon on disk AND evicts the cache.
            vault_set_icon_with_dir(tmp.path(), &state, None)
                .await
                .expect("clear icon");
            let view = prefs_read_with_dir(tmp.path(), &state)
                .await
                .expect("read after clear");
            assert_eq!(view.icon, None);
            assert_eq!(state.cached_icon(test_vault_id()).await, None);
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
