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
///
/// **Appended-only** — postcard serializes a fieldless enum by variant index, so
/// new variants MUST be added at the end to keep the existing tags
/// (Pdf=0/Docx=1/Text=2/Other=3) byte-stable for already-written `MYE1` blobs.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum SourceFormat {
    Pdf,
    Docx,
    Text,
    Other,
    /// Audio transcript from the on-device ASR engine (voice-to-text, MYND-551;
    /// `extractor_version 0x02`). Index tag `4`.
    Audio,
}

/// The extracted-text payload, serialized (postcard) into the `MYE1` blob
/// plaintext (`extractor_version 0x02`, § 9.15.2).
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
    /// SHA-256 of the model that produced this payload, for cache-invalidation
    /// on a model swap (voice-to-text, MYND-551; `extractor_version 0x02`).
    /// `None` for a deterministic extractor (PDF/DOCX/text — output is
    /// model-independent); `Some` for a [`SourceFormat::Audio`] ASR transcript.
    /// Lives in the inner payload, NOT the AAD — mirrors the `vault.embeddings`
    /// model-identity rule (§ 9.17.2): a model swap invalidates cached
    /// transcripts via a payload-side comparison ([`ExtractedText::is_model_stale`]),
    /// while the crypto framing (AAD) stays model-agnostic. Because the
    /// `extractor_version` header byte (bumped `0x01`→`0x02`) is checked and
    /// AAD-bound BEFORE any payload decode, only `0x02` blobs are ever parsed
    /// with this trailing field present — an old `0x01` blob is rejected at the
    /// header and never reaches this struct.
    pub model_hash: Option<[u8; 32]>,
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
            model_hash: None,
        }
    }

    /// Whether this cached payload is stale relative to `current_model_hash` —
    /// a model-dependent transcript recorded under a different model than the
    /// one now selected (voice-to-text, MYND-551). A deterministic extraction
    /// (`model_hash == None`) is never model-stale. A recorded hash with no
    /// current model (`current_model_hash == None`) reads as stale — the
    /// producing model is gone, so the transcript can no longer be reproduced
    /// or verified and the UI should offer a re-transcribe. This is a UI/search
    /// freshness hint only; the AEAD framing never depends on the model hash.
    pub fn is_model_stale(&self, current_model_hash: Option<&[u8; 32]>) -> bool {
        match &self.model_hash {
            Some(recorded) => Some(recorded) != current_model_hash,
            None => false,
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
            model_hash: None,
        };
        let bytes = r.to_blob_plaintext();
        let back = ExtractedText::from_blob_plaintext(&bytes).expect("decode");
        assert_eq!(r, back);
    }

    #[test]
    fn audio_source_format_round_trips() {
        // A transcript payload (SourceFormat::Audio) round-trips equal through
        // the postcard MYE1 inner-plaintext codec — additive, not load-bearing.
        // extractor_version 0x02 carries the producing model's SHA-256 in the
        // inner payload (§9.17.2 mirror).
        let r = ExtractedText {
            status: ExtractStatus::Ok,
            source_format: SourceFormat::Audio,
            text: "on-device transcript".to_string(),
            char_count: 20,
            truncated: false,
            model_hash: Some([0xa5; 32]),
        };
        let bytes = r.to_blob_plaintext();
        let back = ExtractedText::from_blob_plaintext(&bytes).expect("decode");
        assert_eq!(r, back);
        assert_eq!(back.model_hash, Some([0xa5; 32]));
    }

    #[test]
    fn model_stale_detects_a_swapped_model() {
        // An audio transcript recorded under model A reads stale once model B is
        // selected, fresh under A, and stale when no model is selected — the
        // cache-invalidation-on-model-swap rule (§9.17.2 mirror).
        let a = [0x11; 32];
        let b = [0x22; 32];
        let t = ExtractedText {
            status: ExtractStatus::Ok,
            source_format: SourceFormat::Audio,
            text: "transcript".to_string(),
            char_count: 10,
            truncated: false,
            model_hash: Some(a),
        };
        assert!(!t.is_model_stale(Some(&a)), "same model → fresh");
        assert!(t.is_model_stale(Some(&b)), "swapped model → stale");
        assert!(t.is_model_stale(None), "no current model → stale");
        // A deterministic (model-independent) extraction is never model-stale.
        let pdf = ExtractedText::negative(ExtractStatus::Empty, SourceFormat::Pdf);
        assert!(!pdf.is_model_stale(Some(&a)));
        assert!(!pdf.is_model_stale(None));
    }

    #[test]
    fn model_hash_is_payload_not_framing() {
        // Two payloads differing ONLY in model_hash serialize to DIFFERENT inner
        // plaintexts (the hash rides the payload), yet the postcard shape is
        // otherwise identical — the hash never enters the AAD/crypto framing,
        // which the codec layer (attachment_text_blob) binds independently.
        let base = ExtractedText {
            status: ExtractStatus::Ok,
            source_format: SourceFormat::Audio,
            text: "same text".to_string(),
            char_count: 9,
            truncated: false,
            model_hash: Some([0x01; 32]),
        };
        let other = ExtractedText {
            model_hash: Some([0x02; 32]),
            ..base.clone()
        };
        assert_ne!(base.to_blob_plaintext(), other.to_blob_plaintext());
    }

    #[test]
    fn existing_source_format_tags_are_stable() {
        // Guard the appended-only invariant: Pdf/Docx/Text/Other keep their
        // postcard index tags 0..=3 (a reorder would silently misread every
        // already-written MYE1 blob).
        assert_eq!(
            postcard::to_allocvec(&SourceFormat::Pdf).unwrap(),
            vec![0u8]
        );
        assert_eq!(
            postcard::to_allocvec(&SourceFormat::Docx).unwrap(),
            vec![1u8]
        );
        assert_eq!(
            postcard::to_allocvec(&SourceFormat::Text).unwrap(),
            vec![2u8]
        );
        assert_eq!(
            postcard::to_allocvec(&SourceFormat::Other).unwrap(),
            vec![3u8]
        );
        assert_eq!(
            postcard::to_allocvec(&SourceFormat::Audio).unwrap(),
            vec![4u8]
        );
    }

    #[test]
    fn malformed_payload_decodes_to_none() {
        assert!(
            ExtractedText::from_blob_plaintext(&[0xff, 0xff, 0xff]).is_none()
                || ExtractedText::from_blob_plaintext(&[]).is_none()
        );
    }
}
