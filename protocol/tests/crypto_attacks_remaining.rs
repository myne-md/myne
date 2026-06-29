// SPDX-License-Identifier: AGPL-3.0
//! Offensive red-team round 3 — coverage completion:
//!  * integrity of the 4 remaining opaque-plaintext blob types
//!    (MYS1 search, MYW1 workspace, MYD1 dictionary, MYI1 indices)
//!  * subkey role-separation matrix (all 8 roles distinct + cross-role decode)
//!  * salt cross-account binding
//!  * update-path content-nonce freshness / item_key preservation (§6.3)
//!
//! Each test mounts an attack and asserts the secure outcome.

use std::collections::HashSet;

use protocol::{
    decode_dictionary_blob, decode_note, decode_search_index_blob, decode_vault_indices_blob,
    decode_workspace_blob, derive_password_wrap_key, derive_subkey, encode_dictionary_blob,
    encode_new_note, encode_search_index_blob, encode_update, encode_vault_indices_blob,
    encode_workspace_blob, KdfParams, SubkeyRole,
};

// ───────────── Battery 9: remaining opaque blob types integrity ────────────

/// Generate an integrity battery for a (key, account_hash, plaintext) blob:
/// exhaustive single-byte forgery, wrong key, and account_hash AAD binding —
/// each must be rejected.
macro_rules! blob_integrity_battery {
    ($name:ident, $enc:path, $dec:path) => {
        #[test]
        fn $name() {
            let key = [0x07u8; 32];
            let hash = [0xABu8; 16];
            let pt = b"opaque inner plaintext payload for this blob type ....";
            let blob = $enc(&key, &hash, pt).expect("encode");
            assert!(
                $dec(&key, &hash, &blob).is_ok(),
                "baseline decode must succeed"
            );

            // Exhaustive single-byte forgery.
            let mut accepted = Vec::new();
            for i in 0..blob.len() {
                let mut m = blob.clone();
                m[i] ^= 0xFF;
                if $dec(&key, &hash, &m).is_ok() {
                    accepted.push(i);
                }
            }
            assert!(
                accepted.is_empty(),
                "FORGERY: mutations accepted at {:?}",
                accepted
            );

            // Wrong key and wrong account_hash (AAD-bound) must both fail.
            assert!(
                $dec(&[0x08u8; 32], &hash, &blob).is_err(),
                "wrong key accepted"
            );
            assert!(
                $dec(&key, &[0xACu8; 16], &blob).is_err(),
                "wrong account_hash accepted"
            );
        }
    };
}

blob_integrity_battery!(
    battery9_search_integrity,
    encode_search_index_blob,
    decode_search_index_blob
);
blob_integrity_battery!(
    battery9_workspace_integrity,
    encode_workspace_blob,
    decode_workspace_blob
);
blob_integrity_battery!(
    battery9_dictionary_integrity,
    encode_dictionary_blob,
    decode_dictionary_blob
);
blob_integrity_battery!(
    battery9_indices_integrity,
    encode_vault_indices_blob,
    decode_vault_indices_blob
);

// ───────────── Battery 10: subkey role-separation matrix ───────────────────

/// All 8 registered subkey roles must derive DISTINCT keys from one root_key
/// (domain separation — a collision would let one subsystem's key open
/// another's blobs). Also prove it operationally: a blob sealed under one
/// role's subkey must not open under another role's subkey.
#[test]
fn battery10_all_subkey_roles_are_distinct() {
    let root = [0x5Cu8; 32];
    let roles = [
        SubkeyRole::ItemsKeyWrap,
        SubkeyRole::PrefsKey,
        SubkeyRole::SearchIndexKey,
        SubkeyRole::AttachmentsCatalogKey,
        SubkeyRole::AttachmentsIdHmac,
        SubkeyRole::SessionStateKey,
        SubkeyRole::PersonalDictKey,
        SubkeyRole::VaultIndicesKey,
    ];
    let mut seen: HashSet<[u8; 32]> = HashSet::new();
    for r in roles {
        let k = derive_subkey(&root, r);
        assert!(
            seen.insert(*k),
            "ROLE COLLISION: two roles derived the same subkey"
        );
    }
    assert_eq!(seen.len(), 8, "expected 8 distinct subkeys");

    // Operational separation: seal a search blob under the SearchIndexKey
    // subkey, then try to open it under the VaultIndicesKey subkey.
    let hash = [0x22u8; 16];
    let search_key = derive_subkey(&root, SubkeyRole::SearchIndexKey);
    let indices_key = derive_subkey(&root, SubkeyRole::VaultIndicesKey);
    let blob = encode_search_index_blob(&search_key, &hash, b"index payload").expect("enc");
    assert!(
        decode_search_index_blob(&indices_key, &hash, &blob).is_err(),
        "ROLE CONFUSION: a different role's subkey opened the blob"
    );
}

// ───────────── Battery 11: salt cross-account binding ──────────────────────

const WEAK: KdfParams = KdfParams {
    m_kib: 8,
    t: 1,
    p: 1,
    argon2_version: 0x13,
};

/// The wrap-key salt mixes in the account_number_hash, so the SAME password
/// under two different accounts must derive DIFFERENT wrap keys (defeats
/// cross-account precomputation / rainbow sharing). Same inputs → same key
/// (determinism).
#[test]
fn battery11_same_password_different_account_distinct_keys() {
    let salt = [0x11u8; 16];
    let acct_a = [0xA1u8; 16];
    let acct_b = [0xB2u8; 16];
    let k_a = derive_password_wrap_key("hunter2", &salt, &acct_a, &WEAK).expect("a");
    let k_b = derive_password_wrap_key("hunter2", &salt, &acct_b, &WEAK).expect("b");
    assert_ne!(
        *k_a, *k_b,
        "CROSS-ACCOUNT KEY REUSE: same pw on two accounts = same key"
    );

    let k_a2 = derive_password_wrap_key("hunter2", &salt, &acct_a, &WEAK).expect("a2");
    assert_eq!(*k_a, *k_a2, "derivation must be deterministic");
}

// ───────────── Battery 12: update-path (§6.3) ──────────────────────────────

/// An update re-encrypts content under the SAME item_key but a FRESH content
/// nonce, and preserves the wrapped item_key header verbatim. Verify: the
/// content nonce changes on update (no content-nonce reuse across versions),
/// the wrapped-item_key header region is preserved, and two updates with the
/// SAME plaintext still yield distinct ciphertext (fresh nonce each time).
#[test]
fn battery12_update_uses_fresh_content_nonce() {
    use protocol::blob::{ENC_ITEM_KEY_WRAPPED_LEN, OFFSET_CONTENT_NONCE, OFFSET_ENC_ITEM_KEY};

    let items_key = [0x07u8; 32];
    let items_key_id = [0xABu8; 16];
    let uuid = [0xCDu8; 16];

    let v1 = encode_new_note(&items_key, &items_key_id, &uuid, b"version one").expect("v1");
    let handle = decode_note(&v1, &uuid, &items_key, &items_key_id).expect("decode v1");
    let v2 = encode_update(handle, b"version two!").expect("update");

    let nonce_range = OFFSET_CONTENT_NONCE..OFFSET_CONTENT_NONCE + 24;
    assert_ne!(
        v1[nonce_range.clone()],
        v2[nonce_range.clone()],
        "content nonce reused across update — keystream-reuse risk"
    );

    // Wrapped item_key header preserved verbatim (§6.3 persistent item_key).
    let hdr = OFFSET_ENC_ITEM_KEY..OFFSET_ENC_ITEM_KEY + ENC_ITEM_KEY_WRAPPED_LEN;
    assert_eq!(
        v1[hdr.clone()],
        v2[hdr],
        "wrapped item_key changed on update"
    );

    // The update still decrypts to the new plaintext under the same keys.
    let dec = decode_note(&v2, &uuid, &items_key, &items_key_id).expect("decode v2");
    assert_eq!(dec.plaintext(), b"version two!");

    // Two updates with identical plaintext yield distinct ciphertext.
    let h1 = decode_note(&v1, &uuid, &items_key, &items_key_id).unwrap();
    let a = encode_update(h1, b"same body").unwrap();
    let h2 = decode_note(&v1, &uuid, &items_key, &items_key_id).unwrap();
    let b = encode_update(h2, b"same body").unwrap();
    assert_ne!(
        a, b,
        "identical-plaintext updates are byte-identical (nonce reuse)"
    );
}
