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

/// Fold a token to its diacritic-stripped, lowercased form: `şirket` → `sirket`,
/// `İSTANBUL` → `istanbul`, `dağ` → `dag`.
///
/// **Why this exists (MYND-441).** On-device OCR does not reliably reproduce
/// Turkish diacritics — the MYND-441 spike measured `ı`, `ş` and `ç` being
/// dropped even though they are present in the recognition charset, because the
/// model's training distribution is Chinese+English dominant. No engine
/// available on-device does better: PaddleOCR ships no Turkish recognizer, its
/// `latin` variant lacks `ğ`/`ş`/`İ` outright, and `ocrs` is English-only. Since
/// the search tokenizer does Turkish-aware casefolding and stemming but **no**
/// diacritic folding, an OCR imperfection would otherwise become a total miss: a
/// document reading `şirketin`, recognized as `sirketin`, is unreachable by a
/// user who types `şirket` correctly.
///
/// Folding both sides of that comparison is the standard remedy for noisy OCR
/// text, and it is engine-independent — it keeps working whichever recognizer
/// ships.
///
/// Implementation: NFD-decompose and drop combining marks, which covers every
/// Turkish diacritic that decomposes (`ç`→`c`, `ğ`→`g`, `ö`→`o`, `ş`→`s`,
/// `ü`→`u`, `İ`→`I`). The dotless `ı` is **not** a decomposable form — it is a
/// distinct Latin letter — so it is mapped explicitly. Lowercasing runs last, so
/// `İ` (→`I`→`i`) and `I` (→`i`) and `ı` (→`i`) all converge, which is exactly
/// the confusion OCR produces.
///
/// This is deliberately lossy and must NEVER be used for storage or display —
/// only as an additional index/query key.
pub fn fold_diacritics(s: &str) -> String {
    use unicode_normalization::char::is_combining_mark;

    s.chars()
        .map(|c| match c {
            // Not decomposable: a distinct letter, not i-with-something.
            'ı' => 'i',
            'İ' => 'I',
            other => other,
        })
        .nfd()
        .filter(|c| !is_combining_mark(*c))
        .flat_map(char::to_lowercase)
        .collect()
}

/// The largest byte index at or below `at` that is a character boundary.
///
/// Slicing a `&str` on an index that is not a boundary panics, so any code
/// truncating user text to a byte budget needs this first. Hand-rolled because
/// `str::floor_char_boundary` is still unstable.
///
/// Lives here rather than beside its first caller because it is a property of
/// `str` rather than of any one feature, and the tree already had the same
/// `while !is_char_boundary` walk written inline in two places
/// (`plugins::attachments::extract_types`, `plugins::attachments::text_cache`).
/// Those are not converted here, since they are outside the change that added
/// this, but they are where the third and fourth copies would otherwise have
/// gone.
pub fn floor_char_boundary(s: &str, at: usize) -> usize {
    if at >= s.len() {
        return s.len();
    }
    let mut i = at;
    while i > 0 && !s.is_char_boundary(i) {
        i -= 1;
    }
    i
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fold_diacritics_strips_turkish_marks() {
        // Every Turkish diacritic folds to its base letter. These are exactly
        // the characters MYND-441 measured OCR dropping.
        assert_eq!(fold_diacritics("şirket"), "sirket");
        assert_eq!(fold_diacritics("dağ"), "dag");
        assert_eq!(fold_diacritics("çalışma"), "calisma");
        assert_eq!(fold_diacritics("öğretmen"), "ogretmen");
        assert_eq!(fold_diacritics("Ürgüp"), "urgup");
    }

    #[test]
    fn fold_diacritics_converges_the_turkish_i_family() {
        // `İ`, `I` and `ı` all fold to `i`. This is the whole point: OCR
        // confuses exactly these, so the index and the query must agree on one
        // form regardless of which the recognizer emitted.
        assert_eq!(fold_diacritics("İSTANBUL"), "istanbul");
        assert_eq!(fold_diacritics("ISTANBUL"), "istanbul");
        assert_eq!(fold_diacritics("ıspanak"), "ispanak");
        assert_eq!(fold_diacritics("İzmir"), fold_diacritics("Izmir"));
    }

    #[test]
    fn fold_diacritics_leaves_plain_ascii_alone() {
        assert_eq!(fold_diacritics("invoice"), "invoice");
        assert_eq!(fold_diacritics("Report2024"), "report2024");
        assert_eq!(fold_diacritics(""), "");
    }

    #[test]
    fn fold_diacritics_is_idempotent() {
        // It must be safe to apply to an already-folded token (the query path
        // folds every term, including ones that were never accented).
        for w in ["şirket", "dağ", "istanbul", "plain"] {
            let once = fold_diacritics(w);
            assert_eq!(fold_diacritics(&once), once, "not idempotent for {w:?}");
        }
    }

    #[test]
    fn fold_diacritics_covers_non_turkish_latin_too() {
        // The mechanism is NFD + combining-mark removal, so it is not
        // Turkish-specific — useful because OCR flattens other Latin scripts
        // the same way.
        assert_eq!(fold_diacritics("café"), "cafe");
        assert_eq!(fold_diacritics("naïve"), "naive");
        assert_eq!(fold_diacritics("Müller"), "muller");
    }

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

    #[test]
    fn floor_char_boundary_never_splits_a_character() {
        // Every char is 4 bytes, so any index not a multiple of 4 is inside one.
        let s = "🙂🙂🙂";
        for at in 0..=s.len() {
            let cut = floor_char_boundary(s, at);
            assert!(s.is_char_boundary(cut), "at={at} gave {cut}");
            assert!(cut <= at);
            // And it is the LARGEST such index, not merely a safe one: a
            // helper that always returned 0 would satisfy everything above.
            assert!(
                cut + 4 > at || cut == s.len(),
                "at={at} gave {cut}, too low"
            );
        }
    }

    #[test]
    fn floor_char_boundary_clamps_past_the_end() {
        assert_eq!(floor_char_boundary("abc", 99), 3);
        assert_eq!(floor_char_boundary("", 5), 0);
    }
}
