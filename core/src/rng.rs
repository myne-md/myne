// SPDX-License-Identifier: AGPL-3.0
//! `OsRng`, the one production RNG adapter for the B2B identity paths
//! (myne-md/myne#698).
//!
//! The protocol crate's person/invite/rekey surfaces take
//! `rand_core::CryptoRng` so their `_raw` callers own entropy and their
//! test vectors use a seeded fixture. Production callers must hand them
//! the OS CSPRNG; this is that hand.
//!
//! **Why an adapter rather than `getrandom::SysRng`.** `myne-core` depends
//! on `getrandom` 0.2 on native and reaches 0.4 only as `uuid`'s transitive
//! backend on wasm32 (pinned by the `getrandom_v04` manifest feature, see
//! `scripts/wasm-csprng-check.sh`). `getrandom` 0.2 predates `rand_core`
//! 0.10's `TryRng` traits, so it cannot be passed directly; this adapter
//! implements them over `getrandom::getrandom`, which is the SAME entropy
//! source on every target (native syscall backend; the `custom` hook the
//! web Worker registers). No new crate enters the graph.
//!
//! `try_next_u32` / `try_next_u64` fill 4 / 8 bytes and read them
//! big-endian: the byte ORDER is arbitrary (the bytes are uniform), but it
//! is fixed so a future test can pin it.

use core::convert::Infallible;
use rand_core::{TryCryptoRng, TryRng};

/// The OS CSPRNG as a `rand_core` 0.10 RNG.
#[derive(Clone, Copy, Debug, Default)]
pub struct OsRng;

impl TryRng for OsRng {
    // `getrandom::getrandom` reports failure through `getrandom::Error`,
    // which is not `Infallible`. Its `Display` carries no secret and no
    // path, so it is safe to surface. Callers that take a FALLIBLE RNG use
    // `OsRng` directly and map `OsRngError` into their own closed enum; the
    // few that need a `CryptoRng` (infallible) bound wrap it in
    // `rand_core::UnwrapErr`, which PANICS on an OS failure, and say so at
    // the call site (an OS CSPRNG failure on a supported platform is not a
    // recoverable state).
    type Error = OsRngError;

    fn try_next_u32(&mut self) -> Result<u32, Self::Error> {
        let mut b = [0u8; 4];
        getrandom::getrandom(&mut b).map_err(|_| OsRngError)?;
        Ok(u32::from_be_bytes(b))
    }

    fn try_next_u64(&mut self) -> Result<u64, Self::Error> {
        let mut b = [0u8; 8];
        getrandom::getrandom(&mut b).map_err(|_| OsRngError)?;
        Ok(u64::from_be_bytes(b))
    }

    fn try_fill_bytes(&mut self, dst: &mut [u8]) -> Result<(), Self::Error> {
        getrandom::getrandom(dst).map_err(|_| OsRngError)
    }
}

impl TryCryptoRng for OsRng {}

/// The OS CSPRNG refused. A fieldless struct rather than wrapping
/// `getrandom::Error`, so nothing about the underlying call can leak into
/// an error value that reaches a page.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct OsRngError;

impl core::fmt::Display for OsRngError {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        f.write_str("os csprng unavailable")
    }
}

impl core::error::Error for OsRngError {}

/// Compile-time reminder that the error type satisfies `TryRng`'s bound
/// (it must implement `core::error::Error`). Kept as a `const _` so it
/// runs on every build rather than only under `cargo test`.
const _: () = {
    fn assert_error<E: core::error::Error>() {}
    let _ = assert_error::<OsRngError>;
    let _ = core::mem::size_of::<Infallible>();
};

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fills_distinct_bytes() {
        let mut a = [0u8; 32];
        let mut b = [0u8; 32];
        OsRng.try_fill_bytes(&mut a).expect("os rng");
        OsRng.try_fill_bytes(&mut b).expect("os rng");
        assert_ne!(a, b, "two draws must differ");
        assert_ne!(a, [0u8; 32], "a draw must not be all zeros");
    }

    #[test]
    fn next_u64_advances_the_stream() {
        let mut rng = OsRng;
        let first = TryRng::try_next_u64(&mut rng).expect("u64");
        let second = TryRng::try_next_u64(&mut rng).expect("u64");
        assert_ne!(first, second);
    }

    #[test]
    fn next_u32_advances_the_stream() {
        let mut rng = OsRng;
        let first = TryRng::try_next_u32(&mut rng).expect("u32");
        let second = TryRng::try_next_u32(&mut rng).expect("u32");
        assert_ne!(first, second);
    }

    #[test]
    fn error_display_carries_no_detail() {
        assert_eq!(OsRngError.to_string(), "os csprng unavailable");
    }
}
