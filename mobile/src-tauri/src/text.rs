//! Shared text tokenization + casefolding (SYNC-2, spell-checker epic).
//!
//! Extracted from the search index (MYND-29, `search::mod`) so the search
//! index and the spell engine (MYND-262) agree byte-for-byte on word
//! boundaries and casefolding — a word the index sees is the word the checker
//! sees. The Turkish casefold (`I → ı`, `İ → i`) is the load-bearing special
//! case: Rust's default `str::to_lowercase` maps `I → i` / `İ → i̇`, which is
//! wrong for Turkish.
//!
//! These are pure, language-agnostic primitives; per-language stemming (search)
//! and dictionary lookup (spell) layer on top of them in their own modules.

use unicode_normalization::UnicodeNormalization;

/// NFC-normalize `text` and split into raw tokens on any non-alphanumeric
/// character (whitespace, punctuation), **preserving original case**. Empty
/// tokens are dropped. Casefolding is a separate step so the caller can pick
/// per-language lowercasing (e.g. Turkish) before stemming / dictionary lookup.
pub fn split_nfc(text: &str) -> Vec<String> {
    text.nfc()
        .collect::<String>()
        .split(|c: char| !c.is_alphanumeric())
        .filter(|t| !t.is_empty())
        .map(str::to_string)
        .collect()
}

/// Default Unicode lowercasing (language-agnostic). Both producers and
/// consumers of a casefolded token must AGREE, so consistency matters more
/// than linguistic correctness for the language-agnostic layer.
pub fn default_lower(s: &str) -> String {
    s.to_lowercase()
}

/// Turkish-aware lowercasing: `I → ı` (dotless) and `İ → i` (dotted); every
/// other character lowercased normally. Rust's `str::to_lowercase` maps
/// `I → i` and `İ → i̇` per default Unicode rules — wrong for Turkish. Used as
/// the casefold step before Turkish stemming (search) or Turkish dictionary
/// lookup (spell).
pub fn turkish_lower(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        match c {
            'I' => out.push('ı'),
            'İ' => out.push('i'),
            other => out.extend(other.to_lowercase()),
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn split_nfc_splits_on_punctuation_and_preserves_case() {
        assert_eq!(
            split_nfc("Hello, World! rust-lang"),
            vec!["Hello", "World", "rust", "lang"]
        );
    }

    #[test]
    fn split_nfc_drops_empty_tokens() {
        assert_eq!(split_nfc("  a---b  "), vec!["a", "b"]);
        assert!(split_nfc("   ").is_empty());
    }

    #[test]
    fn split_nfc_normalizes_decomposed_to_precomposed() {
        // Decomposed "café" (e + U+0301) NFC-folds to precomposed "café".
        assert_eq!(split_nfc("cafe\u{0301}"), vec!["caf\u{00e9}"]);
    }

    #[test]
    fn default_lower_is_unicode_lowercase() {
        assert_eq!(default_lower("RUST"), "rust");
        assert_eq!(default_lower("Açık"), "açık");
    }

    #[test]
    fn turkish_lower_handles_dotted_and_dotless_i() {
        assert_eq!(turkish_lower("I"), "ı");
        assert_eq!(turkish_lower("İ"), "i");
        assert_eq!(turkish_lower("KİTAP"), "kitap");
        assert_eq!(turkish_lower("ISIRGAN"), "ısırgan");
        // The bug this avoids: default Unicode lowercasing maps I → i.
        assert_ne!(turkish_lower("I"), "I".to_lowercase());
    }
}
