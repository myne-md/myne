//! WebView IPC commands for the pairing dialog (TB10, task 4).
//!
//! These are the NARROW Tauri `#[command]`s the in-app pairing dialog drives.
//! TB6 governs them (they ARE WebView→Rust IPC, unlike the stdio host) — so
//! each has a matching named permission entry in
//! `src-tauri/permissions/clipper-pairing/default.toml`, surfaced as
//! `clipper-pairing:default` in `capabilities/default.json`. No `core:default`
//! widening.
//!
//! Surface (deliberately tiny):
//! - [`pairing_pending`] — read the current pending session (extension id +
//!   the numeric challenge to display); the dialog mounts when this is
//!   `Some`.
//! - [`pairing_accept`] — mint a scoped revocable token bound to the exact
//!   extension ID and clear the session.
//! - [`pairing_reject`] — clear the session WITHOUT minting (no lingering
//!   authorization).
//!
//! The returned token value is the extension's bearer copy. In the full flow
//! the **host process** relays the accept/reject outcome to the extension
//! over the native-messaging reply channel (task 5 owns that wire); this task
//! mints + records the token desktop-side and exposes the dialog commands.
//!
//! DENY-list discipline: the token value + the extension ID are vault-stable
//! correlation tags — never logged. Only bounded outcome labels are emitted.
//!
//! See: ../../CLAUDE.md "Secret-handling logging discipline".

use serde::Serialize;
use tauri::{AppHandle, Runtime, State};

use super::error::PairingError;
use super::state::PairingState;
use crate::plugins::vault_unlock::state::VaultRuntimeState;

/// Resolve the ACTIVE (unlocked) vault root and persist the pairing-token
/// registry snapshot to the `paired_extensions` prefs field (MYND-443 task 7).
///
/// Shared by [`pairing_accept`] (after a token is minted) and [`pairing_revoke`]
/// (after a flag is flipped) so a change to the in-memory registry is durable
/// across restart. The in-memory mutation already happened on `state`; this
/// snapshots it out and writes it through the EXISTING prefs write path (the
/// same path `saved_views` uses). A persistence failure is surfaced as
/// [`PairingError::PersistFailed`] — the in-memory registry stays mutated for
/// the session (the next change re-persists). Never logs a token value.
async fn persist_registry<R: Runtime>(
    app: &AppHandle<R>,
    pairing: &PairingState,
    vault_state: &VaultRuntimeState,
) -> Result<(), PairingError> {
    let vault_dir = crate::paths::active_vault_root_io(app, vault_state.active_vault_id().await)
        .map_err(|_| PairingError::PersistFailed)?;
    let records = pairing.registry_snapshot().to_paired_extensions();
    crate::plugins::prefs::commands::persist_paired_extensions_with_dir(
        &vault_dir,
        vault_state,
        records,
    )
    .await
    .map_err(|_| PairingError::PersistFailed)
}

/// The pending-pairing view the dialog renders: the exact extension ID, the
/// numeric challenge (already formatted to the canonical display string), and
/// the relay's opaque request id (when the session was opened by the relay).
#[derive(Debug, Clone, Serialize)]
pub struct PendingPairingView {
    /// The exact extension ID requesting the connection.
    pub extension_id: String,
    /// The zero-padded numeric challenge the user compares to the extension.
    pub challenge: String,
    /// The relay's opaque correlation id for the in-flight `Pair` dispatch this
    /// session belongs to — the dialog echoes it to `pairing_dispatch_complete`
    /// so the blocked relay thread is woken on the right channel. `None` for a
    /// session opened without a relay round-trip. The id is an opaque relay tag,
    /// NOT a vault-stable correlation tag — safe to surface to the WebView.
    pub request_id: Option<String>,
}

/// Read the current pending pairing session, if any.
///
/// The dialog polls / reads this; `None` means no extension is currently
/// asking to connect (the dialog stays unmounted).
#[tauri::command]
pub async fn pairing_pending(
    state: State<'_, PairingState>,
) -> Result<Option<PendingPairingView>, PairingError> {
    Ok(state.pending().map(|p| PendingPairingView {
        extension_id: p.extension_id,
        challenge: p.challenge.display(),
        request_id: p.request_id,
    }))
}

/// Accept the pending pairing: mint a scoped, revocable token bound to the
/// exact extension ID, clear the session, and **persist** the updated registry
/// to the encrypted prefs-family blob so the pairing survives a restart
/// (MYND-443 task 7).
///
/// Returns the minted token's bearer value (the extension's copy). Errors
/// [`PairingError::NoPendingPairing`] if there is nothing to accept,
/// [`PairingError::CsprngUnavailable`] if the core CSPRNG fails (the session
/// is left intact on a CSPRNG failure so a retry is non-destructive), and
/// [`PairingError::PersistFailed`] if the prefs write failed (the token is live
/// in memory for this session, but durability could not be confirmed — the next
/// pairing change re-persists). The token value is returned only on a fully
/// successful persist.
#[tauri::command]
pub async fn pairing_accept<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, PairingState>,
    vault_state: State<'_, VaultRuntimeState>,
) -> Result<String, PairingError> {
    match state.accept_pending()? {
        Some(token) => {
            // Persist the new registry (issued token) BEFORE handing the value
            // back, so a durability failure is surfaced to the dialog.
            persist_registry(&app, state.inner(), vault_state.inner()).await?;
            // Bounded outcome only — never the token value or extension id.
            tracing::debug!(stage = "ext_pairing", outcome = "accepted");
            Ok(token.value().to_string())
        }
        None => {
            tracing::debug!(stage = "ext_pairing", outcome = "accept_no_session");
            Err(PairingError::NoPendingPairing)
        }
    }
}

/// One paired-extension row for the Settings "Connected extensions" list — the
/// exact extension id with at least one live (issued, non-revoked) token. The
/// token VALUE is deliberately NOT exposed (a vault-stable correlation tag).
#[derive(Debug, Clone, Serialize)]
pub struct PairedExtensionView {
    /// The exact extension id that currently holds a live pairing token.
    pub extension_id: String,
    /// Unix seconds when this pairing was issued (the in-app Accept time), or
    /// `null` for a pre-feature record. User-meaningful display metadata — the
    /// "connected when" line; the timestamp itself lives inside the encrypted
    /// `vault.prefs` (CLAUDE.md "user-meaningful timestamps live inside the
    /// encrypted blob"). The token value is never exposed.
    pub paired_at: Option<u64>,
}

/// List the currently-paired extensions (the Settings follow-up's data source).
///
/// Returns the DISTINCT extension ids that hold at least one live token (each
/// with its issue time), sorted for a stable UI order. Read-only — no registry
/// mutation, no persistence. Surfaces only extension ids + the issue time,
/// never token values.
#[tauri::command]
pub async fn pairing_list_paired(
    state: State<'_, PairingState>,
) -> Result<Vec<PairedExtensionView>, PairingError> {
    Ok(state
        .registry_snapshot()
        .live_paired()
        .into_iter()
        .map(|(extension_id, paired_at)| PairedExtensionView {
            extension_id,
            paired_at,
        })
        .collect())
}

/// Revoke every live pairing token bound to `extension_id` (Settings "Connected
/// extensions → Revoke"; MYND-443 task 7). **Desktop-authoritative + immediate**:
/// the in-memory registry flips the revoked flag at once (the next clip from that
/// extension fails `RegistryGate` validation for free), then the change is
/// **persisted** to the encrypted prefs-family blob so the revocation is durable
/// across restart.
///
/// Idempotent: revoking an extension with no live token is a success that
/// persists nothing-new (the snapshot is unchanged). Errors
/// [`PairingError::PersistFailed`] if the durable write failed — the in-memory
/// revocation still holds for this session. Logs the COUNT revoked, never the
/// extension id (a vault-stable correlation tag).
#[tauri::command]
pub async fn pairing_revoke<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, PairingState>,
    vault_state: State<'_, VaultRuntimeState>,
    extension_id: String,
) -> Result<(), PairingError> {
    let revoked = state.revoke_extension(&extension_id);
    // Persist regardless of `revoked` count: a 0-count revoke is a harmless
    // re-write of the unchanged snapshot (idempotent), and persisting keeps the
    // disk state authoritative even if the in-memory and on-disk views had
    // drifted (e.g. a prior accept's persist had failed).
    persist_registry(&app, state.inner(), vault_state.inner()).await?;
    tracing::debug!(stage = "ext_pairing", outcome = "revoked", count = revoked);
    Ok(())
}

/// Reject the pending pairing: clear the session WITHOUT minting a token (no
/// lingering authorization). Errors [`PairingError::NoPendingPairing`] if
/// there was nothing pending.
#[tauri::command]
pub async fn pairing_reject(state: State<'_, PairingState>) -> Result<(), PairingError> {
    if state.reject_pending() {
        tracing::debug!(stage = "ext_pairing", outcome = "rejected");
        Ok(())
    } else {
        tracing::debug!(stage = "ext_pairing", outcome = "reject_no_session");
        Err(PairingError::NoPendingPairing)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const EXT: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

    // The commands are thin `async` wrappers over `PairingState`; the state
    // module owns the behavioural coverage. Here we exercise the command-shape
    // mapping (view formatting + error variants) directly against the state,
    // without a full Tauri `State<'_, _>` harness (which needs an app
    // instance). The `#[tauri::command]` bodies above call exactly these
    // state methods, so the mapping is covered by parity.

    #[test]
    fn pending_view_formats_the_challenge_as_the_display_string() {
        let st = PairingState::default();
        st.begin_pairing(EXT).unwrap();
        let p = st.pending().unwrap();
        let view = PendingPairingView {
            extension_id: p.extension_id.clone(),
            challenge: p.challenge.display(),
            request_id: p.request_id.clone(),
        };
        assert_eq!(view.extension_id, EXT);
        assert_eq!(
            view.challenge.len(),
            crate::clipper::token::CHALLENGE_DIGITS
        );
        // Serializes to a flat { extension_id, challenge, request_id } object.
        let json = serde_json::to_value(&view).unwrap();
        assert_eq!(json["extension_id"], EXT);
        assert_eq!(json["challenge"], p.challenge.display());
        // A state-layer (request_id-less) session surfaces a null request_id.
        assert!(json["request_id"].is_null());
    }

    #[test]
    fn accept_with_no_session_maps_to_no_pending_pairing_error() {
        let st = PairingState::default();
        // Mirror the command's mapping of `None` → NoPendingPairing.
        let mapped = match st.accept_pending().unwrap() {
            Some(_) => None,
            None => Some(PairingError::NoPendingPairing),
        };
        assert_eq!(mapped, Some(PairingError::NoPendingPairing));
    }

    #[test]
    fn reject_with_no_session_maps_to_no_pending_pairing_error() {
        let st = PairingState::default();
        let mapped = if st.reject_pending() {
            None
        } else {
            Some(PairingError::NoPendingPairing)
        };
        assert_eq!(mapped, Some(PairingError::NoPendingPairing));
    }

    #[test]
    fn error_serializes_with_a_closed_kind_tag() {
        let json = serde_json::to_value(PairingError::NoPendingPairing).unwrap();
        assert_eq!(json["kind"], "NoPendingPairing");
        let json = serde_json::to_value(PairingError::CsprngUnavailable).unwrap();
        assert_eq!(json["kind"], "CsprngUnavailable");
        let json = serde_json::to_value(PairingError::PersistFailed).unwrap();
        assert_eq!(json["kind"], "PersistFailed");
    }

    #[test]
    fn list_paired_view_serializes_to_extension_id_and_paired_at_no_token() {
        // The list query exposes the extension id + the issue time — NEVER a
        // token value (a vault-stable correlation tag).
        let view = PairedExtensionView {
            extension_id: EXT.to_string(),
            paired_at: Some(1_700_000_000),
        };
        let json = serde_json::to_value(&view).unwrap();
        assert_eq!(json["extension_id"], EXT);
        assert_eq!(json["paired_at"], 1_700_000_000);
        // Exactly two fields — no token value leaks through this surface.
        let obj = json.as_object().unwrap();
        assert_eq!(obj.len(), 2);
        assert!(!obj.contains_key("token_value"));
    }

    #[test]
    fn list_paired_reflects_live_minus_revoked() {
        // The list query's data source: live_extension_ids over the state's
        // registry (the command is a thin map over this, covered by parity with
        // the token-module's own live_extension_ids tests).
        let st = PairingState::default();
        st.begin_pairing(EXT).unwrap();
        st.accept_pending().unwrap().unwrap();
        assert_eq!(
            st.registry_snapshot().live_extension_ids(),
            vec![EXT.to_string()]
        );
        st.revoke_extension(EXT);
        assert!(st.registry_snapshot().live_extension_ids().is_empty());
    }
}
