// SPDX-License-Identifier: AGPL-3.0-only

//! Device-scoped person account credential store (myne-md/myne#711).
//!
//! A person account's per-device bearer token cannot live in the vault-scoped
//! token store: a vault-less identity has no vault directory to write under.
//! It lives beside the endpoint config in `<app_config_dir>/person-auth.json`,
//! the one device-scoped seam (`config.rs` documents why `app_config_dir`
//! exists at all). The store holds **no key material**: the token is a
//! revocable availability credential of the same class as the endpoint pin, so
//! it is protected like the rest of the device-local config (filesystem
//! permissions), not wrapped under a keychain key. That choice is recorded as
//! `[person-token-storage] A` in
//! `private-companion/features/b2b-member-sync/progress.md`.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::host::HostCtx;
use crate::vault_io::{VaultIo, WriteOpts};

/// The device-local file name, beside `sync-config.json`.
pub const PERSON_AUTH_FILE: &str = "person-auth.json";

/// The person account's device-local credential. `token_hex` is a bearer
/// credential: never log it, and never cross it over IPC.
///
/// The three public-half fields are PUBLIC material (the person keypair's KEM
/// ek, Ed25519 pk and ML-DSA vk). They live here so the identity home can render
/// the out-of-band person identity code (myne-md/myne#711 task 11) without the
/// recovery phrase crossing IPC again. `#[serde(default)]` keeps a pre-task-11
/// credential file readable. Deliberately NO `Debug`: the type holds the
/// device bearer token, and a derived `Debug` turns one future `tracing::debug!`
/// into a live-credential log line.
#[derive(Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct PersonAuth {
    pub person_id_hex: String,
    pub device_id_hex: String,
    /// Whether this identity has been registered with a server (myne-md/myne#911).
    ///
    /// The persistent half of the three-state lifecycle: a sealed identity with
    /// `registered == false` is `reserved` and has sent nothing; `true` with an
    /// empty token is `pending`. `#[serde(default)]` keeps a pre-feature
    /// credential file readable, and the status derivation deliberately decides
    /// `enrolled` from the TOKEN rather than from this flag, so a legacy file
    /// with a token still reads as enrolled rather than as reserved.
    #[serde(default)]
    pub registered: bool,
    pub token_hex: String,
    #[serde(default)]
    pub kem_ek_hex: String,
    #[serde(default)]
    pub ed_pk_hex: String,
    #[serde(default)]
    pub mldsa_vk_hex: String,
    /// This device's OWN server-auth secret, minted from CSPRNG bytes the first time this
    /// device registers on a person account (`decisions/protocol/0735`; installed on the
    /// approval tap by `0784`).
    ///
    /// It is stored beside `token_hex` on purpose, and the reason is a threat-model
    /// statement rather than a convenience: the token already authenticates every request
    /// this device makes, so a second credential that grants the same account authority
    /// adds no exposure this file did not already carry. Hiding it behind a keychain rung
    /// would protect the weaker of the two secrets and leave the stronger one in the same
    /// file, which is the kind of asymmetry that reads as security and is not.
    ///
    /// Present from the moment a device registers, including while its row is still
    /// PENDING: the phrase is in hand exactly once, and a secret written only after the
    /// approval would have to ask for it again. Absent on every pre-feature file, on a
    /// device that never registered, and on the browser, which keeps no person credential
    /// at rest at all. Redacted from `Debug` like the token.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub device_secret_hex: Option<String>,
    /// The salt this device's credential was derived under (lowercase hex). Public
    /// material: the server echoes it back on every handshake.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub device_salt_hex: Option<String>,
    /// The PBKDF2 iteration count of this device's credential.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub device_iterations: Option<u32>,
}

/// Redacting `Debug`: the public halves are shown, but `token_hex` is never
/// printed. `assert_eq!` in the tests needs `Debug`; a derive would make the
/// token a `?`-format away from a log line.
impl std::fmt::Debug for PersonAuth {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("PersonAuth")
            .field("person_id_hex", &self.person_id_hex)
            .field("device_id_hex", &self.device_id_hex)
            .field("token_hex", &"<redacted>")
            .finish_non_exhaustive()
    }
}

/// Failures reading/writing the person credential. Deliberately one opaque
/// variant: the UI cannot act differently on a parse vs an IO failure here, and
/// neither message may carry a path or the token.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PersonAuthError {
    Io,
}

/// `<app_config_dir>/person-auth.json`, creating the config directory. Callers
/// about to write use this; a read-only caller uses
/// [`person_auth_path_for_read`] so a query does not create a directory.
pub async fn person_auth_path(
    host: &dyn HostCtx,
    io: &dyn VaultIo,
) -> Result<PathBuf, PersonAuthError> {
    let dir = host.app_config_dir().map_err(|_| PersonAuthError::Io)?;
    io.create_dir_all(&dir)
        .await
        .map_err(|_| PersonAuthError::Io)?;
    Ok(dir.join(PERSON_AUTH_FILE))
}

/// The same path, without creating the directory.
pub fn person_auth_path_for_read(host: &dyn HostCtx) -> Result<PathBuf, PersonAuthError> {
    host.app_config_dir()
        .map(|d| d.join(PERSON_AUTH_FILE))
        .map_err(|_| PersonAuthError::Io)
}

/// Read the stored person credential. `None` means "no person account on this
/// device" (an absent file); a present-but-unparseable file is `Err(Io)` rather
/// than a silent default, the same discipline `read_config` follows, because
/// the write path a few lines below would otherwise erase a live token.
pub async fn read_person_auth(
    io: &dyn VaultIo,
    path: &Path,
) -> Result<Option<PersonAuth>, PersonAuthError> {
    match crate::singleton::open_newest(io, path, |bytes| {
        serde_json::from_slice::<PersonAuth>(bytes)
    })
    .await
    {
        Ok(v) => Ok(Some(v)),
        Err(crate::singleton::OpenOutcome::Absent) => Ok(None),
        Err(crate::singleton::OpenOutcome::Undecodable(_))
        | Err(crate::singleton::OpenOutcome::Io(_)) => Err(PersonAuthError::Io),
    }
}

/// Persist the person credential (atomic replace).
pub async fn write_person_auth(
    io: &dyn VaultIo,
    path: &Path,
    auth: &PersonAuth,
) -> Result<(), PersonAuthError> {
    let bytes = serde_json::to_vec_pretty(auth).map_err(|_| PersonAuthError::Io)?;
    io.write(path, &bytes, WriteOpts::default())
        .await
        .map_err(|_| PersonAuthError::Io)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::ScopedTempDir;

    #[test]
    fn round_trips_and_distinguishes_absent_from_corrupt() {
        crate::test_support::block_on(async {
            let tmp = ScopedTempDir::new("person-auth").expect("temp dir");
            let io = crate::vault_io::StdVaultIo;
            let path = tmp.path().join(PERSON_AUTH_FILE);

            // Absent is None, not an error.
            assert_eq!(read_person_auth(&io, &path).await, Ok(None));

            let auth = PersonAuth {
                person_id_hex: "11".repeat(16),
                device_id_hex: "22".repeat(16),
                registered: false,
                token_hex: "33".repeat(32),
                ..Default::default()
            };
            write_person_auth(&io, &path, &auth).await.expect("write");
            assert_eq!(read_person_auth(&io, &path).await, Ok(Some(auth)));

            // A corrupt file is an error, never a silent default.
            use crate::vault_io::VaultIo as _;
            io.write(&path, b"{ not json", WriteOpts::default())
                .await
                .expect("write corrupt");
            assert_eq!(read_person_auth(&io, &path).await, Err(PersonAuthError::Io));
        });
    }
}
