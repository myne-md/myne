// SPDX-License-Identifier: AGPL-3.0-only
//! App-side keyed ingest of a relayed clip frame (TB10, task 6).
//!
//! This is the **security climax** of the foundation: the native-messaging
//! host runs as a SEPARATE OS process from the running Myne app (which holds
//! the keys, the vault `Slot`, and the authoritative `TokenRegistry`). The
//! host is a **thin, untrusted relay** — it forwards each ext→host frame to
//! the running app over a local IPC channel ([`super::relay`]). The app
//! **re-validates every forwarded frame as untrusted input** before it ever
//! touches the vault:
//!
//! 1. **Re-decode** the envelope from the raw bytes (UTF-8 + versioned
//!    `HandoffEnvelope`) — the app does NOT trust that the host decoded it.
//! 2. **Re-check the token** against the app's REAL [`TokenRegistry`] via the
//!    same [`super::token::RegistryGate`] the host-mode path uses — a
//!    missing / invalid / revoked / wrong-ID claim is **silent** (no write,
//!    no reply), exactly the silent-to-unpaired contract. The host relaying a
//!    frame is NOT evidence the frame was authorized.
//! 3. **Re-enforce the caps** — the note-body sub-cap (16 MiB) on the DECODED
//!    `markdown_body`. (Composition moved WebView-side, so the composed-string
//!    re-check is now `note_create`'s own cap inside the WebView assembly —
//!    story 17 still holds: an over-cap body is an error, never a truncated
//!    note. The Rust gate caps the decoded body before any handoff.)
//! 4. **Re-enforce the rate limit** — the app holds the authoritative limiter
//!    so a compromised host cannot flood the vault by relaying fast.
//!
//! Only AFTER all four gates pass does the app hand the **validated envelope**
//! to a [`ClipAssembler`] seam. Assembly (compose + images + wikilink
//! resolution + seal via the normal `note_create`) now happens in the
//! **WebView** (a clip is a programmatic single-note import that reuses the
//! WebView importer pipeline); the production wiring forwards the envelope to
//! the WebView over an internal Tauri event and blocks for a tiny outcome (see
//! [`super::relay_app`]). The internal Rust↔WebView IPC is NOT a new trust
//! boundary — the WebView is already trusted with plaintext and already holds
//! `note_create` / `attachment_import`; authorization stays in Rust, BEFORE the
//! handoff, in the four gates below. NO new `clip_ingest` command.
//!
//! ## No network fetch (SYNC-12)
//!
//! There is NO URL-fetch path anywhere in this handler: the only inputs are the
//! in-page-captured envelope fields, and the only output is the validated
//! envelope handed to the assembler. `source_url` is carried verbatim as a
//! provenance value, never dereferenced — zero SSRF surface, zero read-receipt
//! leak (story 25).
//!
//! ## Double-clip independence (SYNC-16, story 19)
//!
//! Each accepted clip is an independent `note_create` call; the registry has
//! no source-URL index, no dedup, no overwrite. Two clips of the same page
//! mint two distinct backend `NoteId`s and write two `.myn` files. This module
//! adds NO dedup; independence is the absence of a check.
//!
//! ## Image bytes ride the validated envelope to the WebView
//!
//! `image_bytes` are decoded + carried in the validated [`HandoffEnvelope`] this
//! handler forwards to the assembler; rich per-image `attachment_import`
//! reconciliation runs WebView-side in the importer pipeline. This handler does
//! not ingest images itself — it authorizes the frame and forwards the
//! envelope (bytes included; the WebView synthesizes per-image display names).
//!
//! See: ../../AGENTS.md "Secret-handling logging discipline" — the frame body
//! (and the envelope it decodes to) is the same secret class as `password`;
//! this module logs only bounded outcome labels, never a body / URL / token.

use std::time::Instant;

use super::envelope::{
    self, HandoffEnvelope, HandoffKind, HostReply, VaultStatus, VaultStatusSource,
};
use super::host::PairingGate;
use super::rate_limit::{RateDecision, SharedRateLimiter};
use super::token::{RegistryGate, TokenRegistry};
use super::validation;

/// The clip-assembly seam the app-side ingest path drives AFTER the four
/// security gates pass.
///
/// Composition no longer happens in Rust: a clip is a programmatic single-note
/// import, so assembly (provenance frontmatter + images + wikilink resolution +
/// importer-parity degrade, then seal via the normal `note_create`) is owned by
/// the WebView. The production wiring ([`super::relay_app::ClipDispatch`])
/// forwards the *validated* [`HandoffEnvelope`] to the WebView over an internal
/// Tauri event and blocks for a tiny [`AssembleOutcome`]. The trait keeps the
/// keyed re-validation path unit-testable without spinning up the Tauri runtime
/// or the WebView: a test fixture records the envelope it was asked to assemble
/// (and can simulate an error).
///
/// `Locked` is NOT an assembler outcome — the locked short-circuit is decided
/// by the Rust [`VaultStatusSource`] check BEFORE `assemble` is ever called, so
/// the assembler only ever runs against an unlocked vault.
pub trait ClipAssembler {
    /// Assemble + write a clip from the validated envelope. Returns
    /// [`AssembleOutcome::Accepted`] when the WebView sealed the note, or
    /// [`AssembleOutcome::Error`] with a closed label on failure (the label is
    /// the only thing the reply carries — no note id, no media counts).
    fn assemble(&self, env: &HandoffEnvelope) -> AssembleOutcome;
}

/// The outcome of handing a validated envelope to the [`ClipAssembler`].
///
/// Deliberately tiny: only a binary accepted / error with a closed label. The
/// WebView keeps the note id + media counts locally (for its toast); they NEVER
/// cross back to Rust / the extension — the reply stays a decrypted-state-free
/// confirm.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AssembleOutcome {
    /// The WebView assembled + sealed the clip note. The relay maps this to an
    /// `accepted` reply with a fresh confirm token (SYNC-13).
    Accepted,
    /// Assembly failed; the closed `&'static str` label names the cause without
    /// leaking any caller bytes. The relay maps this to an `error` reply.
    Error(&'static str),
}

/// The longest `extension_id` the pairing path will dispatch. Browser-assigned
/// ids are short (Chrome = 32 chars; a gecko id like `clipper@myne.md`); a
/// generous bound keeps a hostile over-long id out of the Accept dialog.
const MAX_EXTENSION_ID_LEN: usize = 256;

/// The pairing-dispatch seam the app-side ingest drives for a relayed `Pair`
/// bootstrap request — the analogue of [`ClipAssembler`] for pairing.
///
/// Pairing is the ONE handoff allowed from an **unpaired** caller: the user's
/// in-app Accept (a numeric challenge, SYNC-6) is the authorization, NOT a token
/// (the token is the RESULT). The production dispatcher
/// ([`super::relay_app::PairingDispatch`]) calls `begin_pairing` + emits the
/// `pairing://dispatch` event + blocks for the WebView's Accept/Reject; a test
/// fixture returns a fixed outcome. Like [`ClipAssembler`], the trait keeps the
/// keyed pairing path unit-testable without the Tauri runtime or the WebView.
pub trait PairingDispatcher {
    /// Phase 1 (`PairBegin`): open the pending session, show the in-app Accept
    /// dialog, foreground Myne, and return the numeric CHALLENGE to relay to the
    /// extension — so the user can compare it against the dialog before approving.
    /// A locked vault returns [`BeginPairOutcome::Locked`] (unlock first); a mint
    /// / emit failure returns a closed [`BeginPairOutcome::Error`].
    fn begin_pair(&self, extension_id: &str) -> BeginPairOutcome;
    /// Phase 2 (`PairAwait`): block for the user's Accept/Reject on the pending
    /// session `begin_pair` opened for `extension_id`. Returns the app-minted
    /// scoped token on Accept, or a closed reason on Reject / timeout. Shows no
    /// new dialog — it awaits the one phase 1 raised.
    fn await_pair(&self, extension_id: &str) -> PairDispatchOutcome;
}

/// The outcome of phase 1 of pairing ([`PairingDispatcher::begin_pair`]).
///
/// Tiny + closed: the [`BeginPairOutcome::Challenge`] carries the numeric
/// comparison code (a human-comparison nonce, not a secret) to relay to the
/// extension; a locked vault or a dispatch failure is a bounded variant.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum BeginPairOutcome {
    /// The pending session opened; relay this numeric challenge to the extension
    /// and proceed to phase 2 (`PairAwait`). The display string, never a secret.
    Challenge(String),
    /// The vault is LOCKED — pairing cannot complete until the user unlocks. The
    /// relay maps it to [`HostReply::Locked`] so the extension prompts to unlock.
    Locked,
    /// Phase 1 failed (CSPRNG / no WebView / wiring). Closed `&'static str` label.
    Error(&'static str),
}

/// The outcome of dispatching a pairing request to the user.
///
/// Tiny + closed: an Accept carries the app-minted scoped token (the ONLY thing
/// that crosses back); a Reject / failure is a bounded label, never a token.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PairDispatchOutcome {
    /// The user ACCEPTED; the app minted this scoped token bound to the exact
    /// extension id. The relay maps it to [`HostReply::Paired`].
    Paired(String),
    /// The user REJECTED. The relay maps it to `error: pairing_rejected`.
    Rejected,
    /// Dispatch failed (timeout / no WebView / mint failure). Closed `&'static
    /// str` label, never a caller byte.
    Error(&'static str),
}

/// The typed outcome of the app-side keyed ingest of one relayed frame.
///
/// The relay maps each variant to a reply (or silence) back to the host, which
/// forwards it to the extension. Distinct from the host-process
/// [`super::host::HandoffOutcome`]: that one stops at the `Accepted` seam,
/// this one carries the WRITE result.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum IngestOutcome {
    /// The frame failed re-validation (unpaired / invalid / revoked / wrong-ID
    /// token, malformed envelope, unknown version). The app writes NOTHING and
    /// replies NOTHING — the silent-to-unpaired contract, re-enforced
    /// app-side. The host relaying the frame does not change this.
    SilentlyIgnored,

    /// The frame passed re-validation and the app forwarded it for assembly +
    /// replied. Carries the tiny [`HostReply`] the relay forwards back to the
    /// host → extension (`accepted` with a confirm token on a successful
    /// assembly; `error` on an over-cap / assembly failure / rate-limit;
    /// `locked` when the vault is not unlocked).
    Replied(HostReply),
}

/// Re-validate, then forward one relayed clip frame to the assembler app-side.
///
/// This is the keyed path the relay calls for every frame the (untrusted) host
/// forwards. It re-runs the FULL validation chain against the app's real state
/// — it does not trust that the host validated. See the module docs for the
/// four gates and their security properties.
///
/// - `body` — the raw ext→host frame bytes, forwarded verbatim by the host.
/// - `registry` — the app's authoritative [`TokenRegistry`] (the WebView mints
///   into it; task 7 persists it). A claim that does not validate here is
///   silent regardless of what the host did.
/// - `status` — the app's real [`VaultStatusSource`] (backed by the live
///   `Slot`). A locked vault ⇒ `locked` reply, no assembly attempted.
/// - `limiter` — the app's authoritative rate limiter.
/// - `assembler` — the [`ClipAssembler`] seam (production: forward the
///   validated envelope to the WebView).
/// - `pairing` — the [`PairingDispatcher`] seam for a `Pair` bootstrap request
///   (production: show the in-app Accept dialog + mint the token). A `Pair`
///   routes BEFORE the token gate — pairing is how an unpaired caller becomes
///   paired; the user's Accept is the authorization, not a token.
/// - `now` — the clock for the rate limiter (injected for deterministic tests).
pub fn ingest_relayed_frame(
    body: &[u8],
    registry: &TokenRegistry,
    status: &dyn VaultStatusSource,
    limiter: &SharedRateLimiter,
    assembler: &dyn ClipAssembler,
    pairing: &dyn PairingDispatcher,
    now: Instant,
) -> IngestOutcome {
    // 1. Re-decode as untrusted input. A bad frame on which we cannot verify a
    //    token has no paired caller to answer — stay SILENT (no error oracle).
    let Ok(text) = validation::validate_utf8(body) else {
        return IngestOutcome::SilentlyIgnored;
    };
    let envelope = match envelope::decode_envelope(text) {
        Ok(e) => e,
        Err(e) => {
            tracing::debug!(stage = "clip_ingest", envelope_error = e.label());
            return IngestOutcome::SilentlyIgnored;
        }
    };

    // 1a. PAIRING is the bootstrap handoff (SYNC-6) — the caller is UNPAIRED by
    //     definition, so it routes BEFORE the token gate (the gate below would
    //     silence it). The authorization is the user's in-app Accept (a numeric
    //     challenge), NEVER a token — the token is the RESULT. The two phases:
    //     `PairBegin` opens the dialog + relays the challenge; `PairAwait` blocks
    //     for the Accept + relays the token. (Legacy single-shot `Pair` falls
    //     through to the defensive silence in the match below.)
    match envelope.kind {
        HandoffKind::PairBegin => return ingest_pair_begin(&envelope, limiter, pairing, now),
        HandoffKind::PairAwait => return ingest_pair_await(&envelope, pairing),
        _ => {}
    }

    // 2. Re-check the token against the REAL registry. The host relaying a
    //    frame is NOT evidence it was authorized — re-validate exactly as the
    //    host-mode path does, and stay silent on anything but Valid. (Pairing
    //    already returned above; clip + status REQUIRE a valid token.)
    let gate = RegistryGate::new(
        registry,
        envelope.extension_id.clone(),
        envelope.token.clone(),
    );
    if !gate.is_paired() {
        return IngestOutcome::SilentlyIgnored;
    }

    // 3. Dispatch on the handoff kind (the type system bounds this to
    //    create-clip / is-unlocked-status; no read/modify/delete is
    //    expressible — token.rs `TokenScope`).
    match envelope.kind {
        HandoffKind::IsUnlockedStatus => match status.vault_status() {
            VaultStatus::Unlocked => {
                IngestOutcome::Replied(HostReply::accepted(super::host::mint_confirm()))
            }
            VaultStatus::Locked => IngestOutcome::Replied(HostReply::locked()),
        },
        HandoffKind::CreateClip => {
            // 3a. Note-body sub-cap on the DECODED body.
            if let Err(e) = validation::validate_note_body_len(envelope.markdown_body.len()) {
                return IngestOutcome::Replied(HostReply::error(e.label()));
            }
            // 3b. Rate limit — the authoritative limiter is the app's.
            if let RateDecision::Throttled = limiter.check(now) {
                return IngestOutcome::Replied(HostReply::error(
                    super::host::RejectReason::RateLimited.label(),
                ));
            }
            // 3c. Vault status — a locked vault ⇒ explicit `locked`, NO
            //     assembly. This is the load-bearing Rust-side `Locked`
            //     short-circuit: the assembler only ever runs against an
            //     unlocked vault (the clip precondition guarantees the WebView
            //     is alive — Myne has no headless/tray mode).
            if status.vault_status() == VaultStatus::Locked {
                return IngestOutcome::Replied(HostReply::locked());
            }
            // 3d. Hand the VALIDATED envelope to the assembler. Composition
            //     (provenance FM + images + wikilink resolution + the
            //     note-cap re-check on the composed body) now happens
            //     WebView-side via the importer pipeline; the four gates above
            //     are the authorization, run in Rust BEFORE this handoff. Each
            //     accepted clip is an independent assembly — no dedup (SYNC-16,
            //     story 19).
            match assembler.assemble(&envelope) {
                AssembleOutcome::Accepted => {
                    tracing::debug!(stage = "clip_ingest", outcome = "written");
                    // SYNC-13: the confirm means "handoff accepted + written".
                    IngestOutcome::Replied(HostReply::accepted(super::host::mint_confirm()))
                }
                AssembleOutcome::Error(label) => {
                    tracing::debug!(
                        stage = "clip_ingest",
                        outcome = "write_failed",
                        reason = label
                    );
                    IngestOutcome::Replied(HostReply::error(label))
                }
            }
        }
        // Defensive: the pairing kinds are handled by the early return above
        // (BEFORE the gate). These arms keep the match exhaustive and never run in
        // a correct flow; if a future refactor moved pairing here, silence (no
        // oracle) is the safe default.
        HandoffKind::PairBegin | HandoffKind::PairAwait => IngestOutcome::SilentlyIgnored,
    }
}

/// Handle a relayed `PairBegin` request app-side (SYNC-6, two-phase phase 1).
///
/// Pairing is the ONE handoff from an UNPAIRED caller — there is no token to
/// gate on; the user's in-app Accept (a numeric challenge) is the
/// authorization. We validate only the extension-id SHAPE (a missing /
/// over-long, unidentifiable id is silent — no oracle), rate-limit pair requests
/// so a hostile extension cannot spam the Accept dialog (a throttled request is
/// silent — no dialog, no reply; the legitimate first request always has
/// budget), then open the dialog via `begin_pair` and relay the numeric
/// CHALLENGE back so the extension can show it. A locked vault replies `locked`
/// (the dialog cannot be approved until the user unlocks). No token is minted in
/// phase 1 — that is phase 2 (`PairAwait`).
fn ingest_pair_begin(
    envelope: &HandoffEnvelope,
    limiter: &SharedRateLimiter,
    pairing: &dyn PairingDispatcher,
    now: Instant,
) -> IngestOutcome {
    // The extension id is shown to the user in the Accept dialog + bound into
    // the minted token. A missing / over-long id is unidentifiable → silent.
    if envelope.extension_id.is_empty() || envelope.extension_id.len() > MAX_EXTENSION_ID_LEN {
        return IngestOutcome::SilentlyIgnored;
    }
    // Dialog-spam guard: a throttled pair request is silent (no dialog shown,
    // no reply). The authoritative limiter is the app's — a compromised host
    // cannot flood the Accept dialog by relaying fast. (Only phase 1 shows a
    // dialog, so only phase 1 is rate-limited; phase 2 just awaits.)
    if let RateDecision::Throttled = limiter.check(now) {
        return IngestOutcome::SilentlyIgnored;
    }
    match pairing.begin_pair(&envelope.extension_id) {
        BeginPairOutcome::Challenge(code) => {
            tracing::debug!(stage = "pair_ingest", outcome = "challenge");
            IngestOutcome::Replied(HostReply::challenge(code))
        }
        BeginPairOutcome::Locked => {
            tracing::debug!(stage = "pair_ingest", outcome = "locked");
            IngestOutcome::Replied(HostReply::locked())
        }
        BeginPairOutcome::Error(label) => {
            tracing::debug!(stage = "pair_ingest", outcome = "error", reason = label);
            IngestOutcome::Replied(HostReply::error(label))
        }
    }
}

/// Handle a relayed `PairAwait` request app-side (SYNC-6, two-phase phase 2).
///
/// The continuation of [`ingest_pair_begin`]: block for the user's Accept/Reject
/// on the pending session phase 1 opened for this `extension_id`, and relay the
/// minted scoped token (`paired`) or a closed reason (`pairing_rejected` /
/// timeout) back. It shows NO new dialog and is NOT rate-limited (it does not
/// raise a dialog — it awaits the one phase 1 raised). The minted token NEVER
/// reaches a log (see ../../AGENTS.md secret-handling DENY list).
fn ingest_pair_await(envelope: &HandoffEnvelope, pairing: &dyn PairingDispatcher) -> IngestOutcome {
    // Same shape guard as phase 1 — the id keys the pending session to await.
    if envelope.extension_id.is_empty() || envelope.extension_id.len() > MAX_EXTENSION_ID_LEN {
        return IngestOutcome::SilentlyIgnored;
    }
    match pairing.await_pair(&envelope.extension_id) {
        PairDispatchOutcome::Paired(token) => {
            tracing::debug!(stage = "pair_ingest", outcome = "accepted");
            IngestOutcome::Replied(HostReply::paired(token))
        }
        PairDispatchOutcome::Rejected => {
            tracing::debug!(stage = "pair_ingest", outcome = "rejected");
            IngestOutcome::Replied(HostReply::error("pairing_rejected"))
        }
        PairDispatchOutcome::Error(label) => {
            tracing::debug!(stage = "pair_ingest", outcome = "error", reason = label);
            IngestOutcome::Replied(HostReply::error(label))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::clipper::envelope::StaticVaultStatus;
    use std::cell::RefCell;
    use std::time::Duration;

    const EXT: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

    /// A `ClipAssembler` that records every validated envelope it was asked to
    /// assemble (so double-clip independence + the carried fields are
    /// observable) and returns [`AssembleOutcome::Accepted`] per call.
    /// Optionally fails with a fixed label (simulating a WebView assembly
    /// error).
    #[derive(Default)]
    struct RecordingAssembler {
        assembled: RefCell<Vec<HandoffEnvelope>>,
        fail_with: Option<&'static str>,
    }

    impl RecordingAssembler {
        fn new() -> Self {
            Self::default()
        }
        fn failing(label: &'static str) -> Self {
            RecordingAssembler {
                assembled: RefCell::new(Vec::new()),
                fail_with: Some(label),
            }
        }
        fn count(&self) -> usize {
            self.assembled.borrow().len()
        }
        fn last(&self) -> HandoffEnvelope {
            self.assembled
                .borrow()
                .last()
                .cloned()
                .expect("an envelope was assembled")
        }
    }

    impl ClipAssembler for RecordingAssembler {
        fn assemble(&self, env: &HandoffEnvelope) -> AssembleOutcome {
            if let Some(label) = self.fail_with {
                return AssembleOutcome::Error(label);
            }
            self.assembled.borrow_mut().push(env.clone());
            AssembleOutcome::Accepted
        }
    }

    /// A [`PairingDispatcher`] that PANICS if dispatched — proves the clip +
    /// status paths NEVER reach pairing (pairing routes BEFORE the gate, so a
    /// clip/status frame must never call it).
    struct NeverPairing;
    impl PairingDispatcher for NeverPairing {
        fn begin_pair(&self, _extension_id: &str) -> BeginPairOutcome {
            panic!("a clip / status handoff must never dispatch pairing");
        }
        fn await_pair(&self, _extension_id: &str) -> PairDispatchOutcome {
            panic!("a clip / status handoff must never dispatch pairing");
        }
    }

    /// A [`PairingDispatcher`] returning fixed phase-1 / phase-2 outcomes and
    /// recording the extension ids it was dispatched for — drives the two-phase
    /// pairing-path tests.
    struct StubPairing {
        begin: BeginPairOutcome,
        await_outcome: PairDispatchOutcome,
        dispatched: RefCell<Vec<String>>,
    }
    impl StubPairing {
        /// Phase-2 await returns `await_outcome`; phase-1 begin returns a fixed
        /// challenge (the happy path) so a `PairAwait` test can stand alone.
        fn new(await_outcome: PairDispatchOutcome) -> Self {
            StubPairing {
                begin: BeginPairOutcome::Challenge("481920".to_string()),
                await_outcome,
                dispatched: RefCell::new(Vec::new()),
            }
        }
        /// An explicit phase-1 begin outcome (e.g. `Locked`); phase-2 unused.
        fn with_begin(begin: BeginPairOutcome) -> Self {
            StubPairing {
                begin,
                await_outcome: PairDispatchOutcome::Error("unused"),
                dispatched: RefCell::new(Vec::new()),
            }
        }
        fn count(&self) -> usize {
            self.dispatched.borrow().len()
        }
    }
    impl PairingDispatcher for StubPairing {
        fn begin_pair(&self, extension_id: &str) -> BeginPairOutcome {
            self.dispatched.borrow_mut().push(extension_id.to_string());
            self.begin.clone()
        }
        fn await_pair(&self, extension_id: &str) -> PairDispatchOutcome {
            self.dispatched.borrow_mut().push(extension_id.to_string());
            self.await_outcome.clone()
        }
    }

    /// A v1 PAIR-BEGIN envelope for `ext` (phase 1) — empty token (unpaired).
    fn pair_begin_envelope(ext: &str) -> Vec<u8> {
        format!(r#"{{ "version": 1, "kind": "pair-begin", "extension_id": "{ext}", "token": "" }}"#)
            .into_bytes()
    }

    /// A v1 PAIR-AWAIT envelope for `ext` (phase 2) — empty token (unpaired).
    fn pair_await_envelope(ext: &str) -> Vec<u8> {
        format!(r#"{{ "version": 1, "kind": "pair-await", "extension_id": "{ext}", "token": "" }}"#)
            .into_bytes()
    }

    fn paired_registry() -> (TokenRegistry, String) {
        let mut reg = TokenRegistry::new();
        let token = reg.issue(EXT).unwrap();
        let value = token.value().to_string();
        (reg, value)
    }

    /// A valid v1 create-clip envelope for `EXT` with the given token + body +
    /// provenance.
    fn clip_envelope(token: &str, body: &str, source: Option<&str>) -> Vec<u8> {
        let source_line = match source {
            Some(s) => format!(r#", "source_url": {}"#, serde_json::to_string(s).unwrap()),
            None => String::new(),
        };
        format!(
            r#"{{ "version": 1, "kind": "create-clip", "extension_id": "{EXT}",
                  "token": "{token}", "markdown_body": {body}{source_line} }}"#,
            body = serde_json::to_string(body).unwrap()
        )
        .into_bytes()
    }

    fn status_envelope(token: &str) -> Vec<u8> {
        format!(
            r#"{{ "version": 1, "kind": "is-unlocked-status",
                  "extension_id": "{EXT}", "token": "{token}" }}"#
        )
        .into_bytes()
    }

    // ---- happy path: a valid clip is composed + written -----------------

    #[test]
    fn valid_clip_with_unlocked_vault_forwards_the_envelope_and_replies_accepted() {
        let (reg, token) = paired_registry();
        let status = StaticVaultStatus(VaultStatus::Unlocked);
        let limiter = SharedRateLimiter::default();
        let assembler = RecordingAssembler::new();
        let outcome = ingest_relayed_frame(
            &clip_envelope(&token, "# Clip\n\nbody", Some("https://example.com/a")),
            &reg,
            &status,
            &limiter,
            &assembler,
            &NeverPairing,
            Instant::now(),
        );
        // Forwarded exactly one envelope for assembly.
        assert_eq!(assembler.count(), 1, "exactly one envelope assembled");
        // The VALIDATED envelope carries the provenance + body the WebView
        // composes from (composition is now WebView-side; the gates ran here).
        let env = assembler.last();
        assert_eq!(env.source_url.as_deref(), Some("https://example.com/a"));
        assert_eq!(env.markdown_body, "# Clip\n\nbody");
        // SYNC-15: no vault structure is sourced — folder is root, tags empty.
        assert_eq!(env.destination_folder, None);
        assert!(env.tags.is_empty());
        // Replied accepted with a confirm token (SYNC-13).
        match outcome {
            IngestOutcome::Replied(HostReply::Accepted { confirm }) => {
                assert!(!confirm.is_empty());
            }
            other => panic!("expected Replied(Accepted), got {other:?}"),
        }
    }

    // ---- double-clip independence (SYNC-16, story 19) -------------------

    #[test]
    fn clipping_the_same_page_twice_forwards_two_independent_envelopes() {
        let (reg, token) = paired_registry();
        let status = StaticVaultStatus(VaultStatus::Unlocked);
        let limiter = SharedRateLimiter::default();
        let assembler = RecordingAssembler::new();
        let frame = clip_envelope(
            &token,
            "# Same page\n\nbody",
            Some("https://example.com/dup"),
        );

        let first = ingest_relayed_frame(
            &frame,
            &reg,
            &status,
            &limiter,
            &assembler,
            &NeverPairing,
            Instant::now(),
        );
        let second = ingest_relayed_frame(
            &frame,
            &reg,
            &status,
            &limiter,
            &assembler,
            &NeverPairing,
            Instant::now(),
        );

        // Two independent assemblies, no dedup, no overwrite (each is a
        // separate WebView note_create; the relay adds no dedup check).
        assert_eq!(assembler.count(), 2, "two clips → two assemblies");
        assert!(matches!(
            first,
            IngestOutcome::Replied(HostReply::Accepted { .. })
        ));
        assert!(matches!(
            second,
            IngestOutcome::Replied(HostReply::Accepted { .. })
        ));
    }

    // ---- over-16-MiB body → error, never a truncated note (story 17) ----

    #[test]
    fn body_over_the_note_cap_replies_error_not_forwarded() {
        let (reg, token) = paired_registry();
        let status = StaticVaultStatus(VaultStatus::Unlocked);
        let limiter = SharedRateLimiter::default();
        let assembler = RecordingAssembler::new();
        let big = "a".repeat(super::super::MAX_NOTE_BODY + 1);
        let outcome = ingest_relayed_frame(
            &clip_envelope(&token, &big, None),
            &reg,
            &status,
            &limiter,
            &assembler,
            &NeverPairing,
            Instant::now(),
        );
        // The decoded-body cap (gate 3) rejected BEFORE the handoff — the
        // assembler never saw the envelope.
        assert_eq!(assembler.count(), 0, "an over-cap body is not forwarded");
        match outcome {
            IngestOutcome::Replied(HostReply::Error { reason }) => {
                assert_eq!(reason, "note_body_oversized");
            }
            other => panic!("expected Replied(Error(note_body_oversized)), got {other:?}"),
        }
    }

    #[test]
    fn body_at_exactly_the_cap_passes_the_rust_gate_and_is_forwarded() {
        // The Rust gate caps the DECODED body at MAX_NOTE_BODY. A body exactly
        // at the cap passes that gate and is forwarded to the WebView for
        // assembly. The composed-string re-check (provenance frontmatter can
        // push the SEALED note just over) is now the WebView's responsibility,
        // applied by `note_create`'s own cap — the Rust gate authorizes; it no
        // longer composes.
        let (reg, token) = paired_registry();
        let status = StaticVaultStatus(VaultStatus::Unlocked);
        let limiter = SharedRateLimiter::default();
        let assembler = RecordingAssembler::new();
        let body = "a".repeat(super::super::MAX_NOTE_BODY);
        let outcome = ingest_relayed_frame(
            &clip_envelope(&token, &body, Some("https://x.test")),
            &reg,
            &status,
            &limiter,
            &assembler,
            &NeverPairing,
            Instant::now(),
        );
        assert_eq!(
            assembler.count(),
            1,
            "an at-cap body passes the Rust gate and is forwarded"
        );
        assert!(matches!(
            outcome,
            IngestOutcome::Replied(HostReply::Accepted { .. })
        ));
    }

    // ---- silent re-validation (the relay re-checks the token) -----------

    #[test]
    fn an_invalid_token_is_silently_ignored_no_assembly() {
        let reg = TokenRegistry::new(); // nothing issued
        let status = StaticVaultStatus(VaultStatus::Unlocked);
        let limiter = SharedRateLimiter::default();
        let assembler = RecordingAssembler::new();
        let outcome = ingest_relayed_frame(
            &clip_envelope("garbage-token", "body", None),
            &reg,
            &status,
            &limiter,
            &assembler,
            &NeverPairing,
            Instant::now(),
        );
        assert_eq!(outcome, IngestOutcome::SilentlyIgnored);
        assert_eq!(assembler.count(), 0, "an invalid token forwards NOTHING");
    }

    #[test]
    fn a_revoked_token_is_silently_ignored_no_assembly() {
        // The relay does NOT trust the host — even if the host forwarded a
        // frame, the app re-checks the token against the REAL registry and a
        // revoked token forwards nothing, silently.
        let mut reg = TokenRegistry::new();
        let token = reg.issue(EXT).unwrap();
        let value = token.value().to_string();
        reg.revoke_extension(EXT);
        let status = StaticVaultStatus(VaultStatus::Unlocked);
        let limiter = SharedRateLimiter::default();
        let assembler = RecordingAssembler::new();
        let outcome = ingest_relayed_frame(
            &clip_envelope(&value, "body", None),
            &reg,
            &status,
            &limiter,
            &assembler,
            &NeverPairing,
            Instant::now(),
        );
        assert_eq!(outcome, IngestOutcome::SilentlyIgnored);
        assert_eq!(assembler.count(), 0, "a revoked token forwards NOTHING");
    }

    #[test]
    fn a_malformed_frame_is_silently_ignored_no_panic_no_assembly() {
        let (reg, _token) = paired_registry();
        let status = StaticVaultStatus(VaultStatus::Unlocked);
        let limiter = SharedRateLimiter::default();
        let assembler = RecordingAssembler::new();
        for body in [
            &b"not json"[..],
            b"{}",
            b"{ \"version\": 99 }",
            &[0x7B, 0xFF, 0x7D],
        ] {
            let outcome = ingest_relayed_frame(
                body,
                &reg,
                &status,
                &limiter,
                &assembler,
                &NeverPairing,
                Instant::now(),
            );
            assert_eq!(outcome, IngestOutcome::SilentlyIgnored);
        }
        assert_eq!(assembler.count(), 0);
    }

    // ---- locked vault ⇒ no write, locked reply --------------------------

    #[test]
    fn a_locked_vault_replies_locked_and_assembles_nothing() {
        let (reg, token) = paired_registry();
        let status = StaticVaultStatus(VaultStatus::Locked);
        let limiter = SharedRateLimiter::default();
        let assembler = RecordingAssembler::new();
        let outcome = ingest_relayed_frame(
            &clip_envelope(&token, "body", None),
            &reg,
            &status,
            &limiter,
            &assembler,
            &NeverPairing,
            Instant::now(),
        );
        assert_eq!(outcome, IngestOutcome::Replied(HostReply::Locked));
        assert_eq!(
            assembler.count(),
            0,
            "a locked vault forwards NOTHING to assembly"
        );
    }

    // ---- rate limit (app holds the authoritative limiter) ---------------

    #[test]
    fn over_rate_limit_replies_error_and_assembles_nothing_for_the_throttled_frame() {
        let (reg, token) = paired_registry();
        let status = StaticVaultStatus(VaultStatus::Unlocked);
        let limiter = SharedRateLimiter::new(1, Duration::from_secs(60));
        let now = Instant::now();
        let assembler = RecordingAssembler::new();
        // First clip consumes the single-slot budget → forwarded.
        let first = ingest_relayed_frame(
            &clip_envelope(&token, "a", None),
            &reg,
            &status,
            &limiter,
            &assembler,
            &NeverPairing,
            now,
        );
        assert!(matches!(
            first,
            IngestOutcome::Replied(HostReply::Accepted { .. })
        ));
        assert_eq!(assembler.count(), 1);
        // Second within the window → throttled error, no second assembly.
        let second = ingest_relayed_frame(
            &clip_envelope(&token, "b", None),
            &reg,
            &status,
            &limiter,
            &assembler,
            &NeverPairing,
            now,
        );
        match second {
            IngestOutcome::Replied(HostReply::Error { reason }) => {
                assert_eq!(reason, "rate_limited")
            }
            other => panic!("expected rate_limited error, got {other:?}"),
        }
        assert_eq!(
            assembler.count(),
            1,
            "the throttled frame forwards NO envelope"
        );
    }

    // ---- a WebView assembly failure surfaces an honest error ------------

    #[test]
    fn an_assembly_failure_replies_error_never_a_fake_success() {
        let (reg, token) = paired_registry();
        let status = StaticVaultStatus(VaultStatus::Unlocked);
        let limiter = SharedRateLimiter::default();
        let assembler = RecordingAssembler::failing("clip_dispatch_timeout");
        let outcome = ingest_relayed_frame(
            &clip_envelope(&token, "body", None),
            &reg,
            &status,
            &limiter,
            &assembler,
            &NeverPairing,
            Instant::now(),
        );
        // The app is the write authority (SYNC-13) — a failed assembly is an
        // honest error, never a fake `accepted`.
        match outcome {
            IngestOutcome::Replied(HostReply::Error { reason }) => {
                assert_eq!(reason, "clip_dispatch_timeout")
            }
            other => panic!("expected Replied(Error(clip_dispatch_timeout)), got {other:?}"),
        }
    }

    // ---- status query path (is-unlocked-status over the relay) ----------

    #[test]
    fn status_query_unlocked_replies_accepted_no_assembly() {
        let (reg, token) = paired_registry();
        let status = StaticVaultStatus(VaultStatus::Unlocked);
        let limiter = SharedRateLimiter::default();
        let assembler = RecordingAssembler::new();
        let outcome = ingest_relayed_frame(
            &status_envelope(&token),
            &reg,
            &status,
            &limiter,
            &assembler,
            &NeverPairing,
            Instant::now(),
        );
        assert!(matches!(
            outcome,
            IngestOutcome::Replied(HostReply::Accepted { .. })
        ));
        assert_eq!(assembler.count(), 0, "a status query forwards NO envelope");
    }

    #[test]
    fn status_query_locked_replies_locked() {
        let (reg, token) = paired_registry();
        let status = StaticVaultStatus(VaultStatus::Locked);
        let limiter = SharedRateLimiter::default();
        let assembler = RecordingAssembler::new();
        let outcome = ingest_relayed_frame(
            &status_envelope(&token),
            &reg,
            &status,
            &limiter,
            &assembler,
            &NeverPairing,
            Instant::now(),
        );
        assert_eq!(outcome, IngestOutcome::Replied(HostReply::Locked));
    }

    // ---- pairing: the bootstrap handoff (SYNC-6) ------------------------

    #[test]
    fn pair_begin_replies_with_the_challenge_to_relay_to_the_extension() {
        // Phase 1: the app opens the dialog + returns the numeric challenge for
        // the extension to display. No token crosses yet (that is phase 2), and
        // no clip is assembled.
        let reg = TokenRegistry::new(); // nothing issued — caller is UNPAIRED
        let status = StaticVaultStatus(VaultStatus::Unlocked);
        let limiter = SharedRateLimiter::default();
        let assembler = RecordingAssembler::new();
        let pairing = StubPairing::new(PairDispatchOutcome::Paired("unused".to_string()));
        let outcome = ingest_relayed_frame(
            &pair_begin_envelope(EXT),
            &reg,
            &status,
            &limiter,
            &assembler,
            &pairing,
            Instant::now(),
        );
        assert_eq!(pairing.count(), 1, "phase 1 dispatched to the user");
        assert_eq!(assembler.count(), 0, "pairing assembles no clip");
        match outcome {
            IngestOutcome::Replied(HostReply::Challenge { code }) => {
                assert_eq!(code, "481920");
            }
            other => panic!("expected Replied(Challenge), got {other:?}"),
        }
    }

    #[test]
    fn pair_await_dispatches_and_replies_paired_with_the_minted_token() {
        // Phase 2: the user Accepts; the app mints a scoped token; the relay
        // replies `paired` carrying it. No clip is assembled.
        let reg = TokenRegistry::new();
        let status = StaticVaultStatus(VaultStatus::Unlocked);
        let limiter = SharedRateLimiter::default();
        let assembler = RecordingAssembler::new();
        let pairing = StubPairing::new(PairDispatchOutcome::Paired("scopedtoken123".to_string()));
        let outcome = ingest_relayed_frame(
            &pair_await_envelope(EXT),
            &reg,
            &status,
            &limiter,
            &assembler,
            &pairing,
            Instant::now(),
        );
        assert_eq!(pairing.count(), 1, "phase 2 awaited the user's decision");
        assert_eq!(assembler.count(), 0, "pairing assembles no clip");
        match outcome {
            IngestOutcome::Replied(HostReply::Paired { token }) => {
                assert_eq!(token, "scopedtoken123");
            }
            other => panic!("expected Replied(Paired), got {other:?}"),
        }
    }

    #[test]
    fn both_pair_phases_route_before_the_token_gate_from_an_unpaired_caller() {
        // The defining security property: an UNPAIRED caller (empty token,
        // nothing in the registry) still reaches the pairing dispatcher in BOTH
        // phases — the user's Accept is the gate, NOT a token.
        let reg = TokenRegistry::new();
        let status = StaticVaultStatus(VaultStatus::Unlocked);
        let limiter = SharedRateLimiter::default();
        let assembler = RecordingAssembler::new();

        let begin = StubPairing::new(PairDispatchOutcome::Paired("t".to_string()));
        let begin_outcome = ingest_relayed_frame(
            &pair_begin_envelope(EXT),
            &reg,
            &status,
            &limiter,
            &assembler,
            &begin,
            Instant::now(),
        );
        assert!(matches!(
            begin_outcome,
            IngestOutcome::Replied(HostReply::Challenge { .. })
        ));

        let await_ = StubPairing::new(PairDispatchOutcome::Paired("t".to_string()));
        let await_outcome = ingest_relayed_frame(
            &pair_await_envelope(EXT),
            &reg,
            &status,
            &limiter,
            &assembler,
            &await_,
            Instant::now(),
        );
        assert!(matches!(
            await_outcome,
            IngestOutcome::Replied(HostReply::Paired { .. })
        ));
    }

    #[test]
    fn pair_begin_on_a_locked_vault_replies_locked_to_prompt_unlock() {
        // A locked vault cannot approve the dialog — phase 1 replies `locked` so
        // the extension prompts the user to unlock (then re-pair).
        let reg = TokenRegistry::new();
        let status = StaticVaultStatus(VaultStatus::Locked);
        let limiter = SharedRateLimiter::default();
        let assembler = RecordingAssembler::new();
        let pairing = StubPairing::with_begin(BeginPairOutcome::Locked);
        let outcome = ingest_relayed_frame(
            &pair_begin_envelope(EXT),
            &reg,
            &status,
            &limiter,
            &assembler,
            &pairing,
            Instant::now(),
        );
        assert!(matches!(outcome, IngestOutcome::Replied(HostReply::Locked)));
    }

    #[test]
    fn a_rejected_pair_await_replies_error_pairing_rejected() {
        let reg = TokenRegistry::new();
        let status = StaticVaultStatus(VaultStatus::Unlocked);
        let limiter = SharedRateLimiter::default();
        let assembler = RecordingAssembler::new();
        let pairing = StubPairing::new(PairDispatchOutcome::Rejected);
        let outcome = ingest_relayed_frame(
            &pair_await_envelope(EXT),
            &reg,
            &status,
            &limiter,
            &assembler,
            &pairing,
            Instant::now(),
        );
        match outcome {
            IngestOutcome::Replied(HostReply::Error { reason }) => {
                assert_eq!(reason, "pairing_rejected");
            }
            other => panic!("expected pairing_rejected error, got {other:?}"),
        }
    }

    #[test]
    fn a_pair_await_error_surfaces_its_closed_label() {
        let reg = TokenRegistry::new();
        let status = StaticVaultStatus(VaultStatus::Unlocked);
        let limiter = SharedRateLimiter::default();
        let assembler = RecordingAssembler::new();
        let pairing = StubPairing::new(PairDispatchOutcome::Error("pairing_timeout"));
        let outcome = ingest_relayed_frame(
            &pair_await_envelope(EXT),
            &reg,
            &status,
            &limiter,
            &assembler,
            &pairing,
            Instant::now(),
        );
        match outcome {
            IngestOutcome::Replied(HostReply::Error { reason }) => {
                assert_eq!(reason, "pairing_timeout");
            }
            other => panic!("expected pairing_timeout error, got {other:?}"),
        }
    }

    #[test]
    fn a_pair_begin_with_an_empty_extension_id_is_silent_no_dispatch() {
        let reg = TokenRegistry::new();
        let status = StaticVaultStatus(VaultStatus::Unlocked);
        let limiter = SharedRateLimiter::default();
        let assembler = RecordingAssembler::new();
        let pairing = StubPairing::new(PairDispatchOutcome::Paired("t".to_string()));
        let outcome = ingest_relayed_frame(
            &pair_begin_envelope(""), // unidentifiable caller
            &reg,
            &status,
            &limiter,
            &assembler,
            &pairing,
            Instant::now(),
        );
        assert_eq!(outcome, IngestOutcome::SilentlyIgnored);
        assert_eq!(pairing.count(), 0, "a malformed id never reaches the user");
    }

    #[test]
    fn a_throttled_pair_begin_is_silent_no_dialog_spam() {
        // Dialog-spam guard: once the limiter budget is spent, further phase-1
        // requests are silent (no dialog shown, no reply). Only phase 1 (which
        // raises a dialog) is rate-limited.
        let reg = TokenRegistry::new();
        let status = StaticVaultStatus(VaultStatus::Unlocked);
        let limiter = SharedRateLimiter::new(1, Duration::from_secs(60));
        let now = Instant::now();
        let assembler = RecordingAssembler::new();
        let pairing = StubPairing::new(PairDispatchOutcome::Paired("t".to_string()));
        // First pair-begin consumes the single-slot budget → dispatched.
        let first = ingest_relayed_frame(
            &pair_begin_envelope(EXT),
            &reg,
            &status,
            &limiter,
            &assembler,
            &pairing,
            now,
        );
        assert!(matches!(
            first,
            IngestOutcome::Replied(HostReply::Challenge { .. })
        ));
        assert_eq!(pairing.count(), 1);
        // Second within the window → throttled, silent, NO second dialog.
        let second = ingest_relayed_frame(
            &pair_begin_envelope(EXT),
            &reg,
            &status,
            &limiter,
            &assembler,
            &pairing,
            now,
        );
        assert_eq!(second, IngestOutcome::SilentlyIgnored);
        assert_eq!(pairing.count(), 1, "a throttled pair-begin shows no dialog");
    }

    #[test]
    fn pair_await_is_not_rate_limited_so_phase_2_always_completes() {
        // Phase 2 awaits the dialog phase 1 raised — it must NOT be silenced by a
        // spent limiter budget, or an Accept could be lost. With a zero-budget
        // limiter, pair-await still dispatches and replies.
        let reg = TokenRegistry::new();
        let status = StaticVaultStatus(VaultStatus::Unlocked);
        let limiter = SharedRateLimiter::new(0, Duration::from_secs(60)); // no budget
        let assembler = RecordingAssembler::new();
        let pairing = StubPairing::new(PairDispatchOutcome::Paired("t".to_string()));
        let outcome = ingest_relayed_frame(
            &pair_await_envelope(EXT),
            &reg,
            &status,
            &limiter,
            &assembler,
            &pairing,
            Instant::now(),
        );
        assert_eq!(pairing.count(), 1, "phase 2 is not gated by the limiter");
        assert!(matches!(
            outcome,
            IngestOutcome::Replied(HostReply::Paired { .. })
        ));
    }
}
