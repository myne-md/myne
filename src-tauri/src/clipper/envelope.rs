//! Versioned ext→host handoff envelope + the tiny host→ext reply (TB10, task 5).
//!
//! The browser extension hands one **versioned JSON envelope** to the host
//! over the native-messaging wire (SYNC-10). This module owns the envelope
//! **schema + decode** and the **reply types** (a tiny
//! `accepted | error | locked` payload with a confirm token), plus the
//! [`VaultStatusSource`] seam that answers `is-unlocked-status` from the
//! app's real vault-runtime lock state.
//!
//! ## What this delivers (task 5 boundary)
//!
//! - [`HandoffEnvelope`] — the decoded `{ version, kind, markdown_body,
//!   capture_kind, destination_folder, tags[], source_url, clip_date,
//!   image_bytes[], extension_id, token }` shape. Decode (`decode_envelope`)
//!   **rejects an unknown version and a malformed shape WITHOUT panic**.
//! - [`HostReply`] — the tiny `accepted | error | locked` payload with a
//!   confirm token (SYNC-13), serialized through `encode_reply` which
//!   enforces the ≤1 MiB reply cap (reusing [`super::validation::validate_reply_len`]).
//! - [`VaultStatusSource`] — the trait the host queries for the live
//!   `Unlocked` / `Locked` state. The **app process** wires the real
//!   implementation (backed by `VaultRuntimeState`'s `Slot`); the host
//!   process gets it through the relay seam (see the "Cross-process" note).
//!
//! ## SYNC-15 — the foundation never sources structure from the vault
//!
//! `destination_folder` is **null/root** and `tags[]` is **empty** at
//! capture. The fields stay in the envelope shape (siblings / Phase 2 may
//! populate them) but the host NEVER reads vault structure to fill them —
//! decode preserves whatever the extension sent (which, under SYNC-15, is
//! `null` + `[]`), and the host never consults the vault to populate them.
//! [`HandoffEnvelope::destination_folder`] defaults to `None` and
//! [`HandoffEnvelope::tags`] to an empty `Vec` when the extension omits them.
//!
//! ## Cross-process state access (the architecture question)
//!
//! The native-messaging host runs as a **separate OS process** from the
//! running Myne app (the browser launches the binary with
//! [`super::host::NATIVE_MESSAGING_ARG`]). The host therefore CANNOT directly
//! read the app's in-memory `Slot::Unlocked` / `Slot::Locked`.
//!
//! **Resolution taken here: the [`VaultStatusSource`] trait seam + a real
//! app-process implementation, with the host-process relay flagged as the
//! task-6 prerequisite.** This module defines the trait; the app process
//! supplies a `Slot`-backed implementation (`plugins::clipper_pairing` owns
//! the `VaultRuntimeState` borrow). The host process is given the
//! [`StaticVaultStatus`] adapter so the wire path is real and tested today;
//! wiring the host's `VaultStatusSource` to the running app's `Slot` requires
//! a host↔app relay (Tauri single-instance forward, or a local IPC
//! rendezvous) — explicitly deferred to the task-6 `note_create` wiring,
//! which already needs to reach the app-process `note_create` over the SAME
//! relay. This module does NOT pretend the host magically sees the `Slot`.
//!
//! See: ../../AGENTS.md "Secret-handling logging discipline" — the envelope
//! carries note plaintext (`markdown_body`, same secret class as `password`);
//! this module never logs a body, only bounded outcome labels.

use serde::{Deserialize, Serialize};

use super::validation::{self, ValidationError};

/// The ONLY handoff-envelope version the foundation decodes: **1**.
///
/// The envelope is forward-incompatible by design (mirrors the protocol's
/// no-extension-points posture): a future wire shape bumps this and the host
/// rejects any version it does not recognize. A decode of any other version
/// is [`EnvelopeError::UnknownVersion`] — never a best-effort partial parse.
pub const ENVELOPE_VERSION: u32 = 1;

/// What a handoff is asking the host to do.
///
/// Mirrors the token scope ceiling ([`super::token::TokenScope`]): a handoff
/// either CREATEs a clip or ASKs whether the vault is unlocked. There is no
/// read / modify / delete kind — the type system makes them inexpressible,
/// exactly as the token scope does.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum HandoffKind {
    /// A keyless clip handoff: the host composes a note and (task 6) calls
    /// the existing `note_create`. Carries the markdown body + provenance.
    CreateClip,
    /// A pure status query: the host answers from the vault-runtime
    /// `Slot::Unlocked` / `Slot::Locked` state. Exposes no vault content,
    /// no structure (AS3/AS5) — only the unlocked/locked boolean.
    IsUnlockedStatus,
    /// Phase 1 of the two-phase pairing handshake (SYNC-6): open the pending
    /// session + show the in-app Accept dialog, foreground Myne, and relay the
    /// numeric CHALLENGE back ([`HostReply::Challenge`]) so the extension can
    /// display it for the user to compare against the dialog BEFORE approving.
    /// Carries an empty `token` (the caller is unpaired). Routed BEFORE the token
    /// gate. A locked vault replies [`HostReply::Locked`] (unlock first).
    PairBegin,
    /// Phase 2 of the two-phase pairing handshake: block for the user's
    /// Accept/Reject on the pending session that [`HandoffKind::PairBegin`]
    /// opened, and relay the minted token in [`HostReply::Paired`] (or an error
    /// on Reject / timeout). Carries an empty `token`. Routed BEFORE the token
    /// gate. No new dialog is shown — it awaits the one `PairBegin` raised.
    PairAwait,
}

/// How a clip was captured (SYNC-10 `capture_kind`).
///
/// A non-secret structural enum carried in the envelope so the host (task 6)
/// and downstream siblings can branch on the capture shape. The foundation
/// decodes it but does not yet act on the distinction.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum CaptureKind {
    /// A full-article clip (the headline action; SYNC-3).
    FullArticle,
    /// A selected-text highlight clip.
    Selection,
    /// A lightweight URL bookmark (SYNC-16).
    Bookmark,
}

/// The decoded ext→host handoff envelope (SYNC-10).
///
/// Every field is the extension's claim and therefore hostile (A14) — the
/// caps + UTF-8 + path-traversal + re-sniff disciplines in
/// [`super::validation`] are applied by the host AFTER decode, not trusted
/// from the wire. The `extension_id` + `token` are threaded into the task-4
/// [`super::token::RegistryGate`] before any action.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct HandoffEnvelope {
    /// The wire schema version. Decode rejects anything but [`ENVELOPE_VERSION`].
    pub version: u32,

    /// What the handoff asks for (create a clip, or ask the unlock status).
    pub kind: HandoffKind,

    /// The claimed extension ID — threaded into the [`super::token::RegistryGate`]
    /// (exact-ID binding). Defaults to empty if omitted (which validates to
    /// nothing — the silent-to-unpaired contract).
    #[serde(default)]
    pub extension_id: String,

    /// The claimed bearer token value (hex) — threaded into the
    /// [`super::token::RegistryGate`]. Defaults to empty if omitted.
    #[serde(default)]
    pub token: String,

    /// The clip's markdown body (frontmatter + body, composed in-page by the
    /// extension). Empty for an `is-unlocked-status` handoff. The host applies
    /// the note-body cap to THIS field (task 6); decode does not.
    #[serde(default)]
    pub markdown_body: String,

    /// How the clip was captured. `None` for a status query.
    #[serde(default)]
    pub capture_kind: Option<CaptureKind>,

    /// The destination folder. **Always `None` (root) under SYNC-15** — the
    /// host never reads vault structure to populate it. The field stays in
    /// the shape so a sibling / Phase 2 can fill it; the foundation leaves it
    /// `None`.
    #[serde(default)]
    pub destination_folder: Option<String>,

    /// The destination tags. **Always empty under SYNC-15** — same rule as
    /// `destination_folder`. The field stays in the shape; the foundation
    /// leaves it empty.
    #[serde(default)]
    pub tags: Vec<String>,

    /// The source page URL (provenance frontmatter, SYNC-14/16). `None` for a
    /// status query.
    #[serde(default)]
    pub source_url: Option<String>,

    /// The capture timestamp (provenance frontmatter, SYNC-14). An opaque
    /// caller-supplied string (e.g. ISO-8601); the host treats it as an
    /// ordinary user-authored field, never parses it for control flow.
    #[serde(default)]
    pub clip_date: Option<String>,

    /// In-page-captured image bytes (SYNC-12 — every byte originates from
    /// in-page capture, zero core-side fetch). The rich per-image
    /// `attachment_import` reconciliation is sub-feature 3's seam (task 6
    /// references it); the foundation decodes the field but does not ingest.
    #[serde(default)]
    pub image_bytes: Vec<Vec<u8>>,
}

/// Closed failure taxonomy for envelope decode.
///
/// Every variant is DENY-list-clean: a bounded variant name, never a frame
/// body or a caller string. The host logs only [`EnvelopeError::label`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum EnvelopeError {
    /// The bytes were not valid JSON, or the JSON did not match the envelope
    /// shape (missing required field, wrong type, unknown field). The
    /// offending bytes are NOT carried.
    Malformed,
    /// The envelope decoded structurally but declared a `version` the host
    /// does not recognize. Carries the observed version (a non-secret small
    /// integer) so the host can surface a precise "update Myne" rejection.
    UnknownVersion {
        /// The version the envelope declared.
        got: u32,
    },
}

impl EnvelopeError {
    /// Stable `&'static str` label for tracing (closed-enum mapping rule; a
    /// new variant compile-fails this match).
    pub fn label(&self) -> &'static str {
        match self {
            EnvelopeError::Malformed => "envelope_malformed",
            EnvelopeError::UnknownVersion { .. } => "envelope_unknown_version",
        }
    }
}

/// Decode a UTF-8 JSON frame body into a [`HandoffEnvelope`].
///
/// Two-stage so an unknown version is reported distinctly from a malformed
/// shape (the extension can then tell "update Myne" from "bad request"):
///
/// 1. Parse the JSON into the strict [`HandoffEnvelope`] shape
///    (`deny_unknown_fields` — an unexpected field is hostile, not ignored).
///    A parse failure → [`EnvelopeError::Malformed`].
/// 2. Check `version == ENVELOPE_VERSION`. A mismatch →
///    [`EnvelopeError::UnknownVersion`].
///
/// **Never panics** on adversarial input — every failure is a typed
/// `EnvelopeError`. The input is the already-UTF-8-validated frame body
/// (the host calls [`super::validation::validate_utf8`] first).
pub fn decode_envelope(body: &str) -> Result<HandoffEnvelope, EnvelopeError> {
    let envelope: HandoffEnvelope =
        serde_json::from_str(body).map_err(|_| EnvelopeError::Malformed)?;
    if envelope.version != ENVELOPE_VERSION {
        return Err(EnvelopeError::UnknownVersion {
            got: envelope.version,
        });
    }
    Ok(envelope)
}

/// The vault-runtime lock state, projected for the host→ext status path.
///
/// A two-state projection of the three-state [`Slot`] the app holds: the
/// host only ever needs "is the vault usable for a clip right now?" — and a
/// `Slot::Recovering` (a transient password-reset state that grants NO editor
/// access) is NOT usable, so it maps to [`VaultStatus::Locked`] exactly like
/// `Slot::Empty`. Only `Slot::Unlocked` is [`VaultStatus::Unlocked`].
///
/// [`Slot`]: crate::plugins::vault_unlock::state::Slot
///
/// `Unlocked` is constructed by the app-process `Slot`-backed status path
/// ([`vault_status_from_slot_kind`]) + the tests; in the host process today
/// only `Locked` is constructed (the fail-secure default until the host↔app
/// relay lands, task 6) — hence `allow(dead_code)` for the not-yet-wired
/// `Unlocked` construction in non-test library builds.
#[cfg_attr(not(test), allow(dead_code))]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum VaultStatus {
    /// A vault is fully unlocked — a clip can be written (task 6).
    Unlocked,
    /// No vault is usable for a clip (locked, empty, or mid-recovery). The
    /// host returns the explicit `locked` reply (O4) that drives the
    /// extension's "Unlock Myne" affordance — never a silent retry, never a
    /// fake success.
    Locked,
}

/// The seam the host queries for the live vault lock state.
///
/// The **app process** implements this over the real `VaultRuntimeState`
/// `Slot` (only `Slot::Unlocked` → [`VaultStatus::Unlocked`]). The host
/// process reaches it through the relay seam (see the module-level
/// "Cross-process" note); until that relay lands (task 6 prerequisite) the
/// host uses a [`StaticVaultStatus`] adapter so the wire path is real and
/// tested.
pub trait VaultStatusSource {
    /// The current vault lock state.
    fn vault_status(&self) -> VaultStatus;
}

/// Project the vault-runtime [`SlotKind`] onto the host status (the REAL
/// `Slot` integration).
///
/// Only [`SlotKind::Unlocked`] is [`VaultStatus::Unlocked`]; both
/// [`SlotKind::Empty`] (no vault loaded / locked) and [`SlotKind::Recovering`]
/// (a transient password-reset state that grants NO editor access) map to
/// [`VaultStatus::Locked`] — the host must NOT write a clip into a vault that
/// is not fully unlocked. This is the single mapping the app-process
/// `VaultStatusSource` uses to answer `is-unlocked-status` from the running
/// app's `VaultRuntimeState` slot.
///
/// [`SlotKind`]: crate::plugins::vault_unlock::state::SlotKind
///
/// Seam: the app process calls this to answer `is-unlocked-status` from its
/// live `VaultRuntimeState` slot, then hands the resolved [`VaultStatus`] to
/// the host over the relay (task 6 prerequisite). Exercised end-to-end by the
/// real-runtime test; `allow(dead_code)` in non-test library builds until the
/// relay wires it to a production caller.
#[cfg_attr(not(test), allow(dead_code))]
pub fn vault_status_from_slot_kind(
    kind: crate::plugins::vault_unlock::state::SlotKind,
) -> VaultStatus {
    use crate::plugins::vault_unlock::state::SlotKind;
    match kind {
        SlotKind::Unlocked => VaultStatus::Unlocked,
        // A vault open as an import SOURCE reports Locked, and must: the
        // clipper's only question is whether it may hand a clip to a vault that
        // can accept a note, and a read-only source context cannot. Reporting
        // Unlocked here would offer the clipper a vault whose every write path
        // rejects at the slot guard.
        SlotKind::Empty | SlotKind::Recovering | SlotKind::ImportSource => VaultStatus::Locked,
    }
}

/// A fixed-status [`VaultStatusSource`] — the host-process default + the test
/// fixture.
///
/// In the host process (a separate OS process from the app), the real `Slot`
/// is not observable without the relay; this adapter lets the envelope/reply
/// wire path be exercised end-to-end with an explicit status. Now that the
/// task-6 relay wires the app's REAL `Slot`-backed [`VaultStatusSource`]
/// (`clipper::relay_app::AppVaultStatus`), this fixed adapter is exercised only
/// by the validation-primitive tests — `allow(dead_code)` in non-test builds.
#[cfg_attr(not(test), allow(dead_code))]
pub struct StaticVaultStatus(pub VaultStatus);

impl VaultStatusSource for StaticVaultStatus {
    fn vault_status(&self) -> VaultStatus {
        self.0
    }
}

/// The tiny host→ext reply (SYNC-10/13).
///
/// Bounded to ≤1 MiB by [`encode_reply`] (the confirm/ACK channel is tiny by
/// contract). The `confirm` token (SYNC-13) means **"handoff accepted"**, NOT
/// "written to the vault" — the desktop is the write authority; the extension
/// never claims a commit that has not happened.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "status", rename_all = "kebab-case")]
pub enum HostReply {
    /// The handoff was accepted (for a clip: it will be written; for a status
    /// query: the vault is unlocked). Carries the SYNC-13 confirm token — a
    /// handoff-accepted marker, never a write-committed claim.
    Accepted {
        /// The confirm token (SYNC-13) — "handoff accepted", not "written".
        confirm: String,
    },
    /// A bounded, reportable error (validation failure, rate-limit throttle,
    /// malformed envelope). The closed `reason` label names the cause without
    /// leaking any caller bytes.
    Error {
        /// The closed `&'static str` reason label (e.g. `note_body_oversized`,
        /// `rate_limited`, `envelope_unknown_version`).
        reason: String,
    },
    /// The vault is locked (O4). Drives the extension's "Unlock Myne"
    /// affordance — the extension shows the prompt and captures NOTHING (no
    /// `chrome.storage` clip buffer — SYNC-1a). NOT a silent retry, NOT a
    /// fake success.
    Locked,
    /// A pairing request was ACCEPTED by the user: the app minted a scoped,
    /// revocable token bound to the exact extension id and the host relays it
    /// here (SYNC-6, desktop-authoritative). The `token` is a CREDENTIAL — not a
    /// key, decrypts nothing, scoped to `create-clip` + `is-unlocked-status`
    /// only — that the extension presents on every later handoff. It is the
    /// SOLE reply variant that carries a token, and only on an explicit user
    /// Accept; a Reject / timeout is a bounded `Error`, never `Paired`.
    Paired {
        /// The app-minted scoped pairing token (hex). A vault-stable correlation
        /// tag — NEVER logged (see ../../AGENTS.md secret-handling DENY list).
        token: String,
    },
    /// Phase-1 pairing reply (SYNC-6, two-phase handshake): the app opened the
    /// pending session and relays the numeric CHALLENGE the user compares against
    /// the in-app Accept dialog. NOT a token — the token only crosses in
    /// [`HostReply::Paired`] after the user Accepts (phase 2, `PairAwait`). A
    /// human-comparison nonce, safe to display; gates nothing, carries no secret.
    Challenge {
        /// The zero-padded numeric challenge display string (e.g. `"481920"`).
        code: String,
    },
}

impl HostReply {
    /// An `accepted` reply carrying `confirm` (SYNC-13 handoff-accepted token).
    pub fn accepted(confirm: impl Into<String>) -> Self {
        HostReply::Accepted {
            confirm: confirm.into(),
        }
    }

    /// An `error` reply carrying the closed `reason` label.
    pub fn error(reason: &'static str) -> Self {
        HostReply::Error {
            reason: reason.to_string(),
        }
    }

    /// The `locked` reply (O4) — the explicit locked status the extension
    /// turns into the "Unlock Myne" affordance.
    pub fn locked() -> Self {
        HostReply::Locked
    }

    /// The `paired` reply (SYNC-6) carrying the app-minted scoped token. Used
    /// ONLY on an explicit user Accept; a Reject / timeout is a bounded `error`.
    pub fn paired(token: impl Into<String>) -> Self {
        HostReply::Paired {
            token: token.into(),
        }
    }

    /// The `challenge` reply (SYNC-6 phase 1) carrying the numeric comparison
    /// code the extension displays. A human-comparison nonce, never a secret.
    pub fn challenge(code: impl Into<String>) -> Self {
        HostReply::Challenge { code: code.into() }
    }

    /// The bounded status label for tracing (never the confirm token / reason
    /// body / PAIRING TOKEN — those are emitted only as part of the wire reply,
    /// never logged).
    pub fn status_label(&self) -> &'static str {
        match self {
            HostReply::Accepted { .. } => "accepted",
            HostReply::Error { .. } => "error",
            HostReply::Locked => "locked",
            HostReply::Paired { .. } => "paired",
            HostReply::Challenge { .. } => "challenge",
        }
    }
}

/// Serialize a [`HostReply`] to its wire bytes, enforcing the ≤1 MiB reply
/// cap (SYNC-10) via [`super::validation::validate_reply_len`].
///
/// A reply over the cap is a host-side composition bug (the host composes the
/// reply, and an `accepted | error | locked` payload is tiny by construction)
/// — it is refused with [`ValidationError::ReplyOversized`], never truncated.
/// The framing writer enforces the SAME bound at the wire boundary; this is
/// the field-level pre-check the host runs before composing the frame.
pub fn encode_reply(reply: &HostReply) -> Result<Vec<u8>, ValidationError> {
    // `HostReply` is a closed enum of tiny payloads — serialization cannot
    // fail (no maps with non-string keys, no custom impls). Treat a
    // (theoretically impossible) failure as a reply-cap violation rather than
    // unwrapping, keeping the function total and panic-free.
    let bytes = serde_json::to_vec(reply).map_err(|_| ValidationError::ReplyOversized {
        len: usize::MAX,
        cap: super::MAX_HOST_TO_EXT_REPLY,
    })?;
    validation::validate_reply_len(bytes.len())?;
    Ok(bytes)
}

#[cfg(test)]
mod tests {
    use super::*;

    const EXT: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

    /// A minimal valid v1 create-clip envelope JSON. SYNC-15 shape: no folder,
    /// no tags.
    fn valid_clip_json() -> String {
        // `r##"…"##` (double-hash) because the markdown body contains `"#`
        // (a heading right after the opening quote), which would close a
        // single-hash raw string early.
        format!(
            r##"{{
                "version": 1,
                "kind": "create-clip",
                "extension_id": "{EXT}",
                "token": "deadbeef",
                "markdown_body": "# Hello\n\nbody",
                "capture_kind": "full-article",
                "source_url": "https://example.com/a",
                "clip_date": "2026-06-20T12:00:00Z"
            }}"##
        )
    }

    // ---- decode: valid -------------------------------------------------

    #[test]
    fn decodes_a_valid_v1_clip_envelope() {
        let env = decode_envelope(&valid_clip_json()).expect("valid envelope decodes");
        assert_eq!(env.version, 1);
        assert_eq!(env.kind, HandoffKind::CreateClip);
        assert_eq!(env.extension_id, EXT);
        assert_eq!(env.token, "deadbeef");
        assert_eq!(env.markdown_body, "# Hello\n\nbody");
        assert_eq!(env.capture_kind, Some(CaptureKind::FullArticle));
        assert_eq!(env.source_url.as_deref(), Some("https://example.com/a"));
    }

    #[test]
    fn decodes_a_minimal_status_query_envelope() {
        // An is-unlocked-status query needs only version + kind; every other
        // field defaults (no body, no provenance).
        let json = r#"{ "version": 1, "kind": "is-unlocked-status" }"#;
        let env = decode_envelope(json).expect("status envelope decodes");
        assert_eq!(env.kind, HandoffKind::IsUnlockedStatus);
        assert!(env.markdown_body.is_empty());
        assert_eq!(env.extension_id, "");
        assert_eq!(env.token, "");
    }

    #[test]
    fn decodes_a_minimal_pair_begin_envelope_with_empty_token() {
        // A pairing BOOTSTRAP request (phase 1): version + kind + extension_id,
        // and an EMPTY token (the caller is unpaired — it has none yet). Every
        // clip field defaults (no body, no provenance).
        let json = format!(
            r#"{{ "version": 1, "kind": "pair-begin", "extension_id": "{EXT}", "token": "" }}"#
        );
        let env = decode_envelope(&json).expect("pair-begin envelope decodes");
        assert_eq!(env.kind, HandoffKind::PairBegin);
        assert_eq!(env.extension_id, EXT);
        assert_eq!(env.token, "", "a pair request carries no token yet");
    }

    #[test]
    fn the_retired_single_shot_pair_kind_is_now_rejected() {
        // The legacy single-shot `kind: "pair"` was replaced by the two-phase
        // `pair-begin` / `pair-await`. With the enum variant removed, serde now
        // rejects an old `"pair"` frame outright — the ingest path treats that as
        // a malformed envelope (silent), the same no-action outcome as before.
        let json =
            format!(r#"{{ "version": 1, "kind": "pair", "extension_id": "{EXT}", "token": "" }}"#);
        assert!(
            decode_envelope(&json).is_err(),
            "the retired \"pair\" kind is rejected"
        );
    }

    #[test]
    fn paired_reply_encodes_with_token_and_labels_paired() {
        // The token-carrying reply (SYNC-6, desktop-authoritative). status_label
        // is the bounded `"paired"` (never the token itself).
        let reply = HostReply::paired("deadbeefcafe0123");
        assert_eq!(reply.status_label(), "paired");
        let bytes = encode_reply(&reply).expect("paired reply encodes");
        let s = String::from_utf8(bytes).expect("utf8 reply");
        assert!(s.contains(r#""status":"paired""#), "tagged status: {s}");
        assert!(
            s.contains(r#""token":"deadbeefcafe0123""#),
            "carries token: {s}"
        );
    }

    // ---- SYNC-15: folder null / tags empty by default ------------------

    #[test]
    fn destination_folder_defaults_to_root_and_tags_to_empty() {
        // The valid clip JSON omits destination_folder + tags entirely — the
        // SYNC-15 capture shape. Decode must yield root (None) + empty, NEVER
        // a fabricated default.
        let env = decode_envelope(&valid_clip_json()).unwrap();
        assert_eq!(
            env.destination_folder, None,
            "SYNC-15: destination_folder defaults to root (None)"
        );
        assert!(env.tags.is_empty(), "SYNC-15: tags default to empty");
    }

    #[test]
    fn explicit_null_folder_and_empty_tags_decode_as_root() {
        // Even when the extension sends them explicitly as null / [], the
        // result is root + empty (the SYNC-15 shape is preserved verbatim).
        let json = format!(
            r#"{{ "version": 1, "kind": "create-clip", "extension_id": "{EXT}",
                  "token": "t", "markdown_body": "x",
                  "destination_folder": null, "tags": [] }}"#
        );
        let env = decode_envelope(&json).unwrap();
        assert_eq!(env.destination_folder, None);
        assert!(env.tags.is_empty());
    }

    // ---- decode: unknown version (distinct from malformed) -------------

    #[test]
    fn rejects_an_unknown_version_without_panic() {
        let json = r#"{ "version": 2, "kind": "create-clip" }"#;
        match decode_envelope(json) {
            Err(EnvelopeError::UnknownVersion { got }) => assert_eq!(got, 2),
            other => panic!("expected UnknownVersion(2), got {other:?}"),
        }
    }

    #[test]
    fn rejects_version_zero_as_unknown() {
        let json = r#"{ "version": 0, "kind": "create-clip" }"#;
        assert!(matches!(
            decode_envelope(json),
            Err(EnvelopeError::UnknownVersion { got: 0 })
        ));
    }

    // ---- decode: malformed shape (no panic) ----------------------------

    #[test]
    fn rejects_non_json_without_panic() {
        assert_eq!(
            decode_envelope("not json at all"),
            Err(EnvelopeError::Malformed)
        );
        assert_eq!(decode_envelope(""), Err(EnvelopeError::Malformed));
    }

    #[test]
    fn rejects_missing_required_field_without_panic() {
        // No `kind` — required, no default.
        assert_eq!(
            decode_envelope(r#"{ "version": 1 }"#),
            Err(EnvelopeError::Malformed)
        );
        // No `version` — required.
        assert_eq!(
            decode_envelope(r#"{ "kind": "create-clip" }"#),
            Err(EnvelopeError::Malformed)
        );
    }

    #[test]
    fn rejects_wrong_field_type_without_panic() {
        // version as a string, kind as a number — both type-mismatch.
        assert_eq!(
            decode_envelope(r#"{ "version": "1", "kind": "create-clip" }"#),
            Err(EnvelopeError::Malformed)
        );
    }

    #[test]
    fn rejects_unknown_kind_value_without_panic() {
        // A kind the enum does not name (e.g. an injected "delete-note") must
        // reject — the type system makes read/modify/delete inexpressible.
        assert_eq!(
            decode_envelope(r#"{ "version": 1, "kind": "delete-note" }"#),
            Err(EnvelopeError::Malformed)
        );
    }

    #[test]
    fn rejects_unknown_extra_field_without_panic() {
        // deny_unknown_fields: an unexpected field is hostile, not ignored.
        let json = format!(
            r#"{{ "version": 1, "kind": "create-clip", "extension_id": "{EXT}",
                  "token": "t", "evil_extra": "smuggled" }}"#
        );
        assert_eq!(decode_envelope(&json), Err(EnvelopeError::Malformed));
    }

    // ---- reply: tiny, ≤1 MiB, round-trips ------------------------------

    #[test]
    fn accepted_reply_carries_confirm_token() {
        let reply = HostReply::accepted("confirm-123");
        let bytes = encode_reply(&reply).expect("tiny reply within cap");
        let back: HostReply = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(back, reply);
        assert_eq!(back.status_label(), "accepted");
        // Wire shape: `{"status":"accepted","confirm":"confirm-123"}`.
        let s = String::from_utf8(bytes).unwrap();
        assert!(s.contains(r#""status":"accepted""#), "wire was {s}");
        assert!(s.contains(r#""confirm":"confirm-123""#), "wire was {s}");
    }

    #[test]
    fn locked_reply_serializes_to_the_locked_status() {
        let bytes = encode_reply(&HostReply::locked()).unwrap();
        let s = String::from_utf8(bytes).unwrap();
        assert_eq!(s, r#"{"status":"locked"}"#);
    }

    #[test]
    fn error_reply_carries_closed_reason_label() {
        let bytes = encode_reply(&HostReply::error("note_body_oversized")).unwrap();
        let s = String::from_utf8(bytes).unwrap();
        assert!(s.contains(r#""status":"error""#), "wire was {s}");
        assert!(
            s.contains(r#""reason":"note_body_oversized""#),
            "wire was {s}"
        );
    }

    #[test]
    fn every_reply_is_far_under_the_reply_cap() {
        // The three reply shapes are all tiny — well under 1 MiB.
        for reply in [
            HostReply::accepted("x".repeat(64)),
            HostReply::error("rate_limited"),
            HostReply::locked(),
        ] {
            let bytes = encode_reply(&reply).expect("tiny reply within cap");
            assert!(
                bytes.len() < super::super::MAX_HOST_TO_EXT_REPLY,
                "reply {:?} was {} bytes",
                reply.status_label(),
                bytes.len()
            );
        }
    }

    // ---- status source seam --------------------------------------------

    #[test]
    fn static_vault_status_reports_its_fixed_state() {
        assert_eq!(
            StaticVaultStatus(VaultStatus::Unlocked).vault_status(),
            VaultStatus::Unlocked
        );
        assert_eq!(
            StaticVaultStatus(VaultStatus::Locked).vault_status(),
            VaultStatus::Locked
        );
    }

    // ---- REAL Slot integration -----------------------------------------
    //
    // `is-unlocked-status` MUST be driven by the real vault-runtime state, not
    // a hand-rolled boolean. These tests project the actual `SlotKind`
    // discriminator (the same one `vault_status` IPC exposes) onto the host
    // status, and drive a real `VaultRuntimeState` slot to prove
    // `Slot::Unlocked → unlocked` and `Slot::Locked → locked`.

    #[test]
    fn slot_kind_maps_unlocked_to_unlocked_and_everything_else_to_locked() {
        use crate::plugins::vault_unlock::state::SlotKind;
        assert_eq!(
            vault_status_from_slot_kind(SlotKind::Unlocked),
            VaultStatus::Unlocked
        );
        // Empty (locked / no vault) and Recovering (transient, no editor
        // access) both map to Locked — the host never writes into them.
        assert_eq!(
            vault_status_from_slot_kind(SlotKind::Empty),
            VaultStatus::Locked
        );
        assert_eq!(
            vault_status_from_slot_kind(SlotKind::Recovering),
            VaultStatus::Locked
        );
    }

    #[test]
    fn real_runtime_slot_drives_the_unlocked_and_locked_status() {
        use crate::plugins::vault_unlock::state::{
            fixture_unlocked_with_keys, test_vault_id, VaultRuntimeState,
        };
        // A current-thread runtime for the async slot accessors (the codebase
        // intentionally does not enable tokio's `macros` feature in tests).
        let rt = tokio::runtime::Builder::new_current_thread()
            .build()
            .expect("current-thread runtime");
        rt.block_on(async {
            let state = VaultRuntimeState::default();

            // No vault loaded → Empty → Locked.
            let kind = state.slot_kind_active().await;
            assert_eq!(vault_status_from_slot_kind(kind), VaultStatus::Locked);

            // Unlock a vault → Unlocked → Unlocked.
            state
                .set_unlocked(test_vault_id(), fixture_unlocked_with_keys(7, 9, 1))
                .await;
            let kind = state.slot_kind_active().await;
            assert_eq!(vault_status_from_slot_kind(kind), VaultStatus::Unlocked);

            // Lock it (take the slot) → back to Locked.
            let _ = state.take(test_vault_id()).await;
            let kind = state.slot_kind_active().await;
            assert_eq!(vault_status_from_slot_kind(kind), VaultStatus::Locked);
        });
    }

    // ---- labels --------------------------------------------------------

    #[test]
    fn envelope_error_labels_are_stable() {
        assert_eq!(EnvelopeError::Malformed.label(), "envelope_malformed");
        assert_eq!(
            EnvelopeError::UnknownVersion { got: 9 }.label(),
            "envelope_unknown_version"
        );
    }
}
