// SPDX-License-Identifier: AGPL-3.0
//! Native Argon2id reference for the web benchmark (phase3-web-client task 63).
//!
//!   cargo run --release --example bench-kdf -p protocol [runs]
//!
//! Prints one JSON object on stdout so `scripts/bench-web.mjs` can read it
//! without parsing prose:
//!
//!   {"kind":"native","runs":5,"median_ms":412.0,"min_ms":…,"max_ms":…,"params":{…}}
//!
//! # Why this exists as a committed example rather than a throwaway
//!
//! The Phase 0 spike measured the browser against native once, in a scratchpad,
//! and the report's own conclusion is that **the ratio is the transferable
//! number** — 1.13–1.65× wasm-over-native — because absolute milliseconds are a
//! property of the machine. A ratio needs both halves measured on the SAME
//! machine, in the same session, or it is two unrelated numbers divided by each
//! other. So the native half has to be re-runnable too.
//!
//! # `--release` is not optional
//!
//! A debug Argon2id at `m=256 MiB, t=3, p=2` runs tens of seconds and would put
//! the ratio off by an order of magnitude in the flattering direction. The
//! harness refuses to report a ratio from a debug build (`debug_assertions`).

use protocol::{derive_password_wrap_key, DEFAULT_V0_1_KDF_PARAMS};
use std::time::Instant;

fn main() {
    if cfg!(debug_assertions) {
        eprintln!(
            "bench-kdf: refusing to run under a debug build — the numbers would be \
             meaningless. Use `cargo run --release --example bench-kdf -p protocol`."
        );
        std::process::exit(2);
    }

    let runs: usize = std::env::args()
        .nth(1)
        .and_then(|a| a.parse().ok())
        .unwrap_or(5);

    // Fixed inputs: the benchmark measures the KDF, not the CSPRNG, and a fixed
    // salt keeps two runs on the same machine comparable.
    let salt = [0x11u8; 16];
    let account_hash = [0x22u8; 16];
    let password = "benchmark-password-not-a-credential";

    // One warm-up, discarded. The first Argon2id allocation of 256 MiB is a
    // page-fault storm that measures the allocator rather than the KDF, and the
    // browser side gets the same treatment.
    let _ = derive_password_wrap_key(password, &salt, &account_hash, &DEFAULT_V0_1_KDF_PARAMS)
        .expect("warm-up derive");

    let mut samples = Vec::with_capacity(runs);
    for _ in 0..runs {
        let t0 = Instant::now();
        let key =
            derive_password_wrap_key(password, &salt, &account_hash, &DEFAULT_V0_1_KDF_PARAMS)
                .expect("derive");
        let ms = t0.elapsed().as_secs_f64() * 1000.0;
        // Consume the key so the optimiser cannot elide the derivation.
        std::hint::black_box(&key);
        samples.push(ms);
    }

    samples.sort_by(|a, b| a.partial_cmp(b).expect("no NaN from a duration"));
    let median = samples[samples.len() / 2];

    println!(
        r#"{{"kind":"native","runs":{},"median_ms":{:.1},"min_ms":{:.1},"max_ms":{:.1},"params":{{"m_kib":{},"t":{},"p":{}}}}}"#,
        runs,
        median,
        samples[0],
        samples[samples.len() - 1],
        DEFAULT_V0_1_KDF_PARAMS.m_kib,
        DEFAULT_V0_1_KDF_PARAMS.t,
        DEFAULT_V0_1_KDF_PARAMS.p,
    );
}
