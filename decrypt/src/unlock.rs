// SPDX-License-Identifier: AGPL-3.0
//! The unlock path for `myne-decrypt`: derive `root_key` and `items_key` from
//! the master password or recovery phrase, for both on-disk generations.
//!
//! This is the same derivation the app's `vault_unlock` plugin runs, re-expressed
//! against the `protocol` crate directly (the CLI has no `VaultRuntimeState`).
//! The error discipline is the §6.4 non-distinguishing collapse: a wrong
//! password, a wrong phrase, and a tampered `vault.meta` all surface as one
//! answer, so the tool cannot be used as a credential oracle.

use protocol::{MetaVersion, VaultMeta};
use zeroize::Zeroizing;

/// The material the export walk needs: the per-vault `items_key` (and its id)
/// plus the `root_key` (for the prefs + catalog subkeys).
pub struct UnlockedVault {
    pub root_key: Zeroizing<[u8; 32]>,
    pub items_key: Zeroizing<[u8; 32]>,
    pub items_key_id: [u8; 16],
    pub version: MetaVersion,
}

/// A non-distinguishing unlock failure (§6.4). One variant on purpose.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum UnlockError {
    /// The credential did not open the vault, or the meta is corrupt. The two
    /// are deliberately indistinguishable.
    InvalidCredentialOrVault,
    /// The `vault.meta` bytes are not a well-formed vault of either generation.
    InvalidVaultMeta,
}

/// Read `vault.meta` from `vault_dir` and parse it as either generation.
fn read_meta(vault_dir: &std::path::Path) -> Result<(VaultMeta, MetaVersion), UnlockError> {
    let bytes =
        std::fs::read(vault_dir.join("vault.meta")).map_err(|_| UnlockError::InvalidVaultMeta)?;
    let version = protocol::meta_version_of(&bytes).ok_or(UnlockError::InvalidVaultMeta)?;
    let meta = protocol::parse_vault_meta_any(&bytes).map_err(|_| UnlockError::InvalidVaultMeta)?;
    Ok((meta, version))
}

/// Derive `root_key` from the master password, for either generation.
fn root_key_from_password(
    password: &str,
    meta: &VaultMeta,
    version: MetaVersion,
) -> Result<Zeroizing<[u8; 32]>, UnlockError> {
    protocol::validate_kdf_params(&meta.kdf_params).map_err(|_| UnlockError::InvalidVaultMeta)?;
    match version {
        MetaVersion::V0_1 => {
            let wrap_key = protocol::derive_password_wrap_key(
                password,
                &meta.random_salt_password,
                &meta.account_number_hash,
                &meta.kdf_params,
            )
            .map_err(|_| UnlockError::InvalidCredentialOrVault)?;
            let aad = protocol::aad_password_wrap(&meta.kdf_params);
            open_32(
                &wrap_key,
                &meta.nonce_password_wrap,
                &meta.enc_root_key_password,
                &aad,
            )
        }
        MetaVersion::V0_2 => {
            protocol::unlock_root_key_v0_2_password(meta, password, &meta.account_number_hash)
                .map_err(|_| UnlockError::InvalidCredentialOrVault)
        }
    }
}

/// Derive `root_key` from the normalized recovery phrase, for either generation.
fn root_key_from_phrase(
    phrase_normalized: &str,
    meta: &VaultMeta,
    version: MetaVersion,
) -> Result<Zeroizing<[u8; 32]>, UnlockError> {
    protocol::validate_kdf_params(&meta.kdf_params).map_err(|_| UnlockError::InvalidVaultMeta)?;
    match version {
        MetaVersion::V0_1 => {
            let wrap_key = protocol::derive_recovery_wrap_key_from_normalized(
                phrase_normalized,
                &meta.random_salt_recovery,
                &meta.account_number_hash,
                &meta.kdf_params,
            )
            .map_err(|_| UnlockError::InvalidCredentialOrVault)?;
            let aad = protocol::aad_recovery_wrap(&meta.kdf_params);
            open_32(
                &wrap_key,
                &meta.nonce_recovery_wrap,
                &meta.enc_root_key_recovery,
                &aad,
            )
        }
        MetaVersion::V0_2 => protocol::unlock_root_key_v0_2_recovery(
            meta,
            phrase_normalized,
            &meta.account_number_hash,
        )
        .map_err(|_| UnlockError::InvalidCredentialOrVault),
    }
}

/// Derive `items_key` from `root_key`, for either generation.
fn items_key_from_root(
    root_key: &[u8; 32],
    meta: &VaultMeta,
    version: MetaVersion,
) -> Result<Zeroizing<[u8; 32]>, UnlockError> {
    match version {
        MetaVersion::V0_1 => {
            protocol::derive_items_key(root_key, meta).map_err(|_| UnlockError::InvalidVaultMeta)
        }
        MetaVersion::V0_2 => protocol::derive_items_key_v0_2(root_key, meta)
            .map_err(|_| UnlockError::InvalidVaultMeta),
    }
}

/// AEAD-open a 32-byte secret and copy it into a fresh `Zeroizing` array.
fn open_32(
    wrap_key: &[u8; 32],
    nonce: &[u8; 24],
    sealed: &[u8],
    aad: &[u8],
) -> Result<Zeroizing<[u8; 32]>, UnlockError> {
    let plaintext = protocol::aead_open_ctx(wrap_key, nonce, sealed, aad)
        .map_err(|_| UnlockError::InvalidCredentialOrVault)?;
    if plaintext.len() != 32 {
        return Err(UnlockError::InvalidCredentialOrVault);
    }
    let mut out = Zeroizing::new([0u8; 32]);
    out.copy_from_slice(&plaintext);
    Ok(out)
}

/// Unlock a vault directory with the master password.
pub fn unlock_with_password(
    vault_dir: &std::path::Path,
    password: &str,
) -> Result<UnlockedVault, UnlockError> {
    let (meta, version) = read_meta(vault_dir)?;
    eprint!("Deriving the vault key (Argon2id, ~1-3 s)... ");
    let root_key = root_key_from_password(password, &meta, version)?;
    let items_key = items_key_from_root(&root_key, &meta, version)?;
    eprintln!("done");
    Ok(UnlockedVault {
        root_key,
        items_key,
        items_key_id: meta.items_key_id,
        version,
    })
}

/// Unlock a vault directory with the normalized recovery phrase.
pub fn unlock_with_phrase(
    vault_dir: &std::path::Path,
    phrase_normalized: &str,
) -> Result<UnlockedVault, UnlockError> {
    let (meta, version) = read_meta(vault_dir)?;
    eprint!("Deriving the vault key (Argon2id, ~1-3 s)... ");
    let root_key = root_key_from_phrase(phrase_normalized, &meta, version)?;
    let items_key = items_key_from_root(&root_key, &meta, version)?;
    eprintln!("done");
    Ok(UnlockedVault {
        root_key,
        items_key,
        items_key_id: meta.items_key_id,
        version,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use protocol::{KdfParams, SubkeyRole};

    /// Fast Argon2id parameters for tests, pinned to the `validate_kdf_params`
    /// memory floor so a vault built here still passes the unlock range gate
    /// while staying ~32x cheaper than production.
    const FAST_TEST_KDF: KdfParams = KdfParams {
        m_kib: protocol::MIN_KDF_M_KIB,
        t: 1,
        p: 1,
        argon2_version: 0x13,
    };

    /// Build a real v0.2 (`NTV5`) `vault.meta` under `password`, returning the
    /// serialized bytes plus the `root_key` and `items_key` it wraps (so the
    /// test can assert the unlock path recovers them byte-exactly).
    fn build_v0_2_vault(password: &str) -> (Vec<u8>, [u8; 32], [u8; 32], String) {
        let account = protocol::generate_account_number().expect("account");
        let phrase = protocol::generate_recovery_phrase().expect("phrase");
        let root_key = protocol::generate_root_key().expect("root_key");
        let salt_password = [1u8; 16];
        let salt_recovery = [2u8; 16];

        let password_wrap_key = protocol::derive_password_wrap_key_v0_2(
            password,
            &salt_password,
            &account.hash,
            &FAST_TEST_KDF,
        )
        .expect("password wrap key");
        let recovery_wrap_key = protocol::derive_recovery_wrap_key_v0_2(
            &phrase,
            &salt_recovery,
            &account.hash,
            &FAST_TEST_KDF,
        )
        .expect("recovery wrap key");

        let aad_pw = protocol::aad_password_wrap_v0_2(&FAST_TEST_KDF);
        let nonce_pw = [3u8; 24];
        let enc_root_pw =
            protocol::aead_seal_ctx(&password_wrap_key, &nonce_pw, root_key.as_slice(), &aad_pw)
                .expect("seal password wrap");

        let aad_rec = protocol::aad_recovery_wrap_v0_2(&FAST_TEST_KDF);
        let nonce_rec = [4u8; 24];
        let enc_root_rec = protocol::aead_seal_ctx(
            &recovery_wrap_key,
            &nonce_rec,
            root_key.as_slice(),
            &aad_rec,
        )
        .expect("seal recovery wrap");

        let items_wrap_key = protocol::derive_subkey_versioned(
            MetaVersion::V0_2,
            &root_key,
            SubkeyRole::ItemsKeyWrap,
        );
        let items_key = protocol::generate_root_key().expect("items_key");
        let items_key_id = [5u8; 16];
        let aad_items = protocol::aad_vault_items_key_wrap_v0_2(&items_key_id);
        let nonce_items = [6u8; 24];
        let enc_items = protocol::aead_seal_ctx(
            &items_wrap_key,
            &nonce_items,
            items_key.as_slice(),
            &aad_items,
        )
        .expect("seal items_key");

        let meta = protocol::VaultMeta {
            account_number_hash: account.hash,
            kdf_params: FAST_TEST_KDF,
            random_salt_password: salt_password,
            random_salt_recovery: salt_recovery,
            nonce_password_wrap: nonce_pw,
            enc_root_key_password: enc_root_pw.as_slice().try_into().expect("64 bytes"),
            nonce_recovery_wrap: nonce_rec,
            enc_root_key_recovery: enc_root_rec.as_slice().try_into().expect("64 bytes"),
            items_key_id,
            items_key_nonce: nonce_items,
            enc_items_key: enc_items.as_slice().try_into().expect("64 bytes"),
            membership: None,
        };
        let bytes = protocol::serialize_vault_meta_v0_2(&meta);
        let phrase_normalized = phrase.join_normalized().to_string();
        (bytes, *root_key, *items_key, phrase_normalized)
    }

    /// Write `bytes` to a temp dir's `vault.meta` and return the dir.
    fn write_vault(bytes: &[u8]) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("myne-decrypt-test-{}", uuid_like()));
        std::fs::create_dir_all(&dir).expect("temp dir");
        std::fs::write(dir.join("vault.meta"), bytes).expect("write vault.meta");
        dir
    }

    /// A unique-enough suffix without pulling `uuid` as a dev-dep.
    fn uuid_like() -> String {
        use std::time::{SystemTime, UNIX_EPOCH};
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock")
            .as_nanos();
        format!("{nanos}")
    }

    #[test]
    fn password_unlock_recovers_root_and_items_key() {
        let (bytes, root_key, items_key, _) = build_v0_2_vault("correct horse battery staple");
        let dir = write_vault(&bytes);
        let unlocked = unlock_with_password(&dir, "correct horse battery staple").expect("unlock");
        assert_eq!(*unlocked.root_key, root_key);
        assert_eq!(*unlocked.items_key, items_key);
        assert_eq!(unlocked.version, MetaVersion::V0_2);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn phrase_unlock_recovers_root_and_items_key() {
        let (bytes, root_key, items_key, phrase) = build_v0_2_vault("pw");
        let dir = write_vault(&bytes);
        let unlocked = unlock_with_phrase(&dir, &phrase).expect("unlock");
        assert_eq!(*unlocked.root_key, root_key);
        assert_eq!(*unlocked.items_key, items_key);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn a_wrong_password_is_non_distinguishing() {
        let (bytes, _, _, _) = build_v0_2_vault("the real password");
        let dir = write_vault(&bytes);
        assert!(matches!(
            unlock_with_password(&dir, "wrong password"),
            Err(UnlockError::InvalidCredentialOrVault)
        ));
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn a_missing_vault_meta_is_invalid_vault_meta() {
        let dir = std::env::temp_dir().join(format!("myne-decrypt-empty-{}", uuid_like()));
        std::fs::create_dir_all(&dir).expect("temp dir");
        assert!(matches!(
            unlock_with_password(&dir, "anything"),
            Err(UnlockError::InvalidVaultMeta)
        ));
        std::fs::remove_dir_all(&dir).ok();
    }
}
