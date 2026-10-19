// SPDX-License-Identifier: AGPL-3.0
//! Device-local, vault-bound person-identity carrier (myne-md/myne#792).
//!
//! An `NTV6` vault's sync head must be signed by the holder's person keypair
//! (`decisions/protocol/0603`), and unlock is by password, which does not install
//! the person session (the identity is session-scoped, `decisions/protocol/0612`).
//! Without a carrier, every session re-enters the 24-word identity phrase to get
//! sync. This removes that: when the person identity is unlocked while an owner
//! vault is open, the keypair is sealed under the vault's `root_key` into a
//! device-local file, and every later owner-vault unlock opens it and installs
//! the session.
//!
//! Storage is app-config, per vault: `<app_config_dir>/person-vault-carriers/
//! <vault_id_hex>.json`. A JSON envelope whose `sealed_hex` is
//! `AEAD(person_keypair_plaintext)` bound to the vault id AND the person id. The
//! KEK is `OwnerRole::PersonVaultCarrier` (a `root_key` subkey, `protocol.md`
//! §3.4). Device-local, outside the vault directory: never synced, never backed
//! up, and erasing the directory forgets every vault's carrier at once.
//!
//! **Accepted exposure (user-owned).** The vault's `root_key` (hence the vault
//! password, or a quick-unlock PIN/biometric that yields `root_key`) opens the
//! person identity, and because the identity is vault-independent a leaked vault
//! credential also exposes the person's B2B identity in their other vaults. This
//! is a deliberate weakening of `0612`'s separation, accepted for now; the
//! decoupling is tracked as myne-md/myne#793.

use zeroize::{Zeroize, Zeroizing};

use crate::vault_io::{VaultIo, WriteOpts};

/// Device-local carrier directory, under `<app_config_dir>`.
pub const PERSON_VAULT_CARRIER_DIR: &str = "person-vault-carriers";

#[derive(serde::Serialize, serde::Deserialize)]
struct CarrierEnvelope {
    vault_id_hex: String,
    person_id_hex: String,
    nonce_hex: String,
    sealed_hex: String,
}

fn hex_lower(bytes: &[u8]) -> String {
    crate::account::person_identity::hex_lower(bytes)
}

/// Strict (`protocol::hex::decode_lower`): the carrier is this device's own
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

fn carrier_dir(host: &dyn crate::host::HostCtx) -> Option<std::path::PathBuf> {
    host.app_config_dir()
        .ok()
        .map(|d| d.join(PERSON_VAULT_CARRIER_DIR))
}

fn carrier_path(
    host: &dyn crate::host::HostCtx,
    vault_id: &[u8; 16],
) -> Option<std::path::PathBuf> {
    Some(carrier_dir(host)?.join(format!("{}.json", hex_lower(vault_id))))
}

/// The `PersonVaultCarrier` subkey of `root_key`, the only seal/open key.
fn carrier_key(root_key: &[u8; 32]) -> Zeroizing<[u8; 32]> {
    protocol::derive_owner_subkey_v0_2(
        &protocol::OwnerKey::new(*root_key),
        protocol::OwnerRole::PersonVaultCarrier,
    )
}

/// Seal and write the person keypair for `vault_id`. Best-effort at the call
/// sites: a failure must never block the person unlock or the vault unlock that
/// triggered it.
pub async fn write_person_vault_carrier(
    host: &dyn crate::host::HostCtx,
    io: &dyn VaultIo,
    vault_id: &[u8; 16],
    person_id: &[u8; 16],
    root_key: &[u8; 32],
    pair: &protocol::PersonKeyPair,
) -> Result<(), ()> {
    let dir = carrier_dir(host).ok_or(())?;
    io.create_dir_all(&dir).await.map_err(|_| ())?;
    let path = carrier_path(host, vault_id).ok_or(())?;
    let key = carrier_key(root_key);
    let mut nonce = [0u8; protocol::AEAD_NONCE_LEN];
    getrandom::getrandom(&mut nonce).map_err(|_| ())?;
    let plaintext = Zeroizing::new(pair.to_plaintext_bytes());
    let aad = protocol::aad_person_vault_carrier(vault_id, person_id);
    let sealed = protocol::aead_seal_ctx(&key, &nonce, &plaintext[..], &aad).map_err(|_| ())?;
    let env = CarrierEnvelope {
        vault_id_hex: hex_lower(vault_id),
        person_id_hex: hex_lower(person_id),
        nonce_hex: hex_lower(&nonce),
        sealed_hex: hex_lower(&sealed),
    };
    let bytes = serde_json::to_vec_pretty(&env).map_err(|_| ())?;
    io.write(&path, &bytes, WriteOpts::default())
        .await
        .map_err(|_| ())
}

/// Read and open the carrier with the vault `root_key`. `None` on an absent
/// store, a wrong vault id, or any AEAD/parse failure (a wrong key is
/// indistinguishable from tampering, the §6.4 discipline). Returns the keypair
/// and the person id it was sealed for.
pub async fn read_person_vault_carrier(
    host: &dyn crate::host::HostCtx,
    io: &dyn VaultIo,
    vault_id: &[u8; 16],
    root_key: &[u8; 32],
) -> Option<(protocol::PersonKeyPair, [u8; 16])> {
    let path = carrier_path(host, vault_id)?;
    let bytes = io.read(&path).await.ok()?;
    let env: CarrierEnvelope = serde_json::from_slice(&bytes).ok()?;
    if env.vault_id_hex != hex_lower(vault_id) {
        return None;
    }
    let person_id = hex16(&env.person_id_hex)?;
    let nonce_vec = hex_n(&env.nonce_hex, protocol::AEAD_NONCE_LEN)?;
    let mut nonce = [0u8; protocol::AEAD_NONCE_LEN];
    nonce.copy_from_slice(&nonce_vec);
    let sealed = hex_n(
        &env.sealed_hex,
        protocol::PERSON_PLAINTEXT_LEN + protocol::CTX_COMMITMENT_TAG_LEN,
    )?;
    let key = carrier_key(root_key);
    let aad = protocol::aad_person_vault_carrier(vault_id, &person_id);
    let plaintext = protocol::aead_open_ctx(&key, &nonce, &sealed, &aad).ok()?;
    if plaintext.len() != protocol::PERSON_PLAINTEXT_LEN {
        return None;
    }
    let mut arr = [0u8; protocol::PERSON_PLAINTEXT_LEN];
    arr.copy_from_slice(&plaintext);
    let pair = protocol::PersonKeyPair::from_plaintext_bytes(&arr);
    arr.zeroize();
    Some((pair, person_id))
}

/// Whether this vault has a person-identity carrier. Test-only today: the
/// unlock path opens the carrier directly and treats absence as a miss.
#[cfg(test)]
pub async fn person_vault_carrier_exists(
    host: &dyn crate::host::HostCtx,
    io: &dyn VaultIo,
    vault_id: &[u8; 16],
) -> bool {
    match carrier_path(host, vault_id) {
        Some(path) => io.exists(&path).await.unwrap_or(false),
        None => false,
    }
}

/// Erase one vault's carrier (vault delete). Best-effort.
pub async fn delete_person_vault_carrier(
    host: &dyn crate::host::HostCtx,
    io: &dyn VaultIo,
    vault_id: &[u8; 16],
) {
    if let Some(path) = carrier_path(host, vault_id) {
        let _ = io.remove_file(&path).await;
    }
}

/// Erase every vault's carrier (person off-boarding from this device): one
/// device-local directory, so a forget does not leave a carrier behind that
/// would silently re-install the identity at the next unlock. Propagates a
/// failure: a forget that reported success while a carrier survived would
/// re-install the identity it claimed to erase.
pub async fn delete_all_person_vault_carriers(
    host: &dyn crate::host::HostCtx,
    io: &dyn VaultIo,
) -> Result<(), ()> {
    let Some(dir) = carrier_dir(host) else {
        return Ok(());
    };
    match io.remove_dir_all(&dir).await {
        Ok(()) | Err(crate::io_failure_kind::IoFailureKind::NotFound) => Ok(()),
        Err(_) => Err(()),
    }
}

/// Whether this vault's `vault.meta` is an `NTV6` frame.
async fn is_ntv6(io: &dyn VaultIo, vault_root: &std::path::Path) -> bool {
    io.read(&vault_root.join("vault.meta"))
        .await
        .map(|b| b.get(..4) == Some(protocol::VAULT_META_NTV6_MAGIC.as_slice()))
        .unwrap_or(false)
}

/// Refresh the carrier for the active vault after a person unlock. Best-effort:
/// only an owner vault (a held `root_key`) that is `NTV6` gets one, and any
/// failure is swallowed (it must never block the person unlock).
#[cfg(not(target_arch = "wasm32"))]
pub async fn refresh_carrier_best_effort(
    host: &dyn crate::host::HostCtx,
    io: &dyn VaultIo,
    state: &crate::plugins::vault_unlock::state::VaultRuntimeState,
    person_id: &[u8; 16],
    pair: &protocol::PersonKeyPair,
) {
    let Some(active) = state.active_vault_id().await else {
        return;
    };
    let Ok(base) = host.app_data_dir() else {
        return;
    };
    let Some(root_key) = state.peek_unlocked_root_key_clone().await else {
        return;
    };
    let root = crate::paths::vault_root_for_id_from_base(&base, active);
    if !is_ntv6(io, &root).await {
        return;
    }
    let _ = write_person_vault_carrier(
        host,
        io,
        active.as_uuid().as_bytes(),
        person_id,
        &root_key,
        pair,
    )
    .await;
}

/// Install the person session from the carrier at owner-vault unlock, if this
/// vault is `NTV6`, the person session is not already held, and a carrier exists.
/// Best-effort: any failure leaves unlock intact and sync simply reports
/// `identity_locked`, exactly as before this file existed.
///
/// The session's per-vault private AI profile key is derived from the phrase and
/// is **not** recoverable here, so `profile` is `None`; the profile plane stays
/// dormant until the next phrase unlock. Head signing (what sync needs) does not
/// use it.
#[cfg(not(target_arch = "wasm32"))]
pub async fn install_from_carrier_best_effort(
    host: &dyn crate::host::HostCtx,
    io: &dyn VaultIo,
    state: &crate::plugins::vault_unlock::state::VaultRuntimeState,
) {
    let Some(active) = state.active_vault_id().await else {
        return;
    };
    if state.person_identity_unlocked().await {
        return;
    }
    // An explicit person lock suppresses auto-install: it must not be silently
    // reversed by the next owner-vault unlock (myne-md/myne#792 review).
    if state.person_explicit_lock().await {
        return;
    }
    let Ok(base) = host.app_data_dir() else {
        return;
    };
    let Some(root_key) = state.peek_unlocked_root_key_clone().await else {
        return;
    };
    let root = crate::paths::vault_root_for_id_from_base(&base, active);
    if !is_ntv6(io, &root).await {
        return;
    }
    let vault_id = *active.as_uuid().as_bytes();
    let Some((pair, person_id)) = read_person_vault_carrier(host, io, &vault_id, &root_key).await
    else {
        return;
    };
    let generation = state.person_session_generation().await;
    let transition = crate::account::person_identity::read_pending_person_key_transition(host, io)
        .await
        .ok()
        .flatten();
    let install = crate::plugins::vault_unlock::state::PersonSessionInstall {
        pair,
        person_id,
        profile: None,
        transition,
    };
    let _ = state
        .install_person_session_if_generation(generation, install)
        .await;
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::ScopedTempDir;
    use std::sync::Arc;

    /// A minimal `HostCtx` whose `app_config_dir` is a scoped temp dir.
    struct CarrierHost {
        base: std::path::PathBuf,
    }

    impl crate::host::HostCtx for CarrierHost {
        fn app_data_dir(&self) -> Result<std::path::PathBuf, crate::host::HostPathError> {
            Ok(self.base.clone())
        }
        fn app_config_dir(&self) -> Result<std::path::PathBuf, crate::host::HostPathError> {
            Ok(self.base.clone())
        }
        fn now_unix_millis(&self) -> u64 {
            0
        }
        fn monotonic_millis(&self) -> u64 {
            0
        }
        fn emit(&self, _event: &'static str, _payload: crate::host::EventPayload) {}
    }

    fn pair() -> protocol::PersonKeyPair {
        let seeds = protocol::kdf::expand_person_identity_key_seeds(&[7u8; 32]);
        protocol::PersonKeyPair::generate_raw(&seeds.kem, &seeds.ed25519, &seeds.mldsa)
    }

    // Seal then open with the same root_key: the keypair round-trips. A wrong
    // root_key and a wrong vault id both fail closed (AEAD).
    #[test]
    fn carrier_round_trips_and_refuses_wrong_key_or_ids() {
        crate::test_support::block_on(async {
            let tmp = Arc::new(ScopedTempDir::new("person-vault-carrier").expect("temp dir"));
            let host = CarrierHost {
                base: tmp.path().to_path_buf(),
            };
            let io = crate::vault_io::StdVaultIo;
            let vault_id = [0x11u8; 16];
            let person_id = [0x22u8; 16];
            let root_key = [0x33u8; 32];
            let p = pair();

            write_person_vault_carrier(&host, &io, &vault_id, &person_id, &root_key, &p)
                .await
                .expect("write");
            assert!(person_vault_carrier_exists(&host, &io, &vault_id).await);

            let (opened, opened_person) =
                read_person_vault_carrier(&host, &io, &vault_id, &root_key)
                    .await
                    .expect("open");
            assert_eq!(opened_person, person_id);
            assert_eq!(opened.fingerprint(), p.fingerprint());

            // A wrong root_key fails closed.
            assert!(
                read_person_vault_carrier(&host, &io, &vault_id, &[0x44u8; 32])
                    .await
                    .is_none()
            );
            // A carrier mislaid under another vault name still refuses: both the
            // header's vault id and the AAD bind the real one.
            let src = carrier_path(&host, &vault_id).expect("src path");
            let dst = carrier_path(&host, &[0x99u8; 16]).expect("dst path");
            std::fs::copy(&src, &dst).expect("copy carrier to another name");
            assert!(
                read_person_vault_carrier(&host, &io, &[0x99u8; 16], &root_key)
                    .await
                    .is_none()
            );
            let _ = std::fs::remove_file(&dst);

            let _ = delete_all_person_vault_carriers(&host, &io).await;
            assert!(!person_vault_carrier_exists(&host, &io, &vault_id).await);
        });
    }

    fn seed_vault_meta(base: &std::path::Path, id: crate::vault_id::VaultId, magic: &[u8]) {
        let root = crate::paths::vault_root_for_id_from_base(base, id);
        std::fs::create_dir_all(&root).expect("vault root");
        std::fs::write(root.join("vault.meta"), magic).expect("vault.meta");
    }

    async fn unlocked_owner(
        state: &crate::plugins::vault_unlock::state::VaultRuntimeState,
        id: crate::vault_id::VaultId,
        root_byte: u8,
    ) {
        let generation = state.person_session_generation().await;
        state
            .set_unlocked_locking_others_with_person_session(
                generation,
                id,
                crate::plugins::vault_unlock::state::fixture_unlocked_with_keys(root_byte, 9, 1),
                None,
            )
            .await;
    }

    // refresh_carrier_best_effort writes for an NTV6 owner vault and does
    // nothing for an NTV5 one.
    #[test]
    fn refresh_writes_only_for_an_ntv6_owner_vault() {
        crate::test_support::block_on(async {
            let tmp = ScopedTempDir::new("carrier-refresh").expect("temp dir");
            let host = CarrierHost {
                base: tmp.path().to_path_buf(),
            };
            let io = crate::vault_io::StdVaultIo;
            let vault_id = crate::plugins::vault_unlock::state::test_vault_id();
            let person_id = [0x22u8; 16];
            let p = pair();

            seed_vault_meta(tmp.path(), vault_id, &protocol::VAULT_META_NTV6_MAGIC);
            let state = crate::plugins::vault_unlock::state::VaultRuntimeState::default();
            unlocked_owner(&state, vault_id, 0x33).await;

            refresh_carrier_best_effort(&host, &io, &state, &person_id, &p).await;
            assert!(person_vault_carrier_exists(&host, &io, vault_id.as_uuid().as_bytes()).await);
            let _ = delete_all_person_vault_carriers(&host, &io).await;

            // An NTV5 vault writes nothing.
            let vault_id_b = crate::plugins::vault_unlock::state::test_vault_id_b();
            seed_vault_meta(tmp.path(), vault_id_b, b"MYV1");
            unlocked_owner(&state, vault_id_b, 0x34).await;
            refresh_carrier_best_effort(&host, &io, &state, &person_id, &p).await;
            assert!(
                !person_vault_carrier_exists(&host, &io, vault_id_b.as_uuid().as_bytes()).await
            );
        });
    }

    // install_from_carrier_best_effort installs the session for an NTV6 owner
    // vault with a carrier, and stands down for an NTV5 vault and after an
    // explicit person lock.
    #[test]
    fn install_from_carrier_installs_for_ntv6_and_stands_down_otherwise() {
        crate::test_support::block_on(async {
            let tmp = ScopedTempDir::new("carrier-install").expect("temp dir");
            let host = CarrierHost {
                base: tmp.path().to_path_buf(),
            };
            let io = crate::vault_io::StdVaultIo;
            let vault_id = crate::plugins::vault_unlock::state::test_vault_id();
            let root_key = [0x33u8; 32];
            let person_id = [0x22u8; 16];
            let p = pair();

            seed_vault_meta(tmp.path(), vault_id, &protocol::VAULT_META_NTV6_MAGIC);
            let state = crate::plugins::vault_unlock::state::VaultRuntimeState::default();
            unlocked_owner(&state, vault_id, 0x33).await;
            write_person_vault_carrier(
                &host,
                &io,
                vault_id.as_uuid().as_bytes(),
                &person_id,
                &root_key,
                &p,
            )
            .await
            .expect("write");

            // An explicit person lock suppresses auto-install.
            state.set_person_explicit_lock().await;
            install_from_carrier_best_effort(&host, &io, &state).await;
            assert!(state.clone_person_identity().await.is_none());

            // A real install (phrase unlock) clears the lock, then the carrier
            // installs the matching keypair.
            state.set_person_identity(p.clone()).await;
            state.clear_person_session().await;
            install_from_carrier_best_effort(&host, &io, &state).await;
            let held = state.clone_person_identity().await.expect("installed");
            assert_eq!(held.fingerprint(), p.fingerprint());
            assert_eq!(state.clone_person_id().await, Some(person_id));

            // An NTV5 vault installs nothing even with a carrier present.
            let vault_id_b = crate::plugins::vault_unlock::state::test_vault_id_b();
            seed_vault_meta(tmp.path(), vault_id_b, b"MYV1");
            unlocked_owner(&state, vault_id_b, 0x33).await;
            state.clear_person_session().await;
            write_person_vault_carrier(
                &host,
                &io,
                vault_id_b.as_uuid().as_bytes(),
                &person_id,
                &root_key,
                &p,
            )
            .await
            .expect("write b");
            install_from_carrier_best_effort(&host, &io, &state).await;
            assert!(state.clone_person_identity().await.is_none());
        });
    }
}
