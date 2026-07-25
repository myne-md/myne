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
/// (Pdf=0/Docx=1/Text=2/Other=3/Audio=4) byte-stable for already-written `MYE1`
/// blobs. Inserting or reordering silently re-interprets every cached blob.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum SourceFormat {
    Pdf,
    Docx,
    Text,
    Other,
    /// Audio transcript from the on-device ASR engine (voice-to-text, MYND-551;
    /// `extractor_version 0x02`). Index tag `4`.
    Audio,
    /// Recognized text from the on-device OCR engine for a **raster image**
    /// attachment (MYND-441; `extractor_version 0x03`). Index tag `5`.
    ///
    /// A scanned, text-layer-less PDF keeps [`SourceFormat::Pdf`] — it *is* a
    /// PDF, and `status` + `text` already distinguish an OCR result from a
    /// text-layer one. Only the attachment's own format selects this variant.
    Image,
}

impl SourceFormat {
    /// Whether this format's text was produced by a **model**, as opposed to a
    /// deterministic parser. Model-backed output is inherently approximate —
    /// notably it may flatten diacritics the source document carries — which is
    /// why OCR-derived documents are indexed under a diacritic-folded token
    /// variant (MYND-441). Deterministic extractors reproduce the source exactly
    /// and need no such widening.
    pub fn is_model_derived(self) -> bool {
        matches!(self, SourceFormat::Audio | SourceFormat::Image)
    }
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

    /// NFC-normalize `raw`, apply the [`MAX_EXTRACTED_TEXT_LEN`] cap, and
    /// classify the result as [`ExtractStatus::Ok`] or [`ExtractStatus::Empty`].
    ///
    /// The single place every extractor lands its text, so normalization, the
    /// cap, the `char_count`-before-truncation rule and the whitespace-only →
    /// `Empty` rule cannot drift between formats. Shared with mobile, which
    /// runs the same extractors.
    ///
    /// `char_count` is deliberately the count **before** truncation (§9.15.2),
    /// so a caller can tell how much was dropped. Truncation cuts on a char
    /// boundary, never mid-codepoint.
    pub fn finalize(raw: String, source_format: SourceFormat) -> ExtractedText {
        use unicode_normalization::UnicodeNormalization;

        let normalized: String = raw.nfc().collect();
        let char_count = normalized.chars().count() as u32;

        let (mut text, truncated) = if normalized.len() > MAX_EXTRACTED_TEXT_LEN {
            let mut end = MAX_EXTRACTED_TEXT_LEN;
            while end > 0 && !normalized.is_char_boundary(end) {
                end -= 1;
            }
            (normalized[..end].to_string(), true)
        } else {
            (normalized, false)
        };

        let status = if text.trim().is_empty() {
            text.clear();
            ExtractStatus::Empty
        } else {
            ExtractStatus::Ok
        };

        ExtractedText {
            status,
            source_format,
            text,
            char_count,
            truncated,
            // Every extractor that lands here is either deterministic
            // (PDF/DOCX/text) or model-backed with BUNDLED weights (OCR) — in
            // both cases there is no per-vault model identity to record. The
            // one caller that sets `model_hash` is the ASR path, whose model
            // the user side-loads; it builds its payload directly.
            model_hash: None,
        }
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
        assert_eq!(
            postcard::to_allocvec(&SourceFormat::Image).unwrap(),
            vec![5u8]
        );
    }

    #[test]
    fn image_source_format_round_trips() {
        // An OCR payload (SourceFormat::Image) round-trips equal through the
        // postcard MYE1 inner-plaintext codec. `model_hash` stays None: the OCR
        // weights are BUNDLED rather than user-chosen, so there is no per-vault
        // model identity to record — `extractor_version` alone is the staleness
        // signal, which is why changing the bundled weights must bump it.
        let r = ExtractedText {
            status: ExtractStatus::Ok,
            source_format: SourceFormat::Image,
            text: "recognized from pixels".to_string(),
            char_count: 22,
            truncated: false,
            model_hash: None,
        };
        let bytes = r.to_blob_plaintext();
        let back = ExtractedText::from_blob_plaintext(&bytes).expect("decode");
        assert_eq!(r, back);
        assert_eq!(back.model_hash, None);
        // ...and being model-independent in the payload does NOT make it
        // deterministic: the index still needs the diacritic-folded widening.
        assert!(SourceFormat::Image.is_model_derived());
        assert!(!back.is_model_stale(None), "no recorded hash → never stale");
    }

    #[test]
    fn model_derived_formats_are_exactly_audio_and_image() {
        // Guards the classification the index-side folding keys off: adding a
        // future model-backed format without updating this set would silently
        // leave its output unfolded.
        for f in [SourceFormat::Audio, SourceFormat::Image] {
            assert!(f.is_model_derived(), "{f:?} must be model-derived");
        }
        for f in [
            SourceFormat::Pdf,
            SourceFormat::Docx,
            SourceFormat::Text,
            SourceFormat::Other,
        ] {
            assert!(!f.is_model_derived(), "{f:?} must be deterministic");
        }
    }

    #[test]
    fn malformed_payload_decodes_to_none() {
        assert!(
            ExtractedText::from_blob_plaintext(&[0xff, 0xff, 0xff]).is_none()
                || ExtractedText::from_blob_plaintext(&[]).is_none()
        );
    }
}
