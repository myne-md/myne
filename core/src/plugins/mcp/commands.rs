// SPDX-License-Identifier: AGPL-3.0-only
//! The Settings surface's two reads (external-mcp-connection, myne-md/myne#923).
//!
//! Everything the external-access section shows comes through here, and the
//! reason is the PRD's own: the counts are a statement about SCOPE, so the host
//! answers them from the same resolver the tools enforce rather than letting the
//! WebView sum a folder list it was handed. [`super::view`] holds the arithmetic
//! and this module holds the two things a command needs and a pure function
//! cannot have: the vault's live index, and the stored prefs.
//!
//! ## Two reads, and no writer
//!
//! `mcp_external_access` is the section. `mcp_grant_preview` is the approval
//! screen's live count while the user ticks exclusions, before anything exists on
//! disk. Neither writes: the writers are `plugin:prefs|set_mcp_connection_grant`
//! and `plugin:prefs|revoke_mcp_connection`, which already own the nonce discipline
//! and the budget refusal. A Settings read that also wrote would be a second
//! writer of `vault.prefs` outside the chokepoint `check-prefs-nonce.mjs` guards.
//!
//! ## Why the error enum is here rather than in `error.rs`
//!
//! [`super::error::McpToolError`] is a WIRE vocabulary: its variants are the
//! `reason` labels a calling agent receives, and every one of them is a statement
//! about a tool call. These two failures are statements about a Settings render,
//! and folding them in would add two labels a client could receive in a
//! `tools/call` result for no reason. One closed enum per command family, as
//! `core/AGENTS.md` requires.

use serde::Serialize;
use std::collections::BTreeMap;

use crate::host::HostCtx;
use crate::plugins::prefs::commands::prefs_read_from_host;
use crate::plugins::prefs::error::PrefsReadError;
use crate::plugins::vault_indices::state::NoteRecord;
use crate::plugins::vault_indices::VaultIndicesState;
use crate::plugins::vault_unlock::state::{SlotKind, VaultRuntimeState};
use crate::vault_io::VaultIo;

use super::view::{external_access_view, grant_preview, McpExternalAccessView, McpGrantPreview};

/// Why a Settings read could not answer.
///
/// No `String` field, per the crate's rule: an error that reaches the WebView
/// carries a label, and the detail goes to `tracing` (none of it here names a
/// path, a folder or a connection).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", content = "detail", rename_all = "camelCase")]
pub enum McpViewError {
    /// The vault locked between opening Settings and this read. The screen
    /// reports it rather than rendering zero connections, which would read as
    /// "nothing is approved".
    VaultLocked,
    /// The index or the prefs blob could not be read. Distinct from
    /// `VaultLocked` because the user's remedy is different.
    Io,
}

/// The section's payload, resolved against the open vault.
pub async fn external_access_from_host(
    host: &dyn HostCtx,
    state: &VaultRuntimeState,
    indices: &VaultIndicesState,
    io: &dyn VaultIo,
) -> Result<McpExternalAccessView, McpViewError> {
    let (prefs, records) = read_vault(host, state, indices, io).await?;
    Ok(external_access_view(&prefs, &records))
}

/// What the candidate grant would cover, before it is written.
pub async fn grant_preview_from_host(
    host: &dyn HostCtx,
    state: &VaultRuntimeState,
    indices: &VaultIndicesState,
    excluded: Vec<String>,
    io: &dyn VaultIo,
) -> Result<McpGrantPreview, McpViewError> {
    let (prefs, records) = read_vault(host, state, indices, io).await?;
    Ok(grant_preview(&prefs, &records, &excluded))
}

/// The two reads both need: the lock check, the prefs blob, the index snapshot.
///
/// One function rather than two copies, so the two commands cannot disagree about
/// which vault they answered from.
async fn read_vault(
    host: &dyn HostCtx,
    state: &VaultRuntimeState,
    indices: &VaultIndicesState,
    io: &dyn VaultIo,
) -> Result<(protocol::PrefsView, BTreeMap<String, NoteRecord>), McpViewError> {
    if !matches!(state.slot_kind_active().await, SlotKind::Unlocked) {
        return Err(McpViewError::VaultLocked);
    }
    let prefs = match prefs_read_from_host(host, state, io).await {
        Ok(prefs) => prefs,
        Err(PrefsReadError::SlotNotUnlocked) => return Err(McpViewError::VaultLocked),
        // Every other prefs failure is `Io`: a screen that said "locked" about an
        // unlocked vault would send the user after the wrong thing.
        Err(PrefsReadError::Io { .. }) | Err(PrefsReadError::InvalidVaultMeta) => {
            return Err(McpViewError::Io)
        }
    };
    Ok((prefs, indices.snapshot()))
}

// ---- the Tauri surface (desktop only) ------------------------------------
//
// Not compiled for wasm32: the MCP surface is a desktop sidecar and a Settings
// section that only exists on desktop, so a browser build would carry two
// commands nothing can reach. The web client's dispatcher classifies the plugin
// as unsupported rather than answering it.

#[cfg(all(feature = "tauri-ipc", not(target_arch = "wasm32")))]
use crate::host::tauri_host::TauriHost;
#[cfg(all(feature = "tauri-ipc", not(target_arch = "wasm32")))]
use tauri::{AppHandle, Runtime, State};

/// The connections list, with each one's resolved read scope and delta.
#[cfg(all(feature = "tauri-ipc", not(target_arch = "wasm32")))]
#[tauri::command]
pub async fn mcp_external_access<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, VaultRuntimeState>,
    indices: State<'_, VaultIndicesState>,
) -> Result<McpExternalAccessView, McpViewError> {
    external_access_from_host(
        &TauriHost::new(app),
        state.inner(),
        indices.inner(),
        &crate::vault_io::StdVaultIo,
    )
    .await
}

/// The approval screen's live count for a candidate exclusion list.
#[cfg(all(feature = "tauri-ipc", not(target_arch = "wasm32")))]
#[tauri::command]
pub async fn mcp_grant_preview<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, VaultRuntimeState>,
    indices: State<'_, VaultIndicesState>,
    excluded: Vec<String>,
) -> Result<McpGrantPreview, McpViewError> {
    grant_preview_from_host(
        &TauriHost::new(app),
        state.inner(),
        indices.inner(),
        excluded,
        &crate::vault_io::StdVaultIo,
    )
    .await
}
