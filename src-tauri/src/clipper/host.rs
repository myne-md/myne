//! Native-messaging host-mode entry skeleton (TB10).
//!
//! When the production binary is launched by a browser with the
//! native-messaging argument ([`NATIVE_MESSAGING_ARG`]), it does NOT bring
//! up the Tauri WebView — it runs this thin stdio loop instead: read a
//! length-prefixed frame from stdin, hand it to the per-message processor,
//! write any reply to stdout, repeat until the extension disconnects (a
//! clean EOF).
//!
//! ## Scope of THIS task (3 of 10)
//!
//! This is the framing + validation + rate-limit + silent-to-unpaired
//! SKELETON. The clean seams the later tasks fill:
//!
//! - **Task 4 (pairing):** [`PairingGate`] is a trait the host queries to
//!   decide whether a caller is paired. Here it is an
//!   always-unpaired stub ([`UnpairedGate`]) so the
//!   silent-to-unpaired behaviour is real and tested; task 4 supplies the
//!   token-registry-backed implementation.
//! - **Task 5 (landed):** [`process_message`] decodes the versioned
//!   [`super::envelope::HandoffEnvelope`], answers `is-unlocked-status` from a
//!   [`super::envelope::VaultStatusSource`] (the host↔app `Slot` seam), and
//!   returns the tiny `accepted | error | locked` reply
//!   ([`super::envelope::HostReply`]). The claimed `(extension_id, token)` is
//!   threaded off the decoded envelope into the [`PairingGate`].
//! - **Task 6 (`note_create`):** the unlocked-path clip WRITE is task 6; here
//!   a validated, in-budget, paired `create-clip` handoff with an unlocked
//!   vault resolves to [`HandoffOutcome::Accepted`] (the seam) WITHOUT
//!   composing a note.
//!
//! ## Silent to unpaired callers (acceptance criterion)
//!
//! The host produces **NO output** for an unpaired / unknown caller — no
//! error frame, no ACK, nothing. An unpaired caller (or any local process
//! that learned the manifest path but never paired) gets silence, not a
//! liveness oracle. This is enforced in [`process_message`]: the pairing
//! gate is checked FIRST, and a `false` result returns
//! [`HandoffOutcome::SilentlyIgnored`] which the loop maps to "write
//! nothing".
//!
//! See: ../../AGENTS.md "Secret-handling logging discipline" — the loop
//! logs only bounded stage tags + closed error labels, never a frame body.

use std::io::{Read, Write};
use std::time::Instant;

use super::envelope::{
    self, EnvelopeError, HandoffKind, HostReply, VaultStatus, VaultStatusSource,
};
use super::framing::{self, FrameError};
use super::rate_limit::{RateDecision, RateLimiter};
use super::token::{RegistryGate, TokenRegistry};
use super::validation;

/// The CLI argument that puts the binary into native-messaging host mode.
///
/// Browsers append their own arguments (the extension origin, and on
/// Chromium a Windows parent-window handle) after the host path; the
/// presence of THIS flag — which the native-host manifest's `path`
/// wrapper passes — is what selects host mode over normal app launch.
/// Distinct, unambiguous, and not a value a browser supplies on its own.
pub const NATIVE_MESSAGING_ARG: &str = "--native-messaging-host";

/// Whether the process was launched in native-messaging host mode.
///
/// Scans the provided args for [`NATIVE_MESSAGING_ARG`]. The binary's
/// `main` consults this BEFORE building the Tauri app: host mode runs the
/// stdio loop and exits; normal launch proceeds to the WebView.
pub fn is_host_mode<I, S>(args: I) -> bool
where
    I: IntoIterator<Item = S>,
    S: AsRef<str>,
{
    args.into_iter().any(|a| a.as_ref() == NATIVE_MESSAGING_ARG)
}

/// The pairing decision seam.
///
/// The host asks the gate whether the current connection is paired before
/// acting on ANY frame. Task 4 supplies the registry-backed implementation
/// ([`super::token::RegistryGate`]) bound to the exact extension ID + a
/// scoped, revocable token; [`UnpairedGate`] remains as the
/// always-unpaired test fixture (and the boot default until the host reads
/// the connection's claimed token, task 5/7).
pub trait PairingGate {
    /// Is the current native-messaging connection paired (a valid,
    /// non-revoked token bound to the exact extension ID)?
    fn is_paired(&self) -> bool;
}

/// Always-unpaired gate: every caller is unpaired.
///
/// Makes the silent-to-unpaired contract testable, and is the host's boot
/// default before a connection presents a claimed token. The real gate is
/// [`super::token::RegistryGate`] (task 4), which validates a presented
/// `(extension_id, token)` against the [`super::token::TokenRegistry`].
///
/// Now that the production loop ([`run_envelope_loop`]) threads the token off
/// the envelope into a [`RegistryGate`], this stub is exercised only by the
/// task-4 primitive tests — `allow(dead_code)` in non-test builds.
#[cfg_attr(not(test), allow(dead_code))]
pub struct UnpairedGate;

impl PairingGate for UnpairedGate {
    fn is_paired(&self) -> bool {
        false
    }
}

/// The typed result of processing one ext→host frame.
///
/// The loop maps each variant to a wire action. Task 4's lower-level
/// [`process_message`] returns the pairing/validation/rate-limit primitive
/// outcome; task 5's envelope-aware [`process_envelope`] additionally carries
/// the composed [`HostReply`] (`accepted | error | locked`) in
/// [`HandoffOutcome::Replied`] so the loop writes the tiny reply frame.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum HandoffOutcome {
    /// The caller is unpaired/unknown → the host writes NOTHING. This is
    /// the silent-to-unpaired contract; it is distinct from `Rejected`
    /// (which DOES emit a bounded error to a paired caller).
    SilentlyIgnored,

    /// A paired caller's frame passed framing + validation + the rate
    /// limiter (task 4 primitive). Task 6 turns this into the real
    /// `note_create` write; here it is the clean seam meaning "everything the
    /// foundation validates, validated, vault unlocked".
    Accepted,

    /// A paired caller's frame was rejected by a bounded, reportable
    /// reason (validation failure or rate-limit throttle). The closed
    /// [`RejectReason`] names the cause without leaking bytes; the
    /// envelope-aware path maps this to a [`HostReply::Error`].
    Rejected(RejectReason),

    /// A paired caller's frame was fully processed by [`process_envelope`]
    /// and the host must write this tiny [`HostReply`] back. Carries the
    /// `accepted | error | locked` reply (≤1 MiB by [`super::envelope::encode_reply`]).
    Replied(HostReply),
}

/// Closed reasons a PAIRED caller's frame is rejected (paired callers get
/// honest feedback; unpaired callers get silence).
///
/// The envelope path ([`process_envelope`]) consumes `RejectReason::label`
/// when mapping a rate-limit throttle to a [`HostReply::Error`]; the
/// `Validation` variant + the lower-level [`process_message`] path are
/// task-4 primitives exercised by tests — `allow(dead_code)` in non-test
/// builds for the variants the envelope path does not itself construct.
#[cfg_attr(not(test), allow(dead_code))]
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RejectReason {
    /// A field-level validation failure (UTF-8, note-body cap, path
    /// traversal, MIME re-sniff). Carries the closed validation label.
    Validation(&'static str),
    /// The clip-handoff rate limit throttled this handoff (story 21).
    RateLimited,
}

impl RejectReason {
    /// Stable `&'static str` label for tracing.
    pub fn label(&self) -> &'static str {
        match self {
            RejectReason::Validation(l) => l,
            RejectReason::RateLimited => "rate_limited",
        }
    }
}

/// Process one ext→host frame body, deciding the outcome.
///
/// Order of gates (each is a real, tested bound even though tasks 4/5/6
/// fill the bodies they guard):
///
/// 1. **Pairing** — unpaired ⇒ [`HandoffOutcome::SilentlyIgnored`] (no
///    output, no further work). Checked FIRST so an unpaired caller never
///    learns anything about the host's internal state.
/// 2. **UTF-8** — the frame must be well-formed UTF-8.
/// 3. **Note-body cap** — the WHOLE frame body is bounded here as a
///    conservative stand-in for the note-body field until task 5 decodes
///    the envelope and applies the cap to the `markdown` field
///    specifically. (The 64 MiB frame cap is already enforced at the
///    framing layer; this 16 MiB gate is the note-body sub-cap.)
/// 4. **Rate limit** — the LAST gate before a write, so malformed frames
///    never burn a legitimate sender's budget.
///
/// Returns [`HandoffOutcome::Accepted`] when all gates pass — task 6 turns
/// that into the actual `note_create`.
///
/// The task-4 lower-level primitive (gate constructed externally, whole-frame
/// body cap). The production path is [`process_envelope`], which decodes the
/// versioned envelope and threads the token off it. This primitive is
/// retained as a tested building block — `allow(dead_code)` in non-test builds.
#[cfg_attr(not(test), allow(dead_code))]
pub fn process_message(
    body: &[u8],
    gate: &dyn PairingGate,
    limiter: &mut RateLimiter,
    now: Instant,
) -> HandoffOutcome {
    // 1. Silent to unpaired/unknown callers — FIRST, before any other
    //    observation. No output, no rate-limit consumption, no logging of
    //    anything caller-derived.
    if !gate.is_paired() {
        return HandoffOutcome::SilentlyIgnored;
    }

    // 2. UTF-8 validation.
    if let Err(e) = validation::validate_utf8(body) {
        return HandoffOutcome::Rejected(RejectReason::Validation(e.label()));
    }

    // 3. Note-body sub-cap (16 MiB). Task 5 narrows this to the decoded
    //    `markdown` field; here the whole frame body stands in.
    if let Err(e) = validation::validate_note_body_len(body.len()) {
        return HandoffOutcome::Rejected(RejectReason::Validation(e.label()));
    }

    // 4. Rate limit — last gate before the (task-6) write.
    match limiter.check(now) {
        RateDecision::Allowed => HandoffOutcome::Accepted,
        RateDecision::Throttled => HandoffOutcome::Rejected(RejectReason::RateLimited),
    }
}

/// Process one ext→host frame body as a **versioned handoff envelope** (task
/// 5), threading the claimed `(extension_id, token)` off the decoded envelope
/// into the [`RegistryGate`] and answering `is-unlocked-status` from the real
/// vault-runtime state via `status`.
///
/// This is the envelope-aware sibling of [`process_message`] (which task 4
/// left as the lower-level pairing/validation/rate-limit primitive). Gate
/// order — each step is silent-to-unpaired-safe:
///
/// 1. **UTF-8 + decode.** The body must be well-formed UTF-8 and a valid
///    [`super::envelope::HandoffEnvelope`]. A decode failure (malformed shape
///    or unknown version) on a frame whose token we cannot even verify is
///    treated as **unpaired ⇒ silent** ([`HandoffOutcome::SilentlyIgnored`]):
///    a malformed frame must not become an error oracle for an unidentifiable
///    caller. (A decode failure from a *paired* caller — verifiable token but
///    a bad shape — is a bounded `error` reply; see step 2's ordering.)
/// 2. **Pairing.** Build a [`RegistryGate`] from the envelope's claimed
///    `(extension_id, token)` against `registry`; an invalid / revoked /
///    missing claim ⇒ silent. Checked BEFORE any body-shape work so an
///    unpaired caller learns nothing.
/// 3. **Dispatch on `kind`.**
///    - [`HandoffKind::IsUnlockedStatus`] ⇒ answer from `status`:
///      [`VaultStatus::Unlocked`] → [`HostReply::accepted`] (status query
///      confirm), [`VaultStatus::Locked`] → [`HostReply::locked`] (the O4
///      explicit `locked` status that drives "Unlock Myne").
///    - [`HandoffKind::CreateClip`] ⇒ apply the note-body sub-cap to the
///      decoded `markdown_body` (NOT the whole frame), then the rate limit;
///      then check the vault status — a locked vault ⇒ [`HostReply::locked`]
///      (no write attempted), an unlocked vault ⇒ [`HandoffOutcome::Accepted`]
///      (the task-6 `note_create` seam, no note composed here).
///
/// To keep the silent-to-unpaired contract exact, decode happens before the
/// gate but its FAILURE is mapped through the gate: we build the gate from
/// whatever `(extension_id, token)` we *can* extract; on a decode failure we
/// have none, so the gate is unpaired and we stay silent. A *paired* caller
/// whose envelope is malformed is handled by re-deriving below.
///
/// **Superseded as the PRODUCTION validator by [`super::ingest`] (task 6).**
/// The native-messaging host is now a thin, untrusted relay: it does NOT
/// validate — it forwards every frame to the app, which re-validates as
/// untrusted input via [`super::ingest::ingest_relayed_frame`] (the SAME
/// gate order, plus the note-compose + `note_create` write). This function is
/// retained as the tested validation primitive that documents the gate
/// discipline — `allow(dead_code)` in non-test builds.
#[cfg_attr(not(test), allow(dead_code))]
pub fn process_envelope(
    body: &[u8],
    registry: &TokenRegistry,
    status: &dyn VaultStatusSource,
    limiter: &mut RateLimiter,
    now: Instant,
) -> HandoffOutcome {
    // 1. UTF-8 + envelope decode. On ANY decode failure we cannot verify a
    //    token, so there is no paired caller to answer — stay SILENT (no
    //    error oracle to an unidentifiable / unpaired caller). This is the
    //    conservative, contract-preserving choice: a paired caller's client
    //    only ever sends well-formed envelopes; a malformed frame is hostile.
    let Ok(text) = validation::validate_utf8(body) else {
        return HandoffOutcome::SilentlyIgnored;
    };
    let envelope = match envelope::decode_envelope(text) {
        Ok(e) => e,
        Err(e) => {
            // Decode failed → no verifiable token → silent. Log the closed
            // label only (never the body).
            tracing::debug!(stage = "clip_envelope", envelope_error = e.label());
            let _: EnvelopeError = e; // bind the closed type for the reader
            return HandoffOutcome::SilentlyIgnored;
        }
    };

    // 2. Pairing — build the gate from the envelope's claimed identity and
    //    validate against the authoritative registry. Invalid / revoked /
    //    missing ⇒ silent (the task-4 contract, now driven by the envelope).
    let gate = RegistryGate::new(
        registry,
        envelope.extension_id.clone(),
        envelope.token.clone(),
    );
    if !gate.is_paired() {
        return HandoffOutcome::SilentlyIgnored;
    }

    // 3. Dispatch on the handoff kind.
    match envelope.kind {
        HandoffKind::IsUnlockedStatus => {
            // A pure status read of the vault-runtime Slot — exposes only the
            // unlocked/locked boolean (no content, no AS3/AS5 structure).
            match status.vault_status() {
                VaultStatus::Unlocked => {
                    // The status query is "accepted": the vault is unlocked.
                    // The confirm token is the SYNC-13 handoff-accepted marker.
                    HandoffOutcome::Replied(HostReply::accepted(mint_confirm()))
                }
                VaultStatus::Locked => HandoffOutcome::Replied(HostReply::locked()),
            }
        }
        HandoffKind::CreateClip => {
            // 3a. Note-body sub-cap on the DECODED body (task 5 narrows the
            //     task-4 whole-frame stand-in to the `markdown_body` field).
            if let Err(e) = validation::validate_note_body_len(envelope.markdown_body.len()) {
                return HandoffOutcome::Replied(HostReply::error(e.label()));
            }
            // 3b. Rate limit — last gate before the (task-6) write.
            if let RateDecision::Throttled = limiter.check(now) {
                return HandoffOutcome::Replied(HostReply::error(
                    RejectReason::RateLimited.label(),
                ));
            }
            // 3c. Vault status. A locked vault ⇒ explicit `locked` (no write
            //     attempted; the extension shows "Unlock Myne", writes nothing
            //     — SYNC-1a). An unlocked vault ⇒ the task-6 `note_create`
            //     seam (Accepted; no note composed here).
            match status.vault_status() {
                VaultStatus::Locked => HandoffOutcome::Replied(HostReply::locked()),
                VaultStatus::Unlocked => HandoffOutcome::Accepted,
            }
        }
        HandoffKind::PairBegin | HandoffKind::PairAwait => {
            // Pairing (the two-phase `PairBegin`/`PairAwait`) is an APP-side flow
            // — it needs the in-app Accept dialog + the token registry, and routes
            // BEFORE the token gate (the caller is unpaired).
            // The PRODUCTION path [`super::ingest::ingest_relayed_frame`] owns it.
            // This host-process validation primitive does NOT dispatch pairing; a
            // pairing kind reaching here is silent (no oracle), exactly as the
            // gate-first ordering already yields for an unpaired caller.
            HandoffOutcome::SilentlyIgnored
        }
    }
}

/// Mint a confirm token (SYNC-13) for an accepted handoff — a
/// **handoff-accepted** marker, NOT a write-committed claim.
///
/// 16 hex chars of CSPRNG (`getrandom`) — enough to correlate one handoff's
/// reply without being guessable. It carries NO vault material and is not a
/// key; the desktop remains the sole write authority. On the (fatal-class)
/// CSPRNG-unavailable path it falls back to a fixed marker rather than
/// failing the reply — the confirm token is a correlation nicety, never a
/// security boundary.
///
/// `pub(crate)` so the app-side keyed ingest path ([`super::ingest`]) mints the
/// SAME confirm-token shape on a written clip — one mint helper, one provenance.
pub(crate) fn mint_confirm() -> String {
    let mut buf = [0u8; 8];
    if getrandom::getrandom(&mut buf).is_err() {
        return "accepted".to_string();
    }
    let mut s = String::with_capacity(16);
    const HEX: &[u8; 16] = b"0123456789abcdef";
    for b in buf {
        s.push(HEX[(b >> 4) as usize] as char);
        s.push(HEX[(b & 0x0f) as usize] as char);
    }
    s
}

/// Run the native-messaging stdio loop over `reader`/`writer` until the
/// extension disconnects (a clean EOF) or an unrecoverable IO error.
///
/// The loop is deliberately THIN: read a frame, hand it to
/// [`process_message`], and act on the outcome —
///
/// - [`HandoffOutcome::SilentlyIgnored`] → write nothing (the
///   silent-to-unpaired contract);
/// - [`HandoffOutcome::Accepted`] → task 5/6 compose and write the tiny
///   `accepted` reply (here: a no-op placeholder, no reply yet);
/// - [`HandoffOutcome::Rejected`] → task 5 composes a bounded error reply
///   to the PAIRED caller (here: a no-op placeholder).
///
/// A [`FrameError::Eof`] ends the loop cleanly (normal disconnect). A
/// per-frame [`FrameError`] (oversized / truncated) is logged with its
/// closed label and the loop CONTINUES — a single malformed frame must not
/// take down the whole connection. (A true stream IO error ends the loop.)
///
/// Returns `Ok(())` on clean disconnect.
///
/// The task-4 primitive loop (over [`process_message`] with an externally
/// constructed [`PairingGate`]). The production loop is [`run_envelope_loop`];
/// this is retained as a tested building block — `allow(dead_code)` in
/// non-test builds.
#[cfg_attr(not(test), allow(dead_code))]
pub fn run_loop<R: Read, W: Write>(
    reader: &mut R,
    writer: &mut W,
    gate: &dyn PairingGate,
    limiter: &mut RateLimiter,
) -> std::io::Result<()> {
    loop {
        match framing::read_frame(reader) {
            Ok(body) => {
                let outcome = process_message(&body, gate, limiter, Instant::now());
                act_on_outcome(writer, outcome);
            }
            Err(FrameError::Eof) => return Ok(()),
            Err(e) => return end_on_frame_error(e),
        }
    }
}

/// Run the **envelope-aware** native-messaging stdio loop (task 5).
///
/// The production host loop: read a frame, hand it to [`process_envelope`]
/// (which decodes the versioned envelope, threads `(extension_id, token)`
/// into the [`RegistryGate`], and answers `is-unlocked-status` from `status`),
/// then act on the outcome —
///
/// - [`HandoffOutcome::SilentlyIgnored`] → write nothing (silent-to-unpaired);
/// - [`HandoffOutcome::Replied`] → write the tiny `accepted | error | locked`
///   reply frame via [`framing::write_frame`] (bounded ≤1 MiB by
///   [`super::envelope::encode_reply`]);
/// - [`HandoffOutcome::Accepted`] → the task-6 `note_create` seam (no reply
///   yet — task 6 composes the note and the `accepted` confirm).
///
/// `registry` is the authoritative token registry (the WebView mints into it;
/// task 7 makes it durable + shared across the host/app processes). `status`
/// is the [`VaultStatusSource`] — in the host process it is the relay seam to
/// the app's real `Slot` (currently a [`super::envelope::StaticVaultStatus`]
/// adapter until the relay lands; see the `envelope` module's "Cross-process"
/// note and [`super::envelope::VaultStatusSource`]).
///
/// Frame-error + EOF handling matches [`run_loop`] exactly.
///
/// **Superseded as the production host loop by the task-6 relay** — the host is
/// now a thin pump ([`super::relay::forward_stdio_over_socket`]) and the
/// app-side keyed loop is [`super::relay::serve_connection`] (which drives
/// [`super::ingest::ingest_relayed_frame`]). Retained as the tested
/// envelope-loop primitive; `allow(dead_code)` in non-test builds.
#[cfg_attr(not(test), allow(dead_code))]
pub fn run_envelope_loop<R: Read, W: Write>(
    reader: &mut R,
    writer: &mut W,
    registry: &TokenRegistry,
    status: &dyn VaultStatusSource,
    limiter: &mut RateLimiter,
) -> std::io::Result<()> {
    loop {
        match framing::read_frame(reader) {
            Ok(body) => {
                let outcome = process_envelope(&body, registry, status, limiter, Instant::now());
                act_on_outcome(writer, outcome);
            }
            Err(FrameError::Eof) => return Ok(()),
            Err(e) => return end_on_frame_error(e),
        }
    }
}

/// Act on one processed frame's [`HandoffOutcome`]: stay silent, write the
/// tiny reply frame, or note the task-6 `Accepted` seam. The body may carry
/// note plaintext — only bounded outcome labels are ever logged, never a body.
fn act_on_outcome<W: Write>(writer: &mut W, outcome: HandoffOutcome) {
    match outcome {
        HandoffOutcome::SilentlyIgnored => {
            // Silent: write nothing (the silent-to-unpaired contract).
        }
        HandoffOutcome::Accepted => {
            // Task 6 turns this into the `note_create` write + the `accepted`
            // confirm reply. The seam stays a no-reply no-op for now.
            tracing::debug!(stage = "clip_handoff", outcome = "accepted");
        }
        HandoffOutcome::Rejected(reason) => {
            // The lower-level `process_message` path; the envelope path emits
            // `Replied(HostReply::Error)` instead. Logged, no reply here.
            tracing::debug!(
                stage = "clip_handoff",
                outcome = "rejected",
                reason = reason.label()
            );
        }
        HandoffOutcome::Replied(reply) => {
            tracing::debug!(stage = "clip_handoff", outcome = reply.status_label());
            // Compose the tiny reply frame (≤1 MiB enforced by `encode_reply`
            // AND again by `write_frame`). A composition / write failure is
            // logged with a closed label and the frame is dropped — a reply
            // we cannot send must never panic or leak.
            match envelope::encode_reply(&reply) {
                Ok(bytes) => {
                    if let Err(e) = framing::write_frame(writer, &bytes) {
                        tracing::debug!(stage = "clip_reply", frame_error = e.label());
                    }
                }
                Err(e) => {
                    tracing::debug!(stage = "clip_reply", validation_error = e.label());
                }
            }
        }
    }
}

/// Map a per-frame [`FrameError`] to the loop's exit decision.
///
/// A malformed frame (oversized / truncated / non-EOF IO) leaves the stream
/// in an unknown sync state; we do NOT attempt a mid-stream resync (that is a
/// re-framing attack surface) — we log the closed label and end the loop.
/// Returns `Ok(())` (a closed connection is not a host-fatal error).
fn end_on_frame_error(e: FrameError) -> std::io::Result<()> {
    tracing::debug!(stage = "clip_frame", frame_error = e.label());
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;
    use std::time::Duration;

    /// A test gate that reports a fixed pairing state.
    struct FixedGate(bool);
    impl PairingGate for FixedGate {
        fn is_paired(&self) -> bool {
            self.0
        }
    }

    fn framed(body: &[u8]) -> Vec<u8> {
        let mut v = (body.len() as u32).to_le_bytes().to_vec();
        v.extend_from_slice(body);
        v
    }

    // ---- host-mode arg -------------------------------------------------

    #[test]
    fn detects_host_mode_arg() {
        assert!(is_host_mode([
            "/path/to/myne".to_string(),
            NATIVE_MESSAGING_ARG.to_string(),
            "chrome-extension://abc/".to_string(),
        ]));
    }

    #[test]
    fn normal_launch_is_not_host_mode() {
        assert!(!is_host_mode(["/path/to/myne".to_string()]));
        assert!(!is_host_mode([
            "/path/to/myne".to_string(),
            "--some-other-flag".to_string()
        ]));
    }

    // ---- silent-to-unpaired --------------------------------------------

    #[test]
    fn unpaired_caller_is_silently_ignored() {
        let mut limiter = RateLimiter::default();
        let outcome = process_message(
            br#"{"markdown":"hi"}"#,
            &UnpairedGate,
            &mut limiter,
            Instant::now(),
        );
        assert_eq!(outcome, HandoffOutcome::SilentlyIgnored);
    }

    #[test]
    fn unpaired_caller_produces_no_output_through_the_loop() {
        // A full frame from an unpaired caller → the loop writes NOTHING.
        let wire = framed(br#"{"markdown":"hi"}"#);
        let mut reader = Cursor::new(wire);
        let mut writer: Vec<u8> = Vec::new();
        let mut limiter = RateLimiter::default();
        run_loop(&mut reader, &mut writer, &UnpairedGate, &mut limiter).unwrap();
        assert!(
            writer.is_empty(),
            "host must be silent to an unpaired caller — wrote {} bytes",
            writer.len()
        );
    }

    #[test]
    fn unpaired_caller_does_not_consume_rate_budget() {
        // Silent-to-unpaired is checked BEFORE the limiter, so an unpaired
        // flood never burns a (future paired) budget. The limiter count is
        // observable indirectly: after many unpaired handoffs, a freshly
        // paired caller still gets its full budget.
        let mut limiter = RateLimiter::new(1, Duration::from_secs(60));
        let now = Instant::now();
        for _ in 0..50 {
            assert_eq!(
                process_message(b"{}", &UnpairedGate, &mut limiter, now),
                HandoffOutcome::SilentlyIgnored
            );
        }
        // The first paired handoff is still Allowed (budget untouched).
        assert_eq!(
            process_message(b"{}", &FixedGate(true), &mut limiter, now),
            HandoffOutcome::Accepted
        );
    }

    // ---- paired-caller validation gates --------------------------------

    #[test]
    fn paired_valid_frame_is_accepted() {
        let mut limiter = RateLimiter::default();
        assert_eq!(
            process_message(
                br#"{"markdown":"hi"}"#,
                &FixedGate(true),
                &mut limiter,
                Instant::now()
            ),
            HandoffOutcome::Accepted
        );
    }

    #[test]
    fn paired_invalid_utf8_frame_is_rejected() {
        let mut limiter = RateLimiter::default();
        let body = [0x7B, 0xFF, 0x7D]; // `{`, invalid, `}`
        match process_message(&body, &FixedGate(true), &mut limiter, Instant::now()) {
            HandoffOutcome::Rejected(RejectReason::Validation(label)) => {
                assert_eq!(label, "invalid_utf8");
            }
            other => panic!("expected Validation(invalid_utf8), got {other:?}"),
        }
    }

    #[test]
    fn paired_oversized_note_body_is_rejected() {
        // A frame body over the 16 MiB note-body sub-cap (but under the
        // 64 MiB frame cap, so framing passes) → rejected by the note-body
        // gate, never accepted/truncated.
        let mut limiter = RateLimiter::default();
        let body = vec![b'a'; super::super::MAX_NOTE_BODY + 1];
        match process_message(&body, &FixedGate(true), &mut limiter, Instant::now()) {
            HandoffOutcome::Rejected(RejectReason::Validation(label)) => {
                assert_eq!(label, "note_body_oversized");
            }
            other => panic!("expected Validation(note_body_oversized), got {other:?}"),
        }
    }

    #[test]
    fn paired_caller_over_rate_limit_is_rejected() {
        let mut limiter = RateLimiter::new(2, Duration::from_secs(60));
        let now = Instant::now();
        assert_eq!(
            process_message(b"{}", &FixedGate(true), &mut limiter, now),
            HandoffOutcome::Accepted
        );
        assert_eq!(
            process_message(b"{}", &FixedGate(true), &mut limiter, now),
            HandoffOutcome::Accepted
        );
        // Third within the window → rate-limited (rejected, not written).
        assert_eq!(
            process_message(b"{}", &FixedGate(true), &mut limiter, now),
            HandoffOutcome::Rejected(RejectReason::RateLimited)
        );
    }

    #[test]
    fn rate_limiter_is_last_gate_invalid_frames_do_not_burn_budget() {
        // A burst of INVALID-UTF8 frames from a paired caller must not
        // consume the rate budget (the limiter is the last gate). After
        // the burst, the full budget remains for valid frames.
        let mut limiter = RateLimiter::new(1, Duration::from_secs(60));
        let now = Instant::now();
        let bad = [0xFF]; // invalid UTF-8
        for _ in 0..10 {
            assert!(matches!(
                process_message(&bad, &FixedGate(true), &mut limiter, now),
                HandoffOutcome::Rejected(RejectReason::Validation(_))
            ));
        }
        // The one valid frame still gets the budget.
        assert_eq!(
            process_message(b"{}", &FixedGate(true), &mut limiter, now),
            HandoffOutcome::Accepted
        );
    }

    // ---- loop framing resilience ---------------------------------------

    #[test]
    fn loop_exits_cleanly_on_eof() {
        let wire = framed(b"{}");
        let mut reader = Cursor::new(wire);
        let mut writer: Vec<u8> = Vec::new();
        let mut limiter = RateLimiter::default();
        // Paired so the frame is processed; the loop then hits EOF.
        run_loop(&mut reader, &mut writer, &FixedGate(true), &mut limiter).unwrap();
        // Accepted path writes no reply yet (task 5), so still empty.
        assert!(writer.is_empty());
    }

    #[test]
    fn loop_does_not_panic_on_truncated_frame() {
        // Prefix declares 100 bytes, only 3 present → Truncated; the loop
        // ends cleanly without panicking.
        let mut wire = (100u32).to_le_bytes().to_vec();
        wire.extend_from_slice(b"abc");
        let mut reader = Cursor::new(wire);
        let mut writer: Vec<u8> = Vec::new();
        let mut limiter = RateLimiter::default();
        run_loop(&mut reader, &mut writer, &FixedGate(true), &mut limiter).unwrap();
        assert!(writer.is_empty());
    }

    #[test]
    fn loop_does_not_panic_on_oversized_frame() {
        // Prefix declares over the frame cap → Oversized on the prefix
        // alone; the loop ends cleanly without allocating the body.
        let declared = (super::super::MAX_EXT_TO_HOST_FRAME + 1) as u32;
        let wire = declared.to_le_bytes().to_vec(); // prefix only
        let mut reader = Cursor::new(wire);
        let mut writer: Vec<u8> = Vec::new();
        let mut limiter = RateLimiter::default();
        run_loop(&mut reader, &mut writer, &FixedGate(true), &mut limiter).unwrap();
        assert!(writer.is_empty());
    }

    // ---- real token-registry gate (task 4) -----------------------------
    //
    // The seam task 3 left (`PairingGate`) is now filled by
    // `token::RegistryGate`. These tests drive `process_message` /
    // `run_loop` through the REAL gate (not the `FixedGate` fixture) to
    // prove the host accepts a valid scoped token and stays SILENT — no
    // write, no reply — to a missing / invalid / revoked one.
    //
    // `RegistryGate` / `TokenRegistry` come in via `use super::*` (host.rs
    // imports them at the top for `process_envelope`).

    const EXT: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

    #[test]
    fn valid_token_gate_accepts_a_well_formed_frame() {
        let mut reg = TokenRegistry::new();
        let token = reg.issue(EXT).unwrap();
        let gate = RegistryGate::new(&reg, EXT, token.value());
        let mut limiter = RateLimiter::default();
        assert_eq!(
            process_message(br#"{"markdown":"hi"}"#, &gate, &mut limiter, Instant::now()),
            HandoffOutcome::Accepted
        );
    }

    #[test]
    fn missing_token_gate_is_silently_ignored() {
        let reg = TokenRegistry::new(); // nothing issued
        let gate = RegistryGate::new(&reg, EXT, "garbage-token");
        let mut limiter = RateLimiter::default();
        assert_eq!(
            process_message(br#"{"markdown":"hi"}"#, &gate, &mut limiter, Instant::now()),
            HandoffOutcome::SilentlyIgnored
        );
    }

    #[test]
    fn revoked_token_gate_is_silently_ignored() {
        let mut reg = TokenRegistry::new();
        let token = reg.issue(EXT).unwrap();
        reg.revoke_extension(EXT);
        let gate = RegistryGate::new(&reg, EXT, token.value());
        let mut limiter = RateLimiter::default();
        assert_eq!(
            process_message(br#"{"markdown":"hi"}"#, &gate, &mut limiter, Instant::now()),
            HandoffOutcome::SilentlyIgnored
        );
    }

    #[test]
    fn wrong_extension_id_gate_is_silently_ignored() {
        // The right token value replayed under a DIFFERENT extension ID
        // never validates (exact-ID binding).
        let mut reg = TokenRegistry::new();
        let token = reg.issue(EXT).unwrap();
        let other = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
        let gate = RegistryGate::new(&reg, other, token.value());
        let mut limiter = RateLimiter::default();
        assert_eq!(
            process_message(br#"{"markdown":"hi"}"#, &gate, &mut limiter, Instant::now()),
            HandoffOutcome::SilentlyIgnored
        );
    }

    #[test]
    fn host_writes_nothing_through_the_loop_for_a_revoked_token() {
        // End-to-end: a full frame from a revoked extension → the loop
        // writes ZERO bytes (no error frame, no liveness oracle).
        let mut reg = TokenRegistry::new();
        let token = reg.issue(EXT).unwrap();
        reg.revoke_extension(EXT);
        let gate = RegistryGate::new(&reg, EXT, token.value());

        let wire = framed(br#"{"markdown":"hi"}"#);
        let mut reader = Cursor::new(wire);
        let mut writer: Vec<u8> = Vec::new();
        let mut limiter = RateLimiter::default();
        run_loop(&mut reader, &mut writer, &gate, &mut limiter).unwrap();
        assert!(
            writer.is_empty(),
            "host must be silent to a revoked token — wrote {} bytes",
            writer.len()
        );
    }

    // ---- envelope-aware path (task 5) ----------------------------------
    //
    // `process_envelope` decodes the versioned envelope, threads the claimed
    // `(extension_id, token)` into the registry gate, and answers
    // `is-unlocked-status` from a `VaultStatusSource`. These tests drive it
    // through a REAL `TokenRegistry` + the `StaticVaultStatus` adapter (the
    // app process supplies the real `Slot`-backed status — see
    // `envelope::vault_status_from_slot_kind` + its real-runtime test).

    use super::super::envelope::{HostReply, StaticVaultStatus, VaultStatus};

    /// A registry holding one live token for `EXT`, plus that token's value.
    fn paired_registry() -> (TokenRegistry, String) {
        let mut reg = TokenRegistry::new();
        let token = reg.issue(EXT).unwrap();
        let value = token.value().to_string();
        (reg, value)
    }

    /// A valid v1 create-clip envelope for `EXT` with the given token + body.
    fn clip_envelope(token: &str, body: &str) -> Vec<u8> {
        let json = format!(
            r#"{{ "version": 1, "kind": "create-clip", "extension_id": "{EXT}",
                  "token": "{token}", "markdown_body": {body} }}"#,
            body = serde_json::to_string(body).unwrap()
        );
        json.into_bytes()
    }

    /// A valid v1 is-unlocked-status envelope for `EXT` with the given token.
    fn status_envelope(token: &str) -> Vec<u8> {
        format!(
            r#"{{ "version": 1, "kind": "is-unlocked-status",
                  "extension_id": "{EXT}", "token": "{token}" }}"#
        )
        .into_bytes()
    }

    #[test]
    fn envelope_status_query_unlocked_replies_accepted() {
        let (reg, token) = paired_registry();
        let status = StaticVaultStatus(VaultStatus::Unlocked);
        let mut limiter = RateLimiter::default();
        match process_envelope(
            &status_envelope(&token),
            &reg,
            &status,
            &mut limiter,
            Instant::now(),
        ) {
            HandoffOutcome::Replied(HostReply::Accepted { confirm }) => {
                assert!(
                    !confirm.is_empty(),
                    "accepted reply carries a confirm token"
                );
            }
            other => panic!("expected Replied(Accepted), got {other:?}"),
        }
    }

    #[test]
    fn envelope_status_query_locked_replies_locked() {
        let (reg, token) = paired_registry();
        let status = StaticVaultStatus(VaultStatus::Locked);
        let mut limiter = RateLimiter::default();
        assert_eq!(
            process_envelope(
                &status_envelope(&token),
                &reg,
                &status,
                &mut limiter,
                Instant::now()
            ),
            HandoffOutcome::Replied(HostReply::Locked)
        );
    }

    #[test]
    fn envelope_clip_with_unlocked_vault_is_accepted_seam_for_task_6() {
        // A valid-token clip + unlocked vault → Accepted (the task-6
        // `note_create` seam). No reply is written for Accepted (task 6
        // composes the note + the accepted confirm).
        let (reg, token) = paired_registry();
        let status = StaticVaultStatus(VaultStatus::Unlocked);
        let mut limiter = RateLimiter::default();
        assert_eq!(
            process_envelope(
                &clip_envelope(&token, "# clip\n\nbody"),
                &reg,
                &status,
                &mut limiter,
                Instant::now()
            ),
            HandoffOutcome::Accepted
        );
    }

    #[test]
    fn envelope_clip_with_locked_vault_replies_locked_no_write_attempted() {
        // A valid-token clip but the vault is LOCKED → explicit `locked`
        // reply, NO write attempted (the extension shows "Unlock Myne",
        // writes nothing — SYNC-1a).
        let (reg, token) = paired_registry();
        let status = StaticVaultStatus(VaultStatus::Locked);
        let mut limiter = RateLimiter::default();
        assert_eq!(
            process_envelope(
                &clip_envelope(&token, "# clip"),
                &reg,
                &status,
                &mut limiter,
                Instant::now()
            ),
            HandoffOutcome::Replied(HostReply::Locked)
        );
    }

    #[test]
    fn envelope_clip_over_note_body_cap_replies_error() {
        // The note-body cap applies to the DECODED `markdown_body`, not the
        // whole frame. An over-cap body → a bounded `error` reply, never a
        // truncated note.
        let (reg, token) = paired_registry();
        let status = StaticVaultStatus(VaultStatus::Unlocked);
        let mut limiter = RateLimiter::default();
        let big = "a".repeat(super::super::MAX_NOTE_BODY + 1);
        match process_envelope(
            &clip_envelope(&token, &big),
            &reg,
            &status,
            &mut limiter,
            Instant::now(),
        ) {
            HandoffOutcome::Replied(HostReply::Error { reason }) => {
                assert_eq!(reason, "note_body_oversized");
            }
            other => panic!("expected Replied(Error(note_body_oversized)), got {other:?}"),
        }
    }

    #[test]
    fn envelope_clip_over_rate_limit_replies_error() {
        let (reg, token) = paired_registry();
        let status = StaticVaultStatus(VaultStatus::Unlocked);
        let mut limiter = RateLimiter::new(1, Duration::from_secs(60));
        let now = Instant::now();
        // First clip consumes the single-slot budget → Accepted.
        assert_eq!(
            process_envelope(
                &clip_envelope(&token, "a"),
                &reg,
                &status,
                &mut limiter,
                now
            ),
            HandoffOutcome::Accepted
        );
        // Second within the window → rate-limited error reply.
        match process_envelope(
            &clip_envelope(&token, "b"),
            &reg,
            &status,
            &mut limiter,
            now,
        ) {
            HandoffOutcome::Replied(HostReply::Error { reason }) => {
                assert_eq!(reason, "rate_limited");
            }
            other => panic!("expected Replied(Error(rate_limited)), got {other:?}"),
        }
    }

    #[test]
    fn envelope_unpaired_token_is_silently_ignored() {
        // A well-formed envelope but an UNKNOWN token → silent (no reply,
        // no oracle). The silent-to-unpaired contract carries into the
        // envelope path.
        let reg = TokenRegistry::new(); // nothing issued
        let status = StaticVaultStatus(VaultStatus::Unlocked);
        let mut limiter = RateLimiter::default();
        assert_eq!(
            process_envelope(
                &status_envelope("garbage"),
                &reg,
                &status,
                &mut limiter,
                Instant::now()
            ),
            HandoffOutcome::SilentlyIgnored
        );
    }

    #[test]
    fn envelope_unknown_version_is_silently_ignored() {
        // An unknown version → no verifiable token → silent (no error oracle
        // to an unidentifiable caller). Never panics.
        let (reg, _token) = paired_registry();
        let status = StaticVaultStatus(VaultStatus::Unlocked);
        let mut limiter = RateLimiter::default();
        let body = br#"{ "version": 99, "kind": "create-clip" }"#;
        assert_eq!(
            process_envelope(body, &reg, &status, &mut limiter, Instant::now()),
            HandoffOutcome::SilentlyIgnored
        );
    }

    #[test]
    fn envelope_malformed_shape_is_silently_ignored_no_panic() {
        let (reg, _token) = paired_registry();
        let status = StaticVaultStatus(VaultStatus::Unlocked);
        let mut limiter = RateLimiter::default();
        for body in [&b"not json"[..], b"{}", b"{ \"version\": 1 }"] {
            assert_eq!(
                process_envelope(body, &reg, &status, &mut limiter, Instant::now()),
                HandoffOutcome::SilentlyIgnored
            );
        }
    }

    #[test]
    fn envelope_invalid_utf8_is_silently_ignored_no_panic() {
        let (reg, _token) = paired_registry();
        let status = StaticVaultStatus(VaultStatus::Unlocked);
        let mut limiter = RateLimiter::default();
        let body = [0x7B, 0xFF, 0x7D]; // `{`, invalid, `}`
        assert_eq!(
            process_envelope(&body, &reg, &status, &mut limiter, Instant::now()),
            HandoffOutcome::SilentlyIgnored
        );
    }

    // ---- envelope loop: writes the tiny reply frame --------------------

    #[test]
    fn envelope_loop_writes_a_locked_reply_frame() {
        // End-to-end through the loop: a valid-token status query with a
        // locked vault → the loop writes exactly one tiny `locked` reply
        // frame (4-byte LE prefix + JSON body).
        let (reg, token) = paired_registry();
        let status = StaticVaultStatus(VaultStatus::Locked);
        let wire = framed(&status_envelope(&token));
        let mut reader = Cursor::new(wire);
        let mut writer: Vec<u8> = Vec::new();
        let mut limiter = RateLimiter::default();
        run_envelope_loop(&mut reader, &mut writer, &reg, &status, &mut limiter).unwrap();
        assert!(!writer.is_empty(), "a locked reply frame must be written");
        // Decode the framed reply back and assert it is `locked`.
        let mut rcur = Cursor::new(writer);
        let reply_body = framing::read_frame(&mut rcur).expect("reply frame");
        let reply: HostReply = serde_json::from_slice(&reply_body).unwrap();
        assert_eq!(reply, HostReply::Locked);
    }

    #[test]
    fn envelope_loop_is_silent_to_an_unpaired_caller() {
        // The silent-to-unpaired contract through the envelope loop: an
        // unknown token → ZERO bytes written.
        let reg = TokenRegistry::new(); // nothing issued
        let status = StaticVaultStatus(VaultStatus::Unlocked);
        let wire = framed(&status_envelope("garbage"));
        let mut reader = Cursor::new(wire);
        let mut writer: Vec<u8> = Vec::new();
        let mut limiter = RateLimiter::default();
        run_envelope_loop(&mut reader, &mut writer, &reg, &status, &mut limiter).unwrap();
        assert!(
            writer.is_empty(),
            "host must be silent to an unpaired caller — wrote {} bytes",
            writer.len()
        );
    }

    #[test]
    fn envelope_loop_writes_an_accepted_reply_for_an_unlocked_status_query() {
        let (reg, token) = paired_registry();
        let status = StaticVaultStatus(VaultStatus::Unlocked);
        let wire = framed(&status_envelope(&token));
        let mut reader = Cursor::new(wire);
        let mut writer: Vec<u8> = Vec::new();
        let mut limiter = RateLimiter::default();
        run_envelope_loop(&mut reader, &mut writer, &reg, &status, &mut limiter).unwrap();
        let mut rcur = Cursor::new(writer);
        let reply_body = framing::read_frame(&mut rcur).expect("reply frame");
        let reply: HostReply = serde_json::from_slice(&reply_body).unwrap();
        assert!(matches!(reply, HostReply::Accepted { .. }));
    }
}
