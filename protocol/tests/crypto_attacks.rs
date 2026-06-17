// SPDX-License-Identifier: AGPL-3.0-or-later
//! Offensive crypto red-team suite against the MY01 per-note encryption.
//!
//! Each test MOUNTS AN ATTACK and asserts the secure outcome (rejection).
//! A test that fails means an attack SUCCEEDED — i.e. a real break in the
//! note encryption (forgery, replay, key-confusion, or nonce reuse). These
//! double as a permanent regression suite: the encryption may not regress
//! into accepting any of these.
//!
//! Scope: the per-note content path (`encode_new_note` / `decode_note`),
//! which is the AEAD that actually protects note plaintext on disk. KDF
//! downgrade + recovery-phrase attacks live in `crypto_attacks_kdf.rs`
//! (separate, because Argon2id at production cost is slow).

use std::collections::HashSet;

use protocol::{decode_note, encode_new_note, AEAD_NONCE_LEN};

const KEY_LEN: usize = 32;
const ID_LEN: usize = 16;
const UUID_LEN: usize = 16;

// Fixed victim context. The "plaintext" is the secret an attacker wants.
const ITEMS_KEY: [u8; KEY_LEN] = [0x07; KEY_LEN];
const ITEMS_KEY_ID: [u8; ID_LEN] = [0xAB; ID_LEN];
const NOTE_UUID: [u8; UUID_LEN] = [0xCD; UUID_LEN];
const SECRET: &[u8] = b"dear diary: the launch date is real and the password is hunter2";

fn fresh_blob() -> Vec<u8> {
    encode_new_note(&ITEMS_KEY, &ITEMS_KEY_ID, &NOTE_UUID, SECRET).expect("encode")
}

/// Baseline: the legitimate holder decrypts and recovers the exact plaintext.
#[test]
fn baseline_legitimate_decrypt_roundtrips() {
    let blob = fresh_blob();
    let note = decode_note(&blob, &NOTE_UUID, &ITEMS_KEY, &ITEMS_KEY_ID).expect("legit decode");
    assert_eq!(note.plaintext(), SECRET);
}

/// MUTATION-HARDENING: a note at exactly `MAX_PLAINTEXT_LEN` (16 MiB) must
/// round-trip. This pins the decode-side `ciphertext_len` cap at its exact
/// upper boundary. cargo-mutants showed every off-by-one / arithmetic
/// mutation of that cap (blob.rs §9.2 `ciphertext_len > MAX + 32`) survived
/// because no test exercised a maximum-size note; this one fails them all —
/// each mutated cap wrongly rejects the valid maximum.
#[test]
fn baseline_max_size_note_roundtrips_pinning_the_cap() {
    let big = vec![0x61u8; protocol::MAX_PLAINTEXT_LEN];
    let blob = encode_new_note(&ITEMS_KEY, &ITEMS_KEY_ID, &NOTE_UUID, &big).expect("encode max");
    let note = decode_note(&blob, &NOTE_UUID, &ITEMS_KEY, &ITEMS_KEY_ID).expect("decode max");
    assert_eq!(note.plaintext().len(), protocol::MAX_PLAINTEXT_LEN);
    assert_eq!(note.plaintext(), &big[..]);
}

// ───────────────────────── Battery 1: AEAD integrity / forgery ────────────

/// Exhaustive single-byte forgery: flip every byte of the blob, one at a
/// time, and require that EVERY mutation is rejected. A single accepted
/// mutation is a forgery break — it would mean an attacker who can tamper
/// the ciphertext on disk can alter what the user reads.
#[test]
fn battery1_every_single_byte_mutation_is_rejected() {
    let blob = fresh_blob();
    let mut accepted_forgeries = Vec::new();
    for i in 0..blob.len() {
        let mut m = blob.clone();
        m[i] ^= 0xFF; // flip all 8 bits of byte i
        if decode_note(&m, &NOTE_UUID, &ITEMS_KEY, &ITEMS_KEY_ID).is_ok() {
            accepted_forgeries.push(i);
        }
    }
    assert!(
        accepted_forgeries.is_empty(),
        "FORGERY BREAK: mutated bytes still decrypted at offsets {accepted_forgeries:?}"
    );
}

/// Truncation attacks: dropping the tag, dropping one byte, or emptying the
/// blob must all be rejected (no "partial" plaintext recovery).
#[test]
fn battery1_truncation_is_rejected() {
    let blob = fresh_blob();
    let cases: &[&[u8]] = &[
        &blob[..blob.len() - 1],  // drop last byte
        &blob[..blob.len() - 32], // drop the 32-byte commitment tag
        &blob[..blob.len() / 2],  // chop in half
        &[],                      // empty
    ];
    for (n, t) in cases.iter().enumerate() {
        assert!(
            decode_note(t, &NOTE_UUID, &ITEMS_KEY, &ITEMS_KEY_ID).is_err(),
            "truncation case {n} ({} bytes) was accepted",
            t.len()
        );
    }
}

/// Extension / trailing-byte injection must be rejected (strict framing).
#[test]
fn battery1_appended_trailing_bytes_rejected() {
    let mut blob = fresh_blob();
    blob.push(0x00);
    assert!(decode_note(&blob, &NOTE_UUID, &ITEMS_KEY, &ITEMS_KEY_ID).is_err());
}

/// Tag/commitment overwrite: zeroing or randomizing the trailing 32-byte
/// commitment must not produce a valid forgery.
#[test]
fn battery1_commitment_tag_overwrite_rejected() {
    let blob = fresh_blob();
    let n = blob.len();
    let mut zeroed = blob.clone();
    zeroed[n - 32..].fill(0x00);
    let mut ones = blob.clone();
    ones[n - 32..].fill(0xFF);
    assert!(decode_note(&zeroed, &NOTE_UUID, &ITEMS_KEY, &ITEMS_KEY_ID).is_err());
    assert!(decode_note(&ones, &NOTE_UUID, &ITEMS_KEY, &ITEMS_KEY_ID).is_err());
}

// ───────────────────────── Battery 2: cross-context / replay ──────────────

/// Rename attack: a stolen blob decrypted under a DIFFERENT note uuid must
/// fail (note_uuid is AAD-bound). Otherwise an attacker could move/relabel
/// notes inside the vault.
#[test]
fn battery2_rename_to_other_uuid_rejected() {
    let blob = fresh_blob();
    let other_uuid = [0xEE; UUID_LEN];
    assert!(decode_note(&blob, &other_uuid, &ITEMS_KEY, &ITEMS_KEY_ID).is_err());
}

/// Wrong items_key (different vault / different key generation) must fail.
#[test]
fn battery2_wrong_items_key_rejected() {
    let blob = fresh_blob();
    let wrong_key = [0x08; KEY_LEN];
    assert!(decode_note(&blob, &NOTE_UUID, &wrong_key, &ITEMS_KEY_ID).is_err());
}

/// Wrong items_key_id (key-generation confusion) must fail.
#[test]
fn battery2_wrong_items_key_id_rejected() {
    let blob = fresh_blob();
    let wrong_id = [0xAC; ID_LEN];
    assert!(decode_note(&blob, &NOTE_UUID, &ITEMS_KEY, &wrong_id).is_err());
}

/// Splice attack: graft note A's wrapped item_key region into note B's blob.
/// The item_key wrap is AAD-bound to (items_key_id, note_uuid), so a spliced
/// header from a different note must not unwrap.
#[test]
fn battery2_enc_item_key_splice_rejected() {
    let uuid_a = [0x11; UUID_LEN];
    let uuid_b = [0x22; UUID_LEN];
    let blob_a = encode_new_note(&ITEMS_KEY, &ITEMS_KEY_ID, &uuid_a, b"note A").expect("a");
    let mut blob_b = encode_new_note(&ITEMS_KEY, &ITEMS_KEY_ID, &uuid_b, b"note B").expect("b");

    use protocol::blob::{ENC_ITEM_KEY_WRAPPED_LEN, OFFSET_ENC_ITEM_KEY};
    let r = OFFSET_ENC_ITEM_KEY..OFFSET_ENC_ITEM_KEY + ENC_ITEM_KEY_WRAPPED_LEN;
    blob_b[r.clone()].copy_from_slice(&blob_a[r]);

    // Try to open the franken-blob under B's identity and under A's identity.
    assert!(decode_note(&blob_b, &uuid_b, &ITEMS_KEY, &ITEMS_KEY_ID).is_err());
    assert!(decode_note(&blob_b, &uuid_a, &ITEMS_KEY, &ITEMS_KEY_ID).is_err());
}

// ───────────────────────── Battery 3: key commitment ──────────────────────

/// Partitioning-oracle / key-confusion: a blob sealed under one items_key
/// must not open under any other key. We hammer many distinct wrong keys;
/// a committing AEAD lets exactly zero of them through.
#[test]
fn battery3_no_second_key_opens_the_blob() {
    let blob = fresh_blob();
    let mut opened_under_wrong_key = 0u32;
    for i in 0u32..4096 {
        let mut k = [0u8; KEY_LEN];
        k[..4].copy_from_slice(&i.to_le_bytes());
        k[4] = 0x5A; // keep it clearly != ITEMS_KEY
        if decode_note(&blob, &NOTE_UUID, &k, &ITEMS_KEY_ID).is_ok() {
            opened_under_wrong_key += 1;
        }
    }
    assert_eq!(
        opened_under_wrong_key, 0,
        "KEY-COMMITMENT BREAK: {opened_under_wrong_key} wrong keys opened the blob"
    );
}

/// Semantic security smoke: encrypting the SAME plaintext+context twice must
/// yield different ciphertext bytes (fresh item_key + nonces each time), so
/// equal-plaintext notes are not linkable by ciphertext equality.
#[test]
fn battery3_same_plaintext_yields_distinct_ciphertext() {
    let a = fresh_blob();
    let b = fresh_blob();
    assert_ne!(a, b, "deterministic ciphertext: equal notes are linkable");
}

// ───────────────────────── Battery 5: randomness / nonce reuse ────────────

/// Nonce-reuse hunt: generate many real blobs and collect both per-blob
/// nonces (item_key_nonce @22..46, content_nonce @112..136). A single
/// repeat across blobs would be catastrophic for XChaCha20. With 192-bit
/// nonces from the OS CSPRNG, the set must be fully distinct.
#[test]
fn battery5_no_nonce_collisions_across_many_blobs() {
    const N: usize = 20_000;
    let mut seen: HashSet<[u8; AEAD_NONCE_LEN]> = HashSet::with_capacity(N * 2);
    let mut collisions = 0u32;

    use protocol::blob::{OFFSET_CONTENT_NONCE, OFFSET_ITEM_KEY_NONCE};
    for _ in 0..N {
        let blob = fresh_blob();
        let mut ikn = [0u8; AEAD_NONCE_LEN];
        ikn.copy_from_slice(&blob[OFFSET_ITEM_KEY_NONCE..OFFSET_ITEM_KEY_NONCE + AEAD_NONCE_LEN]);
        let mut cn = [0u8; AEAD_NONCE_LEN];
        cn.copy_from_slice(&blob[OFFSET_CONTENT_NONCE..OFFSET_CONTENT_NONCE + AEAD_NONCE_LEN]);
        if !seen.insert(ikn) {
            collisions += 1;
        }
        if !seen.insert(cn) {
            collisions += 1;
        }
    }
    assert_eq!(
        collisions,
        0,
        "NONCE REUSE: {collisions} collisions among {} nonces",
        N * 2
    );
}
