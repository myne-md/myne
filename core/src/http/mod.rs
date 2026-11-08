// SPDX-License-Identifier: AGPL-3.0
//! `core::http` — the ONE HTTP/1.1 codec in the tree.
//!
//! **Why it is here and not in `plugins::sync`.** The sync client owned the only
//! HTTP codec, so a second caller — the local AI provider arm (#189) — would
//! have had to duplicate it. `myne-agents/docs/dependency-policy.md` fast-rejects "adding an
//! HTTP client when one already exists in the tree", and `plugins::sync::no_bypass`
//! names duplication as the shape its ratchet exists to catch. Sharing is what
//! makes reuse possible instead of adding a crate.
//!
//! **The type-placement decision (task 1 asked for it to be recorded).** All four
//! wire types moved with the codec: `HttpMethod`, `TransportResponse`,
//! `TransportResponseExt` and `TransportError`. Leaving any of them behind would
//! have meant `core::http` importing upward from one of its own consumers — the
//! coupling this move exists to remove.
//!
//! `TransportError` is the one worth arguing. Its variants are `NotConfigured`,
//! `Network`, `Tls`, `BadRequest`: three are plainly transport facts rather than
//! anything about syncing, and the fourth is the transport's own "I have no
//! endpoint" state, which an AI arm needs in exactly the same sense. Keeping it
//! in the sync tree to preserve a naming accident would have forced either an
//! upward import or a split of the codec's test module — and splitting tests to
//! satisfy a module boundary is how a "verbatim move" quietly stops being one.
//! `plugins::sync::transport` re-exports all four, so its references are untouched.
//!
//! **The response cap is the caller's.** The old codec hard-coded
//! `MAX_SYNC_RESPONSE_BYTES`, a number documented as paired with sync's fetch
//! window. A shared codec must not hold an AI response to a bound chosen for
//! batch blob fetches, so the read/parse entry points take `max_bytes`. Sync
//! passes exactly today's constant — which stays in the sync tree, next to the
//! pairing comment that explains it — so sync's behaviour is unchanged.
//!
//! **A side-benefit worth naming: this file left a blanket `allow`.**
//! `plugins::sync::mod.rs` carries a module-wide `#![allow(dead_code)]`, so the
//! codec's test-only helpers were silently covered by it for as long as they
//! lived there. Out here they are not, and the three that surfaced
//! (`build_http_request`, `parse_http_response`, `parse_http_response_ext`) now
//! carry an individual justification instead of an inherited exemption. A
//! blanket allow is how the next genuinely-dead function goes unnoticed.
//!
//! **Public, not `pub(crate)`.** The whole reason for the move is that a second
//! crate needs it: the desktop AI provider arm speaks HTTP to a loopback
//! endpoint and must not carry its own copy. A crate-private shared codec would
//! have been a move that solved nothing.
//!
//! Pure over `BufRead`/`Write`: no sockets. That is what made the move safe, and
//! it is why this module adds nothing to the wasm graph.

// Only the non-wasm transports frame HTTP by hand: a browser has `fetch`, so
// the codec has no caller there. Same split, and the same reason, as
// `plugins::sync::http_transport`'s socket half.
#[cfg(not(target_arch = "wasm32"))]
pub mod codec;

/// HTTP method for a transport request (the server protocol uses only these).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HttpMethod {
    /// Pull / read-side requests.
    Get,
    /// Push / write-side requests.
    Post,
    /// Idempotent upload (the `vault.meta` enrollment-bootstrap seed + the
    /// `/attachments/{id}` resumable chunk upload, MYND-468).
    Put,
    /// Header-only probe (the `/attachments/{id}` resume/dedup probe —
    /// `X-Uploaded-Length` / `X-Complete`; `server-protocol.md` §3.2).
    Head,
    /// Resource removal (the B2B member revoke,
    /// `DELETE /b2b/vaults/{hash}/members/{person_id}`, myne-md/myne#711 task 14).
    Delete,
}
/// A transport response: the HTTP status and the opaque body bytes.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TransportResponse {
    /// HTTP status code (the engine maps 401/409/410/413/429/507 per §6).
    pub status: u16,
    /// Opaque response body (ciphertext / sync-meta / head record bytes).
    pub body: Vec<u8>,
}
/// A transport response that also surfaces the response headers — needed only
/// by the `/attachments/{id}` byte-transport (`X-Uploaded-Length`,
/// `X-Complete`, `Content-Range`; MYND-468). Header names are lowercased,
/// values trimmed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TransportResponseExt {
    /// HTTP status code.
    pub status: u16,
    /// Opaque response body.
    pub body: Vec<u8>,
    /// Response headers, `(lowercased-name, trimmed-value)`.
    pub headers: Vec<(String, String)>,
}
/// Transport-level failures (below the HTTP-status layer — these mean the
/// request never produced a response).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TransportError {
    /// No sync endpoint configured (SYNC-14) — caller must set one first.
    NotConfigured,
    /// Connection / DNS / socket failure.
    Network,
    /// TLS handshake failure: invalid chain or hostname, expiry, protocol,
    /// version or cipher disagreement. Pins never override this decision.
    Tls,
    /// The request could not be built (bad path, etc.).
    BadRequest,
}
