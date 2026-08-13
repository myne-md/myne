//! `workspace` Tauri command handlers (MYND-561, mobile).
//!
//! - [`workspace_read`] — Slot::Unlocked-gated read of the `vault.workspace`
//!   blob; returns the opaque descriptor string, or `None` on absent /
//!   AEAD-fail / unsupported-format / parse-fail per `docs/spec/protocol.md`
//!   § 9.7.4 (the frontend then restores nothing).
//! - [`workspace_write`] — Slot::Unlocked-gated write of the descriptor,
//!   sealed opaque by the codec, under a per-plugin write mutex.
//!
//! ## Why this is mobile-local rather than shared through `myne-core`
//!
//! The desktop client's workspace plugin
//! (`myne/src-tauri/src/plugins/workspace/`) is bound to desktop-crate
//! internals, and hoisting it into `myne-core` would mean migrating desktop
//! onto the shared copy in the same change — a refactor of a live, load-bearing
//! surface (multi-tab/split-pane restore) that a mobile folder-expand feature
//! has no business dragging along. So this is a deliberate second
//! implementation of ~150 lines, the `vault_repair` precedent, and it is
//! CONTENT-compatible by construction: the bytes are produced by the SAME
//! `protocol::encode_workspace_blob` codec under the SAME
//! `SubkeyRole::SessionStateKey`, so the container is identical and only the
//! host wiring differs. If desktop is ever migrated to a shared core, this
//! module is what gets deleted.
//!
//! The descriptor is AS3-Sensitive activity metadata (which folders a user keeps
//! open). It crosses IPC as a `String`; the Zeroizing-wrap + drop discipline
//! (main repo `src-tauri/CLAUDE.md` "Secret-handling logging discipline",
//! Plaintext-IPC pattern) applies.

use super::error::{WorkspaceReadError, WorkspaceWriteError};
use myne_core::plugins::vault_unlock::state::VaultRuntimeState;
use protocol::{
    decode_workspace_blob, derive_subkey, encode_workspace_blob, parse_vault_meta, SubkeyRole,
    WorkspaceBlobError, VAULT_META_ACCOUNT_HASH_LEN,
};
use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use tauri::{AppHandle, Runtime, State};
use tokio::sync::Mutex;
use zeroize::Zeroizing;

/// Per-plugin write serialization (mirrors the prefs / graph-layout plugins).
fn write_mutex() -> &'static Mutex<()> {
    static M: OnceLock<Mutex<()>> = OnceLock::new();
    M.get_or_init(|| Mutex::new(()))
}

/// Resolve the ACTIVE (sole-`Unlocked`) vault's root `vaults/<id>/`. Mirrors
/// `prefs`/`graph_layout`/`search`: the workspace blob always belongs to the
/// unlocked vault, so it must resolve via the active id.
fn vault_dir<R: Runtime>(
    app: &AppHandle<R>,
    active_id: Option<myne_core::vault_id::VaultId>,
) -> std::io::Result<PathBuf> {
    myne_core::paths::active_vault_root_io(app, active_id)
}

/// Read `vault.meta` and return its `account_number_hash` (offset 6). The caller
/// passes the parse-error constructor so read/write land on their own error
/// surface; an IO failure flows through `E: From<io::Error>`.
fn read_account_number_hash<E>(
    meta_path: &Path,
    on_parse_err: impl FnOnce() -> E,
) -> Result<[u8; VAULT_META_ACCOUNT_HASH_LEN], E>
where
    E: From<std::io::Error>,
{
    let bytes = std::fs::read(meta_path)?;
    let meta = parse_vault_meta(&bytes).map_err(|_| on_parse_err())?;
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

/// Read `vault.workspace` and decode under `session_state_key` + AAD. Returns
/// `None` on any failure (absent / AEAD-fail / unsupported / non-UTF-8) per spec
/// § 9.7.4 — the caller restores nothing.
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
                io_kind = ?myne_core::io_failure_kind::from_io_error_kind(e.kind()),
                "vault.workspace read failed; restoring nothing"
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
                    "vault.workspace plaintext not UTF-8; restoring nothing"
                );
                None
            }
        },
        Err(cause) => {
            tracing::warn!(
                event = "workspace_decode_failed",
                reason = workspace_blob_error_kind(&cause),
                "vault.workspace decode failed; restoring nothing"
            );
            None
        }
    }
}

/// Read the persisted workspace descriptor. `Ok(None)` means "nothing to
/// restore" → the frontend keeps its defaults.
#[tauri::command]
pub async fn workspace_read<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, VaultRuntimeState>,
) -> Result<Option<String>, WorkspaceReadError> {
    let dir = vault_dir(&app, state.active_vault_id().await).map_err(WorkspaceReadError::from)?;
    workspace_read_with_dir(&dir, state.inner()).await
}

/// Testable core of [`workspace_read`].
pub async fn workspace_read_with_dir(
    vault_dir: &Path,
    state: &VaultRuntimeState,
) -> Result<Option<String>, WorkspaceReadError> {
    let (root_key, _vmh) = state
        .peek_unlocked_root_key_and_hash_clone()
        .await
        .ok_or(WorkspaceReadError::SlotNotUnlocked)?;

    let account_number_hash = read_account_number_hash(&vault_dir.join("vault.meta"), || {
        WorkspaceReadError::InvalidVaultMeta
    })?;
    let session_state_key = derive_subkey(&root_key, SubkeyRole::SessionStateKey);

    Ok(read_or_none(
        &vault_dir.join("vault.workspace"),
        &session_state_key,
        &account_number_hash,
    ))
}

/// Persist the workspace descriptor (opaque JSON string from the frontend).
#[tauri::command]
pub async fn workspace_write<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, VaultRuntimeState>,
    descriptor: String,
) -> Result<(), WorkspaceWriteError> {
    // First non-doc statement: bound the descriptor (AS3 activity metadata) to a
    // Zeroizing wrapper so every early-return path wipes it.
    let descriptor = Zeroizing::new(descriptor);
    let dir = vault_dir(&app, state.active_vault_id().await).map_err(WorkspaceWriteError::from)?;
    workspace_write_with_dir(&dir, state.inner(), &descriptor).await
}

/// Testable core of [`workspace_write`].
pub async fn workspace_write_with_dir(
    vault_dir: &Path,
    state: &VaultRuntimeState,
    descriptor: &str,
) -> Result<(), WorkspaceWriteError> {
    let _write_guard = write_mutex().lock().await;

    let (root_key, _vmh) = state
        .peek_unlocked_root_key_and_hash_clone()
        .await
        .ok_or(WorkspaceWriteError::SlotNotUnlocked)?;

    let account_number_hash = read_account_number_hash(&vault_dir.join("vault.meta"), || {
        WorkspaceWriteError::InvalidVaultMeta
    })?;
    let session_state_key = derive_subkey(&root_key, SubkeyRole::SessionStateKey);

    let blob_bytes = encode_workspace_blob(
        &session_state_key,
        &account_number_hash,
        descriptor.as_bytes(),
    )
    .map_err(|_| WorkspaceWriteError::WorkspaceEncodeFailed)?;

    myne_core::atomic_write::atomic_write(&vault_dir.join("vault.workspace"), &blob_bytes, true)
        .map_err(WorkspaceWriteError::from)?;

    tracing::info!(event = "workspace_written");
    Ok(())
}
