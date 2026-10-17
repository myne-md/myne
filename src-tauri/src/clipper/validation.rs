// SPDX-License-Identifier: AGPL-3.0
//! Untrusted-input validation for the native-messaging host (TB10).
//!
//! Every byte handed to the host is hostile (A14 — a compromised
//! extension build, or any local process that learned the native-host
//! manifest path). This module is the load-bearing input-validation
//! layer: it treats every handed-off field as adversarial and enforces
//! the bounds the threat model promises.
//!
//! ## What it enforces
//!
//! - **Size caps.** The frame-level ext→host cap ([`super::MAX_EXT_TO_HOST_FRAME`],
//!   64 MiB, aligning with the MYA1 attachment cap) is enforced at the
//!   framing boundary ([`super::framing`]). HERE we enforce the *field*
//!   sub-caps: a note BODY field ≤ [`super::MAX_NOTE_BODY`] (16 MiB, the
//!   note-plaintext cap), and the host→ext reply ≤
//!   [`super::MAX_HOST_TO_EXT_REPLY`] (1 MiB).
//! - **UTF-8 validation.** A frame body must be well-formed UTF-8; a
//!   single invalid byte rejects the whole frame (no lossy substitution,
//!   no partial accept).
//! - **No path traversal.** Any caller-supplied filename / path field
//!   (e.g. an image attachment's suggested name) is rejected if it
//!   contains `..`, an absolute-path root, any path separator, a NUL, or
//!   a Windows drive prefix. The host derives its OWN storage names; a
//!   caller name is at most a *hint* and may never steer a write outside
//!   the vault.
//! - **MIME re-sniff.** Caller-supplied MIME is NEVER trusted. Any image
//!   bytes are re-sniffed via the existing attachments content sniffer
//!   ([`crate::plugins::attachments::sniff::sniff_content_type`]); the
//!   sniffed type is authoritative.
//!
//! Envelope DECODE (the `{markdown, capture_kind, …}` shape) is task 5 and
//! the `note_create` call is task 6 — this module delivers the
//! field-level validation primitives those tasks compose, not the
//! envelope schema. The seams are the public `validate_*` functions.
//!
//! See: ../../AGENTS.md "Secret-handling logging discipline" — a frame
//! body / note body carries note plaintext; this module never logs a
//! body, only the closed [`ValidationError`] variant name and non-secret
//! lengths.

use super::{MAX_HOST_TO_EXT_REPLY, MAX_NOTE_BODY};

/// Closed failure taxonomy for the input-validation layer.
///
/// Every variant is DENY-list-clean: a bounded variant name plus, where
/// useful, non-secret length counts. No variant ever carries a frame
/// body, a path string, or a caller-supplied name.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ValidationError {
    /// A frame body was not well-formed UTF-8. The offending bytes are
    /// NOT carried (they are untrusted plaintext); only the rejection is
    /// reported.
    InvalidUtf8,

    /// A note BODY field exceeded [`MAX_NOTE_BODY`] (16 MiB). Carries the
    /// observed length and the cap so the caller can surface a precise
    /// "page too large to clip" rejection (task 6) — never a truncated
    /// note.
    NoteBodyOversized {
        /// The observed body length in bytes.
        len: usize,
        /// The enforced cap ([`MAX_NOTE_BODY`]).
        cap: usize,
    },

    /// A host→ext reply exceeded [`MAX_HOST_TO_EXT_REPLY`] (1 MiB). The
    /// reply channel is bounded tiny by contract (SYNC-10).
    ///
    /// Constructed by [`validate_reply_len`] on the task-5 reply path
    /// ([`super::envelope::encode_reply`]).
    ReplyOversized {
        /// The observed reply length in bytes.
        len: usize,
        /// The enforced cap ([`MAX_HOST_TO_EXT_REPLY`]).
        cap: usize,
    },

    /// A caller-supplied filename / path field failed the no-traversal
    /// guard (contained `..`, a separator, an absolute root, a NUL, a
    /// Windows drive prefix, or was empty / a bare dot). The rejected
    /// name is NOT carried (untrusted, potentially path-bearing).
    ///
    /// Seam: constructed by [`validate_no_path_traversal`] (task 5/6 wire
    /// the per-image name check into the envelope decode).
    #[cfg_attr(not(test), allow(dead_code))]
    PathTraversal,

    /// A field the threat model expects to carry image bytes did not
    /// re-sniff to a recognized image content type. Caller MIME is never
    /// trusted; an unrecognized blob is rejected at the foundation rather
    /// than stored opaquely (the rich opaque-attachment path is
    /// sub-feature 3's concern — the foundation only re-sniffs to prove
    /// the discipline holds).
    ///
    /// Seam: constructed by [`resniff_image`] (task 5/6 image path).
    #[cfg_attr(not(test), allow(dead_code))]
    UnrecognizedImage,
}

impl ValidationError {
    /// Stable `&'static str` label for tracing (closed-enum mapping rule;
    /// a new variant compile-fails this match).
    pub fn label(&self) -> &'static str {
        match self {
            ValidationError::InvalidUtf8 => "invalid_utf8",
            ValidationError::NoteBodyOversized { .. } => "note_body_oversized",
            ValidationError::ReplyOversized { .. } => "reply_oversized",
            ValidationError::PathTraversal => "path_traversal",
            ValidationError::UnrecognizedImage => "unrecognized_image",
        }
    }
}

/// Validate that a frame body is well-formed UTF-8, returning a borrowed
/// `&str` view on success.
///
/// A single malformed byte rejects the whole frame
/// ([`ValidationError::InvalidUtf8`]) — never a lossy substitution, never
/// a partial accept. The native-messaging contract is UTF-8 JSON; anything
/// else is hostile.
pub fn validate_utf8(body: &[u8]) -> Result<&str, ValidationError> {
    std::str::from_utf8(body).map_err(|_| ValidationError::InvalidUtf8)
}

/// Enforce the note-BODY sub-cap (16 MiB, [`MAX_NOTE_BODY`]).
///
/// Distinct from the 64 MiB frame cap: a single frame may legitimately
/// carry a smaller note body plus image bytes up to the frame ceiling,
/// but the note *body* specifically may never exceed the note-plaintext
/// cap (`protocol::MAX_PLAINTEXT_LEN`, which [`MAX_NOTE_BODY`] mirrors).
/// An over-cap body is REJECTED, never truncated — task 6 surfaces this as
/// "page too large to clip".
pub fn validate_note_body_len(body_len: usize) -> Result<(), ValidationError> {
    if body_len > MAX_NOTE_BODY {
        return Err(ValidationError::NoteBodyOversized {
            len: body_len,
            cap: MAX_NOTE_BODY,
        });
    }
    Ok(())
}

/// Enforce the host→ext reply cap (1 MiB, [`MAX_HOST_TO_EXT_REPLY`]).
///
/// The confirm/ACK channel is bounded tiny by contract (SYNC-10). A reply
/// over the cap is a host-side composition bug; refuse it rather than
/// truncate. (The framing writer enforces the same bound at the wire
/// boundary — this is the field-level pre-check task 5 uses before
/// composing a reply.)
///
/// Called by [`super::envelope::encode_reply`] before composing the reply
/// frame (the task-5 reply path).
pub fn validate_reply_len(reply_len: usize) -> Result<(), ValidationError> {
    if reply_len > MAX_HOST_TO_EXT_REPLY {
        return Err(ValidationError::ReplyOversized {
            len: reply_len,
            cap: MAX_HOST_TO_EXT_REPLY,
        });
    }
    Ok(())
}

/// Reject any caller-supplied filename / path field that could steer a
/// write outside the vault.
///
/// A clip's image attachments may carry a *suggested* name from the
/// hostile browser. That name is at most a hint — the host derives its own
/// storage names (the MYA1 blob is keyed by an attachment-id, never a
/// caller string). This guard is defence-in-depth: it rejects a name that
/// contains any of —
///
/// - `..` anywhere (the parent-directory traversal token);
/// - a path separator (`/` or `\`) — a name is a single path component,
///   never a path;
/// - a NUL byte (truncation / C-string-splitting trick);
/// - an absolute-path root (`/…`) or a Windows drive prefix (`C:…`);
/// - the empty string or a bare `.` / `..` (no usable component).
///
/// — returning [`ValidationError::PathTraversal`] on any of them, and
/// `Ok(())` for an ordinary single-component name.
///
/// Seam: task 5/6 wire this into the per-image envelope-name check;
/// `allow(dead_code)` in non-test builds until then.
#[cfg_attr(not(test), allow(dead_code))]
pub fn validate_no_path_traversal(name: &str) -> Result<(), ValidationError> {
    // Empty or a bare dot component carries no usable name.
    if name.is_empty() || name == "." || name == ".." {
        return Err(ValidationError::PathTraversal);
    }
    // The parent-directory token anywhere — `..`, `a/../b`, `..\\x`, etc.
    if name.contains("..") {
        return Err(ValidationError::PathTraversal);
    }
    // A name is a single path component: NO separators of either dialect.
    if name.contains('/') || name.contains('\\') {
        return Err(ValidationError::PathTraversal);
    }
    // NUL — a classic path-truncation / string-splitting trick.
    if name.contains('\0') {
        return Err(ValidationError::PathTraversal);
    }
    // A Windows drive prefix (`C:`, `c:relative`, `Z:\\abs`) — even
    // without a separator, `C:foo` resolves against the drive's CWD.
    let bytes = name.as_bytes();
    if bytes.len() >= 2 && bytes[1] == b':' && bytes[0].is_ascii_alphabetic() {
        return Err(ValidationError::PathTraversal);
    }
    Ok(())
}

/// Re-sniff caller-supplied bytes claimed to be an image, returning the
/// authoritative content type.
///
/// Caller MIME is NEVER trusted (the threat model's re-sniff rule): the
/// content type is derived ONLY from the bytes, via the existing
/// attachments sniffer ([`crate::plugins::attachments::sniff::sniff_content_type`]) —
/// the SAME authority the `attachment://` serve path uses, so the
/// browser↔desktop boundary and the WebView serve boundary agree on one
/// sniffer. A blob whose bytes do not sniff to a recognized type is
/// rejected here ([`ValidationError::UnrecognizedImage`]); the rich
/// opaque-attachment fallback is sub-feature 3's concern.
///
/// Returns the sniffed `&'static str` MIME label (a non-secret structural
/// value, safe to log) on success.
///
/// Seam: task 5/6 wire this into the per-image envelope decode;
/// `allow(dead_code)` in non-test builds until then.
#[cfg_attr(not(test), allow(dead_code))]
pub fn resniff_image(bytes: &[u8]) -> Result<&'static str, ValidationError> {
    crate::plugins::attachments::sniff::sniff_content_type(bytes)
        .ok_or(ValidationError::UnrecognizedImage)
}

#[cfg(test)]
mod tests {
    use super::*;

    // ---- UTF-8 ---------------------------------------------------------

    #[test]
    fn invalid_utf8_is_rejected() {
        // 0xFF is never a valid UTF-8 byte.
        let body = [0x48, 0x65, 0xFF, 0x6C];
        assert_eq!(validate_utf8(&body), Err(ValidationError::InvalidUtf8));
    }

    #[test]
    fn truncated_multibyte_utf8_is_rejected() {
        // First byte of a 3-byte sequence, then EOF — a lone lead byte.
        let body = [0xE4, 0xB8]; // "世" is 0xE4 0xB8 0x96; drop the last byte
        assert_eq!(validate_utf8(&body), Err(ValidationError::InvalidUtf8));
    }

    // ---- note-body cap -------------------------------------------------

    #[test]
    fn note_body_at_cap_passes() {
        assert!(validate_note_body_len(MAX_NOTE_BODY).is_ok());
    }

    #[test]
    fn note_body_over_cap_is_rejected_with_observed_len() {
        match validate_note_body_len(MAX_NOTE_BODY + 1) {
            Err(ValidationError::NoteBodyOversized { len, cap }) => {
                assert_eq!(len, MAX_NOTE_BODY + 1);
                assert_eq!(cap, MAX_NOTE_BODY);
            }
            other => panic!("expected NoteBodyOversized, got {other:?}"),
        }
    }

    #[test]
    fn note_body_cap_mirrors_protocol_plaintext_cap() {
        // The note-body cap MUST equal the note-plaintext cap — a clip
        // body that passes here must also pass `note_create`'s own cap
        // (task 6 calls the existing pipeline). Drift would either let an
        // over-cap body reach `note_create` (double-rejection, confusing)
        // or reject a body `note_create` would accept.
        assert_eq!(MAX_NOTE_BODY, protocol::MAX_PLAINTEXT_LEN);
    }

    // ---- reply cap -----------------------------------------------------

    #[test]
    fn reply_at_cap_passes() {
        assert!(validate_reply_len(MAX_HOST_TO_EXT_REPLY).is_ok());
    }

    #[test]
    fn reply_over_cap_is_rejected() {
        match validate_reply_len(MAX_HOST_TO_EXT_REPLY + 1) {
            Err(ValidationError::ReplyOversized { len, cap }) => {
                assert_eq!(len, MAX_HOST_TO_EXT_REPLY + 1);
                assert_eq!(cap, MAX_HOST_TO_EXT_REPLY);
            }
            other => panic!("expected ReplyOversized, got {other:?}"),
        }
    }

    // ---- path traversal ------------------------------------------------

    #[test]
    fn ordinary_name_passes() {
        assert!(validate_no_path_traversal("image.png").is_ok());
        assert!(validate_no_path_traversal("my clip 2026.jpeg").is_ok());
        assert!(validate_no_path_traversal("a-b_c.d.webp").is_ok());
    }

    #[test]
    fn parent_dir_traversal_is_rejected() {
        assert_eq!(
            validate_no_path_traversal(".."),
            Err(ValidationError::PathTraversal)
        );
        assert_eq!(
            validate_no_path_traversal("../etc/passwd"),
            Err(ValidationError::PathTraversal)
        );
        assert_eq!(
            validate_no_path_traversal("foo/../../bar"),
            Err(ValidationError::PathTraversal)
        );
        assert_eq!(
            validate_no_path_traversal("..\\windows\\system32"),
            Err(ValidationError::PathTraversal)
        );
        // `..` embedded without a separator (e.g. `a..b`) is also rejected
        // — defence-in-depth, the host never needs such a name.
        assert_eq!(
            validate_no_path_traversal("a..b"),
            Err(ValidationError::PathTraversal)
        );
    }

    #[test]
    fn forward_slash_separator_is_rejected() {
        assert_eq!(
            validate_no_path_traversal("sub/dir/file.png"),
            Err(ValidationError::PathTraversal)
        );
        assert_eq!(
            validate_no_path_traversal("/etc/shadow"),
            Err(ValidationError::PathTraversal)
        );
    }

    #[test]
    fn backslash_separator_is_rejected() {
        assert_eq!(
            validate_no_path_traversal("sub\\file.png"),
            Err(ValidationError::PathTraversal)
        );
    }

    #[test]
    fn nul_byte_is_rejected() {
        assert_eq!(
            validate_no_path_traversal("evil\0.png"),
            Err(ValidationError::PathTraversal)
        );
    }

    #[test]
    fn windows_drive_prefix_is_rejected() {
        assert_eq!(
            validate_no_path_traversal("C:evil.png"),
            Err(ValidationError::PathTraversal)
        );
        // Uppercase or lowercase drive letter.
        assert_eq!(
            validate_no_path_traversal("z:relative"),
            Err(ValidationError::PathTraversal)
        );
    }

    #[test]
    fn empty_and_bare_dot_are_rejected() {
        assert_eq!(
            validate_no_path_traversal(""),
            Err(ValidationError::PathTraversal)
        );
        assert_eq!(
            validate_no_path_traversal("."),
            Err(ValidationError::PathTraversal)
        );
    }

    #[test]
    fn name_with_colon_not_drive_prefix_passes() {
        // A colon that is NOT a drive prefix (not at position 1, or not
        // preceded by a single ASCII letter) is an ordinary character.
        assert!(validate_no_path_traversal("12:30 note.png").is_ok());
    }

    // ---- MIME re-sniff -------------------------------------------------

    #[test]
    fn resniff_recognizes_png_regardless_of_caller_claim() {
        // A real PNG magic — the caller could claim any MIME; we sniff.
        let png = [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0x00];
        assert_eq!(resniff_image(&png).unwrap(), "image/png");
    }

    #[test]
    fn resniff_recognizes_jpeg() {
        let jpeg = [0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10];
        assert_eq!(resniff_image(&jpeg).unwrap(), "image/jpeg");
    }

    // ---- labels --------------------------------------------------------

    #[test]
    fn error_labels_are_stable() {
        assert_eq!(ValidationError::InvalidUtf8.label(), "invalid_utf8");
        assert_eq!(
            ValidationError::NoteBodyOversized { len: 0, cap: 0 }.label(),
            "note_body_oversized"
        );
        assert_eq!(
            ValidationError::ReplyOversized { len: 0, cap: 0 }.label(),
            "reply_oversized"
        );
        assert_eq!(ValidationError::PathTraversal.label(), "path_traversal");
        assert_eq!(
            ValidationError::UnrecognizedImage.label(),
            "unrecognized_image"
        );
    }
}
