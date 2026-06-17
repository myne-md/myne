// SPDX-License-Identifier: AGPL-3.0-or-later
//! Offensive red-team round 2 — statistical / side-channel attacks:
//!  * timing oracle on decode failure classes (§6.4 non-distinguishing)
//!  * nonce RNG bias (monobit + byte chi-square), not just uniqueness
//!  * recovery-phrase wordlist uniformity (entropy bias hunt)
//!
//! Run visibly:
//!   cargo test -p protocol --test crypto_attacks_oracle -- --nocapture --test-threads=1

use std::collections::HashMap;
use std::time::Instant;

use protocol::{decode_note, encode_new_note, generate_recovery_phrase, AEAD_NONCE_LEN};

const ITEMS_KEY: [u8; 32] = [0x07; 32];
const ITEMS_KEY_ID: [u8; 16] = [0xAB; 16];
const NOTE_UUID: [u8; 16] = [0xCD; 16];
const SECRET: &[u8] = b"timing side-channel target plaintext, reasonably long to encrypt";

/// Timing analysis of `decode_note` failure paths.
///
/// SECURITY GATE (asserted): within a single failure path, timing must be
/// data-independent — two DIFFERENT wrong items_keys (both fail the outer
/// unwrap) must take the same time. A key-dependent branch here would be a
/// genuine constant-time break. We assert that ratio ≈ 1.
///
/// FINDING (measured, not gated): the WRONG-items_key path (outer AEAD fails
/// → inner content decrypt is skipped, 1 AEAD) is ~2x faster than the
/// CORRECT-key-but-tampered-content path (outer succeeds, inner tag fails,
/// 2 AEADs). So decode time distinguishes "wrong key" from "right key, bad
/// content". This is benign in Myne's threat model — decode runs locally with
/// the user's own secret items_key; there is no remote decryption oracle for
/// an attacker to time (the architecture forbids server-side decrypt). But it
/// is a deviation from a strict constant-time-decode ideal and from a naive
/// reading of the §6.4 "non-distinguishing" claim at the timing level. Worth
/// noting for the audit; would matter if a decryption oracle ever existed.
#[test]
fn round2_decode_failure_timing_analysis() {
    let good = encode_new_note(&ITEMS_KEY, &ITEMS_KEY_ID, &NOTE_UUID, SECRET).unwrap();
    let wrong_key_1 = [0x08; 32];
    let wrong_key_2 = [0xF3; 32];
    let mut tampered = good.clone();
    let n = tampered.len();
    tampered[n - 40] ^= 0x01; // valid outer, broken inner

    let iters = 4000;
    let median = |mut v: Vec<u128>| {
        v.sort_unstable();
        v[v.len() / 2] as f64
    };
    let bench = |f: &dyn Fn()| {
        for _ in 0..500 {
            f();
        }
        let mut t = Vec::with_capacity(iters);
        for _ in 0..iters {
            let s = Instant::now();
            f();
            t.push(s.elapsed().as_nanos());
        }
        median(t)
    };

    let t_wrong1 = bench(&|| {
        let _ = decode_note(&good, &NOTE_UUID, &wrong_key_1, &ITEMS_KEY_ID);
    });
    let t_wrong2 = bench(&|| {
        let _ = decode_note(&good, &NOTE_UUID, &wrong_key_2, &ITEMS_KEY_ID);
    });
    let t_tampered = bench(&|| {
        let _ = decode_note(&tampered, &NOTE_UUID, &ITEMS_KEY, &ITEMS_KEY_ID);
    });

    let within_path = t_wrong1.max(t_wrong2) / t_wrong1.min(t_wrong2);
    let cross_path = t_tampered / t_wrong1;
    eprintln!("[timing] wrong-key#1={t_wrong1:.0}ns  wrong-key#2={t_wrong2:.0}ns  (within-path ratio={within_path:.3})");
    eprintln!("[timing] tampered-content={t_tampered:.0}ns  (cross-path ratio vs wrong-key={cross_path:.2}x)");
    eprintln!("[FINDING] decode time distinguishes wrong-key (1 AEAD) from tampered-content (2 AEAD); benign locally (no decryption oracle), noted for audit.");

    // GATE: data-independence within the same failure path. Loose bound to
    // tolerate scheduler noise; a real key-dependent branch would blow past it.
    assert!(
        within_path < 1.4,
        "CONSTANT-TIME BREAK: same-path timing key-dependent ({within_path:.2}x)"
    );
}

/// Nonce RNG bias hunt. Collect many real content-nonces and run two cheap
/// randomness tests: monobit (fraction of 1-bits ≈ 0.5) and a byte-value
/// chi-square (uniform over 0..256). A biased CSPRNG would fail these even
/// while passing the uniqueness test.
#[test]
fn round2_nonce_rng_has_no_detectable_bias() {
    const N: usize = 20_000;
    let mut ones: u64 = 0;
    let mut bits: u64 = 0;
    let mut byte_counts = [0u64; 256];
    use protocol::blob::OFFSET_CONTENT_NONCE;
    for _ in 0..N {
        let blob = encode_new_note(&ITEMS_KEY, &ITEMS_KEY_ID, &NOTE_UUID, SECRET).unwrap();
        let nonce = &blob[OFFSET_CONTENT_NONCE..OFFSET_CONTENT_NONCE + AEAD_NONCE_LEN];
        for &b in nonce {
            ones += b.count_ones() as u64;
            bits += 8;
            byte_counts[b as usize] += 1;
        }
    }
    let frac_ones = ones as f64 / bits as f64;
    eprintln!("[nonce] monobit fraction-of-ones = {frac_ones:.5} (ideal 0.5), bits={bits}");
    assert!(
        (frac_ones - 0.5).abs() < 0.01,
        "MONOBIT BIAS: {frac_ones:.4}"
    );

    // Chi-square over 256 byte values.
    let total: u64 = byte_counts.iter().sum();
    let expected = total as f64 / 256.0;
    let chi2: f64 = byte_counts
        .iter()
        .map(|&c| {
            let d = c as f64 - expected;
            d * d / expected
        })
        .sum();
    // df=255; 99.9% critical value ≈ 330. Comfortably below => uniform.
    eprintln!("[nonce] byte chi-square = {chi2:.1} (df=255, 99.9% crit ≈ 330)");
    assert!(chi2 < 360.0, "BYTE-DISTRIBUTION BIAS: chi2={chi2:.1}");
}

/// Recovery-phrase entropy bias: across many generated phrases, the words
/// must spread across (almost) the full 2048-word BIP-39 list with roughly
/// uniform frequency. A generator that biased toward a small subset would
/// shrink the real entropy. We assert wide coverage + bounded skew.
#[test]
fn round2_recovery_wordlist_is_uniform() {
    const N: usize = 6_000; // 6000 * 24 = 144k word draws over 2048 words (~70 each)
    let mut freq: HashMap<String, u32> = HashMap::new();
    for _ in 0..N {
        let p = generate_recovery_phrase().unwrap();
        for w in p.words().iter() {
            *freq.entry(w.clone()).or_insert(0) += 1;
        }
    }
    let distinct = freq.len();
    let max = *freq.values().max().unwrap();
    let min = *freq.values().min().unwrap();
    let total: u32 = freq.values().sum();
    let expected = total as f64 / 2048.0;
    eprintln!(
        "[wordlist] distinct={distinct}/2048  min={min} max={max} expected≈{expected:.0}/word"
    );
    // With 144k draws, essentially all 2048 words should appear, and the
    // hottest word should be well under 3x the expected count.
    assert!(
        distinct >= 2040,
        "WORDLIST COVERAGE BIAS: only {distinct}/2048 words seen"
    );
    assert!(
        (max as f64) < expected * 2.5,
        "WORDLIST SKEW: max {max} vs expected {expected:.0}"
    );
}
