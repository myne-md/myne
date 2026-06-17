// SPDX-License-Identifier: AGPL-3.0-or-later
//! Offensive KDF red-team: demonstrate and QUANTIFY the missing Argon2id
//! minimum-strength floor (the one defense-in-depth finding from the crypto
//! review). Run with output visible:
//!
//!   cargo test -p protocol --test crypto_attacks_kdf -- --nocapture --test-threads=1
//!
//! These print measurements; the assertions document the CURRENT behavior so
//! the file flips loudly once a floor lands.

use std::time::Instant;

use protocol::{
    derive_password_wrap_key, parse_kdf_params, validate_kdf_params, KdfParams,
    DEFAULT_V0_1_KDF_PARAMS,
};

const SALT: [u8; 16] = [0x11; 16];
const ACCT: [u8; 16] = [0x22; 16];

/// The absolute floor the argon2 crate itself permits (RFC 9106 min: m >= 8*p).
const WEAK: KdfParams = KdfParams {
    m_kib: 8, // 8 KiB instead of 256 MiB  → 32768x less memory
    t: 1,     // 1 pass instead of 3
    p: 1,
    argon2_version: 0x13,
};

/// FIX VERIFIED (floor): a hand-crafted vault.meta KDF block declaring
/// brute-forceable params (8 KiB / t=1) still PARSES (the encoding layer
/// stays permissive for test vectors), but `validate_kdf_params` — the gate
/// the unlock/recover/quick-unlock paths now call before Argon2id — REJECTS
/// it. This closes the floor facet of the downgrade finding.
#[test]
fn floor_rejects_brute_forceable_params() {
    // kdf_id=0x01, m_kib=8 (0x00000008), t=1 (0x00000001), p=1, version=0x13
    let weak_block: [u8; 11] = [0x01, 0, 0, 0, 8, 0, 0, 0, 1, 1, 0x13];
    let parsed = parse_kdf_params(&weak_block).expect("encoding layer still parses");
    assert_eq!(
        parsed.m_kib, 8,
        "parser remains permissive (vectors/fixtures)"
    );
    assert!(
        validate_kdf_params(&parsed).is_err(),
        "FLOOR REGRESSION: brute-forceable m=8 KiB accepted by validate_kdf_params"
    );
    // The default production params must of course pass the gate.
    assert!(validate_kdf_params(&DEFAULT_V0_1_KDF_PARAMS).is_ok());
}

/// Quantify the downgrade: how much faster does offline password
/// brute-force run at the weak params vs the v0.1 default?
#[test]
fn measure_brute_force_speedup() {
    // One derive at the production default (256 MiB, t=3, p=2).
    let t0 = Instant::now();
    let _ = derive_password_wrap_key(
        "correct horse battery staple",
        &SALT,
        &ACCT,
        &DEFAULT_V0_1_KDF_PARAMS,
    )
    .expect("default derive");
    let default_secs = t0.elapsed().as_secs_f64();

    // Many derives at the weak params to get a stable rate.
    const ITERS: u32 = 2000;
    let t1 = Instant::now();
    for i in 0..ITERS {
        // vary the password so nothing is cached/optimized away
        let pw = format!("guess-{i}");
        let _ = derive_password_wrap_key(&pw, &SALT, &ACCT, &WEAK).expect("weak derive");
    }
    let weak_secs_per = t1.elapsed().as_secs_f64() / ITERS as f64;

    let default_rate = 1.0 / default_secs; // guesses/sec
    let weak_rate = 1.0 / weak_secs_per;
    let speedup = weak_rate / default_rate;

    // Model: time to grind a 14.3M-entry rockyou-style dictionary on ONE core.
    let dict = 14_300_000.0;
    let dict_default_days = dict / default_rate / 86_400.0;
    let dict_weak_secs = dict / weak_rate;

    eprintln!("\n===== KDF downgrade — offline brute-force model (single core) =====");
    eprintln!("default (256MiB,t3,p2): {default_secs:.4} s/guess  -> {default_rate:8.1} guesses/s");
    eprintln!(
        "weak    (8KiB,t1,p1)  : {:.8} s/guess  -> {weak_rate:10.0} guesses/s",
        weak_secs_per
    );
    eprintln!("downgrade speedup     : {speedup:.0}x faster brute-force");
    eprintln!("rockyou 14.3M dict @ default: {dict_default_days:.1} days/core");
    eprintln!("rockyou 14.3M dict @ weak   : {dict_weak_secs:.1} s/core");
    eprintln!("==================================================================\n");

    // Sanity: the weak params really are dramatically cheaper.
    assert!(
        speedup > 100.0,
        "expected a large downgrade, got {speedup:.0}x"
    );
}

/// MUTATION-HARDENING: pin the exact KDF cost bounds to their intended
/// values. `cargo-mutants` flagged the `8 * 1024` / `4 * 1024 * 1024`
/// arithmetic in the constant definitions as untested — these are security
/// parameters, so an accidental change (typo, bad refactor, a `*`→`+` slip)
/// to either bound is a silent regression that must fail a test.
#[test]
fn kdf_bound_constants_are_pinned() {
    use protocol::{MAX_KDF_M_KIB, MAX_KDF_P, MAX_KDF_T, MIN_KDF_M_KIB, MIN_KDF_P, MIN_KDF_T};
    assert_eq!(MIN_KDF_M_KIB, 8_192, "memory floor must be exactly 8 MiB");
    assert_eq!(
        MAX_KDF_M_KIB, 4_194_304,
        "memory ceiling must be exactly 4 GiB"
    );
    assert_eq!(MIN_KDF_T, 1);
    assert_eq!(MAX_KDF_T, 16);
    assert_eq!(MIN_KDF_P, 1);
    assert_eq!(MAX_KDF_P, 16);
}

/// MUTATION-HARDENING: pin the EXACT accept/reject boundary of
/// `validate_kdf_params` (one step below/at/above each bound), so the
/// comparison operators in the gate are caught if mutated — not just the
/// far-from-boundary extremes the earlier tests exercise.
#[test]
fn kdf_validate_boundaries_are_exact() {
    use protocol::{MAX_KDF_M_KIB, MAX_KDF_P, MAX_KDF_T, MIN_KDF_M_KIB};
    let ok = |m: u32, t: u32, p: u8| {
        validate_kdf_params(&KdfParams {
            m_kib: m,
            t,
            p,
            argon2_version: 0x13,
        })
        .is_ok()
    };
    // memory cost
    assert!(
        ok(MIN_KDF_M_KIB, 3, 2),
        "exactly the floor must be accepted"
    );
    assert!(
        !ok(MIN_KDF_M_KIB - 1, 3, 2),
        "one below the floor must be rejected"
    );
    assert!(
        ok(MAX_KDF_M_KIB, 3, 2),
        "exactly the ceiling must be accepted"
    );
    assert!(
        !ok(MAX_KDF_M_KIB + 1, 3, 2),
        "one above the ceiling must be rejected"
    );
    // time cost
    assert!(!ok(MIN_KDF_M_KIB, 0, 2), "t below min must be rejected");
    assert!(ok(MIN_KDF_M_KIB, MAX_KDF_T, 2), "t at max must be accepted");
    assert!(
        !ok(MIN_KDF_M_KIB, MAX_KDF_T + 1, 2),
        "t above max must be rejected"
    );
    // parallelism
    assert!(!ok(MIN_KDF_M_KIB, 3, 0), "p below min must be rejected");
    assert!(ok(MIN_KDF_M_KIB, 3, MAX_KDF_P), "p at max must be accepted");
    assert!(
        !ok(MIN_KDF_M_KIB, 3, MAX_KDF_P + 1),
        "p above max must be rejected"
    );
}
