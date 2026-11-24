// SPDX-License-Identifier: AGPL-3.0-only
//! Offensive red-team: account-number forgery against the Damm-32 check.
//!
//! The 20-char Crockford account number ends in a Damm-32 check character.
//! Its job is to reject typos and forgeries. The Damm guarantee: ALL
//! single-character substitutions AND all adjacent transpositions are
//! detected. Each test mounts those forgeries and requires rejection; an
//! accepted forgery is a break of the identifier's integrity.

use protocol::{generate_account_number, parse_account_number};

const CROCKFORD: &[u8; 32] = b"0123456789ABCDEFGHJKMNPQRSTVWXYZ";

fn canonical_string() -> String {
    let acct = generate_account_number().expect("generate");
    String::from_utf8(acct.canonical.to_vec()).expect("canonical is ASCII")
}

/// Baseline: a freshly generated account number parses in both its display
/// (`MY-…`) and bare canonical forms.
#[test]
fn baseline_generated_account_number_parses() {
    let acct = generate_account_number().expect("generate");
    assert!(
        parse_account_number(&acct.display).is_ok(),
        "display form must parse"
    );
    let canon = String::from_utf8(acct.canonical.to_vec()).unwrap();
    assert!(
        parse_account_number(&canon).is_ok(),
        "canonical form must parse"
    );
}

/// Single-character substitution forgery (exhaustive over many account
/// numbers × all 20 positions × all 31 other alphabet chars). The Damm-32
/// check MUST reject every single-character change — zero may slip through.
#[test]
fn battery7_single_char_substitution_always_rejected() {
    let mut accepted = Vec::new();
    for _ in 0..50 {
        let canon = canonical_string();
        let bytes = canon.as_bytes().to_vec();
        for pos in 0..bytes.len() {
            for &c in CROCKFORD.iter() {
                if c == bytes[pos] {
                    continue;
                }
                let mut forged = bytes.clone();
                forged[pos] = c;
                let s = String::from_utf8(forged).unwrap();
                if parse_account_number(&s).is_ok() {
                    accepted.push(s);
                }
            }
        }
    }
    assert!(
        accepted.is_empty(),
        "DAMM BREAK: {} single-char forgeries accepted, e.g. {:?}",
        accepted.len(),
        accepted.first()
    );
}

/// Adjacent-transposition forgery: swapping two neighbouring distinct
/// characters is the classic error Damm (unlike a plain mod checksum) is
/// designed to catch. MUST be rejected for every adjacent pair.
#[test]
fn battery7_adjacent_transposition_always_rejected() {
    let mut accepted = Vec::new();
    for _ in 0..200 {
        let canon = canonical_string();
        let bytes = canon.as_bytes().to_vec();
        for i in 0..bytes.len() - 1 {
            if bytes[i] == bytes[i + 1] {
                continue; // swap is a no-op
            }
            let mut forged = bytes.clone();
            forged.swap(i, i + 1);
            let s = String::from_utf8(forged).unwrap();
            if parse_account_number(&s).is_ok() {
                accepted.push(s);
            }
        }
    }
    assert!(
        accepted.is_empty(),
        "DAMM TRANSPOSITION BREAK: {} adjacent swaps accepted, e.g. {:?}",
        accepted.len(),
        accepted.first()
    );
}

/// Random forgery rate: a random 20-char Crockford string is valid only if
/// its trailing char happens to be the correct Damm check — i.e. acceptance
/// must hover at ~1/32 (3.125%). A materially higher rate would mean the
/// check is not actually constraining the space. We assert it stays well
/// under 6% over a large sample (and is non-zero, proving some do validate,
/// i.e. the parser isn't trivially rejecting everything).
#[test]
fn battery7_random_string_acceptance_is_about_one_in_32() {
    const N: u32 = 60_000;
    let mut accepted = 0u32;
    // cheap deterministic PRNG (xorshift) so the test is reproducible
    let mut state: u64 = 0x9E3779B97F4A7C15;
    let mut next = || {
        state ^= state << 13;
        state ^= state >> 7;
        state ^= state << 17;
        state
    };
    for _ in 0..N {
        let mut s = String::with_capacity(20);
        for _ in 0..20 {
            let idx = (next() % 32) as usize;
            s.push(CROCKFORD[idx] as char);
        }
        if parse_account_number(&s).is_ok() {
            accepted += 1;
        }
    }
    let rate = accepted as f64 / N as f64;
    eprintln!(
        "[Damm-32] random-string acceptance: {accepted}/{N} = {:.4}% (ideal 3.125%)",
        rate * 100.0
    );
    assert!(
        rate > 0.015 && rate < 0.06,
        "acceptance rate {rate:.4} not ~1/32 — check is not constraining as expected"
    );
}
