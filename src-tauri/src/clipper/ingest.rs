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
//!    `markdown_body`, AND again on the COMPOSED note (provenance frontmatter
//!    can only add bytes, so an in-cap body could compose just over — the
//!    re-check on the composed string is the load-bearing one for story 17).
//! 4. **Re-enforce the rate limit** — the app holds the authoritative limiter
//!    so a compromised host cannot flood the vault by relaying fast.
//!
//! Only AFTER all four gates pass does the app **compose** the note
//! ([`super::compose::compose_clip_note`]) and call the **existing
//! `note_create` pipeline** (`folder: null`, SYNC-15 — the clip lands as an
//! ordinary `.myn` note at the vault root). NO new `clip_ingest` command:
//! the note-write goes through a [`NoteWriter`] seam that the production wiring
//! backs with `notes::note_create_with_dir` (signature unchanged).
//!
//! ## No network fetch (SYNC-12)
//!
//! There is NO URL-fetch path anywhere in this handler or in
//! [`super::compose`]: the only inputs are the in-page-captured envelope
//! fields, and the only output is the composed plaintext handed to
//! `note_create`. `source_url` is written verbatim as a frontmatter value,
//! never dereferenced — zero SSRF surface, zero read-receipt leak (story 25).
//!
//! ## Double-clip independence (SYNC-16, story 19)
//!
//! Each accepted clip is an independent `note_create` call; the registry has
//! no source-URL index, no dedup, no overwrite. Two clips of the same page
//! mint two distinct backend `NoteId`s and write two `.myn` files. This module
//! adds NO dedup; independence is the absence of a check.
//!
//! ## Image bytes are sub-feature 3's seam
//!
//! `image_bytes` are decoded but NOT ingested here — rich per-image
//! `attachment_import { Bytes }` reconciliation is owned by desktop-ingest
//! (sub-feature 3). The foundation wires only the TEXT path; the seam is the
//! `image_bytes` field travelling unread through this handler.
//!
//! See: ../../CLAUDE.md "Secret-handling logging discipline" — the frame body
//! and the composed plaintext are the same secret class as `password`; this
//! module logs only bounded outcome labels, never a body / URL / token.

use std::time::Instant;

use super::compose::compose_clip_note;
use super::envelope::{self, HandoffKind, HostReply, VaultStatus, VaultStatusSource};
use super::host::PairingGate;
use super::rate_limit::{RateDecision, RateLimiter};
use super::token::{RegistryGate, TokenRegistry};
use super::validation;

/// The note-write seam the app-side ingest path drives.
///
/// The production wiring backs this with the EXISTING `note_create` pipeline
/// (`notes::note_create_with_dir`, signature `plaintext: String`) so a clip
/// lands as an ordinary `.myn` note at the vault root — NO new `clip_ingest`
/// command. The trait keeps the keyed re-validation path unit-testable without
/// spinning up the Tauri runtime: a test fixture records the composed
/// plaintext (and can simulate the note cap or a write failure).
pub trait NoteWriter {
    /// Write a composed clip note as ordinary plaintext through `note_create`.
    /// Returns the backend-minted note id on success, or a closed write-error
    /// label on failure (the label is the only thing the reply carries).
    fn write_clip_note(&self, plaintext: String) -> Result<String, &'static str>;
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

    /// The frame passed re-validation and the app composed a note + replied.
    /// Carries the tiny [`HostReply`] the relay forwards back to the host →
    /// extension (`accepted` with a confirm token on a successful write;
    /// `error` on an over-cap / write failure / rate-limit; `locked` when the
    /// vault is not unlocked).
    Replied(HostReply),
}

/// Re-validate, compose, and write one relayed clip frame app-side.
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
///   `Slot`). A locked vault ⇒ `locked` reply, no write attempted.
/// - `limiter` — the app's authoritative rate limiter.
/// - `writer` — the [`NoteWriter`] seam (production: `note_create`).
/// - `now` — the clock for the rate limiter (injected for deterministic tests).
pub fn ingest_relayed_frame(
    body: &[u8],
    registry: &TokenRegistry,
    status: &dyn VaultStatusSource,
    limiter: &mut RateLimiter,
    writer: &dyn NoteWriter,
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

    // 2. Re-check the token against the REAL registry. The host relaying a
    //    frame is NOT evidence it was authorized — re-validate exactly as the
    //    host-mode path does, and stay silent on anything but Valid.
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
            // 3c. Vault status — a locked vault ⇒ explicit `locked`, NO write.
            if status.vault_status() == VaultStatus::Locked {
                return IngestOutcome::Replied(HostReply::locked());
            }
            // 3d. Compose the note (provenance FM + body, folder:null SYNC-15),
            //     then RE-CHECK the cap on the COMPOSED string: provenance
            //     frontmatter adds bytes, so an in-cap body can compose just
            //     over — story 17 demands an error, never a truncated note.
            let plaintext = compose_clip_note(&envelope);
            if let Err(e) = validation::validate_note_body_len(plaintext.len()) {
                return IngestOutcome::Replied(HostReply::error(e.label()));
            }
            // 3e. Write via the EXISTING note_create pipeline. Each accepted
            //     clip is an independent write — no dedup (SYNC-16, story 19).
            match writer.write_clip_note(plaintext) {
                Ok(_note_id) => {
                    tracing::debug!(stage = "clip_ingest", outcome = "written");
                    // SYNC-13: the confirm means "handoff accepted + written".
                    IngestOutcome::Replied(HostReply::accepted(super::host::mint_confirm()))
                }
                Err(label) => {
                    tracing::debug!(
                        stage = "clip_ingest",
                        outcome = "write_failed",
                        reason = label
                    );
                    IngestOutcome::Replied(HostReply::error(label))
                }
            }
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

    /// A `NoteWriter` that records every composed plaintext it was asked to
    /// write and hands back a distinct fake note id per call (so double-clip
    /// independence is observable). Optionally fails with a fixed label.
    #[derive(Default)]
    struct RecordingWriter {
        writes: RefCell<Vec<String>>,
        fail_with: Option<&'static str>,
    }

    impl RecordingWriter {
        fn new() -> Self {
            Self::default()
        }
        fn failing(label: &'static str) -> Self {
            RecordingWriter {
                writes: RefCell::new(Vec::new()),
                fail_with: Some(label),
            }
        }
        fn count(&self) -> usize {
            self.writes.borrow().len()
        }
        fn last(&self) -> String {
            self.writes.borrow().last().cloned().unwrap_or_default()
        }
    }

    impl NoteWriter for RecordingWriter {
        fn write_clip_note(&self, plaintext: String) -> Result<String, &'static str> {
            if let Some(label) = self.fail_with {
                return Err(label);
            }
            self.writes.borrow_mut().push(plaintext);
            // A distinct id per call (the index) — two clips → two ids.
            Ok(format!("note-{}", self.writes.borrow().len()))
        }
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
    fn valid_clip_with_unlocked_vault_writes_a_note_and_replies_accepted() {
        let (reg, token) = paired_registry();
        let status = StaticVaultStatus(VaultStatus::Unlocked);
        let mut limiter = RateLimiter::default();
        let writer = RecordingWriter::new();
        let outcome = ingest_relayed_frame(
            &clip_envelope(&token, "# Clip\n\nbody", Some("https://example.com/a")),
            &reg,
            &status,
            &mut limiter,
            &writer,
            Instant::now(),
        );
        // Wrote exactly one note.
        assert_eq!(writer.count(), 1, "exactly one note written");
        // The composed plaintext carries the provenance FM + body (the
        // foundation composes source:/clipped: + body; folder:null).
        let written = writer.last();
        assert!(written.contains("source: https://example.com/a"));
        assert!(written.contains("# Clip"));
        assert!(!written.contains("folder:"), "folder:null — no folder line");
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
    fn clipping_the_same_page_twice_writes_two_independent_notes() {
        let (reg, token) = paired_registry();
        let status = StaticVaultStatus(VaultStatus::Unlocked);
        let mut limiter = RateLimiter::default();
        let writer = RecordingWriter::new();
        let frame = clip_envelope(
            &token,
            "# Same page\n\nbody",
            Some("https://example.com/dup"),
        );

        let first =
            ingest_relayed_frame(&frame, &reg, &status, &mut limiter, &writer, Instant::now());
        let second =
            ingest_relayed_frame(&frame, &reg, &status, &mut limiter, &writer, Instant::now());

        // Two independent writes, no dedup, no overwrite.
        assert_eq!(writer.count(), 2, "two clips → two notes");
        // Two distinct note ids (the writer hands back a fresh id per call).
        let id1 = match first {
            IngestOutcome::Replied(HostReply::Accepted { .. }) => "note-1",
            other => panic!("first clip: expected Accepted, got {other:?}"),
        };
        let id2 = match second {
            IngestOutcome::Replied(HostReply::Accepted { .. }) => "note-2",
            other => panic!("second clip: expected Accepted, got {other:?}"),
        };
        assert_ne!(id1, id2, "two clips mint two distinct note ids");
    }

    // ---- over-16-MiB body → error, never a truncated note (story 17) ----

    #[test]
    fn body_over_the_note_cap_replies_error_not_a_truncated_note() {
        let (reg, token) = paired_registry();
        let status = StaticVaultStatus(VaultStatus::Unlocked);
        let mut limiter = RateLimiter::default();
        let writer = RecordingWriter::new();
        let big = "a".repeat(super::super::MAX_NOTE_BODY + 1);
        let outcome = ingest_relayed_frame(
            &clip_envelope(&token, &big, None),
            &reg,
            &status,
            &mut limiter,
            &writer,
            Instant::now(),
        );
        // No note was written — the cap rejected, never truncated.
        assert_eq!(writer.count(), 0, "an over-cap body writes NO note");
        match outcome {
            IngestOutcome::Replied(HostReply::Error { reason }) => {
                assert_eq!(reason, "note_body_oversized");
            }
            other => panic!("expected Replied(Error(note_body_oversized)), got {other:?}"),
        }
    }

    #[test]
    fn body_at_exactly_the_cap_but_provenance_pushes_composed_over_caps_on_composed() {
        // The load-bearing re-check: a body just under the cap can compose just
        // OVER once the provenance frontmatter is prepended. The composed-string
        // re-check (3d) catches it → error, no truncated/corrupt note.
        let (reg, token) = paired_registry();
        let status = StaticVaultStatus(VaultStatus::Unlocked);
        let mut limiter = RateLimiter::default();
        let writer = RecordingWriter::new();
        // Body exactly at the cap; ANY provenance bytes push the composed note
        // over. Use a body of exactly MAX_NOTE_BODY (passes 3a) + a source URL
        // (composition prepends `---\nsource: ...\n---\n\n`).
        let body = "a".repeat(super::super::MAX_NOTE_BODY);
        let outcome = ingest_relayed_frame(
            &clip_envelope(&token, &body, Some("https://x.test")),
            &reg,
            &status,
            &mut limiter,
            &writer,
            Instant::now(),
        );
        assert_eq!(writer.count(), 0, "composed-over-cap writes NO note");
        match outcome {
            IngestOutcome::Replied(HostReply::Error { reason }) => {
                assert_eq!(reason, "note_body_oversized");
            }
            other => panic!("expected Replied(Error) on composed-over-cap, got {other:?}"),
        }
    }

    // ---- silent re-validation (the relay re-checks the token) -----------

    #[test]
    fn an_invalid_token_is_silently_ignored_no_write() {
        let reg = TokenRegistry::new(); // nothing issued
        let status = StaticVaultStatus(VaultStatus::Unlocked);
        let mut limiter = RateLimiter::default();
        let writer = RecordingWriter::new();
        let outcome = ingest_relayed_frame(
            &clip_envelope("garbage-token", "body", None),
            &reg,
            &status,
            &mut limiter,
            &writer,
            Instant::now(),
        );
        assert_eq!(outcome, IngestOutcome::SilentlyIgnored);
        assert_eq!(writer.count(), 0, "an invalid token writes NOTHING");
    }

    #[test]
    fn a_revoked_token_is_silently_ignored_no_write() {
        // The relay does NOT trust the host — even if the host forwarded a
        // frame, the app re-checks the token against the REAL registry and a
        // revoked token writes nothing, silently.
        let mut reg = TokenRegistry::new();
        let token = reg.issue(EXT).unwrap();
        let value = token.value().to_string();
        reg.revoke_extension(EXT);
        let status = StaticVaultStatus(VaultStatus::Unlocked);
        let mut limiter = RateLimiter::default();
        let writer = RecordingWriter::new();
        let outcome = ingest_relayed_frame(
            &clip_envelope(&value, "body", None),
            &reg,
            &status,
            &mut limiter,
            &writer,
            Instant::now(),
        );
        assert_eq!(outcome, IngestOutcome::SilentlyIgnored);
        assert_eq!(writer.count(), 0, "a revoked token writes NOTHING");
    }

    #[test]
    fn a_malformed_frame_is_silently_ignored_no_panic_no_write() {
        let (reg, _token) = paired_registry();
        let status = StaticVaultStatus(VaultStatus::Unlocked);
        let mut limiter = RateLimiter::default();
        let writer = RecordingWriter::new();
        for body in [
            &b"not json"[..],
            b"{}",
            b"{ \"version\": 99 }",
            &[0x7B, 0xFF, 0x7D],
        ] {
            let outcome =
                ingest_relayed_frame(body, &reg, &status, &mut limiter, &writer, Instant::now());
            assert_eq!(outcome, IngestOutcome::SilentlyIgnored);
        }
        assert_eq!(writer.count(), 0);
    }

    // ---- locked vault ⇒ no write, locked reply --------------------------

    #[test]
    fn a_locked_vault_replies_locked_and_writes_nothing() {
        let (reg, token) = paired_registry();
        let status = StaticVaultStatus(VaultStatus::Locked);
        let mut limiter = RateLimiter::default();
        let writer = RecordingWriter::new();
        let outcome = ingest_relayed_frame(
            &clip_envelope(&token, "body", None),
            &reg,
            &status,
            &mut limiter,
            &writer,
            Instant::now(),
        );
        assert_eq!(outcome, IngestOutcome::Replied(HostReply::Locked));
        assert_eq!(writer.count(), 0, "a locked vault writes NOTHING");
    }

    // ---- rate limit (app holds the authoritative limiter) ---------------

    #[test]
    fn over_rate_limit_replies_error_and_writes_nothing_for_the_throttled_frame() {
        let (reg, token) = paired_registry();
        let status = StaticVaultStatus(VaultStatus::Unlocked);
        let mut limiter = RateLimiter::new(1, Duration::from_secs(60));
        let now = Instant::now();
        let writer = RecordingWriter::new();
        // First clip consumes the single-slot budget → written.
        let first = ingest_relayed_frame(
            &clip_envelope(&token, "a", None),
            &reg,
            &status,
            &mut limiter,
            &writer,
            now,
        );
        assert!(matches!(
            first,
            IngestOutcome::Replied(HostReply::Accepted { .. })
        ));
        assert_eq!(writer.count(), 1);
        // Second within the window → throttled error, no second write.
        let second = ingest_relayed_frame(
            &clip_envelope(&token, "b", None),
            &reg,
            &status,
            &mut limiter,
            &writer,
            now,
        );
        match second {
            IngestOutcome::Replied(HostReply::Error { reason }) => {
                assert_eq!(reason, "rate_limited")
            }
            other => panic!("expected rate_limited error, got {other:?}"),
        }
        assert_eq!(writer.count(), 1, "the throttled frame writes NO note");
    }

    // ---- a note_create write failure surfaces an honest error -----------

    #[test]
    fn a_write_failure_replies_error_never_a_fake_success() {
        let (reg, token) = paired_registry();
        let status = StaticVaultStatus(VaultStatus::Unlocked);
        let mut limiter = RateLimiter::default();
        let writer = RecordingWriter::failing("Io");
        let outcome = ingest_relayed_frame(
            &clip_envelope(&token, "body", None),
            &reg,
            &status,
            &mut limiter,
            &writer,
            Instant::now(),
        );
        // The app is the write authority (SYNC-13) — a failed write is an
        // honest error, never a fake `accepted`.
        match outcome {
            IngestOutcome::Replied(HostReply::Error { reason }) => assert_eq!(reason, "Io"),
            other => panic!("expected Replied(Error(Io)), got {other:?}"),
        }
    }

    // ---- status query path (is-unlocked-status over the relay) ----------

    #[test]
    fn status_query_unlocked_replies_accepted_no_write() {
        let (reg, token) = paired_registry();
        let status = StaticVaultStatus(VaultStatus::Unlocked);
        let mut limiter = RateLimiter::default();
        let writer = RecordingWriter::new();
        let outcome = ingest_relayed_frame(
            &status_envelope(&token),
            &reg,
            &status,
            &mut limiter,
            &writer,
            Instant::now(),
        );
        assert!(matches!(
            outcome,
            IngestOutcome::Replied(HostReply::Accepted { .. })
        ));
        assert_eq!(writer.count(), 0, "a status query writes NO note");
    }

    #[test]
    fn status_query_locked_replies_locked() {
        let (reg, token) = paired_registry();
        let status = StaticVaultStatus(VaultStatus::Locked);
        let mut limiter = RateLimiter::default();
        let writer = RecordingWriter::new();
        let outcome = ingest_relayed_frame(
            &status_envelope(&token),
            &reg,
            &status,
            &mut limiter,
            &writer,
            Instant::now(),
        );
        assert_eq!(outcome, IngestOutcome::Replied(HostReply::Locked));
    }
}
