// SPDX-License-Identifier: AGPL-3.0
//! Closed error surface for the `clipper-pairing` IPC commands (TB10, task 4).
//!
//! DENY-list clean per `src-tauri/AGENTS.md` "Secret-handling logging
//! discipline": a pairing token value + an extension ID are vault-stable
//! correlation tags (the `salts, nonces` / `note_id` class) — they are NEVER
//! placed in an error payload or a `tracing::*!` argument. The variants below
//! carry no token, no extension ID, no path; the WebView dialog matches on
//! the bounded `kind` only.

use serde::Serialize;

/// Failure modes of the pairing-dialog commands (`pairing_pending`,
/// `pairing_accept`, `pairing_reject`).
///
/// Serialization shape (`tag = "kind"`): `{"kind":"NoPendingPairing"}` etc.
/// — a closed string tag the TS side switches on, with no free-form detail.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(tag = "kind")]
pub enum PairingError {
    /// Accept / reject was called but there is no pending pairing session
    /// (none was opened, or it was already resolved / cleared). The dialog
    /// should close — there is nothing to act on.
    NoPendingPairing,
    /// The core CSPRNG (`getrandom`) was unavailable while minting the token.
    /// Fatal, mirrors `protocol::ProtocolError::Csprng`; the dialog surfaces a
    /// generic "could not pair, try again" and the session is left intact so a
    /// retry is non-destructive.
    CsprngUnavailable,
    /// The pairing-token registry could not be persisted to the encrypted
    /// prefs-family blob (MYND-443 task 7) — the vault was not unlocked, the
    /// `vault.meta` could not be read, or the prefs write failed. The in-memory
    /// registry change (issue / revoke) still holds for this session; the next
    /// pairing change re-attempts the durable write. Carries no token value, no
    /// extension id, no path — the dialog surfaces a generic "couldn't save".
    PersistFailed,
}

impl PairingError {
    /// Stable `&'static str` label for tracing (never the token / ext id).
    ///
    /// Mirrors the codebase's `*_error_kind` label-helper discipline — a
    /// drift-catching label surface (a new variant compile-fails the match).
    /// The host-side error reply (task 5) is the production call site, so this
    /// is `allow(dead_code)` in the non-test library until that lands; pinned
    /// by [`tests::label_is_stable`].
    #[cfg_attr(not(test), allow(dead_code))]
    pub fn label(&self) -> &'static str {
        match self {
            PairingError::NoPendingPairing => "no_pending_pairing",
            PairingError::CsprngUnavailable => "csprng_unavailable",
            PairingError::PersistFailed => "persist_failed",
        }
    }
}

impl From<crate::clipper::token::ChallengeError> for PairingError {
    fn from(_: crate::clipper::token::ChallengeError) -> Self {
        // The only ChallengeError variant is a CSPRNG failure.
        PairingError::CsprngUnavailable
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn label_is_stable() {
        assert_eq!(PairingError::NoPendingPairing.label(), "no_pending_pairing");
        assert_eq!(
            PairingError::CsprngUnavailable.label(),
            "csprng_unavailable"
        );
    }

    #[test]
    fn challenge_error_maps_to_csprng_unavailable() {
        let mapped: PairingError = crate::clipper::token::ChallengeError::CsprngUnavailable.into();
        assert_eq!(mapped, PairingError::CsprngUnavailable);
    }
}
