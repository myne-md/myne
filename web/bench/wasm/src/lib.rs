// SPDX-License-Identifier: AGPL-3.0-only
//! Argon2id timing in the browser, at the v0.1 baseline (phase3-web-client
//! task 63).
//!
//! The browser half of the ratio `protocol.md` §4.1 cites. It runs the SAME
//! `derive_password_wrap_key` the client runs at unlock — not a re-implementation
//! and not a reduced parameter set — because a benchmark that measured anything
//! else would produce a number nobody could act on.
//!
//! Timing is taken on the JS side (`performance.now()` around the call), so this
//! module exposes the work and not a clock: `Instant::now()` panics on wasm32,
//! and threading a time source in here would put a second definition of "how
//! long" next to the one the harness already has.

#[cfg(target_arch = "wasm32")]
use wasm_bindgen::prelude::*;

/// Run one Argon2id derivation at `m=256 MiB, t=3, p=2`.
///
/// Returns the first byte of the derived key so the call cannot be optimised
/// away and so a caller can assert the derivation actually happened — a
/// benchmark whose work can be elided measures the optimiser.
#[cfg_attr(target_arch = "wasm32", wasm_bindgen)]
pub fn bench_argon2id_once() -> u8 {
    // Fixed inputs, matching `protocol/examples/bench-kdf.rs` exactly. The
    // ratio is only meaningful if both halves derive the same thing.
    let salt = [0x11u8; 16];
    let account_hash = [0x22u8; 16];
    let key = protocol::derive_password_wrap_key(
        "benchmark-password-not-a-credential",
        &salt,
        &account_hash,
        &protocol::DEFAULT_V0_1_KDF_PARAMS,
    )
    .expect("derive");
    key[0]
}

/// The parameter set being measured, as JSON, so the harness reports what it
/// ran rather than what it assumed.
#[cfg_attr(target_arch = "wasm32", wasm_bindgen)]
pub fn bench_params_json() -> String {
    let p = protocol::DEFAULT_V0_1_KDF_PARAMS;
    format!(
        r#"{{"m_kib":{},"t":{},"p":{},"argon2_version":{}}}"#,
        p.m_kib, p.t, p.p, p.argon2_version
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The host build derives the same key the browser build does.
    ///
    /// Cheap, and it is the only thing standing between "the benchmark measures
    /// Argon2id" and "the benchmark measures something that compiles".
    #[test]
    fn the_derivation_runs_and_is_deterministic() {
        assert_eq!(bench_argon2id_once(), bench_argon2id_once());
    }

    #[test]
    fn the_reported_params_are_the_v0_1_baseline() {
        let json = bench_params_json();
        assert!(json.contains(r#""m_kib":262144"#), "{json}");
        assert!(json.contains(r#""t":3"#), "{json}");
        assert!(json.contains(r#""p":2"#), "{json}");
    }
}
