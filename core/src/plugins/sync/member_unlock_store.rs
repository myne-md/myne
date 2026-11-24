// SPDX-License-Identifier: AGPL-3.0-only
//! Device-local member vault-unlock credential store (`vault.member-unlock`).
//!
//! A B2B member holds no vault password: their access is the group key delivered
//! in the invite's sealed package. This store is **the only way in** on a member
//! device since myne-md/myne#938 task 12 retired `vault.member-key` (the
//! phrase-sealed sibling, `decisions/protocol/0606`), so it holds a device-local
//! credential the member chooses: a password, or a PIN/biometric via the
//! quick-unlock wrap-key providers.
//!
//! What is sealed is the whole credential the phrase path installs at once:
//! `group_key (32) || items_key (32) || items_key_id (16) || group_key_epoch (8)
//! || person_id (16) || person keypair`. Bundling the keypair is what makes the
//! fast unlock complete the session the way the phrase does: the vault head must
//! be signed by the person keypair (`decisions/protocol/0603`) and that keypair
//! is otherwise sealed only under the phrase (`decisions/protocol/0612`), so a
//! credential that delivered only the vault keys would open the vault and leave
//! sync reporting `identity_locked`. The metadata travels INSIDE the sealed
//! payload rather than in the envelope so a tampered `person_id` /
//! `items_key_id` / `group_key_epoch` is an AEAD failure, not a silently
//! mis-installed session.
//!
//! Storage is device-local, under the vault root, never synced and never backed
//! up: a JSON envelope whose `sealed_hex` is `AEAD(payload)` under a KEK that
//! depends on the method. `password` uses an Argon2id KEK derived from the
//! member's password (`"myne.v0.2 argon2id-person-vault-member-unlock|"`, a
//! per-device random salt in the envelope); `pin`/`biometric` use the same
//! wrap-key providers the owner quick-unlock uses (`PinProvider`,
//! `AppleBiometricProvider`). All methods bind the vault id and account-number
//! hash through `aad_person_member_unlock_store`. A wrong secret and a tampered
//! payload are the same AEAD failure (the §6.4 discipline); a wrong `vault_id` is
//! rejected against the reader's expected id, and a wrong `account_hash` scopes
//! the KEK so a store copied to another vault or account does not open.
//!
//! Only ONE method is configured at a time: setting a new one replaces the
//! previous. There is no second store and no second credential: a member whose
//! gate is missing (never set, or deliberately cleared) re-joins with a fresh
//! invite rather than falling back to a phrase unlock.
//!
//! **Accepted exposure (same class as the vault-bound identity carrier).** The
//! credential opens the member's person identity, and because the identity is
//! vault-independent a leaked member-vault credential also exposes the person in
//! their other vaults. This mirrors the trade `decisions/protocol/0622` records
//! for the owner carrier; the decoupling is tracked as myne-md/myne#793.

use zeroize::Zeroizing;

use crate::vault_io::VaultIo;

/// Device-local file name, under the vault root.
pub const MEMBER_UNLOCK_STORE_FILE: &str = "vault.member-unlock";

/// The method a stored credential uses.
pub const METHOD_PASSWORD: &str = "password";
/// The method a stored credential uses.
pub const METHOD_PIN: &str = "pin";
/// The method a stored credential uses.
pub const METHOD_BIOMETRIC: &str = "biometric";

/// Envelope schema version.
const MEMBER_UNLOCK_STORE_VERSION: u64 = 1;

/// The opened member credential: what a member slot plus person session is built
/// from, delivered at once so a fast unlock is as complete as a phrase one.
pub struct MemberUnlockCredential {
    pub group_key: Zeroizing<[u8; 32]>,
    pub items_key: Zeroizing<[u8; 32]>,
    pub group_key_epoch: u64,
    pub items_key_id: [u8; 16],
    pub account_hash: [u8; 16],
    pub person_id: [u8; 16],
    pub pair: protocol::PersonKeyPair,
    /// The private-profile key for this `(person, vault)`, derived from the
    /// **gate of this store** rather than from the recovery phrase
    /// (myne-md/myne#938 task 12). Opening the member credential is the one
    /// moment the gate exists, so this is where the profile key comes from:
    /// `derive_person_vault_profile_key_from_gate(wrap_key, profile_id)`.
    pub profile_id: [u8; 16],
    pub profile_key: Zeroizing<[u8; 32]>,
}

/// The public (pre-decrypt) header fields, for the provider paths that need the
/// method and the stored salt before they can retrieve a wrap key.
pub struct MemberUnlockHeader {
    pub method: String,
    pub salt: [u8; 16],
}

#[derive(serde::Serialize, serde::Deserialize)]
struct MemberUnlockEnvelope {
    version: u64,
    vault_id_hex: String,
    account_hash_hex: String,
    method: String,
    /// The group-key epoch these sealed keys belong to, in the CLEARTEXT header.
    /// Routing metadata rather than a secret, and the member-side trigger for
    /// adopting a rotation has to read it without the credential: since
    /// myne-md/myne#938 task 12 retired `vault.member-key`, this envelope is the
    /// only place that epoch lives on a member's device.
    ///
    /// `Option`, and absent rather than zero, because a store written before this
    /// field existed must read back as UNKNOWN. With `#[serde(default)]` on a `u64`
    /// it read back as `Some(0)`, and the reader it replaced answered `None` for a
    /// missing field: every pre-existing member device would have reported epoch 0
    /// against a vault at epoch >= 1 and taken the rotation-adoption path on its
    /// first cycle — a group-package fetch over the network plus a local re-key for
    /// a device that was not stale. An epoch is a positive `u64` (`protocol.md`
    /// §9.3.2), so `0` is unambiguously "absent" as well as unset
    /// (myne-md/myne#938 review).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    group_key_epoch: Option<u64>,
    /// The password's random Argon2id salt, or the PIN provider's `pin_salt`
    /// (all-zero for biometric).
    salt_hex: String,
    nonce_hex: String,
    sealed_hex: String,
}

fn hex_lower(bytes: &[u8]) -> String {
    crate::account::person_identity::hex_lower(bytes)
}

/// Strict (`protocol::hex::decode_lower`): the envelope is this device's own
/// writer's output, so an uppercase id is a second identity (R1.2).
fn hex16(s: &str) -> Option<[u8; 16]> {
    protocol::hex::decode_lower(s)
}

fn hex_n(s: &str, n: usize) -> Option<Vec<u8>> {
    if s.len() != n * 2 || !s.bytes().all(|b| b.is_ascii_hexdigit()) {
        return None;
    }
    (0..n)
        .map(|i| u8::from_str_radix(&s[i * 2..i * 2 + 2], 16).ok())
        .collect()
}

/// The sealed payload length: `group_key (32) || items_key (32) ||
/// items_key_id (16) || group_key_epoch (8) || person_id (16) || person keypair`.
fn payload_len() -> usize {
    32 + 32 + 16 + 8 + 16 + protocol::PERSON_PLAINTEXT_LEN
}

async fn read_envelope(
    io: &dyn VaultIo,
    vault_root: &std::path::Path,
) -> Option<MemberUnlockEnvelope> {
    io.read(&vault_root.join(MEMBER_UNLOCK_STORE_FILE))
        .await
        .ok()
        .and_then(|b| serde_json::from_slice(&b).ok())
}

/// The configured member-unlock method (`"password"` / `"pin"` / `"biometric"`),
/// or `None` when nothing is configured. Pure disk truth; drives the unlock
/// surface.
pub async fn member_unlock_method(
    io: &dyn VaultIo,
    vault_root: &std::path::Path,
) -> Option<String> {
    let env = read_envelope(io, vault_root).await?;
    if env.version != MEMBER_UNLOCK_STORE_VERSION {
        return None;
    }
    match env.method.as_str() {
        METHOD_PASSWORD | METHOD_PIN | METHOD_BIOMETRIC => Some(env.method),
        _ => None,
    }
}

/// Whether this device holds a member fast-unlock credential at all.
///
/// Since myne-md/myne#938 task 12 this is the ONLY thing that makes a vault a
/// member vault on this device: `vault.member-key` (the phrase-sealed sibling) is
/// retired, so the discriminator the unlock surface and the boot probe ask for is
/// "is there a member gate here", not "is there a phrase-sealed key file".
pub async fn member_unlock_store_exists(io: &dyn VaultIo, vault_root: &std::path::Path) -> bool {
    member_unlock_method(io, vault_root).await.is_some()
}

/// The group-key epoch this device's member credential was sealed at, read
/// WITHOUT the password (the epoch is cleartext routing metadata). `None` on an
/// absent or unparseable store, and on a store written before the field existed:
/// "unknown" keeps meaning "assume current", which is what the caller's
/// `local_epoch` fallback expects and what the reader this replaced answered.
pub async fn member_unlock_store_epoch(
    io: &dyn VaultIo,
    vault_root: &std::path::Path,
) -> Option<u64> {
    let env = read_envelope(io, vault_root).await?;
    if env.version != MEMBER_UNLOCK_STORE_VERSION {
        return None;
    }
    env.group_key_epoch.filter(|epoch| *epoch > 0)
}

/// The public header for the provider paths, validating the expected vault id.
pub async fn member_unlock_header(
    io: &dyn VaultIo,
    vault_root: &std::path::Path,
    vault_id: &[u8; 16],
) -> Option<MemberUnlockHeader> {
    let env = read_envelope(io, vault_root).await?;
    if env.version != MEMBER_UNLOCK_STORE_VERSION || env.vault_id_hex != hex_lower(vault_id) {
        return None;
    }
    let salt_vec = hex_n(&env.salt_hex, 16)?;
    let mut salt = [0u8; 16];
    salt.copy_from_slice(&salt_vec);
    Some(MemberUnlockHeader {
        method: env.method,
        salt,
    })
}

/// Seal the credential payload under `wrap_key` and write the envelope.
#[allow(clippy::too_many_arguments)]
async fn write_sealed(
    io: &dyn VaultIo,
    vault_root: &std::path::Path,
    vault_id: &[u8; 16],
    account_hash: &[u8; 16],
    method: &str,
    salt: &[u8; 16],
    wrap_key: &[u8; 32],
    group_key_epoch: u64,
    items_key_id: &[u8; 16],
    person_id: &[u8; 16],
    group_key: &[u8; 32],
    items_key: &[u8; 32],
    pair: &protocol::PersonKeyPair,
) -> Result<(), ()> {
    let mut nonce = [0u8; protocol::AEAD_NONCE_LEN];
    getrandom::getrandom(&mut nonce).map_err(|_| ())?;
    let pt = Zeroizing::new(pair.to_plaintext_bytes());
    let mut plaintext = Zeroizing::new(Vec::with_capacity(payload_len()));
    plaintext.extend_from_slice(group_key);
    plaintext.extend_from_slice(items_key);
    plaintext.extend_from_slice(items_key_id);
    plaintext.extend_from_slice(&group_key_epoch.to_le_bytes());
    plaintext.extend_from_slice(person_id);
    plaintext.extend_from_slice(&pt[..]);
    let aad = protocol::aad_person_member_unlock_store(vault_id, account_hash);
    let sealed = protocol::aead_seal_ctx(wrap_key, &nonce, &plaintext, &aad).map_err(|_| ())?;
    let env = MemberUnlockEnvelope {
        version: MEMBER_UNLOCK_STORE_VERSION,
        vault_id_hex: hex_lower(vault_id),
        account_hash_hex: hex_lower(account_hash),
        method: method.to_string(),
        group_key_epoch: Some(group_key_epoch),
        salt_hex: hex_lower(salt),
        nonce_hex: hex_lower(&nonce),
        sealed_hex: hex_lower(&sealed),
    };
    let bytes = serde_json::to_vec_pretty(&env).map_err(|_| ())?;
    io.write(
        &vault_root.join(MEMBER_UNLOCK_STORE_FILE),
        &bytes,
        crate::vault_io::WriteOpts::default(),
    )
    .await
    .map_err(|_| ())
}

/// Open the envelope with a caller-supplied `wrap_key` (the provider path).
pub async fn read_member_unlock_with_wrap_key(
    io: &dyn VaultIo,
    vault_root: &std::path::Path,
    vault_id: &[u8; 16],
    wrap_key: &[u8; 32],
) -> Option<MemberUnlockCredential> {
    let env = read_envelope(io, vault_root).await?;
    if env.version != MEMBER_UNLOCK_STORE_VERSION || env.vault_id_hex != hex_lower(vault_id) {
        return None;
    }
    let account_hash = hex16(&env.account_hash_hex)?;
    let nonce_vec = hex_n(&env.nonce_hex, protocol::AEAD_NONCE_LEN)?;
    let mut nonce = [0u8; protocol::AEAD_NONCE_LEN];
    nonce.copy_from_slice(&nonce_vec);
    let sealed = hex_n(
        &env.sealed_hex,
        payload_len() + protocol::CTX_COMMITMENT_TAG_LEN,
    )?;
    let aad = protocol::aad_person_member_unlock_store(vault_id, &account_hash);
    let plaintext = Zeroizing::new(protocol::aead_open_ctx(wrap_key, &nonce, &sealed, &aad).ok()?);
    if plaintext.len() != payload_len() {
        return None;
    }
    let mut group_key = Zeroizing::new([0u8; 32]);
    let mut items_key = Zeroizing::new([0u8; 32]);
    group_key.copy_from_slice(&plaintext[..32]);
    items_key.copy_from_slice(&plaintext[32..64]);
    let mut items_key_id = [0u8; 16];
    items_key_id.copy_from_slice(&plaintext[64..80]);
    let mut epoch_bytes = [0u8; 8];
    epoch_bytes.copy_from_slice(&plaintext[80..88]);
    let group_key_epoch = u64::from_le_bytes(epoch_bytes);
    let mut person_id = [0u8; 16];
    person_id.copy_from_slice(&plaintext[88..104]);
    let pair = protocol::PersonKeyPair::from_plaintext_bytes(
        <&[u8; protocol::PERSON_PLAINTEXT_LEN]>::try_from(&plaintext[104..]).ok()?,
    );
    let profile_id = protocol::person_profile_id(&person_id, &account_hash);
    let profile_key = protocol::derive_person_vault_profile_key_from_gate(wrap_key, &profile_id);
    Some(MemberUnlockCredential {
        group_key,
        items_key,
        group_key_epoch,
        items_key_id,
        account_hash,
        person_id,
        pair,
        profile_id,
        profile_key,
    })
}

/// The wrap key this store is sealed under, returned so the caller can derive the
/// private-profile key from the same gate (myne-md/myne#938 task 12) without a
/// second Argon2id run.
pub type MemberUnlockGate = Zeroizing<[u8; 32]>;

/// Seal and write the member credential under a member-chosen **password**.
/// Best-effort at the caller: the writer is a convenience path.
#[allow(clippy::too_many_arguments)]
pub async fn write_member_unlock_password(
    io: &dyn VaultIo,
    vault_root: &std::path::Path,
    vault_id: &[u8; 16],
    account_hash: &[u8; 16],
    group_key_epoch: u64,
    items_key_id: &[u8; 16],
    person_id: &[u8; 16],
    kdf_params: &protocol::KdfParams,
    password: &str,
    group_key: &[u8; 32],
    items_key: &[u8; 32],
    pair: &protocol::PersonKeyPair,
) -> Result<MemberUnlockGate, ()> {
    let mut salt = [0u8; 16];
    getrandom::getrandom(&mut salt).map_err(|_| ())?;
    write_member_unlock_password_with_salt(
        io,
        vault_root,
        vault_id,
        account_hash,
        group_key_epoch,
        items_key_id,
        person_id,
        kdf_params,
        password,
        &salt,
        group_key,
        items_key,
        pair,
    )
    .await
}

/// The same seal with a **caller-supplied salt**, for a RE-seal of an existing
/// store. Reusing the stored salt keeps the wrap key, and therefore the
/// gate-derived profile key, unchanged across a group-key rotation: a fresh salt
/// would re-key the profile and strand the person-private AI material the member
/// had already written under the old gate.
#[allow(clippy::too_many_arguments)]
pub async fn write_member_unlock_password_with_salt(
    io: &dyn VaultIo,
    vault_root: &std::path::Path,
    vault_id: &[u8; 16],
    account_hash: &[u8; 16],
    group_key_epoch: u64,
    items_key_id: &[u8; 16],
    person_id: &[u8; 16],
    kdf_params: &protocol::KdfParams,
    password: &str,
    salt: &[u8; 16],
    group_key: &[u8; 32],
    items_key: &[u8; 32],
    pair: &protocol::PersonKeyPair,
) -> Result<MemberUnlockGate, ()> {
    let key =
        protocol::derive_person_vault_member_unlock_key(password, salt, account_hash, kdf_params)
            .map_err(|_| ())?;
    write_sealed(
        io,
        vault_root,
        vault_id,
        account_hash,
        METHOD_PASSWORD,
        salt,
        &key,
        group_key_epoch,
        items_key_id,
        person_id,
        group_key,
        items_key,
        pair,
    )
    .await?;
    Ok(key)
}

/// Seal and write the member credential under a provider-supplied **wrap key**
/// (PIN / biometric). `salt` is the provider's `pin_salt` (all-zero for
/// biometric).
#[allow(clippy::too_many_arguments)]
pub async fn write_member_unlock_provider(
    io: &dyn VaultIo,
    vault_root: &std::path::Path,
    vault_id: &[u8; 16],
    account_hash: &[u8; 16],
    method: &str,
    salt: &[u8; 16],
    wrap_key: &[u8; 32],
    group_key_epoch: u64,
    items_key_id: &[u8; 16],
    person_id: &[u8; 16],
    group_key: &[u8; 32],
    items_key: &[u8; 32],
    pair: &protocol::PersonKeyPair,
) -> Result<(), ()> {
    write_sealed(
        io,
        vault_root,
        vault_id,
        account_hash,
        method,
        salt,
        wrap_key,
        group_key_epoch,
        items_key_id,
        person_id,
        group_key,
        items_key,
        pair,
    )
    .await
}

/// Read and open the member credential with `password`. `None` on an absent
/// store, a wrong method/vault id, or any AEAD/parse failure (a wrong password is
/// indistinguishable from tampering, the §6.4 discipline).
pub async fn read_member_unlock_password(
    io: &dyn VaultIo,
    vault_root: &std::path::Path,
    vault_id: &[u8; 16],
    kdf_params: &protocol::KdfParams,
    password: &str,
) -> Option<MemberUnlockCredential> {
    let env = read_envelope(io, vault_root).await?;
    if env.method != METHOD_PASSWORD || env.vault_id_hex != hex_lower(vault_id) {
        return None;
    }
    let account_hash = hex16(&env.account_hash_hex)?;
    let salt_vec = hex_n(&env.salt_hex, 16)?;
    let mut salt = [0u8; 16];
    salt.copy_from_slice(&salt_vec);
    let key =
        protocol::derive_person_vault_member_unlock_key(password, &salt, &account_hash, kdf_params)
            .ok()?;
    read_member_unlock_with_wrap_key(io, vault_root, vault_id, &key).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::ScopedTempDir;

    fn pair() -> protocol::PersonKeyPair {
        let seeds = protocol::kdf::expand_person_identity_key_seeds(&[7u8; 32]);
        protocol::PersonKeyPair::generate_raw(&seeds.kem, &seeds.ed25519, &seeds.mldsa)
    }

    // Seal then open with the same secret: the credential round-trips for both
    // the password and the provider path. A wrong secret and a wrong vault id
    // both fail closed (AEAD), never a partial answer.
    #[test]
    fn member_unlock_round_trips_and_refuses_wrong_secret_or_vault() {
        crate::test_support::block_on(async {
            let tmp = ScopedTempDir::new("member-unlock-store").expect("temp dir");
            let io = crate::vault_io::StdVaultIo;
            let root = tmp.path();
            let vault_id = [0x11u8; 16];
            let account_hash = [0x22u8; 16];
            let items_key_id = [0x33u8; 16];
            let person_id = [0x44u8; 16];
            let group_key = [0x55u8; 32];
            let items_key = [0x66u8; 32];
            let params = protocol::DEFAULT_V0_1_KDF_PARAMS;
            let p = pair();

            write_member_unlock_password(
                &io,
                root,
                &vault_id,
                &account_hash,
                7,
                &items_key_id,
                &person_id,
                &params,
                "correct horse battery staple",
                &group_key,
                &items_key,
                &p,
            )
            .await
            .expect("write");

            assert_eq!(
                member_unlock_method(&io, root).await.as_deref(),
                Some(METHOD_PASSWORD)
            );

            let opened = read_member_unlock_password(
                &io,
                root,
                &vault_id,
                &params,
                "correct horse battery staple",
            )
            .await
            .expect("open");
            assert_eq!(*opened.group_key, group_key);
            assert_eq!(*opened.items_key, items_key);
            assert_eq!(opened.group_key_epoch, 7);
            assert_eq!(opened.items_key_id, items_key_id);
            assert_eq!(opened.person_id, person_id);
            assert_eq!(opened.pair.fingerprint(), p.fingerprint());

            // A wrong password fails closed.
            assert!(
                read_member_unlock_password(&io, root, &vault_id, &params, "wrong password")
                    .await
                    .is_none()
            );
            // A wrong vault id (a store copied to another name) fails closed.
            assert!(read_member_unlock_password(
                &io,
                root,
                &[0x99u8; 16],
                &params,
                "correct horse battery staple"
            )
            .await
            .is_none());

            // The provider path shares the payload and round-trips under its own
            // wrap key, replacing the password method.
            let salt = [0xABu8; 16];
            let wrap_key = [0xCDu8; 32];
            write_member_unlock_provider(
                &io,
                root,
                &vault_id,
                &account_hash,
                METHOD_PIN,
                &salt,
                &wrap_key,
                7,
                &items_key_id,
                &person_id,
                &group_key,
                &items_key,
                &p,
            )
            .await
            .expect("write provider");
            assert_eq!(
                member_unlock_method(&io, root).await.as_deref(),
                Some(METHOD_PIN)
            );
            assert_eq!(
                member_unlock_header(&io, root, &vault_id)
                    .await
                    .map(|h| h.salt),
                Some(salt)
            );
            let opened = read_member_unlock_with_wrap_key(&io, root, &vault_id, &wrap_key)
                .await
                .expect("open provider");
            assert_eq!(*opened.group_key, group_key);
            // A wrong wrap key fails closed.
            assert!(
                read_member_unlock_with_wrap_key(&io, root, &vault_id, &[0x00u8; 32])
                    .await
                    .is_none()
            );
        });
    }
}
