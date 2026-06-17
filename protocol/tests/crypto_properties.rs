// SPDX-License-Identifier: AGPL-3.0-or-later
//! Property-based crypto laws (proptest).
//!
//! Where the attack suite asserts "THIS crafted input is rejected", these
//! assert UNIVERSAL LAWS over thousands of generated inputs — and shrink any
//! counterexample to its minimal form. They run the real primitives (no
//! symbolic limits), complementing the example-based tests and mutation
//! testing. A failure here is a violated invariant, not a missed attack.

use proptest::array::{uniform16, uniform24, uniform32};
use proptest::collection::vec as pvec;
use proptest::prelude::*;
use proptest::sample::Index;

use protocol::{
    decode_note, encode_new_note, encode_new_note_blob_raw, generate_account_number,
    parse_account_number,
};

proptest! {
    /// LAW (roundtrip): for ALL plaintext/keys/ids, decode∘encode = identity.
    #[test]
    fn prop_note_roundtrips(
        key in uniform32(any::<u8>()),
        id in uniform16(any::<u8>()),
        uuid in uniform16(any::<u8>()),
        pt in pvec(any::<u8>(), 0..2048),
    ) {
        let blob = encode_new_note(&key, &id, &uuid, &pt).unwrap();
        let note = decode_note(&blob, &uuid, &key, &id).unwrap();
        prop_assert_eq!(note.plaintext(), &pt[..]);
    }

    /// LAW (confidentiality): a blob sealed under one items_key never opens
    /// under any other key.
    #[test]
    fn prop_wrong_key_never_decrypts(
        key in uniform32(any::<u8>()),
        other in uniform32(any::<u8>()),
        id in uniform16(any::<u8>()),
        uuid in uniform16(any::<u8>()),
        pt in pvec(any::<u8>(), 0..512),
    ) {
        prop_assume!(key != other);
        let blob = encode_new_note(&key, &id, &uuid, &pt).unwrap();
        prop_assert!(decode_note(&blob, &uuid, &other, &id).is_err());
    }

    /// LAW (binding): a blob never opens under a different note_uuid — the
    /// rename attack, generalized over all uuids.
    #[test]
    fn prop_wrong_uuid_never_decrypts(
        key in uniform32(any::<u8>()),
        id in uniform16(any::<u8>()),
        uuid in uniform16(any::<u8>()),
        other_uuid in uniform16(any::<u8>()),
        pt in pvec(any::<u8>(), 0..512),
    ) {
        prop_assume!(uuid != other_uuid);
        let blob = encode_new_note(&key, &id, &uuid, &pt).unwrap();
        prop_assert!(decode_note(&blob, &other_uuid, &key, &id).is_err());
    }

    /// LAW (integrity): ANY single-byte change to a valid blob is rejected —
    /// generalized over random plaintexts, positions, and bit masks.
    #[test]
    fn prop_single_byte_tamper_rejected(
        key in uniform32(any::<u8>()),
        id in uniform16(any::<u8>()),
        uuid in uniform16(any::<u8>()),
        pt in pvec(any::<u8>(), 0..256),
        pos in any::<Index>(),
        mask in 1u8..=255,
    ) {
        let mut blob = encode_new_note(&key, &id, &uuid, &pt).unwrap();
        let i = pos.index(blob.len());
        blob[i] ^= mask;
        prop_assert!(decode_note(&blob, &uuid, &key, &id).is_err());
    }

    /// LAW (determinism): the `_raw` encoder is a pure function of its inputs
    /// — identical inputs (incl. nonces) ⇒ byte-identical output.
    #[test]
    fn prop_raw_encode_is_deterministic(
        key in uniform32(any::<u8>()),
        id in uniform16(any::<u8>()),
        uuid in uniform16(any::<u8>()),
        item_key in uniform32(any::<u8>()),
        ikn in uniform24(any::<u8>()),
        cn in uniform24(any::<u8>()),
        pt in pvec(any::<u8>(), 0..512),
    ) {
        let a = encode_new_note_blob_raw(&key, &id, &uuid, &item_key, &ikn, &cn, &pt).unwrap();
        let b = encode_new_note_blob_raw(&key, &id, &uuid, &item_key, &ikn, &cn, &pt).unwrap();
        prop_assert_eq!(a, b);
    }

    /// LAW (semantic security): the production encoder pulls fresh randomness,
    /// so encrypting the SAME plaintext twice yields distinct ciphertext —
    /// equal-content notes are not linkable by ciphertext equality.
    #[test]
    fn prop_same_plaintext_distinct_ciphertext(
        key in uniform32(any::<u8>()),
        id in uniform16(any::<u8>()),
        uuid in uniform16(any::<u8>()),
        pt in pvec(any::<u8>(), 1..512),
    ) {
        let a = encode_new_note(&key, &id, &uuid, &pt).unwrap();
        let b = encode_new_note(&key, &id, &uuid, &pt).unwrap();
        prop_assert_ne!(a, b);
    }

    /// LAW (robustness): decode never panics on ANY byte string — it always
    /// returns Ok or Err (the property-test form of the fuzzing invariant).
    #[test]
    fn prop_decode_never_panics_on_arbitrary_bytes(
        key in uniform32(any::<u8>()),
        id in uniform16(any::<u8>()),
        uuid in uniform16(any::<u8>()),
        data in pvec(any::<u8>(), 0..600),
    ) {
        let _ = decode_note(&data, &uuid, &key, &id);
    }

    /// LAW (account number): every generated account number parses in both
    /// its display and bare-canonical forms.
    #[test]
    fn prop_account_number_generate_parses(_n in 0u8..=255) {
        let acct = generate_account_number().unwrap();
        prop_assert!(parse_account_number(&acct.display).is_ok());
        let canon = String::from_utf8(acct.canonical.to_vec()).unwrap();
        prop_assert!(parse_account_number(&canon).is_ok());
    }

    /// LAW (Damm-32): any single-character substitution of a valid account
    /// number is rejected — generalized over all positions and replacements.
    #[test]
    fn prop_account_single_char_mutation_rejected(pos in 0usize..20, repl in 0usize..32) {
        const CROCKFORD: &[u8; 32] = b"0123456789ABCDEFGHJKMNPQRSTVWXYZ";
        let acct = generate_account_number().unwrap();
        let mut bytes = acct.canonical.to_vec();
        let c = CROCKFORD[repl];
        prop_assume!(c != bytes[pos]);
        bytes[pos] = c;
        prop_assert!(parse_account_number(&String::from_utf8(bytes).unwrap()).is_err());
    }
}
