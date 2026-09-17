// SPDX-License-Identifier: AGPL-3.0
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
    compute_manifest_hash, decode_manifest, decode_note, encode_manifest, encode_new_note,
    encode_new_note_blob_raw, generate_account_number, head_fingerprint, open_vault_head,
    parse_account_number, vv_dominance, Dominance, ManifestEntry, VaultHead, VvEntry,
    VAULT_HEAD_FORMAT_V1,
};

/// Build a vault head over a fixed set of distinct, ascending device_ids
/// (`[1;16], [2;16], …`) with the given counters — already canonical, so a
/// successful `open_vault_head` round-trips to an identical value.
fn head_with(
    account_number_hash: [u8; 16],
    manifest_hash: [u8; 32],
    seq: u64,
    prev_head_hash: Vec<[u8; 32]>,
    counters: &[u64],
) -> VaultHead {
    let version_vector = counters
        .iter()
        .enumerate()
        .map(|(i, &counter)| VvEntry {
            device_id: [(i as u8) + 1; 16],
            counter,
        })
        .collect();
    VaultHead {
        head_format_version: VAULT_HEAD_FORMAT_V1,
        account_number_hash,
        manifest_hash,
        seq,
        prev_head_hash,
        version_vector,
    }
}

fn vv(counters: &[u64]) -> Vec<VvEntry> {
    counters
        .iter()
        .enumerate()
        .map(|(i, &counter)| VvEntry {
            device_id: [(i as u8) + 1; 16],
            counter,
        })
        .collect()
}

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

proptest! {
    /// LAW (vault head roundtrip): seal then open recovers the head exactly
    /// (canonical inputs), and head_id is stable. (MYND-417, sync-protocol.md §3.)
    #[test]
    fn prop_head_roundtrip(
        root in uniform32(any::<u8>()),
        account in uniform16(any::<u8>()),
        manifest in uniform32(any::<u8>()),
        seq in any::<u64>(),
        nparents in 0usize..=2,
        counters in pvec(any::<u64>(), 1..=4),
    ) {
        let parents: Vec<[u8; 32]> = (0..nparents).map(|i| [(i as u8) + 10; 32]).collect();
        let head = head_with(account, manifest, seq, parents, &counters);
        let sealed = head.seal(&root).unwrap();
        let decoded = open_vault_head(&root, &sealed.record).unwrap();
        prop_assert_eq!(decoded, head);
        // seal is deterministic (no nonce) → identical record + id on re-seal.
        let again = head_with(account, manifest, seq,
            (0..nparents).map(|i| [(i as u8) + 10; 32]).collect(), &counters).seal(&root).unwrap();
        prop_assert_eq!(sealed.record, again.record);
        prop_assert_eq!(sealed.head_id, again.head_id);
    }

    /// LAW (rollback rejection): a candidate VV strictly behind the baseline
    /// (one component decreased, none increased) is a Rollback. (§5.3.)
    #[test]
    fn prop_head_rollback_rejected(
        counters in pvec(1u64..=1_000_000, 1..=4),
        idx in 0usize..4,
        dec in 1u64..=1000,
    ) {
        let i = idx % counters.len();
        let base = vv(&counters);
        let mut cand = counters.clone();
        let d = dec.min(cand[i]); // stay ≥ 0, ensure a real decrease
        prop_assume!(d >= 1);
        cand[i] -= d;
        let cand = vv(&cand);
        prop_assert_eq!(vv_dominance(&base, &cand), Dominance::Rollback);
    }

    /// LAW (fork incomparability): one component up AND another down ⇒
    /// Incomparable (concurrent → author a merge), never a clean Extension. (§5.3.)
    #[test]
    fn prop_head_fork_incomparable(
        counters in pvec(1u64..=1_000_000, 2..=4),
    ) {
        let base = vv(&counters);
        let mut cand = counters.clone();
        cand[0] += 1;          // first device advances
        cand[1] -= 1;          // second device regresses (≥1 by strategy)
        let cand = vv(&cand);
        prop_assert_eq!(vv_dominance(&base, &cand), Dominance::Incomparable);
    }

    /// LAW (extension): a candidate ≥ baseline componentwise is never a Rollback. (§5.3.)
    #[test]
    fn prop_head_extension_never_rollback(
        counters in pvec(0u64..=1_000_000, 1..=4),
        bumps in pvec(0u64..=1000, 1..=4),
    ) {
        let base = vv(&counters);
        let cand: Vec<u64> = counters.iter().zip(bumps.iter().cycle())
            .map(|(c, b)| c.saturating_add(*b)).collect();
        let cand = vv(&cand);
        prop_assert_ne!(vv_dominance(&base, &cand), Dominance::Rollback);
    }

    /// LAW (MAC integrity): any single-byte flip in a sealed record is rejected. (§5.2.)
    #[test]
    fn prop_head_single_byte_tamper_rejected(
        root in uniform32(any::<u8>()),
        account in uniform16(any::<u8>()),
        manifest in uniform32(any::<u8>()),
        seq in any::<u64>(),
        counters in pvec(any::<u64>(), 1..=4),
        pos in any::<Index>(),
        mask in 1u8..=255,
    ) {
        let head = head_with(account, manifest, seq, Vec::new(), &counters);
        let mut sealed = head.seal(&root).unwrap();
        let i = pos.index(sealed.record.len());
        sealed.record[i] ^= mask;
        prop_assert!(open_vault_head(&root, &sealed.record).is_err());
    }

    /// LAW (key binding): a record sealed under one root_key never opens under
    /// any other. (§5.2.)
    #[test]
    fn prop_head_wrong_root_key_rejected(
        root in uniform32(any::<u8>()),
        other in uniform32(any::<u8>()),
        account in uniform16(any::<u8>()),
        manifest in uniform32(any::<u8>()),
        counters in pvec(any::<u64>(), 1..=4),
    ) {
        prop_assume!(root != other);
        let sealed = head_with(account, manifest, 1, Vec::new(), &counters).seal(&root).unwrap();
        prop_assert!(open_vault_head(&other, &sealed.record).is_err());
    }
}

/// Build a manifest from (id, content_nonce) byte fills. ids are made distinct
/// by index so the duplicate-id guard never trips spuriously.
fn manifest_entries(specs: &[(u8, u8)]) -> Vec<ManifestEntry> {
    specs
        .iter()
        .enumerate()
        .map(|(i, &(_id, nonce))| ManifestEntry {
            id: [(i as u8).wrapping_add(1); 16],
            content_nonce: [nonce; 24],
        })
        .collect()
}

proptest! {
    /// Manifest encoding is deterministic and independent of input order: any
    /// permutation of the same entry set produces byte-identical output and the
    /// same `manifest_hash` (§4.2 — the head must commit a canonical value).
    #[test]
    fn prop_manifest_encoding_order_independent(
        nonces in pvec(any::<u8>(), 1..=8),
        perm in any::<Index>(),
    ) {
        let specs: Vec<(u8, u8)> = nonces.iter().map(|&n| (0u8, n)).collect();
        let entries = manifest_entries(&specs);
        let mut shuffled = entries.clone();
        // Rotate by a sampled amount to get a non-trivial permutation.
        let n = shuffled.len().max(1);
        let k = perm.index(n);
        shuffled.rotate_left(k % n);

        prop_assert_eq!(encode_manifest(&entries).unwrap(), encode_manifest(&shuffled).unwrap());
        prop_assert_eq!(
            compute_manifest_hash(&entries).unwrap(),
            compute_manifest_hash(&shuffled).unwrap()
        );
    }

    /// Encode→decode round-trips to the canonical (sorted) entry set.
    #[test]
    fn prop_manifest_roundtrip(
        nonces in pvec(any::<u8>(), 0..=8),
    ) {
        let specs: Vec<(u8, u8)> = nonces.iter().map(|&n| (0u8, n)).collect();
        let mut entries = manifest_entries(&specs);
        let bytes = encode_manifest(&entries).unwrap();
        let decoded = decode_manifest(&bytes).unwrap();
        entries.sort_unstable_by_key(|e| e.id);
        prop_assert_eq!(decoded, entries);
    }

    /// Any single-byte tamper of canonical manifest bytes either fails to decode
    /// or decodes to a different entry set — the hash the head commits is never
    /// silently satisfied by altered bytes.
    #[test]
    fn prop_manifest_tamper_detectable(
        nonces in pvec(any::<u8>(), 1..=6),
        idx in any::<Index>(),
        xor in 1u8..=255,
    ) {
        let specs: Vec<(u8, u8)> = nonces.iter().map(|&n| (0u8, n)).collect();
        let entries = manifest_entries(&specs);
        let bytes = encode_manifest(&entries).unwrap();
        let pos = idx.index(bytes.len());
        let mut tampered = bytes.clone();
        tampered[pos] ^= xor;
        match decode_manifest(&tampered) {
            Err(_) => {}
            Ok(decoded) => prop_assert_ne!(decoded, entries),
        }
    }
}

proptest! {
    /// The SAS fingerprint is a deterministic function of head_id (SYNC-17,
    /// §6.3): the same head_id always yields the same fingerprint.
    #[test]
    fn prop_head_fingerprint_deterministic(id in uniform32(any::<u8>())) {
        prop_assert_eq!(head_fingerprint(&id), head_fingerprint(&id));
        // Always the XXXX-XXXX shape (9 chars, dash at index 4).
        let fp = head_fingerprint(&id);
        prop_assert_eq!(fp.len(), 9);
        prop_assert_eq!(fp.as_bytes()[4], b'-');
    }

    /// Distinct head_ids overwhelmingly give distinct fingerprints (40-bit SAS;
    /// a collision is ~1 in 10^12, far below proptest's case count).
    #[test]
    fn prop_head_fingerprint_distinct(
        a in uniform32(any::<u8>()),
        b in uniform32(any::<u8>()),
    ) {
        prop_assume!(a != b);
        prop_assert_ne!(head_fingerprint(&a), head_fingerprint(&b));
    }
}

// ── Person-keypair PQ hybrid (myne-md/myne#698) ────────────────────────────
//
// The compensating control for shipping unaudited ML-KEM/ML-DSA is that the
// wrap/sign laws are exercised as universal properties, not only by example
// round-trips. A wrong implementation fails these; a self-consistent one that
// is wrong in the same way twice does not, which is what the cross-impl
// `person-identity` vectors cover in the other direction.

use protocol::person_key::{
    PersonKeyPair, PersonPublicHalf, PERSON_DK_SEED_LEN, PERSON_ED25519_SEED_LEN,
    PERSON_MLDSA_SEED_LEN,
};

struct PropRng(u64);
impl rand_core::TryRng for PropRng {
    type Error = core::convert::Infallible;
    fn try_next_u32(&mut self) -> Result<u32, Self::Error> {
        Ok(0)
    }
    fn try_next_u64(&mut self) -> Result<u64, Self::Error> {
        Ok(0)
    }
    fn try_fill_bytes(&mut self, dst: &mut [u8]) -> Result<(), Self::Error> {
        let ctr = self.0.wrapping_add(1);
        self.0 = ctr;
        let mut x = ctr;
        for b in dst.iter_mut() {
            x = x
                .wrapping_mul(6364136223846793005)
                .wrapping_add(1442695040888963407);
            *b = (x >> 33) as u8;
        }
        Ok(())
    }
}
impl rand_core::TryCryptoRng for PropRng {}

fn pair_from(material: &[u8]) -> PersonKeyPair {
    let mut kem = [0u8; PERSON_DK_SEED_LEN];
    let mut ed = [0u8; PERSON_ED25519_SEED_LEN];
    let mut ml = [0u8; PERSON_MLDSA_SEED_LEN];
    for (i, b) in material.iter().enumerate() {
        kem[i % PERSON_DK_SEED_LEN] ^= b;
        ed[i % PERSON_ED25519_SEED_LEN] ^= b.rotate_left(1);
        ml[i % PERSON_MLDSA_SEED_LEN] ^= b.rotate_left(2);
    }
    PersonKeyPair::generate_raw(&kem, &ed, &ml)
}

proptest! {
    /// The fingerprint is a deterministic function of the three public halves:
    /// the same seeds always fingerprint identically, and any change to a seed
    /// changes it.
    #[test]
    fn prop_person_fingerprint_deterministic_and_sensitive(
        a in pvec(any::<u8>(), 8),
        b in pvec(any::<u8>(), 8),
    ) {
        let ka = pair_from(&a);
        let kb = pair_from(&a);
        prop_assert_eq!(ka.fingerprint(), kb.fingerprint());
        prop_assume!(a != b);
        let fa = pair_from(&a);
        let fb = pair_from(&b);
        prop_assert_ne!(fa.fingerprint(), fb.fingerprint());
    }

    /// The PQ-hybrid wrap round-trips: a key wrapped to a member's public half
    /// opens under that member's private half, and a DIFFERENT member cannot
    /// open it.
    #[test]
    fn prop_person_wrap_round_trips_and_excludes_others(
        owner in pvec(any::<u8>(), 8),
        member in pvec(any::<u8>(), 8),
        other in pvec(any::<u8>(), 8),
        key in uniform32(any::<u8>()),
        acct in uniform16(any::<u8>()),
    ) {
        prop_assume!(member != other);
        let member_pair = pair_from(&member);
        let other_pair = pair_from(&other);
        let _ = owner;
        let mut rng = PropRng(0);
        let wrapped = member_pair
            .public_half()
            .wrap_key(&key, &acct, &mut rng)
            .expect("wrap to a valid half");
        let opened = member_pair.unwrap_key(&wrapped, &acct).expect("member opens");
        prop_assert_eq!(*opened, key);
        // The wrong member, and the wrong vault hash, both fail closed.
        prop_assert!(other_pair.unwrap_key(&wrapped, &acct).is_err());
        let mut wrong_acct = acct;
        wrong_acct[0] ^= 0x01;
        prop_assert!(member_pair.unwrap_key(&wrapped, &wrong_acct).is_err());
    }

    /// Both signature halves verify over the signed message, and a tampered
    /// message (or signature) fails. `verify` requires BOTH halves, so the
    /// hybrid is SUF-CMA by independence rather than by a composite.
    #[test]
    fn prop_person_sign_verifies_and_rejects_tamper(
        who in pvec(any::<u8>(), 8),
        msg in pvec(any::<u8>(), 32),
    ) {
        let pair = pair_from(&who);
        let mut rng = PropRng(7);
        let signed = pair.sign(&msg, &mut rng).expect("sign");
        pair.public_half().verify(&msg, &signed).expect("valid signature verifies");

        if !msg.is_empty() {
            let mut tampered = msg.clone();
            tampered[0] ^= 0x01;
            prop_assert!(pair.public_half().verify(&tampered, &signed).is_err());
        }
        let mut bad = signed.clone();
        bad.ed25519_sig[0] ^= 0x01;
        prop_assert!(pair.public_half().verify(&msg, &bad).is_err());
    }

    /// A public half rebuilt from its hex parts fingerprints identically, so
    /// the SAS value a roster pins and the value an invite computes agree.
    #[test]
    fn prop_person_public_half_hex_round_trips(material in pvec(any::<u8>(), 8)) {
        let pair = pair_from(&material);
        let half: &PersonPublicHalf = &pair.public_half();
        let hex = |b: &[u8]| b.iter().map(|x| format!("{x:02x}")).collect::<String>();
        let rebuilt = PersonPublicHalf::from_parts_hex(
            &hex(half.kem_ek()),
            &hex(half.ed_pk()),
            &hex(half.mldsa_vk()),
        )
        .expect("valid hex round-trips");
        prop_assert_eq!(rebuilt.fingerprint(), half.fingerprint());
    }
}
