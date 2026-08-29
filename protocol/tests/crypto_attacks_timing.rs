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
//! Every pass also measures its own NOISE FLOOR — a third class running the
//! identical fixed-key workload — because a timing measurement on a machine
//! doing other work is not a weaker measurement, it is an invalid one, and the
//! test previously could not tell the two apart. At a load average of 15-25 it
//! reported `Welch t = -12.05` and failed as `TIMING LEAK`: a false accusation
//! about the crypto, produced by the host. With the control, that same
//! situation reports INCONCLUSIVE and asserts nothing.
//!
//! Run visibly:
//!   cargo test -p protocol --test crypto_attacks_timing -- --nocapture
//!
//! `MYNE_TIMING_STRICT=1` turns INCONCLUSIVE into a failure. Deliberately NOT
//! set anywhere yet: it belongs on a lane that can promise a quiet machine, and
//! this repo does not have one — CI shares a host across three Woodpecker
//! instances, so setting it there would trade a false "leak" for a false
//! "unmeasurable" and flap just the same. Wire it up together with such a lane,
//! not before. Until then a developer can run it by hand on an idle machine and
//! get a real answer, which is more than the old shape offered.

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

/// One measurement pass: the statistic under test, and the NOISE FLOOR measured
/// the same way at the same moment.
struct Measured {
    /// FIXED vs RANDOM key — the security property. Large ⇒ timing depends on
    /// key bytes.
    real: f64,
    /// FIXED vs the SAME FIXED key, a third class interleaved with the other
    /// two. Two identical workloads cannot differ for any reason but noise, so
    /// this is what the machine is contributing. Large ⇒ the host is too noisy
    /// for `real` to mean anything, in EITHER direction.
    control: f64,
}

/// Time `op` over three interleaved classes and return both statistics.
///
/// Two things here are deliberate and were both wrong before:
///
/// * **The random keys are generated up front.** They used to be produced
///   between the two timed regions, so the random class was always preceded by
///   a PRNG round and the fixed class never was — a systematic difference
///   between the classes that has nothing to do with the code under test.
/// * **A third, redundant fixed class rides along.** Without it the test cannot
///   tell a leak from a busy machine, and it resolved that ambiguity by
///   assuming the machine was quiet: at a load average of 15-25 it reported
///   `Welch t = -12.05` and failed as `TIMING LEAK`, which is a false
///   accusation, not a conservative one.
fn measure(n: usize, fixed: &[u8; 32], seed: u64, op: &dyn Fn(&[u8; 32])) -> Measured {
    let mut rng = XorShift(seed);
    let randoms: Vec<[u8; 32]> = (0..n).map(|_| rng.next_key()).collect();
    // THREE arrays of equal size, one per class, and this is the measurement
    // rather than an implementation detail.
    //
    // The earlier version passed `fixed` by reference every iteration: the same
    // 32 bytes, resident in L1 from the first warm-up call onward. The random
    // class read `randoms[i]`, walking a 3.84 MB Vec sequentially, so it paid a
    // cache line on roughly every other iteration that the fixed class never
    // paid. That is a systematic per-iteration cost applied to exactly one of
    // the two classes being compared, and it has nothing whatever to do with
    // whether `decode_note` branches on key bytes.
    //
    // It was not small. Measured on the same machine, same build: `real` sat
    // between 8 and 15 against a bound of 10 while `control` stayed near 2, so
    // the test failed roughly two runs in three, on a binary with no leak in
    // it. Every push paid for it, because `cargo test --workspace` runs in
    // `pre-push`. Giving the fixed class an equally-sized array to walk drops
    // `real` to under 4 in absolute value and leaves `control` where it was.
    //
    // The control gets its OWN array rather than sharing the fixed one, which
    // the intermediate version did and which cost something visible: reading
    // `fixed_a[i]` twice in one iteration makes the second read warm, so the
    // control was then measuring cold-versus-warm and climbed from ~2 to ~4.3.
    // The control is the noise floor of two IDENTICAL workloads, so it has to
    // be identical in every respect including how cold its bytes are. Three
    // arrays is what makes all three classes alike.
    let fixed_a: Vec<[u8; 32]> = (0..n).map(|_| *fixed).collect();
    let fixed_b: Vec<[u8; 32]> = (0..n).map(|_| *fixed).collect();

    // Warm up branch predictors. NOT the data cache for one class only, which
    // is what the old `op(fixed)` warm-up did on top of everything above.
    for i in 0..2000 {
        op(&fixed_a[i % n]);
        op(&randoms[i % n]);
    }

    let mut t_fixed = Vec::with_capacity(n);
    let mut t_random = Vec::with_capacity(n);
    let mut t_control = Vec::with_capacity(n);
    for i in 0..n {
        let s = Instant::now();
        op(&fixed_a[i]);
        t_fixed.push(s.elapsed().as_nanos());

        let s = Instant::now();
        op(&randoms[i]);
        t_random.push(s.elapsed().as_nanos());

        let s = Instant::now();
        op(&fixed_b[i]);
        t_control.push(s.elapsed().as_nanos());
    }

    let a = crop_high(t_fixed, 0.05);
    Measured {
        real: welch_t(&a, &crop_high(t_random, 0.05)),
        control: welch_t(&a, &crop_high(t_control, 0.05)),
    }
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
    const BOUND: f64 = 10.0;
    let fixed_wrong = [0xAAu8; 32]; // FIXED class key (constant)

    let op = |k: &[u8; 32]| {
        let _ = decode_note(&blob, &NOTE_UUID, k, &ITEMS_KEY_ID);
    };

    // Two passes at most: a noisy control is usually a transient (another test
    // binary saturating a core), and doubling the samples is the cheapest way
    // to tell a transient from a genuinely unusable host before giving up.
    let mut m = measure(N, &fixed_wrong, 0x1234_5678_9ABC_DEF0, &op);
    if m.control.abs() >= BOUND {
        eprintln!(
            "[dudect] control t = {:.2} — host too noisy, retrying at 2x samples",
            m.control
        );
        m = measure(N * 2, &fixed_wrong, 0x0FED_CBA9_8765_4321, &op);
    }

    eprintln!(
        "[dudect] real t = {:.2}   control t = {:.2}   (bound |t| < {BOUND})",
        m.real, m.control
    );

    // The control is the licence to interpret `real` AT ALL. Two runs of the
    // identical workload differ only by what the machine did, so a control past
    // the bound means this host cannot resolve the difference the test is
    // looking for — and "cannot measure" is neither "leak" nor "no leak".
    //
    // Inconclusive is therefore NOT a pass and NOT a failure by default: it
    // returns without asserting, loudly. Under MYNE_TIMING_STRICT — the mode a
    // lane that exists to check this property runs in — it fails instead, so
    // "we never actually measured" cannot masquerade as green where the
    // measurement is the whole job. (Same shape as MYNE_VECTORS_REQUIRED.)
    if m.control.abs() >= BOUND {
        let msg = format!(
            "INCONCLUSIVE: the noise floor ({:.2}) is itself past the bound, so the \
             real statistic ({:.2}) says nothing about constant-timeness. Re-run on \
             an idle machine.",
            m.control, m.real
        );
        if std::env::var("MYNE_TIMING_STRICT").is_ok_and(|v| !v.is_empty() && v != "0") {
            panic!("[dudect] {msg}");
        }
        eprintln!("[dudect] {msg}");
        return;
    }

    // Control is clean ⇒ the machine can resolve this, and `real` means what it
    // says. A genuine key-dependent branch yields |t| in the hundreds at this N.
    assert!(
        m.real.abs() < BOUND,
        "TIMING LEAK: decode time depends on key bytes (real t = {:.2}, control t = {:.2})",
        m.real,
        m.control
    );
}
