// SPDX-License-Identifier: AGPL-3.0
//! The OPFS bridge's cross-language constants, and the test that keeps them true.
//!
//! `web/src/worker/opfs.ts` classifies every storage failure into a small
//! numeric code, and `opfs.rs` maps those codes back onto
//! [`IoFailureKind`](myne_core::io_failure_kind::IoFailureKind). The duplication
//! is not avoidable — the value crosses the wasm boundary on every failing call,
//! and there is no shared type system across it.
//!
//! What IS avoidable is the duplication going unchecked. The failure it would
//! produce is quiet and bad: renumber one side and a "disk full" starts arriving
//! as "file not found", so a vault whose quota ran out reports itself missing.
//! [`tests`] reads the TypeScript source and fails if the two disagree.
//!
//! Compiled on **every** target, not just wasm32, so `cargo nextest run --workspace`
//! covers it — the wasm-only modules are beyond every gate that runs in
//! `pre-push`.

use myne_core::io_failure_kind::IoFailureKind;

/// The numeric code `opfs.ts` throws, per failure kind.
///
/// The single source of truth on the Rust side; `opfs.rs` matches these and the
/// test below pins them against `IO_KIND` in the TypeScript.
pub const fn code_for(kind: IoFailureKind) -> u8 {
    match kind {
        IoFailureKind::PermissionDenied => 0,
        IoFailureKind::NotFound => 1,
        IoFailureKind::NoSpace => 2,
        IoFailureKind::Other => 3,
    }
}

/// The inverse. Anything unrecognised is [`IoFailureKind::Other`] — a code this
/// build has never heard of is not a storage condition it can act on, and
/// guessing would be worse than the honest catch-all.
pub fn kind_for(code: u8) -> IoFailureKind {
    match code {
        0 => IoFailureKind::PermissionDenied,
        1 => IoFailureKind::NotFound,
        2 => IoFailureKind::NoSpace,
        _ => IoFailureKind::Other,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Every variant, so adding one to `IoFailureKind` fails to compile here
    /// until it is given a code — rather than silently defaulting to `Other`.
    const ALL: [IoFailureKind; 4] = [
        IoFailureKind::PermissionDenied,
        IoFailureKind::NotFound,
        IoFailureKind::NoSpace,
        IoFailureKind::Other,
    ];

    #[test]
    fn codes_round_trip_and_are_distinct() {
        let mut seen = Vec::new();
        for kind in ALL {
            let code = code_for(kind);
            assert!(!seen.contains(&code), "duplicate code {code} for {kind:?}");
            seen.push(code);
            assert_eq!(kind_for(code), kind, "round-trip failed for {kind:?}");
        }
    }

    #[test]
    fn the_kind_mapping_matches_the_typescript_side() {
        // Reads `IO_KIND` out of `opfs.ts` and compares. The failure this
        // prevents: renumber one side and "disk full" arrives as "file not
        // found", so a vault whose quota ran out reports itself as missing.
        let ts = std::fs::read_to_string(
            std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../src/worker/opfs.ts"),
        )
        .expect("opfs.ts must be readable from the crate directory");

        let table = ts
            .split_once("export const IO_KIND = {")
            .expect("IO_KIND table not found — did it move or get renamed?")
            .1
            .split_once("} as const;")
            .expect("IO_KIND table is not terminated as expected")
            .0;

        // A parse that silently found nothing would make this test vacuous,
        // which is the classic failure of a source-scanning check.
        let mut checked = 0;
        for (name, kind) in [
            ("permissionDenied", IoFailureKind::PermissionDenied),
            ("notFound", IoFailureKind::NotFound),
            ("noSpace", IoFailureKind::NoSpace),
            ("other", IoFailureKind::Other),
        ] {
            let line = table
                .lines()
                .find(|l| l.trim_start().starts_with(&format!("{name}:")))
                .unwrap_or_else(|| panic!("{name} missing from IO_KIND in opfs.ts"));
            let value: u8 = line
                .split(':')
                .nth(1)
                .and_then(|v| v.trim().trim_end_matches(',').parse().ok())
                .unwrap_or_else(|| panic!("could not parse a number from: {line}"));
            assert_eq!(
                value,
                code_for(kind),
                "opfs.ts IO_KIND.{name} = {value}, but Rust uses {}",
                code_for(kind)
            );
            checked += 1;
        }
        assert_eq!(checked, ALL.len(), "not every kind was compared");
    }
}
