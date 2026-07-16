//! `graph_layout` Tauri command handlers.
//!
//! - [`graph_layout_read`] — Slot::Unlocked-gated read of the `vault.graph`
//!   blob; returns the opaque layout payload string, or `None` (→ frontend
//!   recomputes the force layout) on absent / AEAD-fail / unsupported-format /
//!   parse-fail per `docs/spec/protocol.md` § 9.19.4.
//! - [`graph_layout_write`] — Slot::Unlocked-gated write of the payload,
//!   serialized opaque by the codec, under a per-plugin write mutex.
//!
//! The payload is the desktop client's serialized node-position map + a
//! staleness marker. Positions are derived from note structure (who-links-whom)
//! — treated AS3-Sensitive like the workspace descriptor. It crosses IPC as a
//! `String`; the Zeroizing-wrap + drop discipline (../../CLAUDE.md
//! "Secret-handling logging discipline", Plaintext-IPC pattern) applies.

use super::error::{GraphLayoutReadError, GraphLayoutWriteError};
use crate::plugins::vault_unlock::state::VaultRuntimeState;
use protocol::{
    decode_graph_layout_blob, derive_subkey, encode_graph_layout_blob, parse_vault_meta,
    GraphLayoutBlobError, SubkeyRole, VAULT_META_ACCOUNT_HASH_LEN,
};
use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use tauri::{AppHandle, Runtime, State};
use tokio::sync::Mutex;
use zeroize::Zeroizing;

/// Per-plugin write serialization (mirrors the workspace/prefs plugins).
fn write_mutex() -> &'static Mutex<()> {
    static M: OnceLock<Mutex<()>> = OnceLock::new();
    M.get_or_init(|| Mutex::new(()))
}

/// Resolve the ACTIVE (sole-`Unlocked`) vault's root `vaults/<id>/`. Mirrors
/// `workspace`/`prefs`/`search`: the graph blob always belongs to the unlocked
/// vault, so it resolves via the active id.
fn vault_dir<R: Runtime>(
    app: &AppHandle<R>,
    active_id: Option<crate::vault_id::VaultId>,
) -> std::io::Result<PathBuf> {
    crate::paths::active_vault_root_io(app, active_id)
}

/// Read `vault.meta` and return its `account_number_hash` (offset 6). The
/// caller passes the parse-error constructor so read/write land on their own
/// error surface; an IO failure flows through `E: From<io::Error>`.
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

/// Closed-enum mapping from `GraphLayoutBlobError` to a static log tag.
fn graph_layout_blob_error_kind(e: &GraphLayoutBlobError) -> &'static str {
    match e {
        GraphLayoutBlobError::HeaderTooShort => "header_too_short",
        GraphLayoutBlobError::MagicMismatch => "magic_mismatch",
        GraphLayoutBlobError::ProtocolVersionMismatch => "protocol_version_mismatch",
        GraphLayoutBlobError::FormatUnsupported => "format_unsupported",
        GraphLayoutBlobError::CiphertextLenOverflow => "ciphertext_len_overflow",
        GraphLayoutBlobError::CiphertextTruncated => "ciphertext_truncated",
        GraphLayoutBlobError::CannotDecrypt => "aead_fail",
        GraphLayoutBlobError::PlaintextTooLarge => "plaintext_too_large",
        GraphLayoutBlobError::RandomnessUnavailable => "randomness_unavailable",
        _ => "other_graph_layout_blob_error",
    }
}

/// Read `vault.graph` and decode under `graph_layout_key` + AAD. Returns `None`
/// on any failure (absent / AEAD-fail / unsupported / non-UTF-8) per spec
/// § 9.19.4 — the caller recomputes the layout.
fn read_or_none(
    graph_path: &Path,
    graph_layout_key: &[u8; 32],
    account_number_hash: &[u8; VAULT_META_ACCOUNT_HASH_LEN],
) -> Option<String> {
    let bytes = match std::fs::read(graph_path) {
        Ok(b) => b,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return None,
        Err(e) => {
            tracing::warn!(
                event = "graph_layout_io_failed",
                stage = "read",
                io_kind = ?crate::io_failure_kind::from_io_error_kind(e.kind()),
                "vault.graph read failed; recomputing layout"
            );
            return None;
        }
    };
    match decode_graph_layout_blob(graph_layout_key, account_number_hash, &bytes) {
        Ok(plaintext) => match String::from_utf8(plaintext.to_vec()) {
            Ok(s) => Some(s),
            Err(_) => {
                tracing::warn!(
                    event = "graph_layout_decode_failed",
                    reason = "non_utf8",
                    "vault.graph plaintext not UTF-8; recomputing layout"
                );
                None
            }
        },
        Err(cause) => {
            tracing::warn!(
                event = "graph_layout_decode_failed",
                reason = graph_layout_blob_error_kind(&cause),
                "vault.graph decode failed; recomputing layout"
            );
            None
        }
    }
}

/// Read the persisted graph layout payload. `Ok(None)` means "no restorable
/// layout" → the frontend recomputes the force layout.
#[tauri::command]
pub async fn graph_layout_read<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, VaultRuntimeState>,
) -> Result<Option<String>, GraphLayoutReadError> {
    let dir = vault_dir(&app, state.active_vault_id().await).map_err(GraphLayoutReadError::from)?;
    graph_layout_read_with_dir(&dir, state.inner()).await
}

/// Testable core of [`graph_layout_read`].
pub(crate) async fn graph_layout_read_with_dir(
    vault_dir: &Path,
    state: &VaultRuntimeState,
) -> Result<Option<String>, GraphLayoutReadError> {
    let (root_key, _vmh) = state
        .peek_unlocked_root_key_and_hash_clone()
        .await
        .ok_or(GraphLayoutReadError::SlotNotUnlocked)?;

    let account_number_hash = read_account_number_hash(&vault_dir.join("vault.meta"), || {
        GraphLayoutReadError::InvalidVaultMeta
    })?;
    let graph_layout_key = derive_subkey(&root_key, SubkeyRole::GraphLayoutKey);

    Ok(read_or_none(
        &vault_dir.join("vault.graph"),
        &graph_layout_key,
        &account_number_hash,
    ))
}

/// Persist the graph layout payload (opaque JSON string from the frontend).
/// Called after a fresh layout computation / a node drag.
#[tauri::command]
pub async fn graph_layout_write<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, VaultRuntimeState>,
    payload: String,
) -> Result<(), GraphLayoutWriteError> {
    // First non-doc statement: bound the payload (position map derived from
    // note structure) to a Zeroizing wrapper so every early-return path wipes it.
    let payload = Zeroizing::new(payload);
    let dir = vault_dir(&app, state.active_vault_id().await).map_err(GraphLayoutWriteError::from)?;
    graph_layout_write_with_dir(&dir, state.inner(), &payload).await
}

/// Testable core of [`graph_layout_write`].
pub(crate) async fn graph_layout_write_with_dir(
    vault_dir: &Path,
    state: &VaultRuntimeState,
    payload: &str,
) -> Result<(), GraphLayoutWriteError> {
    let _write_guard = write_mutex().lock().await;

    let (root_key, _vmh) = state
        .peek_unlocked_root_key_and_hash_clone()
        .await
        .ok_or(GraphLayoutWriteError::SlotNotUnlocked)?;

    let account_number_hash = read_account_number_hash(&vault_dir.join("vault.meta"), || {
        GraphLayoutWriteError::InvalidVaultMeta
    })?;
    let graph_layout_key = derive_subkey(&root_key, SubkeyRole::GraphLayoutKey);

    let blob_bytes =
        encode_graph_layout_blob(&graph_layout_key, &account_number_hash, payload.as_bytes())
            .map_err(|_| GraphLayoutWriteError::GraphLayoutEncodeFailed)?;

    crate::atomic_write::atomic_write(&vault_dir.join("vault.graph"), &blob_bytes, true)
        .map_err(GraphLayoutWriteError::from)?;

    tracing::info!(event = "graph_layout_written");
    Ok(())
}
