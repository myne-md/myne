// SPDX-License-Identifier: AGPL-3.0-or-later
//! Offensive red-team round 2 — type/role confusion, the nonce-reuse
//! catastrophe proof, and Damm-32 residual error rate.
//!
//! Run visibly for the printed measurements:
//!   cargo test -p protocol --test crypto_attacks_confusion -- --nocapture --test-threads=1

use protocol::{
    decode_note, decode_prefs_blob, decode_search_index_blob, encode_attachment_blob,
    encode_new_note, encode_new_note_blob_raw, generate_account_number, parse_account_number,
    parse_vault_meta,
};

const ITEMS_KEY: [u8; 32] = [0x07; 32];
const ITEMS_KEY_ID: [u8; 16] = [0xAB; 16];
const UUID: [u8; 16] = [0xCD; 16];
const HASH: [u8; 16] = [0x22; 16];

// ───────────────────────── Cross-type magic confusion ─────────────────────

/// Feed each container type to the WRONG decoder. Distinct magic bytes
/// (MY01/MYV1/MYP1/MYS1/MYA1) must make every cross-type decode fail — a
/// note must never be parsed as a vault.meta, etc. (type-confusion guard).
#[test]
fn round2_cross_type_decode_is_rejected() {
    let note = encode_new_note(&ITEMS_KEY, &ITEMS_KEY_ID, &UUID, b"hello").unwrap();
    let att = encode_attachment_blob(&ITEMS_KEY, &ITEMS_KEY_ID, &[0x33; 32], b"image/png", b"img")
        .unwrap();

    // A note blob fed to foreign decoders.
    assert!(
        parse_vault_meta(&note).is_err(),
        "note accepted as vault.meta"
    );
    assert!(
        decode_prefs_blob(&ITEMS_KEY, &HASH, &note).is_err(),
        "note accepted as prefs"
    );
    assert!(
        decode_search_index_blob(&ITEMS_KEY, &HASH, &note).is_err(),
        "note accepted as search"
    );

    // An attachment blob fed to foreign decoders.
    assert!(
        parse_vault_meta(&att).is_err(),
        "attachment accepted as vault.meta"
    );
    assert!(
        decode_note(&att, &UUID, &ITEMS_KEY, &ITEMS_KEY_ID).is_err(),
        "attachment accepted as note"
    );
    assert!(
        decode_prefs_blob(&ITEMS_KEY, &HASH, &att).is_err(),
        "attachment accepted as prefs"
    );

    // A note blob with its magic overwritten to MYV1 must still not parse as
    // a vault.meta (length/structure guards behind the magic).
    let mut spoofed = note.clone();
    spoofed[0..4].copy_from_slice(b"MYV1");
    assert!(
        parse_vault_meta(&spoofed).is_err(),
        "magic-spoofed note accepted as vault.meta"
    );
}

// ───────────────────────── Nonce-reuse catastrophe (proof) ────────────────

/// Demonstrate WHY the `_raw` nonce-uniqueness contract is load-bearing: if a
/// caller reuses (item_key, content_nonce) across two DIFFERENT plaintexts,
/// the XChaCha20 keystream is reused and C1 ⊕ C2 == P1 ⊕ P2 — i.e. the
/// ciphertexts leak the XOR of the plaintexts. This is NOT a bug in the app
/// (the production `encode_new_note` pulls a fresh nonce every time); it is
/// proof that the contract the crate documents is real and must be honored.
#[test]
fn round2_nonce_reuse_leaks_plaintext_xor() {
    use protocol::blob::OFFSET_CIPHERTEXT;

    // Same key + same nonces, two different equal-length plaintexts.
    let item_key = [0x5A; 32];
    let item_key_nonce = [0x01; 24];
    let content_nonce = [0x02; 24]; // REUSED — the contract violation
    let full1 = b"attack at dawn!! the password is hunter2 ........";
    let full2 = b"retreat at dusk! the launch slips to next month.....";
    let l = full1.len().min(full2.len());
    let p1 = &full1[..l];
    let p2 = &full2[..l];

    let b1 = encode_new_note_blob_raw(
        &ITEMS_KEY,
        &ITEMS_KEY_ID,
        &UUID,
        &item_key,
        &item_key_nonce,
        &content_nonce,
        p1,
    )
    .unwrap();
    let b2 = encode_new_note_blob_raw(
        &ITEMS_KEY,
        &ITEMS_KEY_ID,
        &UUID,
        &item_key,
        &item_key_nonce,
        &content_nonce,
        p2,
    )
    .unwrap();

    let c1 = &b1[OFFSET_CIPHERTEXT..OFFSET_CIPHERTEXT + l];
    let c2 = &b2[OFFSET_CIPHERTEXT..OFFSET_CIPHERTEXT + l];

    // Keystream cancels: C1 ⊕ C2 must equal P1 ⊕ P2.
    let leaked: Vec<u8> = c1.iter().zip(c2).map(|(a, b)| a ^ b).collect();
    let expected: Vec<u8> = p1.iter().zip(p2).map(|(a, b)| a ^ b).collect();
    assert_eq!(leaked, expected, "keystream did NOT cancel — unexpected");

    // And recovering P2 from P1 (known-plaintext) is then trivial:
    let recovered: Vec<u8> = leaked.iter().zip(p1).map(|(x, a)| x ^ a).collect();
    assert_eq!(recovered.as_slice(), p2, "known-plaintext recovery failed");
    eprintln!(
        "[nonce-reuse] CONFIRMED: reused nonce leaks P1⊕P2; known-plaintext fully recovers P2"
    );
    eprintln!("              => the `_raw` fresh-nonce contract is genuinely load-bearing.");
}

// ───────────────────────── Damm-32 residual (honest limits) ───────────────

/// Damm-32 GUARANTEES detection of single-char and adjacent-transposition
/// errors (proven elsewhere). It does NOT guarantee detection of arbitrary
/// TWO-character substitutions — those should slip at roughly the chance
/// rate (~1/32). We measure the residual so the guarantee isn't oversold.
#[test]
fn round2_damm32_two_char_error_residual_is_chance_level() {
    const CROCKFORD: &[u8; 32] = b"0123456789ABCDEFGHJKMNPQRSTVWXYZ";
    let mut undetected = 0u32;
    let mut trials = 0u32;
    let mut state: u64 = 0xDEADBEEFCAFEBABE;
    let mut rng = || {
        state ^= state << 13;
        state ^= state >> 7;
        state ^= state << 17;
        state
    };
    for _ in 0..3000 {
        let acct = generate_account_number().unwrap();
        let mut bytes = acct.canonical.to_vec();
        // mutate two DISTINCT positions to two new chars
        let i = (rng() % 20) as usize;
        let mut j = (rng() % 20) as usize;
        if i == j {
            j = (j + 1) % 20;
        }
        let ci = CROCKFORD[(rng() % 32) as usize];
        let cj = CROCKFORD[(rng() % 32) as usize];
        if ci == bytes[i] || cj == bytes[j] {
            continue;
        }
        bytes[i] = ci;
        bytes[j] = cj;
        trials += 1;
        if parse_account_number(&String::from_utf8(bytes).unwrap()).is_ok() {
            undetected += 1;
        }
    }
    let rate = undetected as f64 / trials as f64;
    eprintln!("[Damm-32] two-char error UNDETECTED rate: {undetected}/{trials} = {:.3}% (chance ≈ 3.125%)", rate * 100.0);
    // Honest assertion: two-char errors are only caught at chance level, not
    // guaranteed. Just sanity-bound it (not a security regression gate).
    assert!(
        rate < 0.07,
        "two-char residual unexpectedly high: {rate:.4}"
    );
}
