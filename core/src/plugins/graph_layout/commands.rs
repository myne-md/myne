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
use crate::host::HostCtx;
use crate::plugins::vault_unlock::state::VaultRuntimeState;
use crate::vault_io::VaultIo;
use protocol::{
    decode_graph_layout_blob, encode_graph_layout_blob, parse_vault_meta_any, GraphLayoutBlobError,
    SubkeyRole, VAULT_META_ACCOUNT_HASH_LEN,
};
use std::path::{Path, PathBuf};
use std::sync::OnceLock;
// Tauri types serve only the cfg-gated wrappers (phase3-web-client task 79,
// Option B); gated alongside them so a `--no-default-features` build does not
// trip on an import of a dependency that is not there.
#[cfg(all(feature = "tauri-ipc", not(target_arch = "wasm32")))]
use crate::host::tauri_host::TauriHost;
#[cfg(all(feature = "tauri-ipc", not(target_arch = "wasm32")))]
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
/// Resolve the active vault's root. One line over the pure resolver in
/// `crate::paths`.
///
/// The Tauri-shaped `vault_dir<R: Runtime>(&AppHandle<R>, ..)` this replaced is
/// **gone**, not gated: once both wrappers delegate to the host inners, nothing
/// calls it. Clippy caught that, which is a small piece of evidence that the
/// port actually moved the resolution rather than duplicating it.
fn vault_dir_from_host(
    host: &dyn HostCtx,
    active_id: Option<crate::vault_id::VaultId>,
) -> std::io::Result<PathBuf> {
    crate::paths::active_vault_root_io_from_host(host, active_id)
}

/// Read `vault.meta` and return its `account_number_hash` (offset 6). The
/// caller passes the parse-error constructor so read/write land on their own
/// error surface; an IO failure flows through `E: From<io::Error>`.
async fn read_account_number_hash<E>(
    io: &dyn VaultIo,
    meta_path: &Path,
    on_parse_err: impl FnOnce() -> E,
) -> Result<(protocol::MetaVersion, [u8; VAULT_META_ACCOUNT_HASH_LEN]), E>
where
    E: From<crate::io_failure_kind::IoFailureKind>,
{
    // `vault.meta` is a double-buffered singleton on the web store (task 18), so
    // "read it" means "the newest copy that PARSES" — and `parse_vault_meta` is
    // the verifier `open_newest` wants. Native is unchanged by construction:
    // `read_candidates` yields one element there, so this is the same read
    // followed by the same parse.
    match crate::singleton::open_newest(io, meta_path, |candidate| {
        let version = protocol::meta_version_of(candidate).unwrap_or(protocol::MetaVersion::V0_1);
        parse_vault_meta_any(candidate).map(|m| (version, m.account_number_hash))
    })
    .await
    {
        Ok(hash) => Ok(hash),
        // Absence stays an IO answer rather than a parse failure, which is what
        // `std::fs::read` reported here before and what the callers'
        // `Io`/`InvalidVaultMeta` split is built on.
        Err(crate::singleton::OpenOutcome::Absent) => {
            Err(crate::io_failure_kind::IoFailureKind::NotFound.into())
        }
        Err(crate::singleton::OpenOutcome::Io(kind)) => Err(kind.into()),
        Err(crate::singleton::OpenOutcome::Undecodable(_)) => Err(on_parse_err()),
    }
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
async fn read_or_none(
    io: &dyn VaultIo,
    graph_path: &Path,
    graph_layout_key: &[u8; 32],
    account_number_hash: &[u8; VAULT_META_ACCOUNT_HASH_LEN],
) -> Option<String> {
    // Through the SINGLETON fallback (myne#301) — see the twin in
    // `workspace/commands.rs`. A torn slot on the web client otherwise discards
    // the intact copy beside it and the layout is recomputed from scratch.
    use crate::singleton::{open_newest_and_sweep, OpenOutcome};
    let bytes = match open_newest_and_sweep(io, graph_path, |b: &[u8]| {
        decode_graph_layout_blob(graph_layout_key, account_number_hash, b)
            .ok()
            .and_then(|pt| String::from_utf8(pt.to_vec()).ok())
            .ok_or(())
    })
    .await
    {
        Ok(text) => return Some(text),
        Err(OpenOutcome::Absent) => return None,
        Err(OpenOutcome::Io(io_kind)) => {
            tracing::warn!(
                event = "graph_layout_io_failed",
                stage = "read",
                io_kind = ?io_kind,
                "vault.graph read failed; recomputing layout"
            );
            return None;
        }
        // Fall through to the per-cause logging below. Nothing decoded, so
        // nothing was swept.
        Err(OpenOutcome::Undecodable(())) => match io.read(graph_path).await {
            Ok(b) => b,
            Err(_) => return None,
        },
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
/// Host-taking inner. Compiles on every target; differs from the wrapper by the
/// path-resolution line alone.
pub async fn graph_layout_read_from_host(
    host: &dyn HostCtx,
    io: &dyn VaultIo,
    state: &VaultRuntimeState,
) -> Result<Option<String>, GraphLayoutReadError> {
    let dir = vault_dir_from_host(host, state.active_vault_id().await)
        .map_err(GraphLayoutReadError::from)?;
    graph_layout_read_with_dir(io, &dir, state).await
}

#[cfg(all(feature = "tauri-ipc", not(target_arch = "wasm32")))]
#[tauri::command]
pub async fn graph_layout_read<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, VaultRuntimeState>,
) -> Result<Option<String>, GraphLayoutReadError> {
    graph_layout_read_from_host(
        &TauriHost::new(app),
        &crate::vault_io::StdVaultIo,
        state.inner(),
    )
    .await
}

/// Testable core of [`graph_layout_read`].
pub async fn graph_layout_read_with_dir(
    io: &dyn VaultIo,
    vault_dir: &Path,
    state: &VaultRuntimeState,
) -> Result<Option<String>, GraphLayoutReadError> {
    let shared = state
        .peek_unlocked_shared_singleton_key()
        .await
        .ok_or(GraphLayoutReadError::SlotNotUnlocked)?;

    let (meta_version, account_number_hash) =
        read_account_number_hash(io, &vault_dir.join("vault.meta"), || {
            GraphLayoutReadError::InvalidVaultMeta
        })
        .await?;
    let graph_layout_key = shared.derive(meta_version, SubkeyRole::GraphLayoutKey);

    Ok(read_or_none(
        io,
        &vault_dir.join("vault.graph"),
        &graph_layout_key,
        &account_number_hash,
    )
    .await)
}

/// Persist the graph layout payload (opaque JSON string from the frontend).
/// Called after a fresh layout computation / a node drag.
/// Host-taking inner.
///
/// The `Zeroizing` wrap stays the FIRST non-doc statement, exactly as in the
/// wrapper it replaces: the payload is a position map derived from note
/// structure, and every early-return path must wipe it. Moving that line would
/// be a behaviour change hiding inside a "pure move".
pub async fn graph_layout_write_from_host(
    host: &dyn HostCtx,
    io: &dyn VaultIo,
    state: &VaultRuntimeState,
    payload: String,
) -> Result<(), GraphLayoutWriteError> {
    let payload = Zeroizing::new(payload);
    let dir = vault_dir_from_host(host, state.active_vault_id().await)
        .map_err(GraphLayoutWriteError::from)?;
    graph_layout_write_with_dir(io, &dir, state, &payload).await
}

#[cfg(all(feature = "tauri-ipc", not(target_arch = "wasm32")))]
#[tauri::command]
pub async fn graph_layout_write<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, VaultRuntimeState>,
    payload: String,
) -> Result<(), GraphLayoutWriteError> {
    graph_layout_write_from_host(
        &TauriHost::new(app),
        &crate::vault_io::StdVaultIo,
        state.inner(),
        payload,
    )
    .await
}

/// Testable core of [`graph_layout_write`].
pub async fn graph_layout_write_with_dir(
    io: &dyn VaultIo,
    vault_dir: &Path,
    state: &VaultRuntimeState,
    payload: &str,
) -> Result<(), GraphLayoutWriteError> {
    let _write_guard = write_mutex().lock().await;

    let shared = state
        .peek_unlocked_shared_singleton_key()
        .await
        .ok_or(GraphLayoutWriteError::SlotNotUnlocked)?;

    let (meta_version, account_number_hash) =
        read_account_number_hash(io, &vault_dir.join("vault.meta"), || {
            GraphLayoutWriteError::InvalidVaultMeta
        })
        .await?;
    let graph_layout_key = shared.derive(meta_version, SubkeyRole::GraphLayoutKey);

    let blob_bytes =
        encode_graph_layout_blob(&graph_layout_key, &account_number_hash, payload.as_bytes())
            .map_err(|_| GraphLayoutWriteError::GraphLayoutEncodeFailed)?;

    io.write(
        &vault_dir.join("vault.graph"),
        &blob_bytes,
        crate::vault_io::WriteOpts::default(),
    )
    .await
    .map_err(GraphLayoutWriteError::from)?;

    tracing::info!(event = "graph_layout_written");
    Ok(())
}
