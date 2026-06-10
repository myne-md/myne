// SPDX-License-Identifier: AGPL-3.0-or-later
//! E2E fixture generator — unlockable `vaults/<id>/vault.meta` layouts
//! with known credentials (e2e-harness task 5; epic policy SYNC-2/9).
//!
//! Composes the SAME protocol public API the production creation path
//! does (`src-tauri/src/plugins/vault_creation/commands.rs::
//! {build_session, build_and_serialize_vault_meta}`), so a generated
//! fixture unlocks through the untouched production unlock path. Weak
//! KDF params are legal at read time because unlock derives from the
//! params stored INSIDE `vault.meta` (`protocol::parse_kdf_params`
//! imposes no minimums); production code keeps its pinned
//! `DEFAULT_V0_1_KDF_PARAMS` at creation — no production branch exists
//! or is added here (SYNC-9).
//!
//! Also the home of the byte-surgery offset table the TS fault-
//! injection helpers mirror (`e2e/support/fixtures.ts`). The tests pin
//! each offset SEMANTICALLY (tampering a field breaks exactly the
//! unwrap that field participates in), so a layout change in
//! `protocol::serialize_vault_meta` fails here before it can silently
//! desync the TS mirror.

use std::fs;
use std::path::Path;

use protocol::{
    aad_password_wrap, aad_recovery_wrap, aad_vault_items_key_wrap, aead_open_ctx, aead_seal_ctx,
    derive_password_wrap_key, derive_recovery_wrap_key, derive_subkey, generate_account_number,
    generate_recovery_phrase, generate_root_key, parse_vault_meta, serialize_vault_meta, KdfParams,
    ProtocolError, SubkeyRole, VaultMeta, AEAD_KEY_LEN, AEAD_NONCE_LEN, ARGON2_SALT_LEN,
    VAULT_META_LEN,
};
use zeroize::Zeroizing;

/// Weak Argon2id parameters for fast fixtures (RFC 9106 minimum) —
/// mirrors `src-tauri/src/test_support.rs::FAST_TEST_KDF`. Lives only
/// in fixture bytes, never in production code (SYNC-9).
pub const WEAK_TEST_KDF: KdfParams = KdfParams {
    m_kib: 8,
    t: 1,
    p: 1,
    argon2_version: 0x13,
};

/// § 9.3 byte offsets of `vault.meta` fields. The TS mirror lives in
/// `e2e/support/fixtures.ts` (`VAULT_META_OFFSETS`) — keep in lockstep;
/// the tests below pin the semantics of each entry.
pub mod offsets {
    /// `"MYV1"` magic.
    pub const MAGIC: usize = 0;
    pub const ACCOUNT_HASH: usize = 6;
    pub const KDF_PARAMS: usize = 22;
    pub const SALT_PASSWORD: usize = 33;
    pub const SALT_RECOVERY: usize = 49;
    pub const NONCE_PASSWORD_WRAP: usize = 65;
    pub const ENC_ROOT_KEY_PASSWORD: usize = 89;
    pub const NONCE_RECOVERY_WRAP: usize = 153;
    pub const ENC_ROOT_KEY_RECOVERY: usize = 177;
    pub const ITEMS_KEY_ID: usize = 241;
    pub const ITEMS_KEY_NONCE: usize = 257;
    pub const ENC_ITEMS_KEY: usize = 281;
    pub const END: usize = 345;
}

/// Everything a scenario needs to drive the generated vault.
pub struct Fixture {
    /// Canonical lowercase-hyphenated UUIDv7 — the `vaults/<id>/` dir name.
    pub vault_id: String,
    pub password: String,
    /// 24 space-joined lowercase BIP-39 words.
    pub phrase: String,
    /// 27-char display account number (`MY-` + 5×4 groups).
    pub account: String,
    /// The serialized 345-byte `vault.meta`.
    pub meta_bytes: [u8; VAULT_META_LEN],
}

fn random_bytes<const N: usize>() -> Result<[u8; N], ProtocolError> {
    let mut buf = [0u8; N];
    getrandom::getrandom(&mut buf).map_err(|_| ProtocolError::Csprng)?;
    Ok(buf)
}

fn seal_32(
    wrap_key: &[u8; AEAD_KEY_LEN],
    plaintext: &[u8; AEAD_KEY_LEN],
    aad: &[u8],
) -> Result<([u8; AEAD_NONCE_LEN], [u8; 64]), ProtocolError> {
    let nonce: [u8; AEAD_NONCE_LEN] = random_bytes()?;
    let sealed = aead_seal_ctx(wrap_key, &nonce, plaintext, aad)?;
    let blob: [u8; 64] = sealed
        .as_slice()
        .try_into()
        .expect("32-byte plaintext + 32-byte CTX tag = 64 bytes");
    Ok((nonce, blob))
}

/// Build one in-memory fixture (mirror of the production
/// `build_session` + `build_and_serialize_vault_meta` composition).
pub fn build_fixture(password: &str, kdf_params: KdfParams) -> Result<Fixture, ProtocolError> {
    let account = generate_account_number()?;
    let phrase = generate_recovery_phrase()?;
    let root_key = generate_root_key()?;

    let salt_password: [u8; ARGON2_SALT_LEN] = random_bytes()?;
    let salt_recovery: [u8; ARGON2_SALT_LEN] = random_bytes()?;

    let password_wrap_key =
        derive_password_wrap_key(password, &salt_password, &account.hash, &kdf_params)?;
    let recovery_wrap_key =
        derive_recovery_wrap_key(&phrase, &salt_recovery, &account.hash, &kdf_params)?;

    let aad_pw = aad_password_wrap(&kdf_params);
    let (nonce_password_wrap, enc_root_key_password) =
        seal_32(&password_wrap_key, &root_key, &aad_pw)?;

    let aad_rec = aad_recovery_wrap(&kdf_params);
    let (nonce_recovery_wrap, enc_root_key_recovery) =
        seal_32(&recovery_wrap_key, &root_key, &aad_rec)?;

    let items_wrap_key = derive_subkey(&root_key, SubkeyRole::ItemsKeyWrap);
    let items_key = generate_root_key()?;
    let items_key_id: [u8; 16] = *uuid::Uuid::now_v7().as_bytes();
    let aad_items = aad_vault_items_key_wrap(&items_key_id);
    let (items_key_nonce, enc_items_key) = seal_32(&items_wrap_key, &items_key, &aad_items)?;

    let meta = VaultMeta {
        account_number_hash: account.hash,
        kdf_params,
        random_salt_password: salt_password,
        random_salt_recovery: salt_recovery,
        nonce_password_wrap,
        enc_root_key_password,
        nonce_recovery_wrap,
        enc_root_key_recovery,
        items_key_id,
        items_key_nonce,
        enc_items_key,
    };

    Ok(Fixture {
        vault_id: uuid::Uuid::now_v7().hyphenated().to_string().to_lowercase(),
        password: password.to_string(),
        phrase: phrase.words().join(" "),
        account: account.display.clone(),
        meta_bytes: serialize_vault_meta(&meta),
    })
}

/// Write `fixture` as `<base>/vaults/<vault_id>/vault.meta`.
/// `base` is the app-data dir (`<XDG_DATA_HOME>/md.myne.desktop`).
pub fn write_fixture(base: &Path, fixture: &Fixture) -> std::io::Result<()> {
    let dir = base.join("vaults").join(&fixture.vault_id);
    fs::create_dir_all(&dir)?;
    fs::write(dir.join("vault.meta"), fixture.meta_bytes)
}

/// Verification helper used by the tests (and reusable from future
/// vector work): unwrap `root_key` from serialized meta bytes via the
/// password side — the same math the production unlock performs.
pub fn unwrap_root_key_with_password(
    bytes: &[u8],
    password: &str,
) -> Result<Zeroizing<Vec<u8>>, ProtocolError> {
    let meta = parse_vault_meta(bytes)?;
    let wrap = derive_password_wrap_key(
        password,
        &meta.random_salt_password,
        &meta.account_number_hash,
        &meta.kdf_params,
    )?;
    let aad = aad_password_wrap(&meta.kdf_params);
    aead_open_ctx(
        &wrap,
        &meta.nonce_password_wrap,
        &meta.enc_root_key_password,
        &aad,
    )
}

/// Recovery-side twin of [`unwrap_root_key_with_password`].
pub fn unwrap_root_key_with_phrase(
    bytes: &[u8],
    normalized_phrase: &str,
) -> Result<Zeroizing<Vec<u8>>, ProtocolError> {
    let meta = parse_vault_meta(bytes)?;
    let wrap = protocol::derive_recovery_wrap_key_from_normalized(
        normalized_phrase,
        &meta.random_salt_recovery,
        &meta.account_number_hash,
        &meta.kdf_params,
    )?;
    let aad = aad_recovery_wrap(&meta.kdf_params);
    aead_open_ctx(
        &wrap,
        &meta.nonce_recovery_wrap,
        &meta.enc_root_key_recovery,
        &aad,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    const PW: &str = "e2e-fixture-password-1";

    #[test]
    fn weak_fixture_round_trips_both_unwrap_paths() {
        let f = build_fixture(PW, WEAK_TEST_KDF).expect("build");
        assert_eq!(f.meta_bytes.len(), VAULT_META_LEN);

        // Password side opens (the production unlock math).
        let root_pw = unwrap_root_key_with_password(&f.meta_bytes, PW).expect("password unwrap");
        // Recovery side opens to the SAME root key.
        let root_rec =
            unwrap_root_key_with_phrase(&f.meta_bytes, &f.phrase).expect("phrase unwrap");
        assert_eq!(root_pw.as_slice(), root_rec.as_slice());

        // Items key unwraps under the derived subkey (the post-unlock step).
        let meta = parse_vault_meta(&f.meta_bytes).expect("parse");
        let root: [u8; 32] = root_pw.as_slice().try_into().expect("32-byte root");
        let items_wrap = derive_subkey(&root, SubkeyRole::ItemsKeyWrap);
        let aad = aad_vault_items_key_wrap(&meta.items_key_id);
        aead_open_ctx(
            &items_wrap,
            &meta.items_key_nonce,
            &meta.enc_items_key,
            &aad,
        )
        .expect("items key unwrap");
    }

    #[test]
    fn wrong_password_and_wrong_phrase_fail_closed() {
        let f = build_fixture(PW, WEAK_TEST_KDF).expect("build");
        assert!(unwrap_root_key_with_password(&f.meta_bytes, "not-the-password").is_err());
        let wrong_phrase = "abandon ".repeat(23) + "about";
        assert!(unwrap_root_key_with_phrase(&f.meta_bytes, &wrong_phrase).is_err());
    }

    /// Pins the § 9.3 offset table SEMANTICALLY: a single tampered byte
    /// at `ENC_ROOT_KEY_RECOVERY` must break exactly the recovery
    /// unwrap while the password unwrap stays green (and vice versa).
    /// If `serialize_vault_meta`'s layout ever shifts, this fails before
    /// the TS mirror (`e2e/support/fixtures.ts`) can drift silently.
    #[test]
    fn byte_surgery_offsets_hit_the_advertised_fields() {
        let f = build_fixture(PW, WEAK_TEST_KDF).expect("build");

        // Tamper recovery wrap → recovery fails, password unaffected.
        let mut tampered = f.meta_bytes;
        tampered[offsets::ENC_ROOT_KEY_RECOVERY] ^= 0xff;
        assert!(unwrap_root_key_with_password(&tampered, PW).is_ok());
        assert!(unwrap_root_key_with_phrase(&tampered, &f.phrase).is_err());

        // Tamper password wrap → password fails, recovery unaffected.
        let mut tampered = f.meta_bytes;
        tampered[offsets::ENC_ROOT_KEY_PASSWORD] ^= 0xff;
        assert!(unwrap_root_key_with_password(&tampered, PW).is_err());
        assert!(unwrap_root_key_with_phrase(&tampered, &f.phrase).is_ok());

        // Tamper items wrap → both root unwraps fine, items unwrap fails.
        let mut tampered = f.meta_bytes;
        tampered[offsets::ENC_ITEMS_KEY] ^= 0xff;
        let root = unwrap_root_key_with_password(&tampered, PW).expect("root ok");
        let meta = parse_vault_meta(&tampered).expect("parse ok");
        let root: [u8; 32] = root.as_slice().try_into().unwrap();
        let items_wrap = derive_subkey(&root, SubkeyRole::ItemsKeyWrap);
        let aad = aad_vault_items_key_wrap(&meta.items_key_id);
        assert!(aead_open_ctx(
            &items_wrap,
            &meta.items_key_nonce,
            &meta.enc_items_key,
            &aad
        )
        .is_err());

        // Tamper magic → structural parse failure (fail-closed class).
        let mut tampered = f.meta_bytes;
        tampered[offsets::MAGIC] ^= 0xff;
        assert!(parse_vault_meta(&tampered).is_err());

        // Layout arithmetic stays glued to the protocol constants.
        assert_eq!(offsets::END, VAULT_META_LEN);
        assert_eq!(
            offsets::ENC_ROOT_KEY_PASSWORD + 64,
            offsets::NONCE_RECOVERY_WRAP
        );
        assert_eq!(offsets::ENC_ROOT_KEY_RECOVERY + 64, offsets::ITEMS_KEY_ID);
        assert_eq!(offsets::ENC_ITEMS_KEY + 64, offsets::END);
    }

    #[test]
    fn write_fixture_lays_out_the_vaults_dir() {
        let f = build_fixture(PW, WEAK_TEST_KDF).expect("build");
        let tmp = std::env::temp_dir().join(format!("fixture-gen-test-{}", f.vault_id));
        write_fixture(&tmp, &f).expect("write");
        let on_disk = std::fs::read(tmp.join("vaults").join(&f.vault_id).join("vault.meta"))
            .expect("read back");
        assert_eq!(on_disk, f.meta_bytes);
        std::fs::remove_dir_all(&tmp).ok();
    }
}
