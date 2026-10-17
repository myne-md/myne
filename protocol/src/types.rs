// SPDX-License-Identifier: AGPL-3.0
//! Shared value types and on-disk encodings used across the crate.
//!
//! This module currently hosts:
//! - [`KdfParams`] — the Argon2id parameter set (`docs/spec/protocol.md` § 4).
//! - [`DEFAULT_V0_1_KDF_PARAMS`] — the v0.1 baseline, calibrated for
//!   desktop ≈ 1 s (`design-notes.md` 2026-04-26 KDF entry).
//! - [`serialize_kdf_params`] / [`parse_kdf_params`] — the canonical
//!   11-byte encoding bound into both wrap AADs (`protocol.md` § 4.3).
//!
//! Future tasks fill in the rest of the shared types
//! (`AccountNumber`, `RecoveryPhrase`, `VaultMeta`, `SubkeyRole`).

use crate::error::ProtocolError;
use zeroize::Zeroizing;

/// Which on-disk cryptographic generation a vault is at (`protocol.md` §10.5).
///
/// v0.1 (`MYV1` vault.meta, `MY01` notes, `MY?1` singletons) and v0.2 (`NTV5`
/// or `NTV6`, `NC05`, `MY?5`) domain-separate on three axes: the KEK derivation context
/// (`derive_subkey` vs `derive_subkey_v0_2`), the AEAD AAD prefix
/// (`"myne.v0.1|"` vs `"myne.v0.2|"`), and the blob magics. A migrated vault is
/// wholly v0.2; before migration it is wholly v0.1. Every version-aware
/// reader/writer selects its crypto from this one discriminator — carried on the
/// unlocked slot so a per-call `vault.meta` re-parse is not the source of truth.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MetaVersion {
    /// The v0.1 generation (`MYV1` / `MY01` / `MY?1`).
    V0_1,
    /// The v0.2 crypto generation (`NTV5` or `NTV6` / `NC05` / `MY?5`).
    V0_2,
}

/// Generate a fresh 32-byte `root_key` from the OS CSPRNG.
///
/// Spec § 3.1 mandates that `root_key` be a 32-byte random value
/// (NOT derived from the password) so the recovery flow can rewrap
/// it under a fresh `password_wrap_key` after a password change.
/// Output is `Zeroizing<[u8; 32]>` so the bytes are wiped on drop.
pub fn generate_root_key() -> Result<Zeroizing<[u8; 32]>, ProtocolError> {
    let mut key = Zeroizing::new([0u8; 32]);
    getrandom::getrandom(key.as_mut_slice()).map_err(|_| ProtocolError::Csprng)?;
    Ok(key)
}

/// `kdf_id` magic byte selecting Argon2id.
///
/// `docs/spec/protocol.md` § 9.3: *"0x01 = Argon2id (only value accepted
/// in v0.1)."* Any other value at offset 0 of the canonical block makes
/// the vault unparseable on this version.
const KDF_ID_ARGON2ID: u8 = 0x01;

/// Argon2 algorithm version 1.3.
///
/// `docs/spec/protocol.md` § 9.3: the only `argon2_version` value v0.1
/// vaults may carry. v1.0 (`0x10`) is rejected.
const ARGON2_VERSION_V13: u8 = 0x13;

/// Length of the canonical KDF parameter block (`protocol.md` § 4.3).
///
/// Bound verbatim into both `AAD_password_wrap` and `AAD_recovery_wrap`,
/// so callers wiring the AADs in later tasks must use exactly these
/// 11 bytes — not a re-encoded form.
pub const KDF_PARAMS_CANONICAL_LEN: usize = 11;

/// Argon2id parameter set persisted in `vault.meta` and bound into the
/// wrap AADs.
///
/// Implements `docs/spec/protocol.md` § 4.3 (canonical encoding) and
/// § 9.3 (on-disk layout, offsets 22..33). Wire-format byte widths:
///
/// | Field            | On-disk size | Encoding |
/// |------------------|--------------|----------|
/// | `m_kib`          | 4 bytes      | big-endian `u32` |
/// | `t`              | 4 bytes      | big-endian `u32` |
/// | `p`              | 1 byte       | unsigned `u8`    |
/// | `argon2_version` | 1 byte       | unsigned `u8`    |
///
/// The 1-byte `kdf_id` magic that prefixes the canonical block is
/// implicit (only `0x01 = Argon2id` is accepted in v0.1) and therefore
/// not a struct field — see [`serialize_kdf_params`] / [`parse_kdf_params`].
#[derive(Debug, Copy, Clone, PartialEq, Eq)]
pub struct KdfParams {
    /// Memory cost in KiB. v0.1 baseline = 262_144 (256 MiB).
    pub m_kib: u32,
    /// Iterations. v0.1 baseline = 3.
    pub t: u32,
    /// Parallelism. v0.1 baseline = 2.
    ///
    /// 1 byte on disk (`protocol.md` § 9.3 offset 31). Argon2 RFC 9106
    /// permits up to 2^24 − 1 lanes; v0.1's wire format caps `p` at 255,
    /// which is above any realistic parallelism for vault unlock.
    pub p: u8,
    /// Argon2 algorithm version. v0.1 mandates `0x13` (Argon2 1.3).
    pub argon2_version: u8,
}

/// v0.1 baseline parameters, calibrated for ≈ 1 s on a 2024-class
/// desktop laptop. See `design-notes.md` 2026-04-26 "KDF parameters
/// resolved" for the rationale (256 MiB chosen as the SN004-vs-research
/// middle ground; bound into AADs to defeat parameter-downgrade).
pub const DEFAULT_V0_1_KDF_PARAMS: KdfParams = KdfParams {
    m_kib: 262_144,
    t: 3,
    p: 2,
    argon2_version: ARGON2_VERSION_V13,
};

/// Inclusive lower bound on Argon2id memory cost accepted from an untrusted
/// `vault.meta`. 8 MiB is far below the v0.1 desktop default (256 MiB) — low
/// enough to leave room for a future memory-constrained mobile profile
/// (spec § 4.2.1) — yet ~1000× the absolute argon2 floor, blocking the
/// brute-forceable `m=8 KiB` downgrade. See [`validate_kdf_params`].
pub const MIN_KDF_M_KIB: u32 = 8 * 1024;
/// Inclusive upper bound on Argon2id memory cost. 4 GiB is well above any
/// legitimate profile; its purpose is to stop a tampered `vault.meta` from
/// declaring an absurd `m_kib` (e.g. 4 TiB) that would trigger a
/// multi-terabyte allocation — a pre-auth client OOM/DoS — at unlock time.
pub const MAX_KDF_M_KIB: u32 = 4 * 1024 * 1024;
/// Inclusive bounds on the Argon2id time cost (passes).
pub const MIN_KDF_T: u32 = 1;
/// See [`MIN_KDF_T`].
pub const MAX_KDF_T: u32 = 16;
/// Inclusive bounds on the Argon2id parallelism (lanes).
pub const MIN_KDF_P: u8 = 1;
/// See [`MIN_KDF_P`].
pub const MAX_KDF_P: u8 = 16;

/// Reject KDF cost parameters taken from an untrusted `vault.meta` that fall
/// outside the accepted range, **before** they reach Argon2id.
///
/// `parse_kdf_params` validates only the on-disk encoding (kdf_id +
/// argon2_version); it deliberately leaves `m_kib`/`t`/`p` unbounded so the
/// test-vector and weak-fixture surfaces stay permissive. Clients call this
/// at the derivation site to close two gaps an unbounded params block opens:
///
/// - **Floor** (`m_kib < MIN_KDF_M_KIB`, `t < MIN_KDF_T`): a vault created or
///   coerced to brute-forceable cost. A pure tamper of an existing strong
///   vault is already defeated by the params→AAD binding, but a low floor
///   honoured blindly weakens any vault legitimately created at that cost.
/// - **Ceiling** (`m_kib > MAX_KDF_M_KIB`): a tampered block declaring an
///   unaffordable `m_kib`, which `derive_*` would try to allocate **before**
///   any AEAD check can fire — a pre-auth OOM/DoS. AAD binding does not help
///   here because the allocation precedes tag verification.
///
/// Returns [`ProtocolError::InvalidVaultMeta`] (a structural, non-credential
/// failure) when any parameter is out of range. The default v0.1 params pass.
///
/// Normative source: `docs/spec/protocol.md` § 4.2.1 (accepted cost range).
/// That clause states the floor as a `m_kib × t` area and lets a client enforce
/// a tighter range than the spec minimum; these per-axis bounds are that
/// tighter range, and they sit strictly inside it.
pub fn validate_kdf_params(params: &KdfParams) -> Result<(), ProtocolError> {
    let ok = (MIN_KDF_M_KIB..=MAX_KDF_M_KIB).contains(&params.m_kib)
        && (MIN_KDF_T..=MAX_KDF_T).contains(&params.t)
        && (MIN_KDF_P..=MAX_KDF_P).contains(&params.p);
    if ok {
        Ok(())
    } else {
        Err(ProtocolError::InvalidVaultMeta)
    }
}

/// Encode `params` to its 11-byte canonical form per
/// `docs/spec/protocol.md` § 4.3.
///
/// The output is appended to both `AAD_password_wrap` and
/// `AAD_recovery_wrap` (built in a later task) and persisted at offset
/// 22 of `vault.meta`. Byte-exact correctness is load-bearing —
/// any drift silently invalidates the AEAD tag on both wrapped
/// `root_key` copies.
pub fn serialize_kdf_params(params: &KdfParams) -> [u8; KDF_PARAMS_CANONICAL_LEN] {
    let mut out = [0u8; KDF_PARAMS_CANONICAL_LEN];
    out[0] = KDF_ID_ARGON2ID;
    out[1..5].copy_from_slice(&params.m_kib.to_be_bytes());
    out[5..9].copy_from_slice(&params.t.to_be_bytes());
    out[9] = params.p;
    out[10] = params.argon2_version;
    out
}

/// Parse the 11-byte canonical form into a [`KdfParams`].
///
/// Rejects with [`ProtocolError::InvalidVaultMeta`]:
/// - `bytes[0] != 0x01` (only Argon2id is accepted in v0.1).
/// - `bytes[10] != 0x13` (only Argon2 1.3 is accepted in v0.1).
///
/// Range checks on `m_kib`, `t`, `p` are deferred to the Argon2id call
/// site — this parser only validates the on-disk encoding layer. A
/// `m_kib` value the runtime cannot afford will surface as a downstream
/// `ProtocolError::KdfFailure` rather than a parse-layer error.
pub fn parse_kdf_params(
    bytes: &[u8; KDF_PARAMS_CANONICAL_LEN],
) -> Result<KdfParams, ProtocolError> {
    if bytes[0] != KDF_ID_ARGON2ID {
        return Err(ProtocolError::InvalidVaultMeta);
    }
    if bytes[10] != ARGON2_VERSION_V13 {
        return Err(ProtocolError::InvalidVaultMeta);
    }
    let m_kib = u32::from_be_bytes([bytes[1], bytes[2], bytes[3], bytes[4]]);
    let t = u32::from_be_bytes([bytes[5], bytes[6], bytes[7], bytes[8]]);
    let p = bytes[9];
    let argon2_version = bytes[10];
    Ok(KdfParams {
        m_kib,
        t,
        p,
        argon2_version,
    })
}

#[cfg(test)]
#[cfg_attr(coverage_nightly, coverage(off))]
mod tests {
    use super::*;

    /// Pinned default-encoding bytes. Hand-derived from § 4.3:
    /// - `kdf_id`         = 0x01
    /// - `m_kib = 262144` = 0x00 04 00 00
    /// - `t = 3`          = 0x00 00 00 03
    /// - `p = 2`          = 0x02
    /// - `argon2_version` = 0x13
    const DEFAULT_CANONICAL: [u8; KDF_PARAMS_CANONICAL_LEN] = [
        0x01, 0x00, 0x04, 0x00, 0x00, 0x00, 0x00, 0x00, 0x03, 0x02, 0x13,
    ];

    #[test]
    fn canonical_block_length_is_eleven_bytes() {
        // Spec § 4.3 fixes the block length at 11 bytes; if this constant
        // ever drifts, AAD construction in later tasks silently breaks.
        assert_eq!(KDF_PARAMS_CANONICAL_LEN, 11);
    }

    #[test]
    fn default_v0_1_kdf_params_match_spec_baseline() {
        // Spec § 9.3 baseline values, restated literally so a careless
        // edit to the const definition is caught here, not in production.
        assert_eq!(DEFAULT_V0_1_KDF_PARAMS.m_kib, 262_144);
        assert_eq!(DEFAULT_V0_1_KDF_PARAMS.t, 3);
        assert_eq!(DEFAULT_V0_1_KDF_PARAMS.p, 2);
        assert_eq!(DEFAULT_V0_1_KDF_PARAMS.argon2_version, 0x13);
    }

    #[test]
    fn serialize_default_matches_pinned_hex() {
        // Golden test against the hand-derived byte sequence above.
        assert_eq!(
            serialize_kdf_params(&DEFAULT_V0_1_KDF_PARAMS),
            DEFAULT_CANONICAL
        );
    }

    #[test]
    fn round_trip_default_params() {
        let bytes = serialize_kdf_params(&DEFAULT_V0_1_KDF_PARAMS);
        let parsed = parse_kdf_params(&bytes).expect("default params must parse");
        assert_eq!(parsed, DEFAULT_V0_1_KDF_PARAMS);
    }

    #[test]
    fn round_trip_phase_3_mobile_style_params() {
        // Spec § 4.2 explicitly permits reduced parameters on Phase 3
        // mobile ports. Make sure the encoder/decoder round-trips a
        // realistic mobile baseline (64 MiB, t=2, p=1).
        let mobile = KdfParams {
            m_kib: 65_536,
            t: 2,
            p: 1,
            argon2_version: 0x13,
        };
        let bytes = serialize_kdf_params(&mobile);
        assert_eq!(parse_kdf_params(&bytes).unwrap(), mobile);
    }

    #[test]
    fn round_trip_extreme_params() {
        // u32::MAX m_kib + u32::MAX t + p=255 — encoder/decoder must not
        // truncate or sign-extend any field.
        let extreme = KdfParams {
            m_kib: u32::MAX,
            t: u32::MAX,
            p: u8::MAX,
            argon2_version: 0x13,
        };
        let bytes = serialize_kdf_params(&extreme);
        assert_eq!(parse_kdf_params(&bytes).unwrap(), extreme);
    }

    #[test]
    fn parse_rejects_wrong_kdf_id() {
        let mut bytes = DEFAULT_CANONICAL;
        bytes[0] = 0x02;
        assert_eq!(
            parse_kdf_params(&bytes),
            Err(ProtocolError::InvalidVaultMeta)
        );
    }

    #[test]
    fn parse_rejects_kdf_id_zero() {
        let mut bytes = DEFAULT_CANONICAL;
        bytes[0] = 0x00;
        assert_eq!(
            parse_kdf_params(&bytes),
            Err(ProtocolError::InvalidVaultMeta)
        );
    }

    #[test]
    fn parse_rejects_argon2_v10() {
        // v0.1 mandates Argon2 1.3; the older 1.0 encoding (0x10) must
        // not parse, even though the rest of the block is well-formed.
        let mut bytes = DEFAULT_CANONICAL;
        bytes[10] = 0x10;
        assert_eq!(
            parse_kdf_params(&bytes),
            Err(ProtocolError::InvalidVaultMeta)
        );
    }

    #[test]
    fn parse_rejects_unknown_argon2_version() {
        let mut bytes = DEFAULT_CANONICAL;
        bytes[10] = 0xFF;
        assert_eq!(
            parse_kdf_params(&bytes),
            Err(ProtocolError::InvalidVaultMeta)
        );
    }

    #[test]
    fn flipping_any_byte_changes_the_canonical_form() {
        // Sanity: every byte position is load-bearing (parameter-downgrade
        // defense relies on bound-by-AAD; here we just confirm the encoder
        // is bijective over its inputs).
        let baseline = serialize_kdf_params(&DEFAULT_V0_1_KDF_PARAMS);
        for offset in [1, 2, 3, 4, 5, 6, 7, 8, 9] {
            let mut alt = DEFAULT_V0_1_KDF_PARAMS;
            // Mutate the field that owns this byte offset.
            match offset {
                1..=4 => alt.m_kib = alt.m_kib.wrapping_add(1),
                5..=8 => alt.t = alt.t.wrapping_add(1),
                9 => alt.p = alt.p.wrapping_add(1),
                _ => unreachable!(),
            }
            let mutated = serialize_kdf_params(&alt);
            assert_ne!(
                mutated, baseline,
                "mutation at offset {offset} must produce different bytes"
            );
        }
    }

    #[test]
    fn generate_root_key_is_not_all_zero() {
        // A 32-byte all-zero output would indicate getrandom never wrote into
        // the buffer (the `[0u8; 32]` init). The probability of a genuine
        // all-zero draw is 2^-256, so this reliably catches a no-op CSPRNG.
        let key = generate_root_key().expect("CSPRNG");
        assert_ne!(*key, [0u8; 32]);
    }

    #[test]
    fn generate_root_key_varies_between_calls() {
        // Two independent draws must differ — proves the bytes come from the
        // CSPRNG and are not a fixed buffer. Collision probability is 2^-256.
        let a = generate_root_key().expect("CSPRNG");
        let b = generate_root_key().expect("CSPRNG");
        assert_ne!(*a, *b);
    }
}
