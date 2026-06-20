//! Pairing-session + token-registry runtime state (TB10, task 4).
//!
//! This is the Tauri-managed state the WebView pairing dialog drives. It
//! holds two things behind one mutex:
//!
//! 1. **The pending pairing session** ([`PendingPairing`]) — the
//!    in-progress "a browser extension wants to connect" prompt: the exact
//!    extension ID that connected and the [`PairingChallenge`] the user
//!    compares against the extension. At most one is pending at a time
//!    (a new connect request supersedes an unresolved one). `Accept` mints a
//!    token and clears the session; `Reject` clears it without minting.
//! 2. **The authoritative [`TokenRegistry`]** — issued / revoked tokens. The
//!    desktop is authoritative (the extension only holds a copy of its token
//!    value). In-memory here; **task 7** persists it (prefs-family blob,
//!    root_key-derived) so pairing survives a restart.
//!
//! ## Why one mutex, why `std::sync::Mutex`
//!
//! The whole pairing surface is cheap, synchronous, in-RAM bookkeeping — no
//! `.await` is ever held across the lock, so a `std::sync::Mutex` is correct
//! and avoids the async-mutex contention discipline the gotcha note in
//! `src-tauri/CLAUDE.md` warns about. (Compare the heavy plugins, which hold
//! `tokio::sync::Mutex` because they `.await` mid-section.)
//!
//! ## Task-7 persistence seam
//!
//! The registry is a plain [`TokenRegistry`] (serde round-trippable). Task 7
//! will (a) load it from the encrypted prefs-family blob at unlock and
//! `replace_registry` it in, and (b) snapshot it via [`PairingState::registry_snapshot`]
//! after every `issue` / `revoke` to persist. Nothing in THIS module does
//! I/O — the seam is intentionally a pure value in + pure value out.
//!
//! See: ../../CLAUDE.md "Secret-handling logging discipline".

use std::sync::Mutex;

use crate::clipper::token::{ChallengeError, PairingChallenge, PairingToken, TokenRegistry};

/// An in-progress pairing prompt awaiting the user's Accept / Reject.
#[derive(Debug, Clone)]
pub struct PendingPairing {
    /// The EXACT extension ID that requested the connection (from the
    /// native-host manifest's allowlisted origin / id). The minted token is
    /// bound to this exact ID.
    pub extension_id: String,
    /// The numeric challenge shown in BOTH the in-app dialog and the
    /// extension; the user compares them before accepting.
    pub challenge: PairingChallenge,
}

/// The Tauri-managed pairing state singleton.
#[derive(Default)]
pub struct PairingState {
    inner: Mutex<Inner>,
}

#[derive(Default)]
struct Inner {
    pending: Option<PendingPairing>,
    registry: TokenRegistry,
}

impl PairingState {
    /// Open a pending pairing session for `extension_id`, generating a fresh
    /// CSPRNG challenge. Supersedes any unresolved prior session (the latest
    /// connect request wins). Returns the challenge so the caller can surface
    /// it to the dialog.
    ///
    /// **Task-5 seam:** the host process triggers this on a connect request
    /// (it knows the connecting extension id from the native-host manifest's
    /// allowlisted origin) so the dialog has a session to show. Exercised by
    /// this module's tests now; wired by the host's connect path in task 5 —
    /// hence `allow(dead_code)` in the non-test library until then.
    #[cfg_attr(not(test), allow(dead_code))]
    pub fn begin_pairing(
        &self,
        extension_id: impl Into<String>,
    ) -> Result<PairingChallenge, ChallengeError> {
        let challenge = PairingChallenge::generate()?;
        let mut inner = self.inner.lock().expect("pairing state mutex poisoned");
        inner.pending = Some(PendingPairing {
            extension_id: extension_id.into(),
            challenge,
        });
        Ok(challenge)
    }

    /// The current pending session, if any (the dialog reads this to render
    /// the challenge + Accept/Reject buttons).
    pub fn pending(&self) -> Option<PendingPairing> {
        self.inner
            .lock()
            .expect("pairing state mutex poisoned")
            .pending
            .clone()
    }

    /// Accept the pending session: mint a token bound to its exact extension
    /// ID, append it to the registry, clear the session, and return the
    /// minted token. `None` if there is no pending session.
    ///
    /// The returned token's value is what the extension stores; the desktop
    /// keeps the authoritative registry copy.
    pub fn accept_pending(&self) -> Result<Option<PairingToken>, ChallengeError> {
        let mut inner = self.inner.lock().expect("pairing state mutex poisoned");
        let Some(pending) = inner.pending.take() else {
            return Ok(None);
        };
        let token = PairingToken::mint(&pending.extension_id)?;
        inner.registry.insert(token.clone());
        Ok(Some(token))
    }

    /// Reject the pending session: clear it WITHOUT minting a token (no
    /// lingering authorization). Returns whether a session was actually
    /// cleared.
    pub fn reject_pending(&self) -> bool {
        let mut inner = self.inner.lock().expect("pairing state mutex poisoned");
        inner.pending.take().is_some()
    }

    /// Revoke every live token bound to `extension_id` (task-7 Revoke action;
    /// exposed now so the gate's revoke path is testable). Returns the count
    /// revoked.
    ///
    /// **Task-7 seam:** the Settings "Connected extensions → Revoke" command
    /// calls this. Exercised by this module's tests now; wired to a
    /// `#[command]` in task 7 — `allow(dead_code)` until then.
    #[cfg_attr(not(test), allow(dead_code))]
    pub fn revoke_extension(&self, extension_id: &str) -> usize {
        let mut inner = self.inner.lock().expect("pairing state mutex poisoned");
        inner.registry.revoke_extension(extension_id)
    }

    /// A clone of the current registry (task-7 persist seam — snapshot to the
    /// encrypted blob after every issue / revoke).
    ///
    /// **Task-7 seam:** persist the snapshot to the prefs-family blob.
    /// Exercised by tests now; `allow(dead_code)` until task 7 wires it.
    #[cfg_attr(not(test), allow(dead_code))]
    pub fn registry_snapshot(&self) -> TokenRegistry {
        self.inner
            .lock()
            .expect("pairing state mutex poisoned")
            .registry
            .clone()
    }

    /// Replace the registry wholesale (task-7 load seam — hydrate from the
    /// decrypted blob at unlock).
    ///
    /// **Task-7 seam:** hydrate from the decrypted prefs-family blob at
    /// unlock. Exercised by tests now; `allow(dead_code)` until task 7.
    #[cfg_attr(not(test), allow(dead_code))]
    pub fn replace_registry(&self, registry: TokenRegistry) {
        let mut inner = self.inner.lock().expect("pairing state mutex poisoned");
        inner.registry = registry;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::clipper::token::TokenValidation;

    const EXT: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

    #[test]
    fn begin_pairing_opens_a_pending_session_with_a_challenge() {
        let st = PairingState::default();
        assert!(st.pending().is_none());
        let challenge = st.begin_pairing(EXT).unwrap();
        let pending = st.pending().expect("a session is pending");
        assert_eq!(pending.extension_id, EXT);
        assert_eq!(pending.challenge.value(), challenge.value());
        // The same challenge the dialog renders is the one the extension is
        // told — identical for the pairing attempt.
        assert_eq!(pending.challenge.display(), challenge.display());
    }

    #[test]
    fn accept_mints_a_bound_token_and_clears_the_session() {
        let st = PairingState::default();
        st.begin_pairing(EXT).unwrap();
        let token = st.accept_pending().unwrap().expect("a token is minted");
        assert_eq!(token.extension_id(), EXT);
        // Session cleared.
        assert!(st.pending().is_none());
        // The token is live in the registry, bound to the exact ID.
        let reg = st.registry_snapshot();
        assert_eq!(reg.validate(EXT, token.value()), TokenValidation::Valid);
    }

    #[test]
    fn accept_with_no_pending_session_is_none() {
        let st = PairingState::default();
        assert!(st.accept_pending().unwrap().is_none());
    }

    #[test]
    fn reject_clears_the_session_without_minting() {
        let st = PairingState::default();
        st.begin_pairing(EXT).unwrap();
        assert!(st.reject_pending());
        // No lingering authorization: the registry has no live token.
        assert!(st.pending().is_none());
        assert!(!st.registry_snapshot().has_live_token(EXT));
    }

    #[test]
    fn reject_with_no_pending_session_is_false() {
        let st = PairingState::default();
        assert!(!st.reject_pending());
    }

    #[test]
    fn a_new_pairing_request_supersedes_an_unresolved_one() {
        let st = PairingState::default();
        let first = st.begin_pairing(EXT).unwrap();
        let other = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
        let second = st.begin_pairing(other).unwrap();
        let pending = st.pending().unwrap();
        // The latest request wins; the earlier challenge is gone.
        assert_eq!(pending.extension_id, other);
        assert_eq!(pending.challenge.value(), second.value());
        // (The two challenges are independently drawn; if they happen to
        // collide that's fine — what matters is the latest session is the
        // one pending.)
        let _ = first;
    }

    #[test]
    fn revoked_extension_can_re_pair_through_the_session_flow() {
        // Story 8 end-to-end at the state layer.
        let st = PairingState::default();
        st.begin_pairing(EXT).unwrap();
        let old = st.accept_pending().unwrap().unwrap();
        assert_eq!(st.revoke_extension(EXT), 1);
        assert_eq!(
            st.registry_snapshot().validate(EXT, old.value()),
            TokenValidation::Revoked
        );

        // Re-pair via the same flow.
        st.begin_pairing(EXT).unwrap();
        let fresh = st.accept_pending().unwrap().unwrap();
        let reg = st.registry_snapshot();
        assert_eq!(reg.validate(EXT, fresh.value()), TokenValidation::Valid);
        assert_eq!(reg.validate(EXT, old.value()), TokenValidation::Revoked);
    }

    #[test]
    fn registry_replace_hydrates_for_task_7_load() {
        // Task-7 load seam: a registry snapshot can be restored wholesale.
        let st = PairingState::default();
        st.begin_pairing(EXT).unwrap();
        let token = st.accept_pending().unwrap().unwrap();
        let snapshot = st.registry_snapshot();

        let fresh = PairingState::default();
        assert_eq!(
            fresh.registry_snapshot().validate(EXT, token.value()),
            TokenValidation::Missing
        );
        fresh.replace_registry(snapshot);
        assert_eq!(
            fresh.registry_snapshot().validate(EXT, token.value()),
            TokenValidation::Valid
        );
    }
}
