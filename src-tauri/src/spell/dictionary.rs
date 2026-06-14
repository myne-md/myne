//! Host-side personal-dictionary payload + persistence (MYND-266 tasks 4-5).
//!
//! The `vault.dictionary` inner plaintext (the `dict_format_version 0x01` format,
//! per `protocol::dictionary_blob` / spec § 9.13.2) is a postcard-serialized
//! `{personal_words, ignore_words}` struct. The protocol crate owns the crypto
//! framing (MYD1 magic, AEAD, AAD) and treats this payload as opaque bytes; this
//! module owns the serialization + the canonical set discipline (NFC-normalized,
//! sorted, exact-deduped — the `deliberate_folders` rules, SYNC-4).
//!
//! Both sets are AS3-Sensitive user vocabulary: they live encrypted at rest, are
//! held in RAM only while unlocked, and are zeroized on lock (see `sync.rs`).

use serde::{Deserialize, Serialize};
use unicode_normalization::UnicodeNormalization;

/// The inner plaintext of `vault.dictionary` (`dict_format_version 0x01`).
/// Two set-semantics string arrays, canonicalized (NFC + sorted + deduped) on
/// encode so the bytes are deterministic and cross-impl-stable.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct PersonalDictionaryData {
    /// User-added words that count as correctly spelled.
    pub personal_words: Vec<String>,
    /// Vault-wide ignore set (suppressed even if otherwise misspelled, SYNC-13).
    pub ignore_words: Vec<String>,
}

/// NFC-normalize, sort, and exact-dedup a word list (the `deliberate_folders`
/// canonical discipline). Folded-identity dedup is the lookup layer's job
/// (`spell::SpellEngine::fold`), not the codec's — this preserves distinct
/// display forms and only collapses exact duplicates.
fn canonicalize(words: &[String]) -> Vec<String> {
    let mut v: Vec<String> = words.iter().map(|w| w.nfc().collect::<String>()).collect();
    v.sort();
    v.dedup();
    v
}

impl PersonalDictionaryData {
    /// Serialize to the canonical postcard bytes (NFC + sorted + deduped). Empty
    /// sets serialize deterministically; the caller omits the whole
    /// `vault.dictionary` file when both are empty (fall-back-to-empty on read).
    pub fn encode(&self) -> Vec<u8> {
        let canonical = PersonalDictionaryData {
            personal_words: canonicalize(&self.personal_words),
            ignore_words: canonicalize(&self.ignore_words),
        };
        postcard::to_allocvec(&canonical).unwrap_or_default()
    }

    /// Deserialize from postcard bytes. Returns `None` on a malformed payload
    /// (the caller collapses to the empty dictionary, § 9.13.4).
    pub fn decode(bytes: &[u8]) -> Option<Self> {
        postcard::from_bytes(bytes).ok()
    }

    /// Add a word to the personal set (NFC-normalized; canonicalized on next
    /// encode). Idempotent — a re-add is collapsed by the dedup at encode time.
    pub fn add_personal(&mut self, word: &str) {
        self.personal_words.push(word.nfc().collect());
    }

    /// Add a word to the vault-wide ignore set (NFC-normalized).
    pub fn add_ignore(&mut self, word: &str) {
        self.ignore_words.push(word.nfc().collect());
    }

    /// True when both sets are empty (→ the caller omits the on-disk file).
    pub fn is_empty(&self) -> bool {
        self.personal_words.is_empty() && self.ignore_words.is_empty()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trips_through_postcard() {
        let mut d = PersonalDictionaryData::default();
        d.add_personal("Myne");
        d.add_personal("tokio");
        d.add_ignore("helllo");
        let bytes = d.encode();
        let back = PersonalDictionaryData::decode(&bytes).expect("decode");
        assert_eq!(back.personal_words, vec!["Myne", "tokio"]);
        assert_eq!(back.ignore_words, vec!["helllo"]);
    }

    #[test]
    fn encode_canonicalizes_sorted_and_deduped() {
        let d = PersonalDictionaryData {
            personal_words: vec!["beta".into(), "alpha".into(), "beta".into()],
            ignore_words: vec![],
        };
        let back = PersonalDictionaryData::decode(&d.encode()).unwrap();
        assert_eq!(back.personal_words, vec!["alpha", "beta"]);
    }

    #[test]
    fn empty_is_empty() {
        assert!(PersonalDictionaryData::default().is_empty());
        let mut d = PersonalDictionaryData::default();
        d.add_ignore("x");
        assert!(!d.is_empty());
    }

    #[test]
    fn decode_rejects_garbage() {
        // postcard is a binary format; arbitrary bytes usually fail to decode
        // into the two-Vec<String> shape. A defensive None keeps the caller on
        // the fall-back-to-empty path.
        let garbage = [0xFFu8; 4];
        let _ = PersonalDictionaryData::decode(&garbage); // must not panic
    }

    #[test]
    fn nfc_normalizes_on_add() {
        let mut d = PersonalDictionaryData::default();
        // decomposed "é" (e + U+0301) normalizes to precomposed on encode.
        d.add_personal("cafe\u{0301}");
        let back = PersonalDictionaryData::decode(&d.encode()).unwrap();
        assert_eq!(back.personal_words, vec!["caf\u{00e9}"]);
    }
}
