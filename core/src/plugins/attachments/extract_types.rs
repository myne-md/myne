// SPDX-License-Identifier: AGPL-3.0
//! Platform-agnostic attachment-text-extraction payload types (MYND-328;
//! `protocol.md` § 9.15).
//!
//! These are the pure data types produced by the desktop text extractor
//! (`src-tauri/.../attachments/extract.rs`, which owns the `lopdf`/`zip`/
//! `quick-xml` dispatch) and consumed by the `MYE1` cache codec
//! ([`super::text_cache`]). They moved into `myne-core` so the cache module
//! (shared desktop↔mobile) can round-trip an [`ExtractedText`] without pulling
//! the desktop-only extractor dependencies: mobile carries the types + the cache
//! codec but has no extraction *producer* (it never writes an MYE1 cache).
//!
//! The `extractor_version 0x01` postcard framing lives here; the crypto framing
//! (`MYE1`) lives in `protocol::attachment_text_blob`.

use serde::{Deserialize, Serialize};

/// Upper bound on emitted extracted text (1 MiB of UTF-8). Bounds the `MYE1`
/// blob + the search index growth; the codec's own ceiling is 4 MiB
/// (`MAX_ATTACHMENT_TEXT_PLAINTEXT_LEN`), generous headroom over this plus
/// postcard overhead. Over-cap extractions set [`ExtractedText::truncated`].
pub const MAX_EXTRACTED_TEXT_LEN: usize = 1024 * 1024;

/// Outcome of an extraction attempt. All four values are persisted in the
/// `MYE1` cache so a rebuild does not retry an extraction that already
/// failed / was unsupported / was empty — until `extractor_version` bumps
/// (§ 9.15.4).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum ExtractStatus {
    /// Text was extracted (non-empty after normalization).
    Ok,
    /// Supported format, but no extractable text (e.g. a scanned PDF with no
    /// text layer — extractable only once the OCR layer lands, MYND-441).
    Empty,
    /// Format not handled by this extractor generation.
    Unsupported,
    /// Extraction errored (corrupt / password-protected / malformed).
    Failed,
}

/// The format this extractor dispatched on. `Other` accompanies
/// [`ExtractStatus::Unsupported`].
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum SourceFormat {
    Pdf,
    Docx,
    Text,
    Other,
}

/// The extracted-text payload, serialized (postcard) into the `MYE1` blob
/// plaintext (`extractor_version 0x01`, § 9.15.2).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ExtractedText {
    pub status: ExtractStatus,
    pub source_format: SourceFormat,
    /// NFC-normalized extracted text; empty unless `status == Ok`.
    pub text: String,
    /// Char count of the extracted text BEFORE truncation (§ 9.15.2).
    pub char_count: u32,
    /// Set when extraction hit [`MAX_EXTRACTED_TEXT_LEN`].
    pub truncated: bool,
}

impl ExtractedText {
    /// A negative (empty-text) result. `pub` so the desktop extractor + the
    /// core no-op extractor both construct it without duplicating the shape.
    pub fn negative(status: ExtractStatus, source_format: SourceFormat) -> Self {
        ExtractedText {
            status,
            source_format,
            text: String::new(),
            char_count: 0,
            truncated: false,
        }
    }

    /// Serialize to the opaque `MYE1` inner plaintext (postcard).
    pub fn to_blob_plaintext(&self) -> Vec<u8> {
        // postcard serialization of a plain struct is infallible in practice;
        // fall back to an empty payload rather than propagating.
        postcard::to_allocvec(self).unwrap_or_default()
    }

    /// Deserialize from an `MYE1` inner plaintext. Returns `None` on a malformed
    /// payload (the caller treats it as a cache miss → re-extract).
    pub fn from_blob_plaintext(bytes: &[u8]) -> Option<ExtractedText> {
        postcard::from_bytes(bytes).ok()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn payload_round_trips_through_postcard() {
        let r = ExtractedText {
            status: ExtractStatus::Ok,
            source_format: SourceFormat::Text,
            text: "round trip me".to_string(),
            char_count: 13,
            truncated: false,
        };
        let bytes = r.to_blob_plaintext();
        let back = ExtractedText::from_blob_plaintext(&bytes).expect("decode");
        assert_eq!(r, back);
    }

    #[test]
    fn malformed_payload_decodes_to_none() {
        assert!(
            ExtractedText::from_blob_plaintext(&[0xff, 0xff, 0xff]).is_none()
                || ExtractedText::from_blob_plaintext(&[]).is_none()
        );
    }
}
