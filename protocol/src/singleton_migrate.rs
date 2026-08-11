// SPDX-License-Identifier: AGPL-3.0
//! Whole-vault migration re-seal of KEK-envelope singletons, v0.1 → v0.2
//! (`spec/protocol.md` §10.4.1, automerge-sync-migration #420).
//!
//! Every single-KEK blob family (`vault.themes` `MYT1`, `vault.dictionary` `MYD1`,
//! and the rebuildable caches) shares the `blob_envelope` framing: a 34-byte
//! header + one AEAD-sealed **opaque** inner plaintext under a `root_key`-derived
//! KEK. Because the inner is opaque, a v0.1→v0.2 re-seal never needs to parse it —
//! it decodes under the old KEK + v0.1 AAD + old magic and re-encodes under the
//! new v0.2 KEK + v0.2 AAD + new magic. This ONE function migrates any such
//! family; the caller supplies the family's magics, its AAD role, format version,
//! and size cap (all of which the family's own codec already owns).
//!
//! The caller derives the two KEKs itself — `derive_subkey(old_root, role)` and
//! `derive_subkey_v0_2(new_root, role)` — so this function chooses no key.
//!
//! **Not covered here:** the two custom-framed real-content families —
//! `vault.prefs` (`MYP1`, hand-rolled canonical-JSON header) and the attachments
//! catalog + blobs (`MYC1`/`MYA1`, a different / three-level layout) — each needs
//! its own re-seal path. This is the generic KEK-envelope leg only.

use crate::aead::{aad_singleton_blob, aad_singleton_blob_v0_2, AEAD_KEY_LEN};
use crate::blob_envelope::{decode_blob_envelope, encode_blob_envelope, EnvelopeError};
use crate::error::ProtocolError;
use alloc::vec::Vec;

/// Collapse an internal [`EnvelopeError`] to the public [`ProtocolError`]. Decode
/// failures (magic / format / AEAD) are non-distinguishing (`AeadFailure`) — for a
/// migration, "this singleton would not re-seal" is one condition; the caller
/// aborts and the `legacy/` snapshot is intact.
fn env_err(e: EnvelopeError) -> ProtocolError {
    match e {
        EnvelopeError::PlaintextTooLarge => ProtocolError::PlaintextTooLarge,
        EnvelopeError::RandomnessUnavailable => ProtocolError::Csprng,
        _ => ProtocolError::AeadFailure,
    }
}

/// Re-seal one KEK-envelope singleton from v0.1 to v0.2 (§10.4.1). Decodes
/// `old_blob` under `old_kek` + the v0.1 AAD for `aad_role` + `old_magic`, then
/// re-encodes the opaque inner under `new_kek` + the v0.2 AAD + `new_magic`. The
/// `format_version` and `max_plaintext_len` are the family's own (carried through
/// unchanged). Returns the new `MY?5`-magic blob.
///
/// Errors: [`ProtocolError::AeadFailure`] if the source does not decode under the
/// old KEK (wrong key / tamper / not that family), [`ProtocolError::PlaintextTooLarge`]
/// if the inner exceeds the cap, [`ProtocolError::Csprng`] if entropy is unavailable.
#[allow(clippy::too_many_arguments)]
pub fn reseal_kek_envelope_v0_2(
    old_blob: &[u8],
    old_kek: &[u8; AEAD_KEY_LEN],
    new_kek: &[u8; AEAD_KEY_LEN],
    old_magic: &[u8; 4],
    new_magic: &[u8; 4],
    format_version: u8,
    aad_role: &[u8],
    account_number_hash: &[u8; 16],
    max_plaintext_len: usize,
) -> Result<Vec<u8>, ProtocolError> {
    let old_aad = aad_singleton_blob(aad_role, account_number_hash);
    let inner = decode_blob_envelope(
        old_kek,
        old_magic,
        format_version,
        &old_aad,
        max_plaintext_len,
        old_blob,
    )
    .map_err(env_err)?;
    let new_aad = aad_singleton_blob_v0_2(aad_role, account_number_hash);
    encode_blob_envelope(
        new_kek,
        new_magic,
        format_version,
        &new_aad,
        max_plaintext_len,
        &inner,
    )
    .map_err(env_err)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::blob_envelope::encode_blob_envelope;

    const OLD_KEK: [u8; 32] = [0x11; 32];
    const NEW_KEK: [u8; 32] = [0x22; 32];
    const ACCT: [u8; 16] = [0x44; 16];
    const OLD_MAGIC: &[u8; 4] = b"MYT1";
    const NEW_MAGIC: &[u8; 4] = b"MYT5";
    const ROLE: &[u8] = b"custom-themes-blob";
    const FMT: u8 = 1;
    const CAP: usize = 64 * 1024;

    fn seal_v0_1(inner: &[u8]) -> Vec<u8> {
        encode_blob_envelope(
            &OLD_KEK,
            OLD_MAGIC,
            FMT,
            &aad_singleton_blob(ROLE, &ACCT),
            CAP,
            inner,
        )
        .expect("seal v0.1")
    }

    #[test]
    fn reseal_round_trips_the_opaque_inner_under_the_new_key() {
        let inner = b"opaque {theme_name -> palette} bytes \x00\x01\xff";
        let v0_1 = seal_v0_1(inner);
        let v0_2 = reseal_kek_envelope_v0_2(
            &v0_1, &OLD_KEK, &NEW_KEK, OLD_MAGIC, NEW_MAGIC, FMT, ROLE, &ACCT, CAP,
        )
        .expect("reseal");

        // The re-sealed blob is the v0.2 family (new magic) and decodes under the
        // NEW KEK + v0.2 AAD to the byte-identical inner.
        assert_eq!(&v0_2[0..4], NEW_MAGIC);
        let got = decode_blob_envelope(
            &NEW_KEK,
            NEW_MAGIC,
            FMT,
            &aad_singleton_blob_v0_2(ROLE, &ACCT),
            CAP,
            &v0_2,
        )
        .expect("decode v0.2");
        assert_eq!(
            got.as_slice(),
            inner,
            "inner survived the re-seal byte-exact"
        );
    }

    #[test]
    fn the_old_key_can_no_longer_read_the_resealed_blob() {
        let v0_1 = seal_v0_1(b"secret settings");
        let v0_2 = reseal_kek_envelope_v0_2(
            &v0_1, &OLD_KEK, &NEW_KEK, OLD_MAGIC, NEW_MAGIC, FMT, ROLE, &ACCT, CAP,
        )
        .expect("reseal");
        // Old KEK + old magic + v0.1 AAD must NOT open the migrated blob.
        assert!(decode_blob_envelope(
            &OLD_KEK,
            OLD_MAGIC,
            FMT,
            &aad_singleton_blob(ROLE, &ACCT),
            CAP,
            &v0_2,
        )
        .is_err());
    }

    #[test]
    fn a_source_that_does_not_decode_under_the_old_key_is_rejected() {
        let v0_1 = seal_v0_1(b"x");
        // Wrong old KEK → AeadFailure, nothing produced.
        assert!(matches!(
            reseal_kek_envelope_v0_2(
                &v0_1,
                &[0x99; 32],
                &NEW_KEK,
                OLD_MAGIC,
                NEW_MAGIC,
                FMT,
                ROLE,
                &ACCT,
                CAP,
            ),
            Err(ProtocolError::AeadFailure)
        ));
    }
}
