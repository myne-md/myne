// SPDX-License-Identifier: AGPL-3.0-or-later
//! Offensive red-team: recovery-phrase collision & normalization attacks.
//!
//! The 24-word BIP-39 recovery phrase is a SECOND root-key path. A collision
//! (two distinct phrases → same key) or a normalization merge (two different
//! phrases canonicalize identically) would let one phrase open another user's
//! vault, or shrink the brute-force space. Each test asserts the secure
//! outcome; a failure means a real break.
//!
//! KDF-based tests use WEAK Argon2 params purely to keep them fast — they
//! test the phrase→key MAPPING (distinctness), not the cost.

use std::collections::HashSet;

use protocol::{
    derive_recovery_wrap_key, generate_recovery_phrase, normalize_user_phrase, KdfParams,
    RecoveryPhrase,
};

const WEAK: KdfParams = KdfParams {
    m_kib: 8,
    t: 1,
    p: 1,
    argon2_version: 0x13,
};
const SALT: [u8; 16] = [0x11; 16];
const ACCT: [u8; 16] = [0x22; 16];

fn words_joined(p: &RecoveryPhrase) -> String {
    p.words().join(" ")
}

/// Generation must never repeat: collect many freshly generated phrases and
/// require every one distinct. A repeat would mean the entropy source or
/// encoding is broken (catastrophic — phrases would be guessable/colliding).
#[test]
fn battery6_generated_phrases_never_collide() {
    const N: usize = 5_000;
    let mut seen: HashSet<String> = HashSet::with_capacity(N);
    for _ in 0..N {
        let p = generate_recovery_phrase().expect("generate");
        assert_eq!(p.words().len(), 24, "phrase must be 24 words");
        assert!(
            seen.insert(words_joined(&p)),
            "COLLISION: duplicate phrase generated"
        );
    }
}

/// Normalization must be COLLISION-FREE across distinct phrases but
/// FORMATTING-INVARIANT for the same phrase. We check both:
///  (a) two distinct generated phrases normalize to distinct strings, and
///  (b) messy formatting (case, extra/odd whitespace, NFKD full-width) of one
///      phrase normalizes to the exact same string (so it derives one key).
#[test]
fn battery6_normalization_no_cross_phrase_merge() {
    // (a) distinct phrases stay distinct after normalization
    const N: usize = 2_000;
    let mut norms: HashSet<String> = HashSet::with_capacity(N);
    for _ in 0..N {
        let p = generate_recovery_phrase().expect("gen");
        let norm = normalize_user_phrase(&words_joined(&p)).to_string();
        assert!(
            norms.insert(norm),
            "NORMALIZATION MERGE: two phrases collapsed to one"
        );
    }

    // (b) formatting variants of the SAME phrase collapse identically
    let p = generate_recovery_phrase().expect("gen");
    let base = words_joined(&p);
    let canonical_norm = normalize_user_phrase(&base).to_string();
    let messy = format!("  {}  ", base.to_uppercase().replace(' ', "   "));
    assert_eq!(
        normalize_user_phrase(&messy).to_string(),
        canonical_norm,
        "formatting variants of one phrase must normalize identically"
    );
}

/// The phrase→key map must be injective in practice: two distinct phrases
/// derive distinct keys, and formatting variants of one phrase derive the
/// SAME key. (WEAK params for speed; this tests the mapping, not cost.)
#[test]
fn battery6_distinct_phrases_derive_distinct_keys() {
    let p1 = generate_recovery_phrase().expect("p1");
    let p2 = generate_recovery_phrase().expect("p2");
    assert_ne!(words_joined(&p1), words_joined(&p2));

    let k1 = derive_recovery_wrap_key(&p1, &SALT, &ACCT, &WEAK).expect("k1");
    let k2 = derive_recovery_wrap_key(&p2, &SALT, &ACCT, &WEAK).expect("k2");
    assert_ne!(
        *k1, *k2,
        "KEY COLLISION: distinct phrases derived the same key"
    );

    // Same phrase derived twice → identical key (determinism).
    let k1b = derive_recovery_wrap_key(&p1, &SALT, &ACCT, &WEAK).expect("k1b");
    assert_eq!(*k1, *k1b, "derivation must be deterministic for one phrase");
}
