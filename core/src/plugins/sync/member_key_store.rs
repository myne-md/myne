// SPDX-License-Identifier: AGPL-3.0
//! Device-local sealed member-vault key store (myne-md/myne#711 task 25).
//!
//! A B2B member holds no vault password: their access is the group key delivered
//! in the invite's sealed package. To re-unlock a member vault on a later launch
//! the member's group and items keys are sealed here under a key derived from
//! their own normalized recovery phrase
//! (`"myne.v0.2 argon2id-person-vault-member|"`, bound to the vault's
//! account-number hash), so the phrase alone opens the vault on any device.
//!
//! Device-local, never synced, and it holds no plaintext key material: the
//! envelope is `AEAD(group_key || items_key)` bound to the vault id and account
//! hash. Distinct from the person-keypair sealed file (the identity cache) and
//! from the `MYY5` profile store.

use zeroize::Zeroizing;

use crate::vault_io::VaultIo;

/// Device-local file name, under the vault root.
pub const MEMBER_KEY_STORE_FILE: &str = "vault.member-key";

/// The opened member keys: what a member slot is built from.
pub struct MemberKeys {
    pub group_key: Zeroizing<[u8; 32]>,
    pub items_key: Zeroizing<[u8; 32]>,
    pub group_key_epoch: u64,
    pub items_key_id: [u8; 16],
    pub account_hash: [u8; 16],
}

#[derive(serde::Serialize, serde::Deserialize)]
struct MemberKeyEnvelope {
    vault_id_hex: String,
    account_hash_hex: String,
    group_key_epoch: u64,
    items_key_id_hex: String,
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

/// Seal and write the member keys. `phrase_normalized` is the member's own
/// normalized phrase; it is used to derive the seal key and dropped here.
#[allow(clippy::too_many_arguments)]
pub async fn write_member_key_store(
    io: &dyn VaultIo,
    vault_root: &std::path::Path,
    vault_id: &[u8; 16],
    account_hash: &[u8; 16],
    group_key_epoch: u64,
    items_key_id: &[u8; 16],
    kdf_params: &protocol::KdfParams,
    phrase_normalized: &str,
    group_key: &[u8; 32],
    items_key: &[u8; 32],
) -> Result<(), ()> {
    let key = protocol::derive_person_vault_member_key(phrase_normalized, account_hash, kdf_params)
        .map_err(|_| ())?;
    let mut nonce = [0u8; protocol::AEAD_NONCE_LEN];
    getrandom::getrandom(&mut nonce).map_err(|_| ())?;
    let mut plaintext = Vec::with_capacity(64);
    plaintext.extend_from_slice(group_key);
    plaintext.extend_from_slice(items_key);
    let aad = protocol::aad_person_member_key_store(vault_id, account_hash);
    let sealed = protocol::aead_seal_ctx(&key, &nonce, &plaintext, &aad).map_err(|_| ())?;
    let env = MemberKeyEnvelope {
        vault_id_hex: hex_lower(vault_id),
        account_hash_hex: hex_lower(account_hash),
        group_key_epoch,
        items_key_id_hex: hex_lower(items_key_id),
        nonce_hex: hex_lower(&nonce),
        sealed_hex: hex_lower(&sealed),
    };
    let bytes = serde_json::to_vec_pretty(&env).map_err(|_| ())?;
    io.write(
        &vault_root.join(MEMBER_KEY_STORE_FILE),
        &bytes,
        crate::vault_io::WriteOpts::default(),
    )
    .await
    .map_err(|_| ())
}

/// Whether this vault has a member-key store (drives the unlock surface).
pub async fn member_key_store_exists(io: &dyn VaultIo, vault_root: &std::path::Path) -> bool {
    io.exists(&vault_root.join(MEMBER_KEY_STORE_FILE))
        .await
        .unwrap_or(false)
}

/// Read and open the member-key store with the member's phrase. `None` on an
/// absent store, a wrong vault id, or any AEAD/parse failure (a wrong phrase is
/// indistinguishable from tampering, the §6.4 discipline).
pub async fn read_member_key_store(
    io: &dyn VaultIo,
    vault_root: &std::path::Path,
    vault_id: &[u8; 16],
    kdf_params: &protocol::KdfParams,
    phrase_normalized: &str,
) -> Option<MemberKeys> {
    let bytes = io
        .read(&vault_root.join(MEMBER_KEY_STORE_FILE))
        .await
        .ok()?;
    let env: MemberKeyEnvelope = serde_json::from_slice(&bytes).ok()?;
    if env.vault_id_hex != hex_lower(vault_id) {
        return None;
    }
    let account_hash = hex16(&env.account_hash_hex)?;
    let items_key_id = hex16(&env.items_key_id_hex)?;
    let nonce_vec = hex_n(&env.nonce_hex, protocol::AEAD_NONCE_LEN)?;
    let mut nonce = [0u8; protocol::AEAD_NONCE_LEN];
    nonce.copy_from_slice(&nonce_vec);
    let sealed = hex_n(&env.sealed_hex, 64 + protocol::CTX_COMMITMENT_TAG_LEN)?;
    let key =
        protocol::derive_person_vault_member_key(phrase_normalized, &account_hash, kdf_params)
            .ok()?;
    let aad = protocol::aad_person_member_key_store(vault_id, &account_hash);
    let plaintext = protocol::aead_open_ctx(&key, &nonce, &sealed, &aad).ok()?;
    if plaintext.len() != 64 {
        return None;
    }
    let mut group_key = Zeroizing::new([0u8; 32]);
    let mut items_key = Zeroizing::new([0u8; 32]);
    group_key.copy_from_slice(&plaintext[..32]);
    items_key.copy_from_slice(&plaintext[32..]);
    Some(MemberKeys {
        group_key,
        items_key,
        group_key_epoch: env.group_key_epoch,
        items_key_id,
        account_hash,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::ScopedTempDir;

    // Seal then open with the same phrase: the keys round-trip. A wrong phrase
    // and a wrong vault id both fail closed (AEAD), never a partial answer.
    #[test]
    fn member_key_store_round_trips_and_refuses_a_wrong_phrase_or_vault() {
        crate::test_support::block_on(async {
            let tmp = ScopedTempDir::new("member-key-store").expect("temp dir");
            let io = crate::vault_io::StdVaultIo;
            let root = tmp.path();
            let vault_id = [0x11u8; 16];
            let account_hash = [0x22u8; 16];
            let items_key_id = [0x33u8; 16];
            let group_key = [0x44u8; 32];
            let items_key = [0x55u8; 32];
            let params = protocol::DEFAULT_V0_1_KDF_PARAMS;

            write_member_key_store(
                &io,
                root,
                &vault_id,
                &account_hash,
                7,
                &items_key_id,
                &params,
                "abandon abandon abandon",
                &group_key,
                &items_key,
            )
            .await
            .expect("write");

            assert!(member_key_store_exists(&io, root).await);

            let opened =
                read_member_key_store(&io, root, &vault_id, &params, "abandon abandon abandon")
                    .await
                    .expect("open");
            assert_eq!(*opened.group_key, group_key);
            assert_eq!(*opened.items_key, items_key);
            assert_eq!(opened.group_key_epoch, 7);
            assert_eq!(opened.items_key_id, items_key_id);
            assert_eq!(opened.account_hash, account_hash);

            // A wrong phrase fails closed.
            assert!(
                read_member_key_store(&io, root, &vault_id, &params, "wrong phrase")
                    .await
                    .is_none()
            );
            // A wrong vault id (a store copied to another name) fails closed.
            assert!(read_member_key_store(
                &io,
                root,
                &[0x99u8; 16],
                &params,
                "abandon abandon abandon"
            )
            .await
            .is_none());
        });
    }
}
