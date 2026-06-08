// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Byte-level integration tests against the `myne-test-vectors/` companion
// repository (expected at `../myne-test-vectors/` per `workspace/setup.sh`).
// Each runner reads a category's `cases.json`, drives the matching public
// API, and asserts byte-equality. When the companion repo is not checked
// out the runners skip with an explanatory message rather than fail.

use std::fs;
use std::path::PathBuf;

fn companion_vectors_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("myne-test-vectors")
        .join("vectors")
}

fn hex_decode(s: &str) -> Vec<u8> {
    assert!(
        s.bytes().all(|b| b.is_ascii_hexdigit()),
        "hex string must contain only ASCII hex digits, got {s:?}"
    );
    assert!(s.len().is_multiple_of(2), "hex string length must be even");
    (0..s.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&s[i..i + 2], 16).expect("ASCII-hex pre-validated"))
        .collect()
}

fn hex_decode_array<const N: usize>(s: &str) -> [u8; N] {
    let v = hex_decode(s);
    assert_eq!(
        v.len(),
        N,
        "hex string decodes to {} bytes, expected exactly {N}",
        v.len()
    );
    let mut arr = [0u8; N];
    arr.copy_from_slice(&v);
    arr
}

fn hex_encode(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        out.push_str(&format!("{b:02x}"));
    }
    out
}

/// Panics if any `vector_id` repeats in `cases` — duplicates would silently
/// pass byte-equality and break downstream tools that reference vector_ids
/// by string. Schema enforces the `vector_id` shape but not its uniqueness
/// across the array.
fn assert_unique_vector_ids(category: &str, cases: &[serde_json::Value]) {
    let mut seen = std::collections::HashSet::with_capacity(cases.len());
    for case in cases {
        let id = case["vector_id"]
            .as_str()
            .expect("vector_id must be a string");
        assert!(
            seen.insert(id),
            "[{category}] duplicate vector_id '{id}' in cases array"
        );
    }
}

/// Parse a case's `input_kdf_params` object (`{ m_kib, t, p, argon2_version_hex }`)
/// into a `KdfParams`. Shared by the argon2id / bip39-recovery / aad-construction
/// runners, all of which bind the canonical Argon2id param block.
fn parse_kdf_params(case: &serde_json::Value, id: &str) -> protocol::KdfParams {
    let obj = case
        .get("input_kdf_params")
        .unwrap_or_else(|| panic!("[{id}] missing input_kdf_params"));
    let argon2_version_bytes = hex_decode(
        obj["argon2_version_hex"]
            .as_str()
            .unwrap_or_else(|| panic!("[{id}] missing kdf_params.argon2_version_hex")),
    );
    protocol::KdfParams {
        m_kib: obj["m_kib"]
            .as_u64()
            .unwrap_or_else(|| panic!("[{id}] missing kdf_params.m_kib")) as u32,
        t: obj["t"]
            .as_u64()
            .unwrap_or_else(|| panic!("[{id}] missing kdf_params.t")) as u32,
        p: obj["p"]
            .as_u64()
            .unwrap_or_else(|| panic!("[{id}] missing kdf_params.p")) as u8,
        argon2_version: argon2_version_bytes[0],
    }
}

#[test]
fn phrase_normalize_vectors() {
    let path = companion_vectors_root()
        .join("phrase_normalize")
        .join("v0.1")
        .join("cases.json");

    if !path.exists() {
        eprintln!(
            "[skip] phrase_normalize: companion repo fixture not present at {}",
            path.display()
        );
        return;
    }

    let raw = fs::read_to_string(&path).unwrap_or_else(|e| panic!("read {}: {e}", path.display()));
    let doc: serde_json::Value =
        serde_json::from_str(&raw).unwrap_or_else(|e| panic!("parse {}: {e}", path.display()));

    assert_eq!(doc["schema"], "phrase_normalize");
    assert_eq!(doc["protocol_version"], "v0.1");

    let cases = doc["cases"].as_array().expect("cases must be a JSON array");
    assert!(
        !cases.is_empty(),
        "phrase_normalize must have at least one case"
    );
    assert_unique_vector_ids("phrase_normalize", cases);

    for case in cases {
        let id = case["vector_id"]
            .as_str()
            .expect("vector_id must be a string");
        let input_hex = case["input_utf8_hex"]
            .as_str()
            .expect("input_utf8_hex must be a string");
        let expected_hex = case["expected_output_utf8_hex"]
            .as_str()
            .expect("expected_output_utf8_hex must be a string");

        let input_bytes = hex_decode(input_hex);
        let input_str = core::str::from_utf8(&input_bytes)
            .unwrap_or_else(|e| panic!("[{id}] input not valid UTF-8: {e}"));
        let expected_bytes = hex_decode(expected_hex);

        let actual = protocol::normalize_user_phrase(input_str);
        let actual_bytes = actual.as_bytes();

        assert_eq!(
            actual_bytes,
            expected_bytes.as_slice(),
            "[{id}] phrase_normalize output mismatch\n  input_hex:    {input_hex}\n  expected_hex: {expected_hex}\n  actual_hex:   {}",
            hex_encode(actual_bytes),
        );
    }
}

#[test]
fn vault_prefs_vectors() {
    use protocol::{
        decode_prefs_blob, derive_subkey, encode_prefs_blob_raw, PrefsBlobError, PrefsView,
        SubkeyRole,
    };

    let path = companion_vectors_root()
        .join("vault-prefs")
        .join("v0.1")
        .join("cases.json");

    if !path.exists() {
        eprintln!(
            "[skip] vault-prefs: companion repo fixture not present at {}",
            path.display()
        );
        return;
    }

    let raw = fs::read_to_string(&path).unwrap_or_else(|e| panic!("read {}: {e}", path.display()));
    let doc: serde_json::Value =
        serde_json::from_str(&raw).unwrap_or_else(|e| panic!("parse {}: {e}", path.display()));

    assert_eq!(doc["schema"], "vault-prefs");
    assert_eq!(doc["protocol_version"], "v0.1");

    let cases = doc["cases"].as_array().expect("cases must be a JSON array");
    assert!(!cases.is_empty(), "vault-prefs must have at least one case");
    assert_unique_vector_ids("vault-prefs", cases);

    for case in cases {
        let id = case["vector_id"]
            .as_str()
            .expect("vector_id must be a string");
        let case_kind = case["case_kind"]
            .as_str()
            .unwrap_or_else(|| panic!("[{id}] missing case_kind"));

        match case_kind {
            "encrypt" => {
                let root_key: [u8; 32] = hex_decode_array(
                    case["input_root_key_hex"]
                        .as_str()
                        .unwrap_or_else(|| panic!("[{id}] missing input_root_key_hex")),
                );
                let account_hash: [u8; 16] = hex_decode_array(
                    case["input_account_number_hash_hex"]
                        .as_str()
                        .unwrap_or_else(|| panic!("[{id}] missing input_account_number_hash_hex")),
                );
                let plaintext_bytes = hex_decode(
                    case["input_plaintext_canonical_utf8_hex"]
                        .as_str()
                        .unwrap_or_else(|| {
                            panic!("[{id}] missing input_plaintext_canonical_utf8_hex")
                        }),
                );
                let nonce: [u8; 24] = hex_decode_array(
                    case["input_prefs_nonce_hex"]
                        .as_str()
                        .unwrap_or_else(|| panic!("[{id}] missing input_prefs_nonce_hex")),
                );
                let expected = hex_decode(
                    case["expected_prefs_blob_hex"]
                        .as_str()
                        .unwrap_or_else(|| panic!("[{id}] missing expected_prefs_blob_hex")),
                );

                let prefs: PrefsView = serde_json::from_slice(&plaintext_bytes)
                    .unwrap_or_else(|e| panic!("[{id}] plaintext not parseable as PrefsView: {e}"));

                let prefs_key = derive_subkey(&root_key, SubkeyRole::PrefsKey);

                // Defensive cross-check: if the case carries the
                // optional `informational_prefs_key_hex` field, verify
                // it matches the helper's own derivation. The schema's
                // "verified implicitly via expected_prefs_blob_hex"
                // claim is true only when the field is correct; this
                // check catches typos in the informational field that
                // would otherwise mislead cross-implementation reviewers.
                if let Some(info_hex) = case
                    .get("informational_prefs_key_hex")
                    .and_then(|v| v.as_str())
                {
                    let info_bytes: [u8; 32] = hex_decode_array(info_hex);
                    assert_eq!(
                        prefs_key.as_slice(),
                        info_bytes.as_slice(),
                        "[{id}] informational_prefs_key_hex disagrees with derive_subkey(root_key, PrefsKey)",
                    );
                }

                let actual = encode_prefs_blob_raw(&prefs_key, &account_hash, &prefs, &nonce)
                    .unwrap_or_else(|e| panic!("[{id}] encode failed: {e:?}"));

                assert_eq!(
                    actual.as_slice(),
                    expected.as_slice(),
                    "[{id}] vault-prefs encrypt mismatch\n  expected_hex: {}\n  actual_hex:   {}",
                    hex_encode(&expected),
                    hex_encode(&actual),
                );
            }
            "decrypt_ok" => {
                let blob = hex_decode(
                    case["input_blob_hex"]
                        .as_str()
                        .unwrap_or_else(|| panic!("[{id}] missing input_blob_hex")),
                );
                let root_key: [u8; 32] = hex_decode_array(
                    case["input_root_key_hex"]
                        .as_str()
                        .unwrap_or_else(|| panic!("[{id}] missing input_root_key_hex")),
                );
                let account_hash: [u8; 16] = hex_decode_array(
                    case["input_account_number_hash_hex"]
                        .as_str()
                        .unwrap_or_else(|| panic!("[{id}] missing input_account_number_hash_hex")),
                );
                let expected_view_value = case
                    .get("expected_prefs_view")
                    .unwrap_or_else(|| panic!("[{id}] missing expected_prefs_view"));
                let expected_view: PrefsView = serde_json::from_value(expected_view_value.clone())
                    .unwrap_or_else(|e| {
                        panic!("[{id}] expected_prefs_view not parseable as PrefsView: {e}")
                    });

                let prefs_key = derive_subkey(&root_key, SubkeyRole::PrefsKey);
                let actual = decode_prefs_blob(&prefs_key, &account_hash, &blob)
                    .unwrap_or_else(|e| panic!("[{id}] decode failed: {e:?}"));

                assert_eq!(
                    actual, expected_view,
                    "[{id}] vault-prefs decrypt_ok mismatch"
                );
            }
            "decrypt_aead_fail" => {
                let blob = hex_decode(
                    case["input_blob_hex"]
                        .as_str()
                        .unwrap_or_else(|| panic!("[{id}] missing input_blob_hex")),
                );
                let root_key: [u8; 32] = hex_decode_array(
                    case["input_root_key_hex"]
                        .as_str()
                        .unwrap_or_else(|| panic!("[{id}] missing input_root_key_hex")),
                );
                let account_hash: [u8; 16] = hex_decode_array(
                    case["input_account_number_hash_hex"]
                        .as_str()
                        .unwrap_or_else(|| panic!("[{id}] missing input_account_number_hash_hex")),
                );

                let prefs_key = derive_subkey(&root_key, SubkeyRole::PrefsKey);
                let result = decode_prefs_blob(&prefs_key, &account_hash, &blob);

                match result {
                    Err(PrefsBlobError::CannotDecrypt) => {}
                    Err(other) => panic!(
                        "[{id}] expected PrefsBlobError::CannotDecrypt (non-distinguishing AEAD failure per spec §6.4 + §9.5.5), got {other:?}"
                    ),
                    Ok(view) => {
                        panic!("[{id}] expected AEAD failure, decoder returned Ok({view:?})")
                    }
                }
            }
            other => panic!("[{id}] unknown case_kind '{other}' — schema enforces enum"),
        }
    }
}

#[test]
fn vault_meta_rewrite_vectors() {
    use protocol::{parse_vault_meta, rewrite_vault_meta_password_side};

    let path = companion_vectors_root()
        .join("vault_meta_rewrite")
        .join("v0.1")
        .join("cases.json");

    if !path.exists() {
        eprintln!(
            "[skip] vault_meta_rewrite: companion repo fixture not present at {}",
            path.display()
        );
        return;
    }

    let raw = fs::read_to_string(&path).unwrap_or_else(|e| panic!("read {}: {e}", path.display()));
    let doc: serde_json::Value =
        serde_json::from_str(&raw).unwrap_or_else(|e| panic!("parse {}: {e}", path.display()));

    assert_eq!(doc["schema"], "vault_meta_rewrite");
    assert_eq!(doc["protocol_version"], "v0.1");

    let cases = doc["cases"].as_array().expect("cases must be a JSON array");
    assert!(
        !cases.is_empty(),
        "vault_meta_rewrite must have at least one case"
    );
    assert_unique_vector_ids("vault_meta_rewrite", cases);

    for case in cases {
        let id = case["vector_id"]
            .as_str()
            .expect("vector_id must be a string");

        let existing_bytes = hex_decode(
            case["input_existing_vault_meta_hex"]
                .as_str()
                .unwrap_or_else(|| panic!("[{id}] missing input_existing_vault_meta_hex")),
        );
        let root_key: [u8; 32] = hex_decode_array(
            case["input_root_key_hex"]
                .as_str()
                .unwrap_or_else(|| panic!("[{id}] missing input_root_key_hex")),
        );
        let new_password_bytes = hex_decode(
            case["input_new_password_utf8_hex"]
                .as_str()
                .unwrap_or_else(|| panic!("[{id}] missing input_new_password_utf8_hex")),
        );
        let new_password = core::str::from_utf8(&new_password_bytes)
            .unwrap_or_else(|e| panic!("[{id}] new_password not valid UTF-8: {e}"));
        let fresh_salt: [u8; 16] = hex_decode_array(
            case["input_fresh_salt_hex"]
                .as_str()
                .unwrap_or_else(|| panic!("[{id}] missing input_fresh_salt_hex")),
        );
        let fresh_nonce: [u8; 24] = hex_decode_array(
            case["input_fresh_nonce_hex"]
                .as_str()
                .unwrap_or_else(|| panic!("[{id}] missing input_fresh_nonce_hex")),
        );
        let expected = hex_decode(
            case["expected_vault_meta_hex"]
                .as_str()
                .unwrap_or_else(|| panic!("[{id}] missing expected_vault_meta_hex")),
        );

        let existing = parse_vault_meta(&existing_bytes)
            .unwrap_or_else(|e| panic!("[{id}] parse_vault_meta failed: {e:?}"));

        let actual = rewrite_vault_meta_password_side(
            &existing,
            &root_key,
            new_password,
            &fresh_salt,
            &fresh_nonce,
        )
        .unwrap_or_else(|e| panic!("[{id}] rewrite failed: {e:?}"));

        assert_eq!(
            actual.as_slice(),
            expected.as_slice(),
            "[{id}] vault_meta_rewrite byte mismatch\n  expected_hex: {}\n  actual_hex:   {}",
            hex_encode(&expected),
            hex_encode(&actual),
        );
    }
}

#[test]
fn hkdf_sha256_vectors() {
    use protocol::{derive_subkey, SubkeyRole};

    let path = companion_vectors_root()
        .join("hkdf-sha256")
        .join("v0.1")
        .join("cases.json");

    if !path.exists() {
        eprintln!(
            "[skip] hkdf-sha256: companion repo fixture not present at {}",
            path.display()
        );
        return;
    }

    let raw = fs::read_to_string(&path).unwrap_or_else(|e| panic!("read {}: {e}", path.display()));
    let doc: serde_json::Value =
        serde_json::from_str(&raw).unwrap_or_else(|e| panic!("parse {}: {e}", path.display()));

    assert_eq!(doc["schema"], "hkdf-sha256");
    assert_eq!(doc["protocol_version"], "v0.1");

    let cases = doc["cases"].as_array().expect("cases must be a JSON array");
    assert!(
        cases.len() >= 10,
        "hkdf-sha256 must carry at least 10 vectors (per PRD); found {}",
        cases.len()
    );
    assert_unique_vector_ids("hkdf-sha256", cases);

    for case in cases {
        let id = case["vector_id"]
            .as_str()
            .expect("vector_id must be a string");

        let root_key: [u8; 32] = hex_decode_array(
            case["input_root_key_hex"]
                .as_str()
                .unwrap_or_else(|| panic!("[{id}] missing input_root_key_hex")),
        );
        let role_str = case["input_role"]
            .as_str()
            .unwrap_or_else(|| panic!("[{id}] missing input_role"));
        let expected = hex_decode(
            case["expected_subkey_hex"]
                .as_str()
                .unwrap_or_else(|| panic!("[{id}] missing expected_subkey_hex")),
        );

        let role = match role_str {
            "itemsKey-wrap" => SubkeyRole::ItemsKeyWrap,
            "prefs-key" => SubkeyRole::PrefsKey,
            "search-index-key" => SubkeyRole::SearchIndexKey,
            other => panic!(
                "[{id}] unknown input_role '{other}' — schema enforces enum; if a new variant landed in SubkeyRole, update this match arm in lockstep"
            ),
        };

        // Defensive cross-check: if the case carries the optional
        // `informational_info_utf8_hex` field, verify it matches the
        // canonical `"myne.v0.1 " || role_str` assembly. The schema's
        // "verified implicitly via expected_subkey_hex" claim is true
        // only when this field is correct; the check catches typos in
        // the informational field that would mislead cross-implementation
        // reviewers verifying their info-parameter assembly.
        if let Some(info_hex) = case
            .get("informational_info_utf8_hex")
            .and_then(|v| v.as_str())
        {
            let info_bytes = hex_decode(info_hex);
            let mut expected_info = b"myne.v0.1 ".to_vec();
            expected_info.extend_from_slice(role_str.as_bytes());
            assert_eq!(
                info_bytes, expected_info,
                "[{id}] informational_info_utf8_hex disagrees with the canonical \"myne.v0.1 \" || role assembly",
            );
        }

        let actual = derive_subkey(&root_key, role);

        assert_eq!(
            actual.as_slice(),
            expected.as_slice(),
            "[{id}] hkdf-sha256 subkey mismatch (role={role_str})\n  expected_hex: {}\n  actual_hex:   {}",
            hex_encode(&expected),
            hex_encode(&*actual),
        );
    }
}

#[test]
fn vault_meta_vectors() {
    use protocol::{
        parse_kdf_params, parse_vault_meta, serialize_vault_meta, KdfParams, ProtocolError,
        VaultMeta,
    };

    let path = companion_vectors_root()
        .join("vault-meta")
        .join("v0.1")
        .join("cases.json");

    if !path.exists() {
        eprintln!(
            "[skip] vault-meta: companion repo fixture not present at {}",
            path.display()
        );
        return;
    }

    let raw = fs::read_to_string(&path).unwrap_or_else(|e| panic!("read {}: {e}", path.display()));
    let doc: serde_json::Value =
        serde_json::from_str(&raw).unwrap_or_else(|e| panic!("parse {}: {e}", path.display()));

    assert_eq!(doc["schema"], "vault-meta");
    assert_eq!(doc["protocol_version"], "v0.1");

    let cases = doc["cases"].as_array().expect("cases must be a JSON array");
    assert!(!cases.is_empty(), "vault-meta must have at least one case");
    assert_unique_vector_ids("vault-meta", cases);

    for case in cases {
        let id = case["vector_id"]
            .as_str()
            .expect("vector_id must be a string");
        let case_kind = case["case_kind"]
            .as_str()
            .unwrap_or_else(|| panic!("[{id}] missing case_kind"));

        match case_kind {
            "roundtrip" => {
                let account_number_hash: [u8; 16] = hex_decode_array(
                    case["input_account_number_hash_hex"]
                        .as_str()
                        .unwrap_or_else(|| panic!("[{id}] missing input_account_number_hash_hex")),
                );
                let kdf_params_obj = case
                    .get("input_kdf_params")
                    .unwrap_or_else(|| panic!("[{id}] missing input_kdf_params"));
                let m_kib = kdf_params_obj["m_kib"]
                    .as_u64()
                    .unwrap_or_else(|| panic!("[{id}] missing kdf_params.m_kib"))
                    as u32;
                let t = kdf_params_obj["t"]
                    .as_u64()
                    .unwrap_or_else(|| panic!("[{id}] missing kdf_params.t"))
                    as u32;
                let p = kdf_params_obj["p"]
                    .as_u64()
                    .unwrap_or_else(|| panic!("[{id}] missing kdf_params.p"))
                    as u8;
                let argon2_version_bytes = hex_decode(
                    kdf_params_obj["argon2_version_hex"]
                        .as_str()
                        .unwrap_or_else(|| panic!("[{id}] missing kdf_params.argon2_version_hex")),
                );
                assert_eq!(argon2_version_bytes.len(), 1);
                let kdf_params = KdfParams {
                    m_kib,
                    t,
                    p,
                    argon2_version: argon2_version_bytes[0],
                };
                let random_salt_password: [u8; 16] = hex_decode_array(
                    case["input_random_salt_password_hex"]
                        .as_str()
                        .unwrap_or_else(|| panic!("[{id}] missing input_random_salt_password_hex")),
                );
                let random_salt_recovery: [u8; 16] = hex_decode_array(
                    case["input_random_salt_recovery_hex"]
                        .as_str()
                        .unwrap_or_else(|| panic!("[{id}] missing input_random_salt_recovery_hex")),
                );
                let nonce_password_wrap: [u8; 24] = hex_decode_array(
                    case["input_nonce_password_wrap_hex"]
                        .as_str()
                        .unwrap_or_else(|| panic!("[{id}] missing input_nonce_password_wrap_hex")),
                );
                let enc_root_key_password: [u8; 64] = hex_decode_array(
                    case["input_enc_root_key_password_hex"]
                        .as_str()
                        .unwrap_or_else(|| {
                            panic!("[{id}] missing input_enc_root_key_password_hex")
                        }),
                );
                let nonce_recovery_wrap: [u8; 24] = hex_decode_array(
                    case["input_nonce_recovery_wrap_hex"]
                        .as_str()
                        .unwrap_or_else(|| panic!("[{id}] missing input_nonce_recovery_wrap_hex")),
                );
                let enc_root_key_recovery: [u8; 64] = hex_decode_array(
                    case["input_enc_root_key_recovery_hex"]
                        .as_str()
                        .unwrap_or_else(|| {
                            panic!("[{id}] missing input_enc_root_key_recovery_hex")
                        }),
                );
                let items_key_id: [u8; 16] = hex_decode_array(
                    case["input_items_key_id_hex"]
                        .as_str()
                        .unwrap_or_else(|| panic!("[{id}] missing input_items_key_id_hex")),
                );
                let items_key_nonce: [u8; 24] = hex_decode_array(
                    case["input_items_key_nonce_hex"]
                        .as_str()
                        .unwrap_or_else(|| panic!("[{id}] missing input_items_key_nonce_hex")),
                );
                let enc_items_key: [u8; 64] = hex_decode_array(
                    case["input_enc_items_key_hex"]
                        .as_str()
                        .unwrap_or_else(|| panic!("[{id}] missing input_enc_items_key_hex")),
                );
                let expected = hex_decode(
                    case["expected_vault_meta_hex"]
                        .as_str()
                        .unwrap_or_else(|| panic!("[{id}] missing expected_vault_meta_hex")),
                );

                let meta = VaultMeta {
                    account_number_hash,
                    kdf_params,
                    random_salt_password,
                    random_salt_recovery,
                    nonce_password_wrap,
                    enc_root_key_password,
                    nonce_recovery_wrap,
                    enc_root_key_recovery,
                    items_key_id,
                    items_key_nonce,
                    enc_items_key,
                };

                let actual = serialize_vault_meta(&meta);
                assert_eq!(
                    actual.as_slice(),
                    expected.as_slice(),
                    "[{id}] vault-meta serialize mismatch\n  expected_hex: {}\n  actual_hex:   {}",
                    hex_encode(&expected),
                    hex_encode(&actual),
                );

                // Round-trip: parse the expected bytes back and re-serialize;
                // both must equal the original expected bytes.
                let reparsed = parse_vault_meta(&expected)
                    .unwrap_or_else(|e| panic!("[{id}] parse_vault_meta round-trip failed: {e:?}"));
                let reserialized = serialize_vault_meta(&reparsed);
                assert_eq!(
                    reserialized.as_slice(),
                    expected.as_slice(),
                    "[{id}] vault-meta parse → re-serialize round-trip diverges from expected"
                );

                // Defensive: also exercise the canonical KDF params helper
                // — drift between serialize/parse_kdf_params would surface
                // here without affecting the parent assertion.
                let params_bytes = &expected[22..33];
                let _ = parse_kdf_params(params_bytes.try_into().unwrap()).unwrap_or_else(|e| {
                    panic!("[{id}] parse_kdf_params on offset 22..33 failed: {e:?}")
                });
            }
            "parse_fail" => {
                let blob = hex_decode(
                    case["input_blob_hex"]
                        .as_str()
                        .unwrap_or_else(|| panic!("[{id}] missing input_blob_hex")),
                );
                let result = parse_vault_meta(&blob);
                match result {
                    Err(ProtocolError::InvalidVaultMeta) => {}
                    Err(other) => panic!(
                        "[{id}] expected ProtocolError::InvalidVaultMeta (non-distinguishing parse-fail per spec §6.4), got {other:?}"
                    ),
                    Ok(meta) => panic!(
                        "[{id}] expected parse-fail, parse_vault_meta returned Ok with account_hash={}",
                        hex_encode(&meta.account_number_hash)
                    ),
                }
            }
            other => panic!("[{id}] unknown case_kind '{other}' — schema enforces enum"),
        }
    }
}

#[test]
fn account_number_vectors() {
    use protocol::{parse_account_number, ProtocolError};

    let path = companion_vectors_root()
        .join("account-number")
        .join("v0.1")
        .join("cases.json");

    if !path.exists() {
        eprintln!(
            "[skip] account-number: companion repo fixture not present at {}",
            path.display()
        );
        return;
    }

    let raw = fs::read_to_string(&path).unwrap_or_else(|e| panic!("read {}: {e}", path.display()));
    let doc: serde_json::Value =
        serde_json::from_str(&raw).unwrap_or_else(|e| panic!("parse {}: {e}", path.display()));

    assert_eq!(doc["schema"], "account-number");
    assert_eq!(doc["protocol_version"], "v0.1");

    let cases = doc["cases"].as_array().expect("cases must be a JSON array");
    assert!(
        cases.len() >= 10,
        "account-number must carry at least 10 vectors (per PRD); found {}",
        cases.len()
    );
    assert_unique_vector_ids("account-number", cases);

    for case in cases {
        let id = case["vector_id"]
            .as_str()
            .expect("vector_id must be a string");
        let case_kind = case["case_kind"]
            .as_str()
            .unwrap_or_else(|| panic!("[{id}] missing case_kind"));

        let input_bytes = hex_decode(
            case["input_candidate_utf8_hex"]
                .as_str()
                .unwrap_or_else(|| panic!("[{id}] missing input_candidate_utf8_hex")),
        );
        let input_str = core::str::from_utf8(&input_bytes)
            .unwrap_or_else(|e| panic!("[{id}] input_candidate not valid UTF-8: {e}"));

        match case_kind {
            "parse_ok" => {
                let expected_canonical = hex_decode(
                    case["expected_canonical_utf8_hex"]
                        .as_str()
                        .unwrap_or_else(|| panic!("[{id}] missing expected_canonical_utf8_hex")),
                );
                let expected_display_bytes = hex_decode(
                    case["expected_display_utf8_hex"]
                        .as_str()
                        .unwrap_or_else(|| panic!("[{id}] missing expected_display_utf8_hex")),
                );
                let expected_display_str = core::str::from_utf8(&expected_display_bytes)
                    .unwrap_or_else(|e| panic!("[{id}] expected_display not valid UTF-8: {e}"));
                let expected_hash: [u8; 16] = hex_decode_array(
                    case["expected_hash_hex"]
                        .as_str()
                        .unwrap_or_else(|| panic!("[{id}] missing expected_hash_hex")),
                );

                let actual = parse_account_number(input_str).unwrap_or_else(|e| {
                    panic!("[{id}] parse_account_number returned Err({e:?}); expected Ok")
                });

                assert_eq!(
                    actual.canonical.as_slice(),
                    expected_canonical.as_slice(),
                    "[{id}] account-number canonical mismatch\n  expected_hex: {}\n  actual_hex:   {}",
                    hex_encode(&expected_canonical),
                    hex_encode(&actual.canonical),
                );
                assert_eq!(
                    actual.display, expected_display_str,
                    "[{id}] account-number display mismatch"
                );
                assert_eq!(
                    actual.hash.as_slice(),
                    expected_hash.as_slice(),
                    "[{id}] account-number hash mismatch\n  expected_hex: {}\n  actual_hex:   {}",
                    hex_encode(&expected_hash),
                    hex_encode(&actual.hash),
                );
            }
            "parse_fail" => {
                let result = parse_account_number(input_str);
                match result {
                    Err(ProtocolError::AccountNumberInvalid) => {}
                    Err(other) => panic!(
                        "[{id}] expected ProtocolError::AccountNumberInvalid (non-distinguishing parse-fail per spec §5), got {other:?}"
                    ),
                    Ok(acct) => panic!(
                        "[{id}] expected parse-fail, parse_account_number returned Ok with canonical={}",
                        core::str::from_utf8(&acct.canonical).unwrap_or("<non-ASCII?>")
                    ),
                }
            }
            other => panic!("[{id}] unknown case_kind '{other}' — schema enforces enum"),
        }
    }
}

#[test]
fn myn_blob_vectors() {
    use protocol::{decode_note, encode_new_note_blob_raw, encode_update_blob_raw, DecryptError};

    let path = companion_vectors_root()
        .join("myn-blob")
        .join("v0.1")
        .join("cases.json");

    if !path.exists() {
        eprintln!(
            "[skip] myn-blob: companion repo fixture not present at {}",
            path.display()
        );
        return;
    }

    let raw = fs::read_to_string(&path).unwrap_or_else(|e| panic!("read {}: {e}", path.display()));
    let doc: serde_json::Value =
        serde_json::from_str(&raw).unwrap_or_else(|e| panic!("parse {}: {e}", path.display()));

    assert_eq!(doc["schema"], "myn-blob");
    assert_eq!(doc["protocol_version"], "v0.1");

    let cases = doc["cases"].as_array().expect("cases must be a JSON array");
    assert!(!cases.is_empty(), "myn-blob must have at least one case");
    assert_unique_vector_ids("myn-blob", cases);

    for case in cases {
        let id = case["vector_id"]
            .as_str()
            .expect("vector_id must be a string");
        let case_kind = case["case_kind"]
            .as_str()
            .unwrap_or_else(|| panic!("[{id}] missing case_kind"));

        match case_kind {
            "encrypt" => {
                let items_key: [u8; 32] = hex_decode_array(
                    case["input_items_key_hex"]
                        .as_str()
                        .unwrap_or_else(|| panic!("[{id}] missing input_items_key_hex")),
                );
                let items_key_id: [u8; 16] = hex_decode_array(
                    case["input_items_key_id_hex"]
                        .as_str()
                        .unwrap_or_else(|| panic!("[{id}] missing input_items_key_id_hex")),
                );
                let note_uuid: [u8; 16] = hex_decode_array(
                    case["input_note_uuid_hex"]
                        .as_str()
                        .unwrap_or_else(|| panic!("[{id}] missing input_note_uuid_hex")),
                );
                let item_key: [u8; 32] = hex_decode_array(
                    case["input_item_key_hex"]
                        .as_str()
                        .unwrap_or_else(|| panic!("[{id}] missing input_item_key_hex")),
                );
                let item_key_nonce: [u8; 24] = hex_decode_array(
                    case["input_item_key_nonce_hex"]
                        .as_str()
                        .unwrap_or_else(|| panic!("[{id}] missing input_item_key_nonce_hex")),
                );
                let content_nonce: [u8; 24] = hex_decode_array(
                    case["input_content_nonce_hex"]
                        .as_str()
                        .unwrap_or_else(|| panic!("[{id}] missing input_content_nonce_hex")),
                );
                let plaintext = hex_decode(
                    case["input_plaintext_hex"]
                        .as_str()
                        .unwrap_or_else(|| panic!("[{id}] missing input_plaintext_hex")),
                );
                let expected = hex_decode(
                    case["expected_myn_blob_hex"]
                        .as_str()
                        .unwrap_or_else(|| panic!("[{id}] missing expected_myn_blob_hex")),
                );

                let actual = encode_new_note_blob_raw(
                    &items_key,
                    &items_key_id,
                    &note_uuid,
                    &item_key,
                    &item_key_nonce,
                    &content_nonce,
                    &plaintext,
                )
                .unwrap_or_else(|e| panic!("[{id}] encode_new_note_blob_raw failed: {e:?}"));

                assert_eq!(
                    actual.len(),
                    expected.len(),
                    "[{id}] myn-blob length mismatch: expected {} bytes, got {} bytes",
                    expected.len(),
                    actual.len(),
                );
                assert_eq!(
                    actual.as_slice(),
                    expected.as_slice(),
                    "[{id}] myn-blob encrypt mismatch ({} bytes)",
                    expected.len(),
                );
            }
            "encrypt_update" => {
                // §6.3 note-update path: decode the source blob, then
                // re-encode its content under a new content_nonce. The
                // 112-byte header_prefix MUST be spliced verbatim (§3.3).
                let source_blob = hex_decode(
                    case["input_source_blob_hex"]
                        .as_str()
                        .unwrap_or_else(|| panic!("[{id}] missing input_source_blob_hex")),
                );
                let note_uuid: [u8; 16] = hex_decode_array(
                    case["input_note_uuid_hex"]
                        .as_str()
                        .unwrap_or_else(|| panic!("[{id}] missing input_note_uuid_hex")),
                );
                let items_key: [u8; 32] = hex_decode_array(
                    case["input_items_key_hex"]
                        .as_str()
                        .unwrap_or_else(|| panic!("[{id}] missing input_items_key_hex")),
                );
                let items_key_id: [u8; 16] = hex_decode_array(
                    case["input_items_key_id_hex"]
                        .as_str()
                        .unwrap_or_else(|| panic!("[{id}] missing input_items_key_id_hex")),
                );
                let new_content_nonce: [u8; 24] = hex_decode_array(
                    case["input_new_content_nonce_hex"]
                        .as_str()
                        .unwrap_or_else(|| panic!("[{id}] missing input_new_content_nonce_hex")),
                );
                let new_plaintext = hex_decode(
                    case["input_new_plaintext_hex"]
                        .as_str()
                        .unwrap_or_else(|| panic!("[{id}] missing input_new_plaintext_hex")),
                );
                let expected = hex_decode(
                    case["expected_myn_blob_hex"]
                        .as_str()
                        .unwrap_or_else(|| panic!("[{id}] missing expected_myn_blob_hex")),
                );

                let handle = decode_note(&source_blob, &note_uuid, &items_key, &items_key_id)
                    .unwrap_or_else(|e| panic!("[{id}] decode_note (source) failed: {e:?}"));
                let actual = encode_update_blob_raw(&handle, &new_content_nonce, &new_plaintext)
                    .unwrap_or_else(|e| panic!("[{id}] encode_update_blob_raw failed: {e:?}"));

                assert_eq!(
                    actual.as_slice(),
                    expected.as_slice(),
                    "[{id}] myn-blob update mismatch ({} bytes)",
                    expected.len(),
                );
                // §3.3 invariant: header_prefix (first 112 bytes) is spliced
                // verbatim from the source — enc_item_key never re-wraps.
                assert_eq!(
                    &actual[..protocol::blob::HEADER_PREFIX_LEN],
                    &source_blob[..protocol::blob::HEADER_PREFIX_LEN],
                    "[{id}] update must preserve header_prefix byte-for-byte",
                );
            }
            "decrypt_ok" => {
                let blob = hex_decode(
                    case["input_blob_hex"]
                        .as_str()
                        .unwrap_or_else(|| panic!("[{id}] missing input_blob_hex")),
                );
                let note_uuid: [u8; 16] = hex_decode_array(
                    case["input_note_uuid_hex"]
                        .as_str()
                        .unwrap_or_else(|| panic!("[{id}] missing input_note_uuid_hex")),
                );
                let items_key: [u8; 32] = hex_decode_array(
                    case["input_items_key_hex"]
                        .as_str()
                        .unwrap_or_else(|| panic!("[{id}] missing input_items_key_hex")),
                );
                let items_key_id: [u8; 16] = hex_decode_array(
                    case["input_items_key_id_hex"]
                        .as_str()
                        .unwrap_or_else(|| panic!("[{id}] missing input_items_key_id_hex")),
                );
                let expected_plaintext = hex_decode(
                    case["expected_plaintext_hex"]
                        .as_str()
                        .unwrap_or_else(|| panic!("[{id}] missing expected_plaintext_hex")),
                );

                let decrypted = decode_note(&blob, &note_uuid, &items_key, &items_key_id)
                    .unwrap_or_else(|e| panic!("[{id}] decode_note failed: {e:?}"));

                assert_eq!(
                    decrypted.plaintext(),
                    expected_plaintext.as_slice(),
                    "[{id}] myn-blob decrypt plaintext mismatch ({} bytes)",
                    expected_plaintext.len(),
                );
                assert_eq!(
                    decrypted.note_uuid(),
                    &note_uuid,
                    "[{id}] myn-blob decrypt note_uuid mismatch",
                );
                assert_eq!(
                    decrypted.items_key_id(),
                    &items_key_id,
                    "[{id}] myn-blob decrypt items_key_id mismatch",
                );
            }
            "decrypt_aead_fail" => {
                let blob = hex_decode(
                    case["input_blob_hex"]
                        .as_str()
                        .unwrap_or_else(|| panic!("[{id}] missing input_blob_hex")),
                );
                let note_uuid: [u8; 16] = hex_decode_array(
                    case["input_note_uuid_hex"]
                        .as_str()
                        .unwrap_or_else(|| panic!("[{id}] missing input_note_uuid_hex")),
                );
                let items_key: [u8; 32] = hex_decode_array(
                    case["input_items_key_hex"]
                        .as_str()
                        .unwrap_or_else(|| panic!("[{id}] missing input_items_key_hex")),
                );
                let items_key_id: [u8; 16] = hex_decode_array(
                    case["input_items_key_id_hex"]
                        .as_str()
                        .unwrap_or_else(|| panic!("[{id}] missing input_items_key_id_hex")),
                );

                let result = decode_note(&blob, &note_uuid, &items_key, &items_key_id);
                match result {
                    Err(DecryptError::CannotDecrypt) => {}
                    Ok(decrypted) => panic!(
                        "[{id}] expected aead_fail, decode_note returned Ok ({} byte plaintext)",
                        decrypted.plaintext().len()
                    ),
                }
            }
            other => panic!("[{id}] unknown case_kind '{other}' — schema enforces enum"),
        }
    }
}

#[test]
fn password_policy_vectors() {
    use protocol::{validate_min_length, ProtocolError};

    let path = companion_vectors_root()
        .join("password-policy")
        .join("v0.1")
        .join("cases.json");

    if !path.exists() {
        eprintln!(
            "[skip] password-policy: companion repo fixture not present at {}",
            path.display()
        );
        return;
    }

    let raw = fs::read_to_string(&path).unwrap_or_else(|e| panic!("read {}: {e}", path.display()));
    let doc: serde_json::Value =
        serde_json::from_str(&raw).unwrap_or_else(|e| panic!("parse {}: {e}", path.display()));

    assert_eq!(doc["schema"], "password-policy");
    assert_eq!(doc["protocol_version"], "v0.1");

    let cases = doc["cases"].as_array().expect("cases must be a JSON array");
    assert!(
        !cases.is_empty(),
        "password-policy must have at least one case"
    );
    assert_unique_vector_ids("password-policy", cases);

    for case in cases {
        let id = case["vector_id"]
            .as_str()
            .expect("vector_id must be a string");
        let expected_kind = case["expected_kind"]
            .as_str()
            .unwrap_or_else(|| panic!("[{id}] missing expected_kind"));
        let password_bytes = hex_decode(
            case["input_password_utf8_hex"]
                .as_str()
                .unwrap_or_else(|| panic!("[{id}] missing input_password_utf8_hex")),
        );
        let password = std::str::from_utf8(&password_bytes)
            .unwrap_or_else(|e| panic!("[{id}] input_password_utf8_hex is not valid UTF-8: {e}"));

        // Cross-check the pinned informational counts against the canonical
        // impl — guards the USV-not-bytes contract: a port computing
        // chars().count() must agree with the vector's recorded USV count,
        // and the byte length must agree with the hex byte count.
        let usv = password.chars().count() as u64;
        let byte_len = password_bytes.len() as u64;
        if let Some(expected_usv) = case["informational_usv_count"].as_u64() {
            assert_eq!(usv, expected_usv, "[{id}] informational_usv_count mismatch");
        }
        if let Some(expected_byte) = case["informational_byte_len"].as_u64() {
            assert_eq!(
                byte_len, expected_byte,
                "[{id}] informational_byte_len mismatch"
            );
        }

        let result = validate_min_length(password);
        match expected_kind {
            "accept" => assert!(
                result.is_ok(),
                "[{id}] expected accept, validate_min_length returned {result:?}"
            ),
            "reject_too_short" => assert_eq!(
                result,
                Err(ProtocolError::PasswordTooShort),
                "[{id}] expected reject_too_short"
            ),
            other => panic!("[{id}] unknown expected_kind '{other}' — schema enforces enum"),
        }
    }
}

#[test]
fn ctx_aead_vectors() {
    use protocol::{
        aad_note_content_encrypt, aad_note_item_key_wrap, aad_password_wrap, aad_prefs_blob,
        aad_recovery_wrap, aad_search_index_blob, aad_vault_items_key_wrap, aead_open_ctx,
        aead_seal_ctx, KdfParams, ProtocolError,
    };

    let path = companion_vectors_root()
        .join("ctx-aead")
        .join("v0.1")
        .join("cases.json");

    if !path.exists() {
        eprintln!(
            "[skip] ctx-aead: companion repo fixture not present at {}",
            path.display()
        );
        return;
    }

    let raw = fs::read_to_string(&path).unwrap_or_else(|e| panic!("read {}: {e}", path.display()));
    let doc: serde_json::Value =
        serde_json::from_str(&raw).unwrap_or_else(|e| panic!("parse {}: {e}", path.display()));

    assert_eq!(doc["schema"], "ctx-aead");
    assert_eq!(doc["protocol_version"], "v0.1");

    let cases = doc["cases"].as_array().expect("cases must be a JSON array");
    assert!(
        cases.len() >= 10,
        "ctx-aead must carry at least 10 vectors (per PRD); found {}",
        cases.len()
    );
    assert_unique_vector_ids("ctx-aead", cases);

    // Track which pub aad_* builders have been pinned via
    // aad_canonical_bytes cases. After the loop, assert every builder
    // got at least one pin — the structural guarantee per PRD that the
    // 6 pub builders are all under the byte-level audit-substitute leg.
    let mut pinned_builders = std::collections::HashSet::new();

    for case in cases {
        let id = case["vector_id"]
            .as_str()
            .expect("vector_id must be a string");
        let case_kind = case["case_kind"]
            .as_str()
            .unwrap_or_else(|| panic!("[{id}] missing case_kind"));

        match case_kind {
            "encrypt" => {
                let key: [u8; 32] = hex_decode_array(
                    case["input_key_hex"]
                        .as_str()
                        .unwrap_or_else(|| panic!("[{id}] missing input_key_hex")),
                );
                let nonce: [u8; 24] = hex_decode_array(
                    case["input_nonce_hex"]
                        .as_str()
                        .unwrap_or_else(|| panic!("[{id}] missing input_nonce_hex")),
                );
                let aad = hex_decode(
                    case["input_aad_hex"]
                        .as_str()
                        .unwrap_or_else(|| panic!("[{id}] missing input_aad_hex")),
                );
                let plaintext = hex_decode(
                    case["input_plaintext_hex"]
                        .as_str()
                        .unwrap_or_else(|| panic!("[{id}] missing input_plaintext_hex")),
                );
                let expected = hex_decode(
                    case["expected_sealed_hex"]
                        .as_str()
                        .unwrap_or_else(|| panic!("[{id}] missing expected_sealed_hex")),
                );

                let actual = aead_seal_ctx(&key, &nonce, &plaintext, &aad)
                    .unwrap_or_else(|e| panic!("[{id}] aead_seal_ctx failed: {e:?}"));

                assert_eq!(
                    actual.as_slice(),
                    expected.as_slice(),
                    "[{id}] ctx-aead encrypt mismatch ({} bytes)\n  expected_hex: {}\n  actual_hex:   {}",
                    expected.len(),
                    hex_encode(&expected),
                    hex_encode(&actual),
                );
            }
            "decrypt_ok" => {
                let key: [u8; 32] = hex_decode_array(
                    case["input_key_hex"]
                        .as_str()
                        .unwrap_or_else(|| panic!("[{id}] missing input_key_hex")),
                );
                let nonce: [u8; 24] = hex_decode_array(
                    case["input_nonce_hex"]
                        .as_str()
                        .unwrap_or_else(|| panic!("[{id}] missing input_nonce_hex")),
                );
                let aad = hex_decode(
                    case["input_aad_hex"]
                        .as_str()
                        .unwrap_or_else(|| panic!("[{id}] missing input_aad_hex")),
                );
                let sealed = hex_decode(
                    case["input_sealed_hex"]
                        .as_str()
                        .unwrap_or_else(|| panic!("[{id}] missing input_sealed_hex")),
                );
                let expected_plaintext = hex_decode(
                    case["expected_plaintext_hex"]
                        .as_str()
                        .unwrap_or_else(|| panic!("[{id}] missing expected_plaintext_hex")),
                );

                let recovered = aead_open_ctx(&key, &nonce, &sealed, &aad)
                    .unwrap_or_else(|e| panic!("[{id}] aead_open_ctx failed: {e:?}"));

                assert_eq!(
                    recovered.as_slice(),
                    expected_plaintext.as_slice(),
                    "[{id}] ctx-aead decrypt plaintext mismatch ({} bytes)",
                    expected_plaintext.len(),
                );
            }
            "decrypt_aead_fail" => {
                let key: [u8; 32] = hex_decode_array(
                    case["input_key_hex"]
                        .as_str()
                        .unwrap_or_else(|| panic!("[{id}] missing input_key_hex")),
                );
                let nonce: [u8; 24] = hex_decode_array(
                    case["input_nonce_hex"]
                        .as_str()
                        .unwrap_or_else(|| panic!("[{id}] missing input_nonce_hex")),
                );
                let aad = hex_decode(
                    case["input_aad_hex"]
                        .as_str()
                        .unwrap_or_else(|| panic!("[{id}] missing input_aad_hex")),
                );
                let sealed = hex_decode(
                    case["input_sealed_hex"]
                        .as_str()
                        .unwrap_or_else(|| panic!("[{id}] missing input_sealed_hex")),
                );

                let result = aead_open_ctx(&key, &nonce, &sealed, &aad);
                match result {
                    Err(ProtocolError::AeadFailure) => {}
                    Err(other) => panic!(
                        "[{id}] expected ProtocolError::AeadFailure (non-distinguishing AEAD failure per spec §6.4), got {other:?}"
                    ),
                    Ok(plaintext) => panic!(
                        "[{id}] expected aead_fail, aead_open_ctx returned Ok ({} byte plaintext)",
                        plaintext.len()
                    ),
                }
            }
            "aad_canonical_bytes" => {
                let builder_name = case["input_builder_name"]
                    .as_str()
                    .unwrap_or_else(|| panic!("[{id}] missing input_builder_name"));
                let expected = hex_decode(
                    case["expected_aad_bytes_hex"]
                        .as_str()
                        .unwrap_or_else(|| panic!("[{id}] missing expected_aad_bytes_hex")),
                );

                let actual: Vec<u8> = match builder_name {
                    "aad_password_wrap" | "aad_recovery_wrap" => {
                        let kdf_params_obj = case
                            .get("input_kdf_params")
                            .unwrap_or_else(|| panic!("[{id}] missing input_kdf_params"));
                        let m_kib = kdf_params_obj["m_kib"]
                            .as_u64()
                            .unwrap_or_else(|| panic!("[{id}] missing kdf_params.m_kib"))
                            as u32;
                        let t = kdf_params_obj["t"]
                            .as_u64()
                            .unwrap_or_else(|| panic!("[{id}] missing kdf_params.t"))
                            as u32;
                        let p = kdf_params_obj["p"]
                            .as_u64()
                            .unwrap_or_else(|| panic!("[{id}] missing kdf_params.p"))
                            as u8;
                        let argon2_version_bytes = hex_decode(
                            kdf_params_obj["argon2_version_hex"].as_str().unwrap_or_else(
                                || panic!("[{id}] missing kdf_params.argon2_version_hex"),
                            ),
                        );
                        let kdf_params = KdfParams {
                            m_kib,
                            t,
                            p,
                            argon2_version: argon2_version_bytes[0],
                        };
                        if builder_name == "aad_password_wrap" {
                            aad_password_wrap(&kdf_params)
                        } else {
                            aad_recovery_wrap(&kdf_params)
                        }
                    }
                    "aad_vault_items_key_wrap" => {
                        let items_key_id: [u8; 16] = hex_decode_array(
                            case["input_items_key_id_hex"]
                                .as_str()
                                .unwrap_or_else(|| panic!("[{id}] missing input_items_key_id_hex")),
                        );
                        aad_vault_items_key_wrap(&items_key_id)
                    }
                    "aad_note_item_key_wrap" => {
                        let items_key_id: [u8; 16] = hex_decode_array(
                            case["input_items_key_id_hex"]
                                .as_str()
                                .unwrap_or_else(|| panic!("[{id}] missing input_items_key_id_hex")),
                        );
                        let note_uuid: [u8; 16] = hex_decode_array(
                            case["input_note_uuid_hex"]
                                .as_str()
                                .unwrap_or_else(|| panic!("[{id}] missing input_note_uuid_hex")),
                        );
                        aad_note_item_key_wrap(&items_key_id, &note_uuid)
                    }
                    "aad_note_content_encrypt" => {
                        let items_key_id: [u8; 16] = hex_decode_array(
                            case["input_items_key_id_hex"]
                                .as_str()
                                .unwrap_or_else(|| panic!("[{id}] missing input_items_key_id_hex")),
                        );
                        let note_uuid: [u8; 16] = hex_decode_array(
                            case["input_note_uuid_hex"]
                                .as_str()
                                .unwrap_or_else(|| panic!("[{id}] missing input_note_uuid_hex")),
                        );
                        aad_note_content_encrypt(&items_key_id, &note_uuid)
                    }
                    "aad_prefs_blob" => {
                        let account_number_hash: [u8; 16] = hex_decode_array(
                            case["input_account_number_hash_hex"].as_str().unwrap_or_else(
                                || panic!("[{id}] missing input_account_number_hash_hex"),
                            ),
                        );
                        aad_prefs_blob(&account_number_hash)
                    }
                    "aad_search_index_blob" => {
                        let account_number_hash: [u8; 16] = hex_decode_array(
                            case["input_account_number_hash_hex"].as_str().unwrap_or_else(
                                || panic!("[{id}] missing input_account_number_hash_hex"),
                            ),
                        );
                        aad_search_index_blob(&account_number_hash)
                    }
                    other => panic!(
                        "[{id}] unknown input_builder_name '{other}' — schema enforces enum; update this match arm in lockstep with the schema"
                    ),
                };

                assert_eq!(
                    actual.as_slice(),
                    expected.as_slice(),
                    "[{id}] {builder_name} canonical AAD mismatch\n  expected_hex: {}\n  actual_hex:   {}",
                    hex_encode(&expected),
                    hex_encode(&actual),
                );

                pinned_builders.insert(builder_name.to_string());
            }
            other => panic!("[{id}] unknown case_kind '{other}' — schema enforces enum"),
        }
    }

    // Structural guarantee: every pub aad_* builder must have at least
    // one aad_canonical_bytes pin in the cases array. Drift in either
    // the schema's input_builder_name enum or the cases.json coverage
    // surfaces here.
    let required: [&str; 7] = [
        "aad_password_wrap",
        "aad_recovery_wrap",
        "aad_vault_items_key_wrap",
        "aad_note_item_key_wrap",
        "aad_note_content_encrypt",
        "aad_prefs_blob",
        "aad_search_index_blob",
    ];
    for builder in required {
        assert!(
            pinned_builders.contains(builder),
            "ctx-aead missing aad_canonical_bytes pin for {builder} — every pub aad_* builder must have at least one case"
        );
    }
}

#[test]
fn argon2id_wrap_vectors() {
    use protocol::{derive_password_wrap_key, derive_recovery_wrap_key_from_normalized};

    let path = companion_vectors_root()
        .join("argon2id")
        .join("v0.1")
        .join("cases.json");

    if !path.exists() {
        eprintln!(
            "[skip] argon2id: companion repo fixture not present at {}",
            path.display()
        );
        return;
    }

    let raw = fs::read_to_string(&path).unwrap_or_else(|e| panic!("read {}: {e}", path.display()));
    let doc: serde_json::Value =
        serde_json::from_str(&raw).unwrap_or_else(|e| panic!("parse {}: {e}", path.display()));

    assert_eq!(doc["schema"], "argon2id");
    assert_eq!(doc["protocol_version"], "v0.1");

    let cases = doc["cases"].as_array().expect("cases must be a JSON array");
    assert!(
        cases.len() >= 6,
        "argon2id must carry at least 6 vectors (per PRD); found {}",
        cases.len()
    );
    assert_unique_vector_ids("argon2id", cases);

    for case in cases {
        let id = case["vector_id"]
            .as_str()
            .expect("vector_id must be a string");
        let path = case["input_path"]
            .as_str()
            .unwrap_or_else(|| panic!("[{id}] missing input_path"));

        let password_bytes = hex_decode(
            case["input_password_or_phrase_utf8_hex"]
                .as_str()
                .unwrap_or_else(|| panic!("[{id}] missing input_password_or_phrase_utf8_hex")),
        );
        let password_str = core::str::from_utf8(&password_bytes)
            .unwrap_or_else(|e| panic!("[{id}] password/phrase not valid UTF-8: {e}"));
        let salt_random: [u8; 16] = hex_decode_array(
            case["input_salt_random_hex"]
                .as_str()
                .unwrap_or_else(|| panic!("[{id}] missing input_salt_random_hex")),
        );
        let account_number_hash: [u8; 16] = hex_decode_array(
            case["input_account_number_hash_hex"]
                .as_str()
                .unwrap_or_else(|| panic!("[{id}] missing input_account_number_hash_hex")),
        );

        let kdf_params = parse_kdf_params(case, id);
        let expected: [u8; 32] = hex_decode_array(
            case["expected_wrap_key_hex"]
                .as_str()
                .unwrap_or_else(|| panic!("[{id}] missing expected_wrap_key_hex")),
        );

        let actual = match path {
            "password" => derive_password_wrap_key(
                password_str,
                &salt_random,
                &account_number_hash,
                &kdf_params,
            )
            .unwrap_or_else(|e| panic!("[{id}] derive_password_wrap_key failed: {e:?}")),
            "recovery" => derive_recovery_wrap_key_from_normalized(
                password_str,
                &salt_random,
                &account_number_hash,
                &kdf_params,
            )
            .unwrap_or_else(|e| {
                panic!("[{id}] derive_recovery_wrap_key_from_normalized failed: {e:?}")
            }),
            other => panic!("[{id}] unknown input_path '{other}' — schema enforces enum"),
        };

        assert_eq!(
            actual.as_slice(),
            expected.as_slice(),
            "[{id}] argon2id wrap-key mismatch (path={path})\n  expected_hex: {}\n  actual_hex:   {}",
            hex_encode(&expected),
            hex_encode(&*actual),
        );
    }
}

#[test]
fn bip39_recovery_vectors() {
    use protocol::{derive_recovery_wrap_key_from_normalized, normalize_user_phrase};

    let path = companion_vectors_root()
        .join("bip39-recovery")
        .join("v0.1")
        .join("cases.json");

    if !path.exists() {
        eprintln!(
            "[skip] bip39-recovery: companion repo fixture not present at {}",
            path.display()
        );
        return;
    }

    let raw = fs::read_to_string(&path).unwrap_or_else(|e| panic!("read {}: {e}", path.display()));
    let doc: serde_json::Value =
        serde_json::from_str(&raw).unwrap_or_else(|e| panic!("parse {}: {e}", path.display()));

    assert_eq!(doc["schema"], "bip39-recovery");
    assert_eq!(doc["protocol_version"], "v0.1");

    let cases = doc["cases"].as_array().expect("cases must be a JSON array");
    assert!(
        !cases.is_empty(),
        "bip39-recovery must have at least one case"
    );
    assert_unique_vector_ids("bip39-recovery", cases);

    for case in cases {
        let id = case["vector_id"]
            .as_str()
            .expect("vector_id must be a string");

        let raw_phrase_bytes = hex_decode(
            case["input_raw_phrase_utf8_hex"]
                .as_str()
                .unwrap_or_else(|| panic!("[{id}] missing input_raw_phrase_utf8_hex")),
        );
        let raw_phrase = core::str::from_utf8(&raw_phrase_bytes)
            .unwrap_or_else(|e| panic!("[{id}] raw phrase not valid UTF-8: {e}"));
        let salt_random: [u8; 16] = hex_decode_array(
            case["input_salt_random_hex"]
                .as_str()
                .unwrap_or_else(|| panic!("[{id}] missing input_salt_random_hex")),
        );
        let account_number_hash: [u8; 16] = hex_decode_array(
            case["input_account_number_hash_hex"]
                .as_str()
                .unwrap_or_else(|| panic!("[{id}] missing input_account_number_hash_hex")),
        );

        let kdf_params = parse_kdf_params(case, id);
        let expected: [u8; 32] = hex_decode_array(
            case["expected_recovery_wrap_key_hex"]
                .as_str()
                .unwrap_or_else(|| panic!("[{id}] missing expected_recovery_wrap_key_hex")),
        );

        // §7.4 normalization, then §3.1 derivation — the composition.
        let normalized = normalize_user_phrase(raw_phrase);

        // Cross-check the pinned normalized form (catches a normalize bug
        // before it silently changes the derived key).
        if let Some(expected_norm_hex) = case["informational_normalized_phrase_utf8_hex"].as_str() {
            let expected_norm = hex_decode(expected_norm_hex);
            assert_eq!(
                normalized.as_bytes(),
                expected_norm.as_slice(),
                "[{id}] normalized phrase mismatch — normalize_user_phrase drift",
            );
        }

        let actual = derive_recovery_wrap_key_from_normalized(
            normalized.as_str(),
            &salt_random,
            &account_number_hash,
            &kdf_params,
        )
        .unwrap_or_else(|e| {
            panic!("[{id}] derive_recovery_wrap_key_from_normalized failed: {e:?}")
        });

        assert_eq!(
            actual.as_slice(),
            expected.as_slice(),
            "[{id}] bip39-recovery wrap-key mismatch\n  expected_hex: {}\n  actual_hex:   {}",
            hex_encode(&expected),
            hex_encode(&*actual),
        );
    }
}

#[test]
fn aad_construction_vectors() {
    use protocol::{
        aad_note_content_encrypt, aad_note_item_key_wrap, aad_password_wrap, aad_prefs_blob,
        aad_recovery_wrap, aad_search_index_blob, aad_vault_items_key_wrap,
    };

    let path = companion_vectors_root()
        .join("aad-construction")
        .join("v0.1")
        .join("cases.json");

    if !path.exists() {
        eprintln!(
            "[skip] aad-construction: companion repo fixture not present at {}",
            path.display()
        );
        return;
    }

    let raw = fs::read_to_string(&path).unwrap_or_else(|e| panic!("read {}: {e}", path.display()));
    let doc: serde_json::Value =
        serde_json::from_str(&raw).unwrap_or_else(|e| panic!("parse {}: {e}", path.display()));

    assert_eq!(doc["schema"], "aad-construction");
    assert_eq!(doc["protocol_version"], "v0.1");

    let cases = doc["cases"].as_array().expect("cases must be a JSON array");
    assert!(
        !cases.is_empty(),
        "aad-construction must have at least one case"
    );
    assert_unique_vector_ids("aad-construction", cases);

    let mut pinned_builders = std::collections::HashSet::new();

    for case in cases {
        let id = case["vector_id"]
            .as_str()
            .expect("vector_id must be a string");
        let builder_name = case["input_builder_name"]
            .as_str()
            .unwrap_or_else(|| panic!("[{id}] missing input_builder_name"));
        let expected = hex_decode(
            case["expected_aad_hex"]
                .as_str()
                .unwrap_or_else(|| panic!("[{id}] missing expected_aad_hex")),
        );

        // Re-derive the AAD via the named builder with the case's inputs.
        let items_key_id = || -> [u8; 16] {
            hex_decode_array(
                case["input_items_key_id_hex"]
                    .as_str()
                    .unwrap_or_else(|| panic!("[{id}] missing input_items_key_id_hex")),
            )
        };
        let note_uuid = || -> [u8; 16] {
            hex_decode_array(
                case["input_note_uuid_hex"]
                    .as_str()
                    .unwrap_or_else(|| panic!("[{id}] missing input_note_uuid_hex")),
            )
        };
        let account_number_hash = || -> [u8; 16] {
            hex_decode_array(
                case["input_account_number_hash_hex"]
                    .as_str()
                    .unwrap_or_else(|| panic!("[{id}] missing input_account_number_hash_hex")),
            )
        };
        let kdf_params = || parse_kdf_params(case, id);

        let actual = match builder_name {
            "aad_password_wrap" => aad_password_wrap(&kdf_params()),
            "aad_recovery_wrap" => aad_recovery_wrap(&kdf_params()),
            "aad_vault_items_key_wrap" => aad_vault_items_key_wrap(&items_key_id()),
            "aad_note_item_key_wrap" => aad_note_item_key_wrap(&items_key_id(), &note_uuid()),
            "aad_prefs_blob" => aad_prefs_blob(&account_number_hash()),
            "aad_search_index_blob" => aad_search_index_blob(&account_number_hash()),
            "aad_note_content_encrypt" => aad_note_content_encrypt(&items_key_id(), &note_uuid()),
            other => panic!(
                "[{id}] unknown input_builder_name '{other}' — schema enforces enum; update this match arm in lockstep with the schema"
            ),
        };

        assert_eq!(
            actual.as_slice(),
            expected.as_slice(),
            "[{id}] {builder_name} AAD byte mismatch\n  expected_hex: {}\n  actual_hex:   {}",
            hex_encode(&expected),
            hex_encode(&actual),
        );

        // Validate the per-call-site segment decomposition: segments must
        // be contiguous from offset 0, each length must match its bytes,
        // and the concatenation must reproduce the full AAD byte-for-byte.
        let segments = case["informational_aad_segments"]
            .as_array()
            .unwrap_or_else(|| panic!("[{id}] missing informational_aad_segments"));
        let mut reassembled: Vec<u8> = Vec::with_capacity(expected.len());
        let mut next_offset = 0u64;
        for (i, seg) in segments.iter().enumerate() {
            let offset = seg["offset"]
                .as_u64()
                .unwrap_or_else(|| panic!("[{id}] segment {i} missing offset"));
            let length = seg["length"]
                .as_u64()
                .unwrap_or_else(|| panic!("[{id}] segment {i} missing length"));
            let bytes = hex_decode(
                seg["bytes_hex"]
                    .as_str()
                    .unwrap_or_else(|| panic!("[{id}] segment {i} missing bytes_hex")),
            );
            assert_eq!(offset, next_offset, "[{id}] segment {i} not contiguous");
            assert_eq!(
                length as usize,
                bytes.len(),
                "[{id}] segment {i} length != bytes_hex byte count"
            );
            reassembled.extend_from_slice(&bytes);
            next_offset += length;
        }
        assert_eq!(
            reassembled.as_slice(),
            expected.as_slice(),
            "[{id}] segment concatenation must reproduce the full AAD",
        );

        pinned_builders.insert(builder_name.to_string());
    }

    // Structural guarantee: every pub aad_* builder must have a decomposition
    // case — drift in either the schema enum or the cases.json surfaces here.
    let required: [&str; 7] = [
        "aad_password_wrap",
        "aad_recovery_wrap",
        "aad_vault_items_key_wrap",
        "aad_note_item_key_wrap",
        "aad_prefs_blob",
        "aad_search_index_blob",
        "aad_note_content_encrypt",
    ];
    for builder in required {
        assert!(
            pinned_builders.contains(builder),
            "aad-construction missing decomposition case for {builder} — every pub aad_* builder must have one"
        );
    }
}

#[test]
fn vault_search_vectors() {
    use protocol::{
        decode_search_index_blob, derive_subkey, encode_search_index_blob_raw, SearchBlobError,
        SubkeyRole,
    };

    let path = companion_vectors_root()
        .join("vault-search")
        .join("v0.1")
        .join("cases.json");

    if !path.exists() {
        eprintln!(
            "[skip] vault-search: companion repo fixture not present at {}",
            path.display()
        );
        return;
    }

    let raw = fs::read_to_string(&path).unwrap_or_else(|e| panic!("read {}: {e}", path.display()));
    let doc: serde_json::Value =
        serde_json::from_str(&raw).unwrap_or_else(|e| panic!("parse {}: {e}", path.display()));

    assert_eq!(doc["schema"], "vault-search");
    assert_eq!(doc["protocol_version"], "v0.1");

    let cases = doc["cases"].as_array().expect("cases must be a JSON array");
    assert!(
        cases.len() >= 12,
        "vault-search must carry at least 12 vectors (3 encrypt + 1 decrypt_ok + 2 decrypt_aead_fail + 6 parse_fail); found {}",
        cases.len()
    );
    assert_unique_vector_ids("vault-search", cases);

    // Coverage guards (mirrors ctx-aead's required-builders array): assert
    // the category actually pins every case_kind and every structural
    // reject, so a future regeneration that silently drops — e.g. all 6
    // parse_fail cases — fails loudly instead of passing on the survivors.
    let mut seen_kinds = std::collections::HashSet::new();
    let mut seen_parse_errors = std::collections::HashSet::new();

    for case in cases {
        let id = case["vector_id"]
            .as_str()
            .expect("vector_id must be a string");
        let case_kind = case["case_kind"]
            .as_str()
            .unwrap_or_else(|| panic!("[{id}] missing case_kind"));
        seen_kinds.insert(case_kind.to_string());

        match case_kind {
            "encrypt" => {
                let root_key: [u8; 32] = hex_decode_array(
                    case["input_root_key_hex"]
                        .as_str()
                        .unwrap_or_else(|| panic!("[{id}] missing input_root_key_hex")),
                );
                let account_hash: [u8; 16] = hex_decode_array(
                    case["input_account_number_hash_hex"]
                        .as_str()
                        .unwrap_or_else(|| panic!("[{id}] missing input_account_number_hash_hex")),
                );
                let plaintext = hex_decode(
                    case["input_plaintext_hex"]
                        .as_str()
                        .unwrap_or_else(|| panic!("[{id}] missing input_plaintext_hex")),
                );
                let nonce: [u8; 24] = hex_decode_array(
                    case["input_nonce_hex"]
                        .as_str()
                        .unwrap_or_else(|| panic!("[{id}] missing input_nonce_hex")),
                );
                let expected = hex_decode(
                    case["expected_search_blob_hex"]
                        .as_str()
                        .unwrap_or_else(|| panic!("[{id}] missing expected_search_blob_hex")),
                );

                let search_index_key = derive_subkey(&root_key, SubkeyRole::SearchIndexKey);

                // Defensive cross-check: if the case carries the optional
                // `informational_search_index_key_hex` field, verify it
                // matches the helper's own derivation. The HKDF role string
                // "search-index-key" is DISTINCT from the AAD role string
                // "search-index-blob"; this catches a typo in the
                // informational field that would mislead porters.
                if let Some(info_hex) = case
                    .get("informational_search_index_key_hex")
                    .and_then(|v| v.as_str())
                {
                    let info_bytes: [u8; 32] = hex_decode_array(info_hex);
                    assert_eq!(
                        search_index_key.as_slice(),
                        info_bytes.as_slice(),
                        "[{id}] informational_search_index_key_hex disagrees with derive_subkey(root_key, SearchIndexKey)",
                    );
                }

                let actual = encode_search_index_blob_raw(
                    &search_index_key,
                    &account_hash,
                    &plaintext,
                    &nonce,
                )
                .unwrap_or_else(|e| panic!("[{id}] encode failed: {e:?}"));

                assert_eq!(
                    actual.as_slice(),
                    expected.as_slice(),
                    "[{id}] vault-search encrypt mismatch ({} bytes)\n  expected_hex: {}\n  actual_hex:   {}",
                    expected.len(),
                    hex_encode(&expected),
                    hex_encode(&actual),
                );
            }
            "decrypt_ok" => {
                let blob = hex_decode(
                    case["input_blob_hex"]
                        .as_str()
                        .unwrap_or_else(|| panic!("[{id}] missing input_blob_hex")),
                );
                let root_key: [u8; 32] = hex_decode_array(
                    case["input_root_key_hex"]
                        .as_str()
                        .unwrap_or_else(|| panic!("[{id}] missing input_root_key_hex")),
                );
                let account_hash: [u8; 16] = hex_decode_array(
                    case["input_account_number_hash_hex"]
                        .as_str()
                        .unwrap_or_else(|| panic!("[{id}] missing input_account_number_hash_hex")),
                );
                let expected_plaintext = hex_decode(
                    case["expected_plaintext_hex"]
                        .as_str()
                        .unwrap_or_else(|| panic!("[{id}] missing expected_plaintext_hex")),
                );

                let search_index_key = derive_subkey(&root_key, SubkeyRole::SearchIndexKey);
                let decoded = decode_search_index_blob(&search_index_key, &account_hash, &blob)
                    .unwrap_or_else(|e| panic!("[{id}] decode failed: {e:?}"));

                assert_eq!(
                    decoded.as_slice(),
                    expected_plaintext.as_slice(),
                    "[{id}] vault-search decrypt plaintext mismatch ({} bytes)",
                    expected_plaintext.len(),
                );
            }
            "decrypt_aead_fail" => {
                let blob = hex_decode(
                    case["input_blob_hex"]
                        .as_str()
                        .unwrap_or_else(|| panic!("[{id}] missing input_blob_hex")),
                );
                let root_key: [u8; 32] = hex_decode_array(
                    case["input_root_key_hex"]
                        .as_str()
                        .unwrap_or_else(|| panic!("[{id}] missing input_root_key_hex")),
                );
                let account_hash: [u8; 16] = hex_decode_array(
                    case["input_account_number_hash_hex"]
                        .as_str()
                        .unwrap_or_else(|| panic!("[{id}] missing input_account_number_hash_hex")),
                );

                let search_index_key = derive_subkey(&root_key, SubkeyRole::SearchIndexKey);
                match decode_search_index_blob(&search_index_key, &account_hash, &blob) {
                    Err(SearchBlobError::CannotDecrypt) => {}
                    Err(other) => panic!(
                        "[{id}] expected SearchBlobError::CannotDecrypt (non-distinguishing AEAD failure per spec §6.4), got {other:?}"
                    ),
                    Ok(plaintext) => panic!(
                        "[{id}] expected aead_fail, decode_search_index_blob returned Ok ({} byte plaintext)",
                        plaintext.len()
                    ),
                }
            }
            "parse_fail" => {
                let blob = hex_decode(
                    case["input_blob_hex"]
                        .as_str()
                        .unwrap_or_else(|| panic!("[{id}] missing input_blob_hex")),
                );
                let expected_error = case["expected_error"]
                    .as_str()
                    .unwrap_or_else(|| panic!("[{id}] missing expected_error"));
                seen_parse_errors.insert(expected_error.to_string());

                let expected_variant = match expected_error {
                    "magic_mismatch" => SearchBlobError::MagicMismatch,
                    "protocol_version_mismatch" => SearchBlobError::ProtocolVersionMismatch,
                    "index_format_unsupported" => SearchBlobError::IndexFormatUnsupported,
                    "header_too_short" => SearchBlobError::HeaderTooShort,
                    "ciphertext_truncated" => SearchBlobError::CiphertextTruncated,
                    "ciphertext_len_overflow" => SearchBlobError::CiphertextLenOverflow,
                    other => panic!(
                        "[{id}] unknown expected_error '{other}' — schema enforces enum; update this match arm in lockstep with SearchBlobError"
                    ),
                };

                // Structural rejects run BEFORE decryption, so the key /
                // account hash are irrelevant — pass throwaway zeros.
                let dummy_key = [0u8; 32];
                let dummy_hash = [0u8; 16];
                match decode_search_index_blob(&dummy_key, &dummy_hash, &blob) {
                    Err(e) if e == expected_variant => {}
                    Err(other) => panic!(
                        "[{id}] expected parse_fail '{expected_error}' ({expected_variant:?}), got {other:?}"
                    ),
                    Ok(_) => panic!(
                        "[{id}] expected parse_fail '{expected_error}', decode_search_index_blob returned Ok"
                    ),
                }
            }
            other => panic!("[{id}] unknown case_kind '{other}' — schema enforces enum"),
        }
    }

    let required_kinds: [&str; 4] = ["encrypt", "decrypt_ok", "decrypt_aead_fail", "parse_fail"];
    for kind in required_kinds {
        assert!(
            seen_kinds.contains(kind),
            "vault-search missing every case of case_kind '{kind}' — coverage regression"
        );
    }
    let required_parse_errors: [&str; 6] = [
        "magic_mismatch",
        "protocol_version_mismatch",
        "index_format_unsupported",
        "header_too_short",
        "ciphertext_truncated",
        "ciphertext_len_overflow",
    ];
    for err in required_parse_errors {
        assert!(
            seen_parse_errors.contains(err),
            "vault-search missing parse_fail coverage for SearchBlobError '{err}' — every structural reject must be pinned"
        );
    }
}

#[test]
fn attachment_blob_vectors() {
    use protocol::{
        aad_encrypt_attachment, aad_wrap_attachment_key, compute_attachment_id,
        decode_attachment_blob, encode_attachment_blob_raw, AttachmentBlobError,
    };

    let path = companion_vectors_root()
        .join("attachment-blob")
        .join("v0.1")
        .join("cases.json");

    if !path.exists() {
        eprintln!(
            "[skip] attachment-blob: companion repo fixture not present at {}",
            path.display()
        );
        return;
    }

    let raw = fs::read_to_string(&path).unwrap_or_else(|e| panic!("read {}: {e}", path.display()));
    let doc: serde_json::Value =
        serde_json::from_str(&raw).unwrap_or_else(|e| panic!("parse {}: {e}", path.display()));

    assert_eq!(doc["schema"], "attachment-blob");
    assert_eq!(doc["protocol_version"], "v0.1");

    let cases = doc["cases"].as_array().expect("cases must be a JSON array");
    assert!(
        !cases.is_empty(),
        "attachment-blob must have at least one case"
    );
    assert_unique_vector_ids("attachment-blob", cases);

    let mut seen_kinds = std::collections::HashSet::new();

    for case in cases {
        let id = case["vector_id"]
            .as_str()
            .expect("vector_id must be a string");
        let case_kind = case["case_kind"]
            .as_str()
            .unwrap_or_else(|| panic!("[{id}] missing case_kind"));
        seen_kinds.insert(case_kind.to_string());

        match case_kind {
            "encrypt" => {
                let items_key: [u8; 32] = hex_decode_array(field(case, id, "input_items_key_hex"));
                let items_key_id: [u8; 16] =
                    hex_decode_array(field(case, id, "input_items_key_id_hex"));
                let attachment_id: [u8; 32] =
                    hex_decode_array(field(case, id, "input_attachment_id_hex"));
                let content_type = hex_decode(field(case, id, "input_content_type_utf8_hex"));
                let attachment_key: [u8; 32] =
                    hex_decode_array(field(case, id, "input_attachment_key_hex"));
                let attachment_key_nonce: [u8; 24] =
                    hex_decode_array(field(case, id, "input_attachment_key_nonce_hex"));
                let content_nonce: [u8; 24] =
                    hex_decode_array(field(case, id, "input_content_nonce_hex"));
                let file = hex_decode(field(case, id, "input_file_plaintext_hex"));
                let expected = hex_decode(field(case, id, "expected_attachment_blob_hex"));

                let actual = encode_attachment_blob_raw(
                    &items_key,
                    &items_key_id,
                    &attachment_id,
                    &content_type,
                    &attachment_key,
                    &attachment_key_nonce,
                    &content_nonce,
                    &file,
                )
                .unwrap_or_else(|e| panic!("[{id}] encode_attachment_blob_raw failed: {e:?}"));

                assert_eq!(
                    actual.as_slice(),
                    expected.as_slice(),
                    "[{id}] attachment-blob encrypt mismatch\n  expected_hex: {}\n  actual_hex:   {}",
                    hex_encode(&expected),
                    hex_encode(&actual),
                );
            }
            "decrypt_ok" => {
                let blob = hex_decode(field(case, id, "input_attachment_blob_hex"));
                let attachment_id: [u8; 32] =
                    hex_decode_array(field(case, id, "input_attachment_id_hex"));
                let content_type = hex_decode(field(case, id, "input_content_type_utf8_hex"));
                let items_key: [u8; 32] = hex_decode_array(field(case, id, "input_items_key_hex"));
                let items_key_id: [u8; 16] =
                    hex_decode_array(field(case, id, "input_items_key_id_hex"));
                let expected = hex_decode(field(case, id, "expected_file_plaintext_hex"));

                let actual = decode_attachment_blob(
                    &blob,
                    &attachment_id,
                    &content_type,
                    &items_key,
                    &items_key_id,
                )
                .unwrap_or_else(|e| panic!("[{id}] decode_attachment_blob failed: {e:?}"));
                assert_eq!(
                    actual.as_slice(),
                    expected.as_slice(),
                    "[{id}] attachment-blob decrypt_ok mismatch"
                );
            }
            "decrypt_aead_fail" => {
                let blob = hex_decode(field(case, id, "input_attachment_blob_hex"));
                let attachment_id: [u8; 32] =
                    hex_decode_array(field(case, id, "input_attachment_id_hex"));
                let content_type = hex_decode(field(case, id, "input_content_type_utf8_hex"));
                let items_key: [u8; 32] = hex_decode_array(field(case, id, "input_items_key_hex"));
                let items_key_id: [u8; 16] =
                    hex_decode_array(field(case, id, "input_items_key_id_hex"));

                match decode_attachment_blob(&blob, &attachment_id, &content_type, &items_key, &items_key_id)
                {
                    Err(AttachmentBlobError::CannotDecrypt) => {}
                    Err(other) => panic!(
                        "[{id}] expected AttachmentBlobError::CannotDecrypt (non-distinguishing AEAD failure §6.4), got {other:?}"
                    ),
                    Ok(pt) => panic!(
                        "[{id}] expected AEAD failure, decode returned Ok ({} bytes)",
                        pt.len()
                    ),
                }
            }
            "aad_construction" => {
                let builder = field(case, id, "input_aad_builder");
                let items_key_id: [u8; 16] =
                    hex_decode_array(field(case, id, "input_items_key_id_hex"));
                let attachment_id: [u8; 32] =
                    hex_decode_array(field(case, id, "input_attachment_id_hex"));
                let expected = hex_decode(field(case, id, "expected_aad_hex"));

                let actual = match builder {
                    "aad_wrap_attachment_key" => {
                        aad_wrap_attachment_key(&items_key_id, &attachment_id)
                    }
                    "aad_encrypt_attachment" => {
                        let content_type =
                            hex_decode(field(case, id, "input_content_type_utf8_hex"));
                        aad_encrypt_attachment(&items_key_id, &attachment_id, &content_type)
                    }
                    other => panic!("[{id}] unknown aad builder '{other}'"),
                };
                assert_eq!(
                    actual.as_slice(),
                    expected.as_slice(),
                    "[{id}] {builder} AAD mismatch"
                );
            }
            "id_determinism" => {
                let root_key: [u8; 32] = hex_decode_array(field(case, id, "input_root_key_hex"));
                let file = hex_decode(field(case, id, "input_file_plaintext_hex"));
                let expected: [u8; 32] =
                    hex_decode_array(field(case, id, "expected_attachment_id_hex"));

                let actual = compute_attachment_id(&root_key, &file);
                assert_eq!(actual, expected, "[{id}] compute_attachment_id mismatch");
                // Determinism: a second call must match.
                assert_eq!(
                    compute_attachment_id(&root_key, &file),
                    actual,
                    "[{id}] compute_attachment_id is not deterministic"
                );
            }
            other => panic!("[{id}] unknown case_kind '{other}' — schema enforces enum"),
        }
    }

    for kind in [
        "encrypt",
        "decrypt_ok",
        "decrypt_aead_fail",
        "aad_construction",
        "id_determinism",
    ] {
        assert!(
            seen_kinds.contains(kind),
            "attachment-blob missing every case of case_kind '{kind}' — coverage regression"
        );
    }
}

#[test]
fn attachments_catalog_vectors() {
    use protocol::{
        aad_attachments_catalog, decode_attachments_catalog, derive_subkey,
        encode_attachments_catalog_raw, CatalogBlobError, SubkeyRole,
    };

    let path = companion_vectors_root()
        .join("attachments-catalog")
        .join("v0.1")
        .join("cases.json");

    if !path.exists() {
        eprintln!(
            "[skip] attachments-catalog: companion repo fixture not present at {}",
            path.display()
        );
        return;
    }

    let raw = fs::read_to_string(&path).unwrap_or_else(|e| panic!("read {}: {e}", path.display()));
    let doc: serde_json::Value =
        serde_json::from_str(&raw).unwrap_or_else(|e| panic!("parse {}: {e}", path.display()));

    assert_eq!(doc["schema"], "attachments-catalog");
    assert_eq!(doc["protocol_version"], "v0.1");

    let cases = doc["cases"].as_array().expect("cases must be a JSON array");
    assert!(
        !cases.is_empty(),
        "attachments-catalog must have at least one case"
    );
    assert_unique_vector_ids("attachments-catalog", cases);

    let mut seen_kinds = std::collections::HashSet::new();

    for case in cases {
        let id = case["vector_id"]
            .as_str()
            .expect("vector_id must be a string");
        let case_kind = case["case_kind"]
            .as_str()
            .unwrap_or_else(|| panic!("[{id}] missing case_kind"));
        seen_kinds.insert(case_kind.to_string());

        match case_kind {
            "encrypt" => {
                let root_key: [u8; 32] = hex_decode_array(field(case, id, "input_root_key_hex"));
                let account_hash: [u8; 16] =
                    hex_decode_array(field(case, id, "input_account_number_hash_hex"));
                let plaintext = hex_decode(field(case, id, "input_plaintext_canonical_utf8_hex"));
                let nonce: [u8; 24] = hex_decode_array(field(case, id, "input_catalog_nonce_hex"));
                let expected = hex_decode(field(case, id, "expected_catalog_blob_hex"));

                // The encoder takes a structured catalog, not raw plaintext;
                // round-trip the canonical bytes through decode to obtain the
                // catalog, then re-encode and assert byte equality (this also
                // pins that decode(plaintext) is the inverse of the encoder's
                // canonical_json_encode).
                let catalog_key = derive_subkey(&root_key, SubkeyRole::AttachmentsCatalogKey);
                // Build a throwaway blob from the pinned plaintext to recover
                // the structured catalog via the public decode path.
                let probe_blob = build_catalog_blob_from_plaintext(
                    &catalog_key,
                    &account_hash,
                    &plaintext,
                    &nonce,
                );
                let catalog = decode_attachments_catalog(&catalog_key, &account_hash, &probe_blob)
                    .unwrap_or_else(|e| panic!("[{id}] probe decode failed: {e:?}"));

                let actual =
                    encode_attachments_catalog_raw(&catalog_key, &account_hash, &catalog, &nonce)
                        .unwrap_or_else(|e| panic!("[{id}] encode failed: {e:?}"));
                assert_eq!(
                    actual.as_slice(),
                    expected.as_slice(),
                    "[{id}] attachments-catalog encrypt mismatch\n  expected_hex: {}\n  actual_hex:   {}",
                    hex_encode(&expected),
                    hex_encode(&actual),
                );
            }
            "decrypt_ok" => {
                let blob = hex_decode(field(case, id, "input_blob_hex"));
                let root_key: [u8; 32] = hex_decode_array(field(case, id, "input_root_key_hex"));
                let account_hash: [u8; 16] =
                    hex_decode_array(field(case, id, "input_account_number_hash_hex"));
                let expected_pt =
                    hex_decode(field(case, id, "expected_plaintext_canonical_utf8_hex"));

                let catalog_key = derive_subkey(&root_key, SubkeyRole::AttachmentsCatalogKey);
                let catalog = decode_attachments_catalog(&catalog_key, &account_hash, &blob)
                    .unwrap_or_else(|e| panic!("[{id}] decode failed: {e:?}"));
                // Verify the decoded catalog equals the catalog the pinned
                // canonical plaintext parses to: build a blob from the
                // expected plaintext bytes and decode it through the same
                // public path, then compare the two structured catalogs.
                let nonce = [0u8; 24];
                let pt_blob = build_catalog_blob_from_plaintext(
                    &catalog_key,
                    &account_hash,
                    &expected_pt,
                    &nonce,
                );
                let catalog_from_pt =
                    decode_attachments_catalog(&catalog_key, &account_hash, &pt_blob)
                        .unwrap_or_else(|e| {
                            panic!("[{id}] expected_plaintext did not decode: {e:?}")
                        });
                assert_eq!(
                    catalog, catalog_from_pt,
                    "[{id}] decoded catalog disagrees with expected canonical plaintext"
                );
            }
            "decrypt_aead_fail" => {
                let blob = hex_decode(field(case, id, "input_blob_hex"));
                let root_key: [u8; 32] = hex_decode_array(field(case, id, "input_root_key_hex"));
                let account_hash: [u8; 16] =
                    hex_decode_array(field(case, id, "input_account_number_hash_hex"));

                let catalog_key = derive_subkey(&root_key, SubkeyRole::AttachmentsCatalogKey);
                match decode_attachments_catalog(&catalog_key, &account_hash, &blob) {
                    Err(CatalogBlobError::CannotDecrypt) => {}
                    Err(other) => panic!(
                        "[{id}] expected CatalogBlobError::CannotDecrypt (non-distinguishing AEAD failure §6.4), got {other:?}"
                    ),
                    Ok(view) => panic!("[{id}] expected AEAD failure, decode returned Ok({view:?})"),
                }
            }
            "aad_construction" => {
                let account_hash: [u8; 16] =
                    hex_decode_array(field(case, id, "input_account_number_hash_hex"));
                let expected = hex_decode(field(case, id, "expected_aad_hex"));
                let actual = aad_attachments_catalog(&account_hash);
                assert_eq!(
                    actual.as_slice(),
                    expected.as_slice(),
                    "[{id}] aad_attachments_catalog mismatch"
                );
            }
            other => panic!("[{id}] unknown case_kind '{other}' — schema enforces enum"),
        }
    }

    for kind in [
        "encrypt",
        "decrypt_ok",
        "decrypt_aead_fail",
        "aad_construction",
    ] {
        assert!(
            seen_kinds.contains(kind),
            "attachments-catalog missing every case of case_kind '{kind}' — coverage regression"
        );
    }
}

/// Helper: build a MYC1 blob directly from a canonical-JSON plaintext,
/// so the runner can recover the structured catalog from a pinned
/// plaintext via the public decode path. Mirrors the encoder's
/// envelope assembly (34-byte header + AEAD-sealed plaintext).
fn build_catalog_blob_from_plaintext(
    catalog_key: &[u8; 32],
    account_hash: &[u8; 16],
    plaintext: &[u8],
    nonce: &[u8; 24],
) -> Vec<u8> {
    use protocol::{aad_attachments_catalog, aead_seal_ctx, CATALOG_BLOB_MAGIC};
    let aad = aad_attachments_catalog(account_hash);
    let sealed = aead_seal_ctx(catalog_key, nonce, plaintext, &aad).expect("seal");
    let mut blob = Vec::with_capacity(34 + sealed.len());
    blob.extend_from_slice(&CATALOG_BLOB_MAGIC);
    blob.push(0x01);
    blob.push(0x00);
    blob.extend_from_slice(nonce);
    blob.extend_from_slice(&(sealed.len() as u32).to_be_bytes());
    blob.extend_from_slice(&sealed);
    blob
}

/// Helper: fetch a required string field, panicking with the vector id
/// on absence. Trims the repetitive `unwrap_or_else` boilerplate the
/// older runners spell out inline.
fn field<'a>(case: &'a serde_json::Value, id: &str, key: &str) -> &'a str {
    case[key]
        .as_str()
        .unwrap_or_else(|| panic!("[{id}] missing {key}"))
}

#[test]
fn damm32_table_vectors() {
    use protocol::damm32_table;

    let path = companion_vectors_root()
        .join("damm32-table")
        .join("v0.1")
        .join("cases.json");

    if !path.exists() {
        eprintln!(
            "[skip] damm32-table: companion repo fixture not present at {}",
            path.display()
        );
        return;
    }

    let raw = fs::read_to_string(&path).unwrap_or_else(|e| panic!("read {}: {e}", path.display()));
    let doc: serde_json::Value =
        serde_json::from_str(&raw).unwrap_or_else(|e| panic!("parse {}: {e}", path.display()));

    assert_eq!(doc["schema"], "damm32-table");
    assert_eq!(doc["protocol_version"], "v0.1");

    let cases = doc["cases"].as_array().expect("cases must be a JSON array");
    assert!(
        !cases.is_empty(),
        "damm32-table must have at least one case"
    );
    assert_unique_vector_ids("damm32-table", cases);

    // The reference table (frozen const, exposed via the public accessor).
    let table = damm32_table();

    let mut saw_table = false;
    for case in cases {
        let id = case["vector_id"]
            .as_str()
            .expect("vector_id must be a string");
        let case_kind = case["case_kind"]
            .as_str()
            .unwrap_or_else(|| panic!("[{id}] missing case_kind"));

        match case_kind {
            "table" => {
                saw_table = true;
                let expected = hex_decode(
                    case["expected_table_hex"]
                        .as_str()
                        .unwrap_or_else(|| panic!("[{id}] missing expected_table_hex")),
                );
                assert_eq!(
                    expected.len(),
                    1024,
                    "[{id}] expected_table_hex must decode to 1024 bytes, got {}",
                    expected.len()
                );
                // Row-major flatten of the reference table.
                let mut actual = Vec::with_capacity(1024);
                for row in table.iter() {
                    actual.extend_from_slice(row);
                }
                assert_eq!(
                    actual,
                    expected,
                    "[{id}] damm32 table mismatch (row-major)\n  expected_hex: {}\n  actual_hex:   {}",
                    hex_encode(&expected),
                    hex_encode(&actual),
                );
            }
            "checksum" => {
                let indices: Vec<u8> = case["input_entropy_indices"]
                    .as_array()
                    .unwrap_or_else(|| panic!("[{id}] missing input_entropy_indices"))
                    .iter()
                    .map(|v| {
                        let n = v
                            .as_u64()
                            .unwrap_or_else(|| panic!("[{id}] index not an integer"));
                        assert!(n < 32, "[{id}] index {n} out of range 0..32");
                        n as u8
                    })
                    .collect();
                let expected = case["expected_check_index"]
                    .as_u64()
                    .unwrap_or_else(|| panic!("[{id}] missing expected_check_index"));
                assert!(expected < 32, "[{id}] expected_check_index out of range");

                // Fold left from interim 0 through the reference table — the
                // same operation a port runs against its derived table.
                let mut interim = 0usize;
                for &d in &indices {
                    interim = table[interim][d as usize] as usize;
                }
                assert_eq!(
                    interim as u64, expected,
                    "[{id}] checksum mismatch: folded {interim}, expected {expected}"
                );
            }
            other => panic!("[{id}] unknown case_kind '{other}'"),
        }
    }

    assert!(
        saw_table,
        "damm32-table must include the full 'table' case (the cross-impl ground truth)"
    );
}
