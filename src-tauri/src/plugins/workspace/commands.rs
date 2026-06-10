//! `workspace` Tauri command handlers (MYND-166).
//!
//! - [`workspace_read`] — Slot::Unlocked-gated read of the
//!   `vault.workspace` blob; returns the opaque descriptor string, or
//!   `None` (→ frontend default single empty pane) on absent / AEAD-fail /
//!   unsupported-format / parse-fail per `docs/spec/protocol.md` § 9.7.4.
//! - [`workspace_write`] — Slot::Unlocked-gated write of the descriptor,
//!   serialized opaque by the codec, under a per-plugin write mutex.
//!
//! The descriptor is the desktop client's serialized pane-tree (note IDs +
//! layout + cursor offsets) — AS3-Sensitive. It crosses IPC as a `String`;
//! the Zeroizing-wrap + drop discipline (../../CLAUDE.md "Secret-handling
//! logging discipline", Plaintext-IPC pattern) applies.

use super::error::{WorkspaceReadError, WorkspaceWriteError};
use crate::plugins::vault_unlock::state::VaultRuntimeState;
use protocol::{
    decode_workspace_blob, derive_subkey, encode_workspace_blob, parse_vault_meta, SubkeyRole,
    WorkspaceBlobError, VAULT_META_ACCOUNT_HASH_LEN,
};
use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use tauri::{AppHandle, Runtime, State};
use tokio::sync::Mutex;
use zeroize::Zeroizing;

/// Per-plugin write serialization (mirrors the prefs plugin).
fn write_mutex() -> &'static Mutex<()> {
    static M: OnceLock<Mutex<()>> = OnceLock::new();
    M.get_or_init(|| Mutex::new(()))
}

/// Resolve the ACTIVE (sole-`Unlocked`) vault's root `vaults/<id>/`. `active_id`
/// is read from the runtime state by the calling command
/// (`state.active_vault_id().await`). Mirrors `prefs`/`search`/`notes`: the
/// workspace blob always belongs to the unlocked vault, so it must resolve via
/// the active id — NOT the retired single-vault `<app_data_dir>/vault/` path,
/// which the multi-vault boot migration (MYND-202) removes.
fn vault_dir<R: Runtime>(
    app: &AppHandle<R>,
    active_id: Option<crate::vault_id::VaultId>,
) -> std::io::Result<PathBuf> {
    crate::paths::active_vault_root_io(app, active_id)
}

/// Read `vault.meta` and return its `account_number_hash` (offset 6).
fn read_account_number_hash(
    meta_path: &Path,
) -> Result<[u8; VAULT_META_ACCOUNT_HASH_LEN], WorkspaceReadError> {
    let bytes = std::fs::read(meta_path)?;
    let meta = parse_vault_meta(&bytes).map_err(|_| WorkspaceReadError::InvalidVaultMeta)?;
    Ok(meta.account_number_hash)
}

fn read_account_number_hash_for_write(
    meta_path: &Path,
) -> Result<[u8; VAULT_META_ACCOUNT_HASH_LEN], WorkspaceWriteError> {
    let bytes = std::fs::read(meta_path)?;
    let meta = parse_vault_meta(&bytes).map_err(|_| WorkspaceWriteError::InvalidVaultMeta)?;
    Ok(meta.account_number_hash)
}

/// Closed-enum mapping from `WorkspaceBlobError` to a static log tag.
fn workspace_blob_error_kind(e: &WorkspaceBlobError) -> &'static str {
    match e {
        WorkspaceBlobError::HeaderTooShort => "header_too_short",
        WorkspaceBlobError::MagicMismatch => "magic_mismatch",
        WorkspaceBlobError::ProtocolVersionMismatch => "protocol_version_mismatch",
        WorkspaceBlobError::FormatUnsupported => "format_unsupported",
        WorkspaceBlobError::CiphertextLenOverflow => "ciphertext_len_overflow",
        WorkspaceBlobError::CiphertextTruncated => "ciphertext_truncated",
        WorkspaceBlobError::CannotDecrypt => "aead_fail",
        WorkspaceBlobError::PlaintextTooLarge => "plaintext_too_large",
        WorkspaceBlobError::RandomnessUnavailable => "randomness_unavailable",
        _ => "other_workspace_blob_error",
    }
}

/// Read `vault.workspace` and decode under `session_state_key` + AAD.
/// Returns `None` on any failure (absent / AEAD-fail / unsupported /
/// non-UTF-8) per spec § 9.7.4 — the caller restores the default workspace.
fn read_or_none(
    workspace_path: &Path,
    session_state_key: &[u8; 32],
    account_number_hash: &[u8; VAULT_META_ACCOUNT_HASH_LEN],
) -> Option<String> {
    let bytes = match std::fs::read(workspace_path) {
        Ok(b) => b,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return None,
        Err(e) => {
            tracing::warn!(
                event = "workspace_io_failed",
                stage = "read",
                io_kind = ?crate::io_failure_kind::from_io_error_kind(e.kind()),
                "vault.workspace read failed; falling back to default"
            );
            return None;
        }
    };
    match decode_workspace_blob(session_state_key, account_number_hash, &bytes) {
        Ok(plaintext) => match String::from_utf8(plaintext.to_vec()) {
            Ok(s) => Some(s),
            Err(_) => {
                tracing::warn!(
                    event = "workspace_decode_failed",
                    reason = "non_utf8",
                    "vault.workspace plaintext not UTF-8; falling back to default"
                );
                None
            }
        },
        Err(cause) => {
            tracing::warn!(
                event = "workspace_decode_failed",
                reason = workspace_blob_error_kind(&cause),
                "vault.workspace decode failed; falling back to default"
            );
            None
        }
    }
}

/// Read the persisted editor workspace descriptor. `Ok(None)` means "no
/// restorable workspace" → the frontend opens a single empty pane.
#[tauri::command]
pub async fn workspace_read<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, VaultRuntimeState>,
) -> Result<Option<String>, WorkspaceReadError> {
    let dir = vault_dir(&app, state.active_vault_id().await).map_err(WorkspaceReadError::from)?;
    workspace_read_with_dir(&dir, state.inner()).await
}

/// Testable core of [`workspace_read`].
pub(crate) async fn workspace_read_with_dir(
    vault_dir: &Path,
    state: &VaultRuntimeState,
) -> Result<Option<String>, WorkspaceReadError> {
    let (root_key, _vmh) = state
        .peek_unlocked_root_key_and_hash_clone()
        .await
        .ok_or(WorkspaceReadError::SlotNotUnlocked)?;

    let account_number_hash = read_account_number_hash(&vault_dir.join("vault.meta"))?;
    let session_state_key = derive_subkey(&root_key, SubkeyRole::SessionStateKey);

    Ok(read_or_none(
        &vault_dir.join("vault.workspace"),
        &session_state_key,
        &account_number_hash,
    ))
}

/// Persist the editor workspace descriptor (opaque JSON string from the
/// frontend). Called on graceful exit (lock / auto-lock grace / quit).
#[tauri::command]
pub async fn workspace_write<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, VaultRuntimeState>,
    descriptor: String,
) -> Result<(), WorkspaceWriteError> {
    // First non-doc statement: bound the descriptor (note IDs + layout) to a
    // Zeroizing wrapper so every early-return path wipes it.
    let descriptor = Zeroizing::new(descriptor);
    let dir = vault_dir(&app, state.active_vault_id().await).map_err(WorkspaceWriteError::from)?;
    workspace_write_with_dir(&dir, state.inner(), &descriptor).await
}

/// Testable core of [`workspace_write`].
pub(crate) async fn workspace_write_with_dir(
    vault_dir: &Path,
    state: &VaultRuntimeState,
    descriptor: &str,
) -> Result<(), WorkspaceWriteError> {
    let _write_guard = write_mutex().lock().await;

    let (root_key, _vmh) = state
        .peek_unlocked_root_key_and_hash_clone()
        .await
        .ok_or(WorkspaceWriteError::SlotNotUnlocked)?;

    let account_number_hash = read_account_number_hash_for_write(&vault_dir.join("vault.meta"))?;
    let session_state_key = derive_subkey(&root_key, SubkeyRole::SessionStateKey);

    let blob_bytes = encode_workspace_blob(
        &session_state_key,
        &account_number_hash,
        descriptor.as_bytes(),
    )
    .map_err(|_| WorkspaceWriteError::WorkspaceEncodeFailed)?;

    crate::atomic_write::atomic_write(&vault_dir.join("vault.workspace"), &blob_bytes, true)
        .map_err(WorkspaceWriteError::from)?;

    tracing::info!(event = "workspace_written");
    Ok(())
}

/// Closed-enum mapping from `WorkspaceWriteError` to a static log tag
/// (DENY-list clean; no path / key material).
fn workspace_write_error_kind(e: &WorkspaceWriteError) -> &'static str {
    match e {
        WorkspaceWriteError::SlotNotUnlocked => "slot_not_unlocked",
        WorkspaceWriteError::Io { .. } => "io",
        WorkspaceWriteError::InvalidVaultMeta => "invalid_vault_meta",
        WorkspaceWriteError::WorkspaceEncodeFailed => "encode_failed",
    }
}

/// In-RAM staging slot for the latest workspace descriptor the frontend
/// pushed on its last layout change. Held opaque in a `Zeroizing` wrapper
/// (note IDs are AS3-Sensitive). Staging touches RAM ONLY — never the file —
/// so `vault.workspace`'s mtime stays a low-resolution lock/quit signal (the
/// 2026-06-01 grill); the staged value is flushed to disk solely on exit.
///
/// A `std::sync::Mutex` (not `tokio`) so [`clear_staged_descriptor`] can wipe
/// it synchronously from the lock-teardown sites — the guard is only ever held
/// for a trivial assign/clone, never across an `.await`.
fn staged_descriptor() -> &'static std::sync::Mutex<Option<Zeroizing<String>>> {
    static S: OnceLock<std::sync::Mutex<Option<Zeroizing<String>>>> = OnceLock::new();
    S.get_or_init(|| std::sync::Mutex::new(None))
}

/// Stage the latest workspace descriptor in RAM (no file write, no slot gate
/// — it is just a string until exit). This is the persistence path for app
/// QUIT (Cmd+Q / app-menu Quit), which fires `RunEvent::ExitRequested` but
/// NOT the window's `onCloseRequested` (the frontend's other persist hook),
/// so without staging a quit would silently drop the layout.
#[tauri::command]
pub async fn workspace_stage(descriptor: String) -> Result<(), WorkspaceWriteError> {
    let descriptor = Zeroizing::new(descriptor);
    *staged_descriptor()
        .lock()
        .unwrap_or_else(|e| e.into_inner()) = Some(descriptor);
    Ok(())
}

/// Clear the staged descriptor (drop wipes the `Zeroizing` → erases the AS3
/// note-ids). Wired into EVERY lock-teardown site alongside
/// `search_sync::zeroize_search_index`, so the open-tab metadata never
/// outlives the slot (threat-model A6) and a vault switch (lock A → unlock B)
/// can't leave A's layout staged to flush into B's vault. Sync + infallible
/// (poison-tolerant; the guard is only ever held for a trivial assign).
pub fn clear_staged_descriptor() {
    *staged_descriptor()
        .lock()
        .unwrap_or_else(|e| e.into_inner()) = None;
}

/// Flush the staged descriptor to `vault.workspace` on app exit (best-effort,
/// called from the `RunEvent::ExitRequested` handler). No-op when nothing was
/// staged or the slot is locked (the write requires the root key). Mirrors
/// `notes::search_sync::persist_search_index`'s exit-path shape — resolves the
/// ACTIVE vault root, never the retired single-vault path.
pub async fn persist_workspace_on_exit<R: Runtime>(app: &AppHandle<R>, state: &VaultRuntimeState) {
    let staged = staged_descriptor()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .clone();
    let Some(descriptor) = staged else {
        return;
    };
    let Ok(dir) = vault_dir(app, state.active_vault_id().await) else {
        return;
    };
    if let Err(e) = workspace_write_with_dir(&dir, state, &descriptor).await {
        tracing::warn!(
            event = "workspace_persist_on_exit_skipped",
            reason = workspace_write_error_kind(&e),
        );
    }
}
