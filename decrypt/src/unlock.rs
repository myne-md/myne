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
    /// Present for an `NTV6` vault (the group tier the export walk needs).
    pub group_key: Option<Zeroizing<[u8; 32]>>,
    pub items_key: Zeroizing<[u8; 32]>,
    pub items_key_id: [u8; 16],
    pub version: MetaVersion,
}

/// A non-distinguishing unlock failure (§6.4), plus the two refusals that are
/// NOT about the credential.
///
/// The split is deliberate. A wrong password and a tampered frame stay one
/// answer, because distinguishing them would make this tool a credential oracle.
/// "This file is a generation I do not know" and "this vault has no identity
/// wrap" are different: neither is a guess about a secret, both are facts the
/// user can act on, and collapsing them into `InvalidVaultMeta` tells somebody
/// with a vault from a newer release that their vault is corrupt.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum UnlockError {
    /// The credential did not open the vault, or the meta is corrupt. The two
    /// are deliberately indistinguishable.
    InvalidCredentialOrVault,
    /// The `vault.meta` bytes are not a well-formed vault of any known
    /// generation, and are too short to even carry a magic.
    InvalidVaultMeta,
    /// The magic is not a generation this build knows. Carries the four bytes so
    /// the caller can name what it found: "vault.meta unreadable" gives a user
    /// holding a vault from a newer Myne nothing to do, and the fix is an
    /// upgrade rather than a restore.
    UnsupportedGeneration([u8; 4]),
    /// The vault is `NTV8` or later: it carries no person wrap, so the identity
    /// phrase is an identity rather than a vault credential. Reported by name
    /// because the user almost certainly has the right words and is being told
    /// they are the wrong KIND of words, which no AEAD failure can say.
    NotPersonWrapped,
}

/// Read `vault.meta` from `vault_dir` and parse it as either generation.
fn read_meta(
    vault_dir: &std::path::Path,
) -> Result<(VaultMeta, MetaVersion, Vec<u8>), UnlockError> {
    let bytes =
        std::fs::read(vault_dir.join("vault.meta")).map_err(|_| UnlockError::InvalidVaultMeta)?;
    let version = match protocol::meta_version_of(&bytes) {
        Some(v) => v,
        // A file too short to carry a magic is corrupt, not from the future.
        None => {
            return Err(match bytes.get(0..4) {
                Some(m) => UnlockError::UnsupportedGeneration([m[0], m[1], m[2], m[3]]),
                None => UnlockError::InvalidVaultMeta,
            })
        }
    };
    let meta = protocol::parse_vault_meta_any(&bytes).map_err(|_| UnlockError::InvalidVaultMeta)?;
    Ok((meta, version, bytes))
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

/// Derive `items_key` (and the group key for an `NTV6` vault) from `root_key`.
#[allow(clippy::type_complexity)]
fn items_key_from_root(
    root_key: &[u8; 32],
    meta: &VaultMeta,
    version: MetaVersion,
    bytes: &[u8],
) -> Result<(Zeroizing<[u8; 32]>, Option<Zeroizing<[u8; 32]>>), UnlockError> {
    // A B2B vault (`NTV6` or the person-wrapped `NTV7`) seals `itemsKey` under
    // the GROUP tier; the root-tier derive fails there, so unwrap the group key
    // first and return it too. Reading only `NTV6` here made this tool unable to
    // open a vault born on the current generation, which is the one case it
    // exists for: the app is gone and the user has only their words
    // (myne-md/myne#911 review).
    if protocol::has_b2b_tail(bytes) {
        let b2b = protocol::parse_b2b_tail_any(bytes).map_err(|_| UnlockError::InvalidVaultMeta)?;
        let group = protocol::unlock_group_key_ntv6(&b2b, &protocol::OwnerKey::new(*root_key))
            .map_err(|_| UnlockError::InvalidVaultMeta)?;
        let group_key = protocol::GroupKey::new(*group);
        let items = protocol::unlock_items_key_ntv6(&b2b, &group_key)
            .map_err(|_| UnlockError::InvalidVaultMeta)?;
        return Ok((items, Some(group)));
    }
    let items = match version {
        MetaVersion::V0_1 => {
            protocol::derive_items_key(root_key, meta).map_err(|_| UnlockError::InvalidVaultMeta)?
        }
        MetaVersion::V0_2 => protocol::derive_items_key_v0_2(root_key, meta)
            .map_err(|_| UnlockError::InvalidVaultMeta)?,
    };
    Ok((items, None))
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

/// Unlock a person-wrapped (`NTV7`) vault directory with the owner's identity
/// phrase.
///
/// This is the second credential the generation ships, and the one a user holds
/// when the app is gone: the tool has to open it or the birth format loses its
/// documented recovery route. The derivation is exactly the app's
/// (`person_id_hash` → identity seed → the three key seeds → the person keypair),
/// under the DEFAULT KDF parameters the unlock path uses, so the same words
/// produce the same key here as there.
pub fn unlock_with_identity(
    vault_dir: &std::path::Path,
    phrase_normalized: &str,
) -> Result<UnlockedVault, UnlockError> {
    let (meta, version, bytes) = read_meta(vault_dir)?;
    // Answered by GENERATION, not by letting the NTV7 parser fail. Since `NTV8`
    // the password is the only vault credential and the frame carries no person
    // wrap at all, so a phrase against one is the wrong kind of credential
    // rather than a wrong one, and the parser's failure cannot say that.
    if protocol::vault_meta_generation(&bytes) == protocol::VaultMetaGeneration::PersonNoWrap {
        return Err(UnlockError::NotPersonWrapped);
    }
    let ntv7 =
        protocol::parse_vault_meta_ntv7(&bytes).map_err(|_| UnlockError::InvalidVaultMeta)?;
    eprintln!("Deriving the identity key (Argon2id, ~1-3 s)... ");
    let person_id = protocol::kdf::person_id_hash(phrase_normalized);
    let seed = protocol::kdf::derive_person_identity_seed(
        phrase_normalized,
        &person_id,
        &protocol::DEFAULT_V0_1_KDF_PARAMS,
    )
    .map_err(|_| UnlockError::InvalidCredentialOrVault)?;
    let seeds = protocol::kdf::expand_person_identity_key_seeds(&seed);
    let owner = protocol::PersonKeyPair::generate_raw(&seeds.kem, &seeds.ed25519, &seeds.mldsa);
    let root_key =
        protocol::open_person_wrapped_root_key(&owner, &ntv7.person_wrap, &ntv7.base.items_key_id)
            .map_err(|_| UnlockError::InvalidCredentialOrVault)?;
    let (items_key, group_key) = items_key_from_root(&root_key, &meta, version, &bytes)?;
    eprintln!("done");
    Ok(UnlockedVault {
        root_key,
        group_key,
        items_key,
        items_key_id: meta.items_key_id,
        version,
    })
}

/// Unlock a vault directory with the master password.
pub fn unlock_with_password(
    vault_dir: &std::path::Path,
    password: &str,
) -> Result<UnlockedVault, UnlockError> {
    let (meta, version, bytes) = read_meta(vault_dir)?;
    eprint!("Deriving the vault key (Argon2id, ~1-3 s)... ");
    let root_key = root_key_from_password(password, &meta, version)?;
    let (items_key, group_key) = items_key_from_root(&root_key, &meta, version, &bytes)?;
    eprintln!("done");
    Ok(UnlockedVault {
        root_key,
        group_key,
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
    let (meta, version, bytes) = read_meta(vault_dir)?;
    eprint!("Deriving the vault key (Argon2id, ~1-3 s)... ");
    let root_key = root_key_from_phrase(phrase_normalized, &meta, version)?;
    let (items_key, group_key) = items_key_from_root(&root_key, &meta, version, &bytes)?;
    eprintln!("done");
    Ok(UnlockedVault {
        root_key,
        group_key,
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
            person_binding: None,
        };
        let bytes = protocol::serialize_vault_meta_v0_2(&meta);
        let phrase_normalized = phrase.join_normalized().to_string();
        (bytes, *root_key, *items_key, phrase_normalized)
    }

    /// A deterministic `CryptoRng` for fixtures. The person-wrap sealer needs
    /// entropy; a fixture wants the same bytes every run, and the wrap's content
    /// is never opened by the password path this test drives.
    struct SeededRng(u64);

    impl rand_core::TryRng for SeededRng {
        type Error = core::convert::Infallible;
        fn try_next_u32(&mut self) -> Result<u32, Self::Error> {
            Ok(self.try_next_u64()? as u32)
        }
        fn try_next_u64(&mut self) -> Result<u64, Self::Error> {
            // splitmix64: deterministic, and enough entropy shape for a fixture.
            self.0 = self.0.wrapping_add(0x9E37_79B9_7F4A_7C15);
            let mut z = self.0;
            z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
            z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
            Ok(z ^ (z >> 31))
        }
        fn try_fill_bytes(&mut self, dst: &mut [u8]) -> Result<(), Self::Error> {
            for chunk in dst.chunks_mut(8) {
                let v = self.try_next_u64()?.to_le_bytes();
                chunk.copy_from_slice(&v[..chunk.len()]);
            }
            Ok(())
        }
    }

    impl rand_core::TryCryptoRng for SeededRng {}

    /// Build a real B2B vault of either person generation, returning the bytes
    /// plus the three keys the unlock path must recover.
    ///
    /// Constructed rather than hand-assembled, because the two things that
    /// matter here are the ones a hand-assembled frame gets wrong: `itemsKey` is
    /// sealed under the **GROUP** tier (which is what makes `has_b2b_tail` the
    /// load-bearing question), and the group key itself is wrapped under the
    /// owner's root-tier `GroupKeyWrap`. `NTV7` additionally carries a person
    /// wrap, which this fixture seals to a deterministic keypair: the password
    /// path never opens it, so its content only has to be structurally real.
    fn build_person_vault(person_wrap: bool) -> (Vec<u8>, [u8; 32], [u8; 32], [u8; 32]) {
        const ACCT: [u8; 16] = [0x44; 16];
        const ITEMS_ID: [u8; 16] = [0x33; 16];
        const ROOT: [u8; 32] = [0x11; 32];
        const ITEMS: [u8; 32] = [0x22; 32];
        const GROUP: [u8; 32] = [0x77; 32];
        const PASSWORD: &str = "correct horse battery staple";

        let password_wrap_key =
            protocol::derive_password_wrap_key_v0_2(PASSWORD, &[1u8; 16], &ACCT, &FAST_TEST_KDF)
                .expect("password wrap key");
        let enc_root_pw = protocol::aead_seal_ctx(
            &password_wrap_key,
            &[3u8; 24],
            &ROOT,
            &protocol::aad_password_wrap_v0_2(&FAST_TEST_KDF),
        )
        .expect("seal password wrap");

        // Group tier: `itemsKey` under the GROUP key, never under `root_key`.
        let items_wrap_key = protocol::derive_group_subkey_v0_2(
            &protocol::GroupKey::new(GROUP),
            protocol::GroupRole::ItemsKeyWrap,
        );
        let enc_items = protocol::aead_seal_ctx(
            &items_wrap_key,
            &[6u8; 24],
            &ITEMS,
            &protocol::aad_vault_items_key_wrap_v0_2(&ITEMS_ID),
        )
        .expect("seal items_key");

        let base = protocol::VaultMeta {
            account_number_hash: ACCT,
            kdf_params: FAST_TEST_KDF,
            random_salt_password: [1u8; 16],
            // Retired by both person generations: structural, not optional.
            random_salt_recovery: [0u8; 16],
            nonce_password_wrap: [3u8; 24],
            enc_root_key_password: enc_root_pw.as_slice().try_into().expect("64 bytes"),
            nonce_recovery_wrap: [0u8; 24],
            enc_root_key_recovery: [0u8; 64],
            items_key_id: ITEMS_ID,
            items_key_nonce: [6u8; 24],
            enc_items_key: enc_items.as_slice().try_into().expect("64 bytes"),
            membership: None,
            person_binding: None,
        };

        // Owner tier: the group key under `root_key`'s GroupKeyWrap.
        let group_wrap_key = protocol::derive_owner_subkey_v0_2(
            &protocol::OwnerKey::new(ROOT),
            protocol::OwnerRole::GroupKeyWrap,
        );
        let enc_group = protocol::aead_seal_ctx(
            &group_wrap_key,
            &[0xA1u8; 24],
            &GROUP,
            &protocol::aad_vault_group_key_wrap_v0_2(&ACCT, 1),
        )
        .expect("seal group key");

        let signed_roster = protocol::person_invite::SignedGroupRoster {
            payload: vec![0xC3; 32],
            signature: protocol::person_key::PersonSigned {
                ed25519_sig: [0xD4; protocol::person_key::PERSON_ED25519_SIG_LEN],
                mldsa_sig: vec![0xE5; protocol::person_key::PERSON_MLDSA_SIG_LEN],
            },
        };
        let roster = protocol::person_invite::seal_group_roster(
            &GROUP,
            &ACCT,
            1,
            &[0x66u8; 24],
            &signed_roster,
        )
        .expect("sealed roster");

        let bytes = if person_wrap {
            let owner =
                protocol::PersonKeyPair::generate_raw(&[0x31; 64], &[0x32; 32], &[0x33; 32]);
            protocol::vault_meta_ntv7::serialize_vault_meta_ntv7(
                &protocol::vault_meta_ntv7::PersonWrappedVaultMeta {
                    base,
                    group_key_nonce: [0xA1u8; 24],
                    enc_group_key: enc_group.as_slice().try_into().expect("64 bytes"),
                    group_key_epoch: 1,
                    signed_roster_envelope: roster,
                    person_wrap: protocol::vault_meta_ntv7::seal_root_key_to_person_raw(
                        &owner.public_half(),
                        &ROOT,
                        &ITEMS_ID,
                        &mut SeededRng(9),
                    )
                    .expect("seal root key"),
                },
            )
            .expect("serialize NTV7")
        } else {
            protocol::vault_meta_ntv8::serialize_vault_meta_ntv8(
                &protocol::vault_meta_ntv8::PasswordOnlyVaultMeta {
                    base,
                    group_key_nonce: [0xA1u8; 24],
                    enc_group_key: enc_group.as_slice().try_into().expect("64 bytes"),
                    group_key_epoch: 1,
                    signed_roster_envelope: roster,
                },
            )
            .expect("serialize NTV8")
        };
        (bytes, ROOT, ITEMS, GROUP)
    }

    /// Write `bytes` to a temp dir's `vault.meta` and return the dir.
    fn write_vault(bytes: &[u8]) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("myne-decrypt-test-{}", uuid_like()));
        std::fs::create_dir_all(&dir).expect("temp dir");
        std::fs::write(dir.join("vault.meta"), bytes).expect("write vault.meta");
        dir
    }

    /// A unique-enough suffix without pulling `uuid` as a dev-dep.
    ///
    /// The clock alone is not enough: macOS resolves `SystemTime` to about a
    /// microsecond, and two tests calling this inside the same microsecond get
    /// the same directory, so one reads the other's `vault.meta` and fails with
    /// `InvalidVaultMeta`. A process-local counter closes that window and costs
    /// nothing; the timestamp stays so two concurrent processes still differ.
    fn uuid_like() -> String {
        use std::sync::atomic::{AtomicU64, Ordering};
        use std::time::{SystemTime, UNIX_EPOCH};
        static SEQ: AtomicU64 = AtomicU64::new(0);
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock")
            .as_nanos();
        format!("{nanos}-{}", SEQ.fetch_add(1, Ordering::Relaxed))
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
    #[test]
    fn an_ntv8_vault_opens_with_the_password_and_the_group_tier() {
        let (bytes, root_key, items_key, group_key) = build_person_vault(false);
        assert_eq!(
            &bytes[..4],
            b"NTV8",
            "the fixture is the password-only generation"
        );
        let dir = write_vault(&bytes);
        let unlocked = unlock_with_password(&dir, "correct horse battery staple").expect("unlock");
        assert_eq!(*unlocked.root_key, root_key);
        assert_eq!(*unlocked.items_key, items_key);
        assert_eq!(
            unlocked.group_key.as_deref().copied(),
            Some(group_key),
            "the group key must come back too, or the export walk cannot read the \
             group-tier singletons"
        );
        assert_eq!(unlocked.version, MetaVersion::V0_2);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn an_ntv7_vault_still_opens_with_the_password() {
        // A vault born before this change, which is the whole point: the app
        // upgrades it to NTV8 on its next unlock, but a `.myne-backup` taken
        // yesterday holds the NTV7 frame and this tool has to open it.
        let (bytes, root_key, items_key, group_key) = build_person_vault(true);
        assert_eq!(&bytes[..4], b"NTV7");
        let dir = write_vault(&bytes);
        let unlocked = unlock_with_password(&dir, "correct horse battery staple").expect("unlock");
        assert_eq!(*unlocked.root_key, root_key);
        assert_eq!(*unlocked.items_key, items_key);
        assert_eq!(unlocked.group_key.as_deref().copied(), Some(group_key));
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn the_identity_phrase_on_an_ntv8_vault_is_a_named_refusal() {
        let (bytes, _, _, _) = build_person_vault(false);
        let dir = write_vault(&bytes);
        // Not `InvalidVaultMeta`: the vault is fine, the words are the wrong
        // KIND of words, and the user needs to be told which door to use.
        assert!(matches!(
            unlock_with_identity(&dir, "abandon ability able about above absent absorb abstract absurd abuse access accident account accuse achieve acid acoustic acquire across act action actor actress actual"),
            Err(UnlockError::NotPersonWrapped)
        ));
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn an_unknown_magic_is_a_named_refusal_carrying_the_bytes() {
        let (bytes, _, _, _) = build_person_vault(false);
        let mut future = bytes.clone();
        future[0..4].copy_from_slice(b"FUT9");
        let dir = write_vault(&future);
        assert!(
            matches!(
                unlock_with_password(&dir, "correct horse battery staple"),
                Err(UnlockError::UnsupportedGeneration(m)) if m == *b"FUT9"
            ),
            "a vault from a newer release must be refused BY NAME, not as a parse error"
        );
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn a_file_too_short_to_carry_a_magic_is_corrupt_rather_than_from_the_future() {
        let dir = write_vault(b"NTV");
        assert!(matches!(
            unlock_with_password(&dir, "anything"),
            Err(UnlockError::InvalidVaultMeta)
        ));
        std::fs::remove_dir_all(&dir).ok();
    }
}
