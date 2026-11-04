// SPDX-License-Identifier: AGPL-3.0
//! The two-sided device admission ceremony (`decisions/protocol/0735`; myne-md/myne#938
//! task 11).
//!
//! A device joins a person's account by showing a code that another, already-admitted
//! device reads. The code carries a **credential-equivalent** SCRAM verifier, so the
//! exchange is wrapped in a short authentication string both screens display: the human
//! compares eight hex characters, and the admitting device's write is bound to the string
//! they confirmed.
//!
//! # What is a client-behaviour guarantee, and what is not
//!
//! This module enforces **two taps**: the admitting device writes nothing until its own
//! confirm call, and the joining device persists nothing until its own. A cancel on either
//! side leaves that side exactly as it was. What it does **not** do is prove mutuality to a
//! cryptography reader: there is no signed confirmation token and no server-mediated phase
//! (both considered and rejected in the PRD's "Out of Scope"), so a malicious peer that
//! skips its own tap is not detected by the other side. The guarantee is that the honest
//! client cannot complete an exchange without both humans, which is what the code below
//! gates and what its tests measure.
//!
//! # Why the write is bound to the SAS
//!
//! `0735` decision 3: "the write is bound to the SAS the user confirmed, so the code cannot
//! change between the screen that showed the string and the button that accepted it."
//! Both confirm paths therefore take the string the human saw and re-derive it from the
//! code in hand. A mismatch is [`SyncDeviceError::SasMismatch`] and **nothing is written**,
//! rather than "close enough", because a code that changed under the user is exactly the attack
//! the SAS exists to catch.
//!
//! # Where the pending state lives
//!
//! In RAM, on the person session ([`VaultRuntimeState::set_pending_admission`]), and it is
//! cleared by a vault lock, an identity lock, a forget and process exit, the same way the
//! pending claim secret is. A minted secret on disk before the human confirms would be
//! precisely the "wrote something" the two-sided rule forbids.
//!
//! **The vault lock was a promise the code did not keep** until the myne-md/myne#938 review:
//! `clear_person_session` ran only when NO vault was open, so locking an open vault left the
//! minted code and its secret resident for the life of the process. `lock_with_state` now
//! clears it on both arms.
//!
//! **One write does happen before a confirm, and it is not this ceremony's**: minting the
//! code loads or creates this device's own signing key, which persists through the platform
//! store on first use (rung 1 to 3 of the ladder). That is the device's key rather than a
//! credential for the exchange, it happens on the first sync action regardless of admission,
//! and a cancel leaves it — so the ACL description says "writes no credential" rather than
//! "writes nothing" (myne-md/myne#938 review).

use crate::host::HostCtx;
use crate::plugins::sync::enroll::{
    install_device_credential, mint_device_credential, DeviceCredential,
};
use crate::plugins::sync::{config, devices::SyncDeviceError, http_transport, person_auth};
use crate::vault_io::VaultIo;
use protocol::device_key::DeviceAdmission;
use zeroize::Zeroizing;

/// What the joining device shows: the code, and the SAS both screens must agree on.
#[derive(Debug, Clone, serde::Serialize)]
pub struct AdmissionMintedView {
    /// The `MYNE-DEVICE-1:` code, for the other device to read.
    pub code: String,
    /// The eight hex characters (with a dash) both screens display.
    pub sas: String,
    /// This device's id, 32 lowercase hex, shown so a user can match it against the
    /// other screen if the SAS is not enough.
    pub device_id_hex: String,
    /// False when this platform has no device-key storage rung, which the surface must
    /// say plainly: the device is admittable, it just signs `0x02` heads afterwards.
    pub has_device_key: bool,
}

/// What the admitting device shows BEFORE it writes anything.
#[derive(Debug, Clone, serde::Serialize)]
pub struct AdmissionPreviewView {
    /// The SAS derived from the code in hand. The surface shows it; the human compares.
    pub sas: String,
    pub device_id_hex: String,
    pub person_id_hex: String,
    /// Whether the joining device declared signing halves. A device without them is still
    /// admittable and cannot author `0x03` heads.
    pub has_device_key: bool,
}

/// The answer once the admitting device has written: the credential installed and the
/// binding row claimed.
#[derive(Debug, Clone, serde::Serialize)]
pub struct AdmissionConfirmedView {
    pub device_id_hex: String,
    pub sas: String,
    /// False when the row could not be written (`MYU5` needs a group-tier session and a
    /// person keypair). The credential is still installed, so the device authenticates;
    /// the row is what publishes its signing halves, and the next claim retries it.
    pub binding_written: bool,
}

/// Mint an admission on the JOINING device. Writes nothing: the code and the SAS go to the
/// screen, and the secret waits in RAM for [`confirm_minted_from_host`].
///
/// `person_id_hex` comes from the QR this device scanned. It is not a secret (the admitting
/// device is signed in to that account), and carrying it is what lets the code be refused
/// if it is applied to the wrong account.
pub async fn mint_from_host(
    state: &crate::plugins::vault_unlock::state::VaultRuntimeState,
    person_id_hex: &str,
) -> Result<AdmissionMintedView, SyncDeviceError> {
    let _person_id =
        crate::plugins::sync::devices::hex16(person_id_hex).ok_or(SyncDeviceError::BadRequest)?;

    // A fresh id: this device has no person-plane identity yet, so there is nothing to
    // adopt. The admitting device installs the credential FOR this id, which is why the id
    // is minted here rather than there.
    let mut device_id = [0u8; 16];
    getrandom::getrandom(&mut device_id).map_err(|_| SyncDeviceError::Internal)?;
    let mut secret = Zeroizing::new([0u8; 32]);
    getrandom::getrandom(secret.as_mut()).map_err(|_| SyncDeviceError::Internal)?;

    let credential = mint_device_credential(secret.as_ref()).map_err(SyncDeviceError::from)?;

    // The signing halves, when the platform has somewhere to keep them. Rung 4 is not a
    // fault: the device joins and signs with the phrase, which the surface states.
    let public = match crate::plugins::sync::device_identity::load_or_create() {
        Ok(pair) => Some(pair.public_half()),
        Err(crate::plugins::sync::device_identity::DeviceKeyStoreError::Unsupported) => None,
        Err(err) => {
            tracing::warn!(
                stage = "device_admission",
                error = ?err,
                "no device key could be created; the device is admitted without signing halves"
            );
            None
        }
    };

    let admission = DeviceAdmission {
        device_id,
        person_id_hex: person_id_hex.trim().to_lowercase(),
        public,
        salt_hex: credential.salt_hex.clone(),
        iterations: credential.iterations,
        stored_key_hex: credential.stored_key_hex.clone(),
        server_key_hex: credential.server_key_hex.clone(),
    };
    let sas = admission.sas();
    let view = AdmissionMintedView {
        code: admission.encode(),
        sas,
        device_id_hex: hex(&device_id),
        has_device_key: admission.public.is_some(),
    };
    state.set_pending_admission(admission.clone(), secret).await;
    Ok(view)
}

/// Persist the minted admission on the joining device, **only** after its own tap.
///
/// `confirmed_sas` is the string the human saw on both screens. It is re-derived from the
/// pending admission, so a code that changed under the user is refused rather than written.
/// After the write this device attempts its device-credential login; a refusal is the
/// ordinary state (the other device has not tapped yet), which is why the answer is a
/// status rather than an error.
pub async fn confirm_minted_from_host(
    host: &dyn HostCtx,
    io: &dyn VaultIo,
    state: &crate::plugins::vault_unlock::state::VaultRuntimeState,
    confirmed_sas: &str,
) -> Result<bool, SyncDeviceError> {
    let Some((admission, secret)) = state.pending_admission().await else {
        return Err(SyncDeviceError::NoPendingAdmission);
    };
    // The bind: what was confirmed is what gets written. A code whose SAS moved between the
    // screen and the button is refused here, with nothing persisted.
    if admission.sas() != confirmed_sas.trim() {
        return Err(SyncDeviceError::SasMismatch);
    }

    let auth_path = person_auth::person_auth_path(host, io)
        .await
        .map_err(|_| SyncDeviceError::Internal)?;
    let existing = person_auth::read_person_auth(io, &auth_path)
        .await
        .map_err(|_| SyncDeviceError::Internal)?;
    // A device that already holds an identity keeps it: overwriting `person-auth` here would
    // orphan the identity the phrase sealed, which is a data-loss path rather than a
    // re-admission.
    if existing
        .as_ref()
        .is_some_and(|a| a.person_id_hex != admission.person_id_hex)
    {
        return Err(SyncDeviceError::AlreadyHeldIdentity);
    }

    let mut auth = existing.unwrap_or(person_auth::PersonAuth {
        person_id_hex: admission.person_id_hex.clone(),
        device_id_hex: String::new(),
        registered: false,
        token_hex: String::new(),
        kem_ek_hex: String::new(),
        ed_pk_hex: String::new(),
        mldsa_vk_hex: String::new(),
        device_secret_hex: None,
        device_salt_hex: None,
        device_iterations: None,
    });
    auth.device_id_hex = hex(&admission.device_id);
    // `registered: true` with an empty token is the PENDING state the status derivation
    // already reads (`person_auth`'s three-state lifecycle): this device has told the
    // server about itself (the admitting device installed the credential) and has no
    // session yet.
    auth.registered = true;
    auth.device_secret_hex = Some(hex(secret.as_ref()));
    auth.device_salt_hex = Some(admission.salt_hex.clone());
    auth.device_iterations = Some(admission.iterations);
    person_auth::write_person_auth(io, &auth_path, &auth)
        .await
        .map_err(|_| SyncDeviceError::Internal)?;

    // The pending slot's job is done: the secret is on disk now, so keeping a second copy
    // in RAM only widens the window it can be read from.
    state.clear_pending_admission().await;

    // Try to authenticate as this device. Success means the other side already tapped;
    // `Unauthenticated` means it has not, which is the ordinary answer and not a failure of
    // this call.
    match login_as_device(host, io, &admission, secret.as_ref()).await {
        Ok(()) => Ok(true),
        Err(SyncDeviceError::Unauthenticated) | Err(SyncDeviceError::AwaitingApproval) => Ok(false),
        Err(other) => Err(other),
    }
}

/// Parse a code the admitting device was handed, and derive the SAS. **Writes nothing** and
/// takes no IO: this is the call whose whole contract is that nothing happens yet.
pub async fn preview_from_host(
    state: &crate::plugins::vault_unlock::state::VaultRuntimeState,
    code: &str,
) -> Result<AdmissionPreviewView, SyncDeviceError> {
    let admission = DeviceAdmission::decode(code).map_err(|_| SyncDeviceError::BadRequest)?;
    // A code naming another account is refused rather than installed into this one: the
    // session is the authority and the body never is (`0735`).
    if let Some(status) = state.person_identity_status().await {
        if status.person_id != decode_person_id(&admission)? {
            return Err(SyncDeviceError::PersonMismatch);
        }
    }
    Ok(preview_of(&admission))
}

/// Install the credential and write the binding row, **only** after the admitting device's
/// own tap, and only for the code whose SAS the human confirmed.
pub async fn confirm_preview_from_host(
    host: &dyn HostCtx,
    io: &dyn VaultIo,
    state: &crate::plugins::vault_unlock::state::VaultRuntimeState,
    code: &str,
    confirmed_sas: &str,
) -> Result<AdmissionConfirmedView, SyncDeviceError> {
    let admission = DeviceAdmission::decode(code).map_err(|_| SyncDeviceError::BadRequest)?;
    // The bind, the same one the joining side applies. Checked before anything is read from
    // disk or sent to the server.
    if admission.sas() != confirmed_sas.trim() {
        return Err(SyncDeviceError::SasMismatch);
    }
    if let Some(status) = state.person_identity_status().await {
        if status.person_id != decode_person_id(&admission)? {
            return Err(SyncDeviceError::PersonMismatch);
        }
    }

    let (person, _person_id) = crate::plugins::device_binding::commands::session_person_id(state)
        .await
        .map_err(|_| SyncDeviceError::PersonSessionRequired)?;
    let token = person_token(host, io).await?;

    let credential = DeviceCredential {
        salt_hex: admission.salt_hex.clone(),
        iterations: admission.iterations,
        stored_key_hex: admission.stored_key_hex.clone(),
        server_key_hex: admission.server_key_hex.clone(),
    };
    let device_id = admission.device_id;
    let device_public = admission.public;
    let sas = admission.sas();

    // The install and the approval are ONE act server-side, so this is the delivery the
    // two-sided rule gates.
    let url = endpoint_url(host, io).await?;
    let credential_for_call = credential.clone();
    crate::task::run_blocking(move || {
        let transport =
            http_transport::build_transport(&url).map_err(|_| SyncDeviceError::Transport)?;
        install_device_credential(transport.as_ref(), &token, &device_id, &credential_for_call)
            .map_err(SyncDeviceError::from)
    })
    .await
    .map_err(|_| SyncDeviceError::Internal)??;

    // The row publishes the joining device's signing halves under the person's signature.
    // Best-effort: the credential above is what makes the device authenticate, and a vault
    // whose group tier is not open writes the row on its next claim rather than failing an
    // exchange that has already succeeded server-side.
    let binding_written = match host.app_data_dir() {
        Ok(base) => {
            let vault_dir =
                crate::paths::active_vault_root_from_base(&base, state.active_vault_id().await);
            match crate::plugins::device_binding::commands::resolve_bindings(io, state, &vault_dir)
                .await
            {
                Ok(resolved) => {
                    let mut rng = rand_core::UnwrapErr(crate::rng::OsRng);
                    crate::plugins::device_binding::store::admit_other_in_dir(
                        io,
                        &vault_dir,
                        &resolved.borrow(),
                        &person,
                        &device_id,
                        device_public.as_ref(),
                        &mut rng,
                    )
                    .await
                    .is_ok()
                }
                Err(_) => false,
            }
        }
        Err(_) => false,
    };
    Ok(AdmissionConfirmedView {
        device_id_hex: hex(&device_id),
        sas,
        binding_written,
    })
}

/// Drop the pending admission. What a cancel on the joining side does: nothing was written,
/// so there is nothing to undo beyond forgetting the secret.
pub async fn cancel_from_host(state: &crate::plugins::vault_unlock::state::VaultRuntimeState) {
    state.clear_pending_admission().await;
}

fn preview_of(admission: &DeviceAdmission) -> AdmissionPreviewView {
    AdmissionPreviewView {
        sas: admission.sas(),
        device_id_hex: hex(&admission.device_id),
        person_id_hex: admission.person_id_hex.clone(),
        has_device_key: admission.public.is_some(),
    }
}

fn decode_person_id(admission: &DeviceAdmission) -> Result<[u8; 16], SyncDeviceError> {
    crate::plugins::sync::devices::hex16(&admission.person_id_hex)
        .ok_or(SyncDeviceError::BadRequest)
}

/// Lowercase hex, from the one encoder the protocol crate exposes rather than a second
/// implementation in this module.
fn hex(bytes: &[u8]) -> String {
    protocol::hex::encode_lower(bytes)
}

/// The person-plane bearer token, or the honest refusal for a device that has none.
async fn person_token(host: &dyn HostCtx, io: &dyn VaultIo) -> Result<String, SyncDeviceError> {
    let path =
        person_auth::person_auth_path_for_read(host).map_err(|_| SyncDeviceError::Internal)?;
    person_auth::read_person_auth(io, &path)
        .await
        .map_err(|_| SyncDeviceError::Internal)?
        .filter(|a| !a.token_hex.is_empty())
        .map(|a| a.token_hex)
        .ok_or(SyncDeviceError::NotEnrolled)
}

async fn endpoint_url(host: &dyn HostCtx, io: &dyn VaultIo) -> Result<String, SyncDeviceError> {
    let path = config::config_path_from_host(host, io)
        .await
        .map_err(|_| SyncDeviceError::Internal)?;
    config::read_config(io, &path)
        .await
        .map_err(|_| SyncDeviceError::NotConfigured)?
        .endpoint_url
        .ok_or(SyncDeviceError::NotConfigured)
}

/// Authenticate as this device with the credential the other side installed, and store the
/// session it returns.
///
/// The handshake itself is [`crate::plugins::sync::enroll::device_login`], shared with the
/// merged approval flow (`decisions/protocol/0784`); this function's own job is the one the
/// ceremony needs and the merged flow does not: the OTHER device installed the verifier, so
/// there is nothing to install here, only a login and a stored token.
async fn login_as_device(
    host: &dyn HostCtx,
    io: &dyn VaultIo,
    admission: &DeviceAdmission,
    secret: &[u8],
) -> Result<(), SyncDeviceError> {
    let url = endpoint_url(host, io).await?;
    let person_id = decode_person_id(admission)?;
    let device_id = admission.device_id;
    let secret = Zeroizing::new(secret.to_vec());
    let mut nonce_bytes = [0u8; 32];
    getrandom::getrandom(&mut nonce_bytes).map_err(|_| SyncDeviceError::Internal)?;
    let client_nonce = hex(&nonce_bytes);

    let outcome = crate::task::run_blocking(move || {
        let transport =
            http_transport::build_transport(&url).map_err(|_| SyncDeviceError::Transport)?;
        super::enroll::device_login(
            transport.as_ref(),
            &person_id,
            device_id,
            secret.as_ref(),
            &client_nonce,
        )
        .map_err(SyncDeviceError::from)
    })
    .await
    .map_err(|_| SyncDeviceError::Internal)??;

    if !outcome.approved || outcome.token.is_empty() {
        return Err(SyncDeviceError::AwaitingApproval);
    }
    let path = person_auth::person_auth_path(host, io)
        .await
        .map_err(|_| SyncDeviceError::Internal)?;
    let Some(mut auth) = person_auth::read_person_auth(io, &path)
        .await
        .map_err(|_| SyncDeviceError::Internal)?
    else {
        return Err(SyncDeviceError::Internal);
    };
    auth.token_hex = hex(&outcome.token);
    auth.registered = true;
    person_auth::write_person_auth(io, &path, &auth)
        .await
        .map_err(|_| SyncDeviceError::Internal)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::host::test_host::TestHost;
    use crate::plugins::sync::devices::SyncDeviceError;
    use crate::plugins::vault_unlock::state::VaultRuntimeState;
    use crate::vault_io::StdVaultIo;

    fn block_on<F: std::future::Future>(f: F) -> F::Output {
        crate::test_support::block_on(f)
    }

    fn person_id_hex() -> String {
        "11".repeat(16)
    }

    // The two screens must agree, or the ceremony asks the human to compare two different
    // strings and the whole exchange is theatre. Driven through the SAME codec both sides
    // use: the mint encodes, the preview decodes, and the SAS is re-derived on the far side
    // rather than carried in the code.
    #[test]
    fn both_screens_derive_the_same_sas_from_one_code() {
        block_on(async {
            let state = VaultRuntimeState::default();
            let minted = mint_from_host(&state, &person_id_hex())
                .await
                .expect("mint");
            assert_eq!(minted.sas.len(), 9, "eight hex characters plus a dash");

            let preview = preview_from_host(&state, &minted.code)
                .await
                .expect("preview");
            assert_eq!(
                preview.sas, minted.sas,
                "the admitting screen must show the string the joining screen shows"
            );
            assert_eq!(preview.device_id_hex, minted.device_id_hex);
            assert_eq!(preview.person_id_hex, person_id_hex());
        });
    }

    // The preview is the call whose whole contract is "nothing has happened yet". Asserted on
    // the two places a premature write could land: the credential file, and the pending slot
    // on the admitting side.
    #[test]
    fn a_preview_writes_nothing() {
        block_on(async {
            let dir = crate::test_support::ScopedTempDir::new("admission-preview").expect("temp");
            let host = TestHost::new(dir.path());
            let io = StdVaultIo;
            let joining = VaultRuntimeState::default();
            let admitting = VaultRuntimeState::default();

            let minted = mint_from_host(&joining, &person_id_hex())
                .await
                .expect("mint");
            let preview = preview_from_host(&admitting, &minted.code)
                .await
                .expect("preview");
            assert_eq!(preview.sas, minted.sas);

            // No credential file exists, because nothing confirmed.
            let path = person_auth::person_auth_path(&host, &io)
                .await
                .expect("path");
            assert!(
                !path.exists(),
                "a preview must not write a person credential"
            );
            assert!(
                admitting.pending_admission().await.is_none(),
                "a preview must not leave a pending admission on the admitting side"
            );
        });
    }

    // The bind from `0735` decision 3, on the admitting side: the write is refused for any
    // SAS other than the one derived from the code in hand.
    #[test]
    fn a_confirmed_sas_that_does_not_match_is_refused_and_writes_nothing() {
        block_on(async {
            let dir = crate::test_support::ScopedTempDir::new("admission-sas").expect("temp");
            let host = TestHost::new(dir.path());
            let io = StdVaultIo;
            let joining = VaultRuntimeState::default();
            let admitting = VaultRuntimeState::default();

            let minted = mint_from_host(&joining, &person_id_hex())
                .await
                .expect("mint");
            let err = confirm_preview_from_host(&host, &io, &admitting, &minted.code, "0000-0000")
                .await
                .expect_err("a different SAS must be refused");
            assert_eq!(err, SyncDeviceError::SasMismatch);

            let path = person_auth::person_auth_path(&host, &io)
                .await
                .expect("path");
            assert!(!path.exists(), "a refused confirm must write nothing");
        });
    }

    // The same bind on the JOINING side, plus the gating the task asks for: the secret is
    // only persisted after the tap, and only for the string the human confirmed.
    #[test]
    fn the_joining_side_persists_nothing_until_its_own_tap() {
        block_on(async {
            let dir = crate::test_support::ScopedTempDir::new("admission-join").expect("temp");
            let host = TestHost::new(dir.path());
            let io = StdVaultIo;
            let state = VaultRuntimeState::default();

            let minted = mint_from_host(&state, &person_id_hex())
                .await
                .expect("mint");
            let path = person_auth::person_auth_path(&host, &io)
                .await
                .expect("path");
            assert!(
                !path.exists(),
                "minting must write nothing: the code is on screen, not on disk"
            );

            let err = confirm_minted_from_host(&host, &io, &state, "0000-0000")
                .await
                .expect_err("a different SAS must be refused");
            assert_eq!(err, SyncDeviceError::SasMismatch);
            assert!(!path.exists(), "a refused confirm must write nothing");

            // The honest confirm persists the secret, then finds the other side has not
            // tapped: no endpoint is configured in this fixture, so the login cannot run and
            // the call reports the pending state rather than a write failure.
            let approved = confirm_minted_from_host(&host, &io, &state, &minted.sas).await;
            let stored = person_auth::read_person_auth(&io, &path)
                .await
                .expect("read")
                .expect("the credential is written on the tap");
            assert_eq!(stored.device_id_hex, minted.device_id_hex);
            assert_eq!(stored.person_id_hex, person_id_hex());
            assert!(
                stored.device_secret_hex.is_some(),
                "the device's own secret is what it authenticates with"
            );
            assert!(
                stored.token_hex.is_empty(),
                "no session exists before the admitting device taps"
            );
            // The login either cannot run (no endpoint) or is refused (the other side has
            // not tapped); neither may be reported as an admission.
            assert!(
                !matches!(approved, Ok(true)),
                "the joining device must not report itself approved before the other tap"
            );
            assert!(
                state.pending_admission().await.is_none(),
                "the RAM copy is dropped once the secret is on disk"
            );
        });
    }

    // Cancel is the "nothing written, nothing delivered" arm: the pending secret is gone, so
    // a later confirm has nothing to confirm.
    #[test]
    fn a_cancel_discards_the_pending_admission() {
        block_on(async {
            let state = VaultRuntimeState::default();
            let _minted = mint_from_host(&state, &person_id_hex())
                .await
                .expect("mint");
            assert!(state.pending_admission().await.is_some());
            cancel_from_host(&state).await;
            assert!(state.pending_admission().await.is_none());
            let err = confirm_minted_from_host(
                &TestHost::new(std::env::temp_dir()),
                &StdVaultIo,
                &state,
                "0000-0000",
            )
            .await
            .expect_err("nothing to confirm");
            assert_eq!(err, SyncDeviceError::NoPendingAdmission);
        });
    }
}
