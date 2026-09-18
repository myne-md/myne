//! `clipper` — the keyless native-messaging host (browser↔desktop, TB10).
//!
//! This module is the desktop side of the browser-extension clip channel
//! (`browser-extension` epic, MYND-442; `ext-foundation-handoff` feature).
//! The Myne browser extension is a **keyless** producer running in a
//! proven-hostile runtime (A14); it captures a page and hands the
//! plaintext markdown to THIS host over the Chrome/Firefox native-messaging
//! wire format. The already-unlocked desktop core does all AEAD via the
//! existing `note_create` pipeline — **zero new crypto** lives here.
//!
//! ## Why this is OUTSIDE the Tauri capability ACL (TB6)
//!
//! The Tauri capability ACL (`capabilities/default.json`, per-command
//! default-deny) governs the **WebView→Rust IPC** surface (TB6). This host
//! is a different ingress entirely: an **external stdio process** the
//! browser launches, with no WebView and no Tauri command dispatch. TB6
//! does not reach it. It therefore carries its **own** untrusted-input
//! discipline — the load-bearing security pattern of this module:
//!
//! - **Framing caps** ([`framing`]): the ext→host frame cap
//!   ([`MAX_EXT_TO_HOST_FRAME`], 64 MiB) is enforced on the 4-byte length
//!   prefix BEFORE the body is allocated; the host→ext reply cap
//!   ([`MAX_HOST_TO_EXT_REPLY`], 1 MiB) bounds the ACK channel.
//! - **Field validation** ([`validation`]): UTF-8 well-formedness, the
//!   note-body sub-cap ([`MAX_NOTE_BODY`], 16 MiB), no path traversal in
//!   any caller-supplied name, and MIME re-sniff (caller MIME is never
//!   trusted — the existing attachments sniffer is the authority).
//! - **Rate limiting** ([`rate_limit`]): a fixed-window cap on clip
//!   handoffs so a runaway/compromised build cannot flood the vault.
//! - **Silent to unpaired callers** ([`host`]): an unpaired/unknown caller
//!   gets NO output — not a liveness oracle.
//!
//! The secret-keeping discipline follows the backend-session precedent
//! (`decisions.md` 2026-04-28 — `root_key` never crosses IPC): the host
//! never holds a key, and the frame body (note plaintext — same secret
//! class as `password`) is never logged (see `src-tauri/AGENTS.md`
//! "Secret-handling logging discipline").
//!
//! ## Cap constants — reused from the codebase, not re-invented
//!
//! - [`MAX_NOTE_BODY`] = `protocol::MAX_PLAINTEXT_LEN` (16 MiB) — the exact
//!   note-plaintext cap, so a clip body that passes here also passes
//!   `note_create`'s own cap (task 6).
//! - [`MAX_EXT_TO_HOST_FRAME`] = `protocol::MAX_ATTACHMENT_LEN` (64 MiB) —
//!   the exact MYA1 attachment cap, the per-image ceiling a clip frame may
//!   carry.
//! - [`MAX_HOST_TO_EXT_REPLY`] = 1 MiB — the tiny ACK/confirm channel
//!   bound (SYNC-10).
//!
//! ## Task boundary (3 of 10)
//!
//! This module delivers the **framing + validation primitives + the
//! host-mode entry skeleton + the native-host manifest**, with thorough
//! unit tests. Clean seams for the later tasks:
//! - **Task 4 (landed)** fills [`host::PairingGate`] with the token registry
//!   ([`token::RegistryGate`] over [`token::TokenRegistry`]) — the host
//!   accepts a valid scoped token bound to the exact extension ID and stays
//!   silent to a missing / invalid / revoked one. The CSPRNG numeric
//!   challenge + the scoped, revocable, append-only token live in [`token`];
//!   the WebView Accept/Reject commands live in
//!   `plugins::clipper_pairing`. The registry is **in memory** here — task 7
//!   persists it (prefs-family blob) so pairing survives a restart.
//! - **Task 5 (landed)** decodes the versioned `{ version, kind,
//!   markdown_body, capture_kind, destination_folder, tags[], source_url,
//!   clip_date, image_bytes[] }` envelope ([`envelope::HandoffEnvelope`]),
//!   threads the claimed `(extension_id, token)` into [`token::RegistryGate`],
//!   answers `is-unlocked-status` from a [`envelope::VaultStatusSource`]
//!   (the host↔app `Slot` seam), and composes the tiny
//!   `accepted | error | locked` reply ([`envelope::HostReply`], ≤1 MiB).
//!   `host::run_envelope_loop` is the production loop; `lib.rs` drives it.
//! - **Task 6** wires the unlocked path (`host::HandoffOutcome::Accepted`) to
//!   the existing `note_create`, and supplies the host↔app relay that lets the
//!   host process read the running app's real `Slot` + shared token registry
//!   (the cross-process seam this task flagged; see `envelope`'s
//!   "Cross-process state access" note).

pub mod envelope;
pub mod framing;
pub mod host;
pub mod ingest;
pub mod install;
pub mod manifest;
pub mod rate_limit;
pub mod relay;
pub mod relay_app;
pub mod token;
pub mod validation;

/// Maximum ext→host frame size: **64 MiB**, the exact MYA1 attachment cap
/// (`protocol::MAX_ATTACHMENT_LEN`). A clip frame may carry an image up to
/// this ceiling; anything larger is rejected at the framing boundary
/// before allocation. Reusing the protocol constant keeps the host's cap
/// in lock-step with the attachment pipeline a clip's images flow into.
pub const MAX_EXT_TO_HOST_FRAME: usize = protocol::MAX_ATTACHMENT_LEN;

/// Maximum note BODY field size: **16 MiB**, the exact note-plaintext cap
/// (`protocol::MAX_PLAINTEXT_LEN`). A clip whose composed body would exceed
/// this is rejected ("page too large to clip", task 6) — never truncated.
/// Reusing the protocol constant guarantees a body that passes the host
/// also passes `note_create`'s own cap.
pub const MAX_NOTE_BODY: usize = protocol::MAX_PLAINTEXT_LEN;

/// Maximum host→ext reply size: **1 MiB**. The ACK/confirm channel is
/// bounded tiny by contract (SYNC-10) — the reply is a small
/// `accepted | error | locked` + a confirm token, never bulk data. Not a
/// protocol constant (there is no on-disk blob of this shape); defined
/// here as the channel's own bound.
///
/// Enforced by [`envelope::encode_reply`] → [`validation::validate_reply_len`]
/// (the host's pre-compose check) AND again by [`framing::write_frame`] at the
/// wire boundary — both now live on the task-5 reply path.
pub const MAX_HOST_TO_EXT_REPLY: usize = 1024 * 1024;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn frame_cap_equals_attachment_cap() {
        assert_eq!(MAX_EXT_TO_HOST_FRAME, protocol::MAX_ATTACHMENT_LEN);
        assert_eq!(MAX_EXT_TO_HOST_FRAME, 64 * 1024 * 1024);
    }

    #[test]
    fn note_body_cap_equals_plaintext_cap() {
        assert_eq!(MAX_NOTE_BODY, protocol::MAX_PLAINTEXT_LEN);
        assert_eq!(MAX_NOTE_BODY, 16 * 1024 * 1024);
    }

    #[test]
    fn reply_cap_is_one_mib() {
        assert_eq!(MAX_HOST_TO_EXT_REPLY, 1024 * 1024);
    }

    #[test]
    fn note_body_cap_is_below_frame_cap() {
        // The frame may carry an image up to 64 MiB; the note body within
        // it is capped tighter at 16 MiB. The ordering is load-bearing.
        // A const block so the (true-by-construction) ordering is checked
        // at compile time without tripping clippy's constant-assert lint.
        const { assert!(MAX_NOTE_BODY < MAX_EXT_TO_HOST_FRAME) };
    }
}
