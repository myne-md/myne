// SPDX-License-Identifier: AGPL-3.0
//! Offensive red-team — dudect-style statistical constant-time test of the
//! note-decrypt failure path.
//!
//! Methodology (Reparaz/Balasch/Verbauwhede "dudect"): time `decode_note`
//! over two input classes — a FIXED wrong items_key vs a RANDOM wrong
//! items_key — interleaved to cancel clock drift, crop scheduler outliers,
//! then run Welch's t-test. If decrypt timing is independent of the key
//! bytes (constant-time), the two distributions are statistically
//! indistinguishable and |t| stays small. A key-dependent branch (e.g. a
//! short-circuiting tag compare, a key-indexed table) would make |t| explode
//! into the hundreds. This is a stronger statement than a median-ratio check.
//!
//! Run visibly:
//!   cargo test -p protocol --test crypto_attacks_timing -- --nocapture

use std::time::Instant;

use protocol::{decode_note, encode_new_note};

const ITEMS_KEY: [u8; 32] = [0x07; 32];
const ITEMS_KEY_ID: [u8; 16] = [0xAB; 16];
const NOTE_UUID: [u8; 16] = [0xCD; 16];

/// Tiny deterministic xorshift PRNG (no external rng; reproducible).
struct XorShift(u64);
impl XorShift {
    fn next_key(&mut self) -> [u8; 32] {
        let mut k = [0u8; 32];
        for chunk in k.chunks_mut(8) {
            self.0 ^= self.0 << 13;
            self.0 ^= self.0 >> 7;
            self.0 ^= self.0 << 17;
            chunk.copy_from_slice(&self.0.to_le_bytes()[..chunk.len()]);
        }
        k[0] = 0x01; // keep it != ITEMS_KEY (which is all 0x07)
        k
    }
}

/// Welch's t-statistic between two samples.
fn welch_t(a: &[u128], b: &[u128]) -> f64 {
    let mean = |v: &[u128]| v.iter().map(|&x| x as f64).sum::<f64>() / v.len() as f64;
    let var = |v: &[u128], m: f64| {
        v.iter().map(|&x| (x as f64 - m).powi(2)).sum::<f64>() / (v.len() as f64 - 1.0)
    };
    let (ma, mb) = (mean(a), mean(b));
    let (va, vb) = (var(a, ma), var(b, mb));
    (ma - mb) / (va / a.len() as f64 + vb / b.len() as f64).sqrt()
}

/// Crop the slowest `pct`% of samples (scheduler preemptions, page faults)
/// — dudect's standard outlier handling so OS noise doesn't dominate.
fn crop_high(mut v: Vec<u128>, pct: f64) -> Vec<u128> {
    v.sort_unstable();
    let keep = ((v.len() as f64) * (1.0 - pct)) as usize;
    v.truncate(keep);
    v
}

#[test]
fn dudect_decode_timing_independent_of_key_bytes() {
    let blob = encode_new_note(
        &ITEMS_KEY,
        &ITEMS_KEY_ID,
        &NOTE_UUID,
        b"secret body bytes here",
    )
    .expect("encode");

    const N: usize = 120_000;
    let fixed_wrong = [0xAAu8; 32]; // FIXED class key (constant)
    let mut rng = XorShift(0x1234_5678_9ABC_DEF0);

    // Warm up caches / branch predictors.
    for _ in 0..2000 {
        let _ = decode_note(&blob, &NOTE_UUID, &fixed_wrong, &ITEMS_KEY_ID);
    }

    let mut t_fixed = Vec::with_capacity(N);
    let mut t_random = Vec::with_capacity(N);
    // Interleave the two classes so any slow clock drift hits both equally.
    for _ in 0..N {
        let s = Instant::now();
        let _ = decode_note(&blob, &NOTE_UUID, &fixed_wrong, &ITEMS_KEY_ID);
        t_fixed.push(s.elapsed().as_nanos());

        let rk = rng.next_key();
        let s = Instant::now();
        let _ = decode_note(&blob, &NOTE_UUID, &rk, &ITEMS_KEY_ID);
        t_random.push(s.elapsed().as_nanos());
    }

    let a = crop_high(t_fixed, 0.05);
    let b = crop_high(t_random, 0.05);
    let t = welch_t(&a, &b);
    eprintln!(
        "[dudect] Welch t = {t:.2}  (|t| < 4.5 ⇒ no first-order leak; a real leak is t >> 50)"
    );

    // A genuine key-dependent branch yields |t| in the hundreds at this N;
    // scheduler noise stays well under 10. Generous bound = non-flaky yet
    // still catches any real leak.
    assert!(
        t.abs() < 10.0,
        "TIMING LEAK: decode time depends on key bytes (Welch t = {t:.2})"
    );
}
