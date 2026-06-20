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
use tauri::State;

use super::error::PairingError;
use super::state::PairingState;

/// The pending-pairing view the dialog renders: the exact extension ID and
/// the numeric challenge (already formatted to the canonical display string).
#[derive(Debug, Clone, Serialize)]
pub struct PendingPairingView {
    /// The exact extension ID requesting the connection.
    pub extension_id: String,
    /// The zero-padded numeric challenge the user compares to the extension.
    pub challenge: String,
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
    }))
}

/// Accept the pending pairing: mint a scoped, revocable token bound to the
/// exact extension ID and clear the session.
///
/// Returns the minted token's bearer value (the extension's copy). Errors
/// [`PairingError::NoPendingPairing`] if there is nothing to accept and
/// [`PairingError::CsprngUnavailable`] if the core CSPRNG fails (the session
/// is left intact on a CSPRNG failure so a retry is non-destructive).
#[tauri::command]
pub async fn pairing_accept(state: State<'_, PairingState>) -> Result<String, PairingError> {
    match state.accept_pending()? {
        Some(token) => {
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
        };
        assert_eq!(view.extension_id, EXT);
        assert_eq!(
            view.challenge.len(),
            crate::clipper::token::CHALLENGE_DIGITS
        );
        // Serializes to a flat { extension_id, challenge } object.
        let json = serde_json::to_value(&view).unwrap();
        assert_eq!(json["extension_id"], EXT);
        assert_eq!(json["challenge"], p.challenge.display());
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
    }
}
