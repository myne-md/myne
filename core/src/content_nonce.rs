// SPDX-License-Identifier: AGPL-3.0
//! The one decryption-free `content_nonce` reader, shared by every blob family
//! that has one (myne-md/myne#638).
//!
//! Five families read a `content_nonce` out of a cleartext header without
//! decrypting: notes (`MY01`/`NC05`), attachments (`MYA1`/`MYA5`), and the
//! attachments-catalog / prefs / themes singletons (`MYC1`/`MYC5`,
//! `MYP1`/`MYP5`, `MYT1`/`MYT5`). Each does the identical three things: bounds
//! check, compare the first four bytes against the family's magics, copy 24
//! bytes at a fixed offset. `MY?5` keeps the `MY?1` byte layout verbatim
//! (`protocol.md` §10.4.1 clause 6), so the offset is shared across generations
//! by construction.
//!
//! **Why this is a function and not three hand-written copies, and what that
//! does and does not buy.** The signature refuses a zero-generation reader
//! outright (`base` is mandatory). It does NOT make a one-generation reader
//! impossible: `later: &[]` compiles, and that is the myne-md/myne#638 shape.
//! What closes THAT is the layer above, and it is worth naming rather than
//! implying: writing `&[]` means not naming the family's later magic in the
//! file, which `scripts/check-crypto-registries.mjs` rule 5 fails on, and
//! leaving the import behind to dodge the rule is an unused import under
//! `-D warnings`. Three cheap layers rather than one type-level guarantee. Two
//! of the three former hand-written copies could express a one-generation
//! reader with no layer at all, and one of them did.
//! `core/src/attachment_nonce.rs` accepted only `MYA1`, so on a migrated vault
//! it answered `None` for every body, the sync manifest scan came back empty,
//! and no attachment was uploaded or accepted in either direction, with the
//! catalog still syncing so other devices listed names and sizes over nothing.
//! `myne-agents/docs/decisions/protocol/0567` carries the incident and the measurements.
//!
//! A reader that answers `None` never errors: the caller reads it as "not this
//! family, nothing to do". That is why the mistake is silent, and why the fix
//! is a shape rather than a fixed comparison.

use protocol::AEAD_NONCE_LEN;

/// Read a `content_nonce` at `offset` from a cleartext blob header, accepting
/// either generation of one family. `None` when the header is shorter than
/// `offset + AEAD_NONCE_LEN` or its magic is neither of `generations`.
///
/// `base` is the family's v0.1 magic and `later` every generation after it.
/// Pass them from `protocol`'s constants rather than local literals:
/// `scripts/check-crypto-registries.mjs` rule 2 requires the constants and rule
/// 5 requires that a file naming the base names the later ones too.
///
/// **Why base-plus-rest and not a fixed-arity pair.** A `[&[u8; 4]; 2]` stops
/// compiling when a family grows a third generation, and the cheapest repair is
/// to swap one magic out for the new one, which compiles, passes every gate,
/// and silently stops reading the generation that was dropped: myne-md/myne#638
/// with the generations reversed. Splitting the base out keeps adding a
/// generation an append while still refusing an empty argument list, which
/// would answer `None` for every header of every family.
///
/// The honest limit, stated because the alternative is a comment that promises
/// more than the type does: `later: &[]` is legal here, and the pair form made
/// a one-generation call visibly absurd (you had to pass the same constant
/// twice). That property is not in the type any more, and the sentence that
/// used to say rule 5 and the unused-import lint carry it was pointing at a
/// layer pointing back here. Neither forces `base` to be the family's OLDEST
/// generation: rule 5 fires only when the base magic is named in the file, so a
/// reader spelling `MYA5` and `MYA9` and never `MYA1` is invisible to it. What
/// the slice does buy is that adding a generation is an append to `later` and a
/// zero-generation reader is a signature error. Whether `base` is the oldest is
/// unguarded, and it is written down here rather than delegated.
pub fn content_nonce_at(
    header: &[u8],
    offset: usize,
    base: &[u8; 4],
    later: &[&[u8; 4]],
) -> Option<[u8; AEAD_NONCE_LEN]> {
    let end = offset + AEAD_NONCE_LEN;
    if header.len() < end {
        return None;
    }
    if header[0..4] != *base && !later.iter().any(|m| header[0..4] == **m) {
        return None;
    }
    let mut nonce = [0u8; AEAD_NONCE_LEN];
    nonce.copy_from_slice(&header[offset..end]);
    Some(nonce)
}

#[cfg(test)]
mod tests {
    use super::*;

    const A: [u8; 4] = *b"AAA1";
    const B: [u8; 4] = *b"AAA5";

    fn header(magic: &[u8; 4], offset: usize, fill: u8) -> Vec<u8> {
        let mut h = vec![0u8; offset + AEAD_NONCE_LEN];
        h[0..4].copy_from_slice(magic);
        h[offset..].fill(fill);
        h
    }

    #[test]
    fn reads_either_generation_at_the_shared_offset() {
        assert_eq!(
            content_nonce_at(&header(&A, 6, 0xAB), 6, &A, &[&B]),
            Some([0xAB; AEAD_NONCE_LEN])
        );
        assert_eq!(
            content_nonce_at(&header(&B, 6, 0xCD), 6, &A, &[&B]),
            Some([0xCD; AEAD_NONCE_LEN])
        );
    }

    #[test]
    fn rejects_a_foreign_magic_and_a_short_header() {
        assert_eq!(content_nonce_at(&header(b"NOPE", 6, 1), 6, &A, &[&B]), None);
        let mut short = header(&A, 6, 1);
        short.truncate(6 + AEAD_NONCE_LEN - 1);
        assert_eq!(content_nonce_at(&short, 6, &A, &[&B]), None);
    }

    /// The offset is honoured rather than assumed: the families do not share
    /// one, and a reader that ignored it would read a neighbouring field as a
    /// nonce and report a plausible wrong answer instead of `None`.
    #[test]
    fn the_offset_selects_the_field() {
        let h = header(&A, 112, 0x5A);
        assert_eq!(
            content_nonce_at(&h, 112, &A, &[&B]),
            Some([0x5A; AEAD_NONCE_LEN])
        );
        assert_eq!(
            content_nonce_at(&h, 6, &A, &[&B]),
            Some([0x00; AEAD_NONCE_LEN])
        );
    }
}
