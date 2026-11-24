// SPDX-License-Identifier: AGPL-3.0-only
//! The browser's Argon2id memory ceiling (phase3-web-client task 31).
//!
//! # Why this is its own module rather than a `const` in [`crate::host`]
//!
//! `host` is `wasm32`-gated — it is JS glue — so anything declared there is
//! checked only when the wasm arm is compiled. This number is not glue: it is a
//! **policy decision about what this client refuses to attempt**, and the
//! failure it guards against is one a type checker cannot see. A `1024` written
//! where `1024 * 1024` was meant compiles perfectly and makes the web client
//! refuse *every* vault in existence, including the v0.1 baseline, with a
//! message telling the user to go and use desktop.
//!
//! Host-compiled, so the three bounds below are checked by every build in the
//! repo — including a `cargo check --workspace` from a contributor who never
//! touches web. Same reasoning as `capability`/`outcome`/`dispatch`; see
//! `Cargo.toml`.
//!
//! # What it is not
//!
//! It is **not** a second opinion about what the protocol allows.
//! `protocol::validate_kdf_params` accepts up to `MAX_KDF_M_KIB` (4 GiB) and
//! that constant, along with the 256 MiB v0.1 baseline, is untouched by this
//! module and must stay so: KDF parameters are AAD-bound and read from
//! `vault.meta` (`protocol.md` §4.2), so they can be neither lowered nor
//! renegotiated for a client. A vault refused here is a perfectly valid vault
//! that opens on desktop — which is exactly what the refusal says.

use protocol::{DEFAULT_V0_1_KDF_PARAMS, MAX_KDF_M_KIB, MIN_KDF_M_KIB};

/// The largest Argon2id memory cost the web client will attempt, in KiB.
///
/// **1 GiB**, chosen from measurement rather than from the address space.
/// `protocol.md` §4.1 records the v0.1 baseline of 256 MiB settling at **321
/// MiB** of wasm linear memory in Chrome, Safari and Firefox — the block plus
/// allocator overhead, a ~1.25× factor. 1 GiB of declared cost therefore
/// implies roughly 1.25 GiB resident, which is where a tab starts being
/// reclaimed under memory pressure even though `wasm32`'s hard ceiling is 4 GiB.
///
/// Deliberately **well above** the baseline: this exists to refuse the
/// unopenable, not to second-guess normal vaults. A vault at the baseline, or
/// at 2× or 3× it, opens here unchanged.
pub const MAX_KDF_MEMORY_KIB: u32 = 1024 * 1024;

// ── the three bounds, checked at compile time ────────────────────────────────
//
// `const _: () = assert!(…)` rather than `#[test]`: every input is known to the
// compiler, so a violation is a **build failure**, not a red line in a test run
// somebody has to have chosen to execute. Const assertions carry a static
// message only (no formatting), so each one names its own constant in prose.

/// A ceiling below the protocol's **floor** cannot refuse only unusual vaults —
/// it refuses every legal one, since `MIN_KDF_M_KIB` (8 MiB) is the least a
/// `vault.meta` may declare and still parse. This is the assertion that catches
/// a mistyped literal.
const _: () = assert!(
    MAX_KDF_MEMORY_KIB > MIN_KDF_M_KIB,
    "MAX_KDF_MEMORY_KIB at or below protocol's MIN_KDF_M_KIB (8 MiB) would refuse every legal vault"
);

/// The v0.1 baseline must open in a browser, with the headroom the doc comment
/// above claims. If it does not, the web client cannot open the vaults desktop
/// creates by default — which is every vault — and this is not a capability
/// ceiling, it is an outage.
const _: () = assert!(
    MAX_KDF_MEMORY_KIB >= 3 * DEFAULT_V0_1_KDF_PARAMS.m_kib,
    "MAX_KDF_MEMORY_KIB must clear 3x the v0.1 baseline (256 MiB), per the measured headroom"
);

/// And it must be a real narrowing. A ceiling at or above `MAX_KDF_M_KIB` can
/// never fire — `validate_kdf_params` rejects anything higher first — so the
/// whole refusal path would be dead code that reads as a live guarantee.
const _: () = assert!(
    MAX_KDF_MEMORY_KIB < MAX_KDF_M_KIB,
    "MAX_KDF_MEMORY_KIB at or above protocol's MAX_KDF_M_KIB (4 GiB) is unreachable"
);
