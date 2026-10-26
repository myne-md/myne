// SPDX-License-Identifier: AGPL-3.0
//! Joining an account **without the recovery phrase** (`decisions/protocol/0735`).
//!
//! Two devices, two acts, one shared code:
//!
//! 1. The JOINING device mints its own server-auth secret, a device id and (when the
//!    platform has a rung) a device key, then shows a [`DeviceAdmission`] code.
//! 2. An already-approved device of the SAME account parses that code, shows the short
//!    authentication string for a human to compare against the other screen, and on
//!    confirmation installs the credential (`POST /auth/devices/credential`, which also
//!    approves the device) and binds the new device's row in `vault.device-bindings`.
//!
//! What makes the act safe is the SAS, not the code: the code carries a
//! credential-equivalent SCRAM verifier, so whoever holds it can complete a handshake as
//! that device. The verifier is derived from the joining device's secret in ONE direction,
//! and the SAS is derived over the whole code in the other, which is what turns "I pasted
//! some text" into "the device in my hand produced this text".
//!
//! What this module deliberately does NOT do is hold a person key. A device that joined
//! this way never sees the recovery phrase, so it has no person keypair: it signs with its
//! DEVICE key (`0731` stage 1) and it cannot sign a member display name or bind another
//! device. That asymmetry is the design, and it is why the admitting side is the one that
//! writes the binding row.

use protocol::device_key::DeviceAdmission;
use zeroize::Zeroizing;

use super::devices::SyncDeviceError;
use super::person_auth::{person_auth_path, read_person_auth, write_person_auth, PersonAuth};
use super::{device_identity, devices, enroll};
use crate::vault_io::VaultIo;

/// What the joining device shows, and what it needs to remember.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AdmissionCodeView {
    /// The whole `MYNE-DEVICE-1:…` code, for the other device to paste or scan.
    pub code: String,
    /// The short string a human compares between the two screens.
    pub sas: String,
    /// This device's id, so the screen can say which device is being added.
    pub device_id_hex: String,
    /// Whether this device minted a signing key as part of the admission, i.e. whether it
    /// will author `0x03` heads afterwards. False on a platform with no storage rung, and
    /// that is a fact to state rather than an error to hide.
    pub has_device_key: bool,
}

/// Mint this device's own credential and the code that offers it to an existing device.
///
/// The secret is generated here and stored beside the device token, which is the exposure
/// class `person_auth` already carries (see the field's own note): the token authenticates
/// every request this device makes, so a credential granting the same authority adds
/// nothing the file did not already hold. It is deliberately NOT derived from the recovery
/// phrase, because the whole point is that the phrase is not on this device.
pub async fn start_admission_from_host(
    host: &dyn crate::host::HostCtx,
    io: &dyn VaultIo,
    person_id_hex: &str,
) -> Result<AdmissionCodeView, SyncDeviceError> {
    let person_id = devices::hex16(person_id_hex.trim()).ok_or(SyncDeviceError::BadRequest)?;
    let mut secret = Zeroizing::new([0u8; 32]);
    getrandom::getrandom(secret.as_mut()).map_err(|_| SyncDeviceError::Internal)?;
    let credential = enroll::mint_device_credential(secret.as_ref())?;
    let device_id = enroll::generate_device_id();
    // Mint the signing key NOW rather than at enrollment: the code is what carries the
    // public halves to the admitting device, and a row written without them is a `v1` row
    // that leaves this device unable to author a `0x03` head. A platform with no rung
    // simply has none, and the code says so by leaving the halves empty.
    let device_key = match device_identity::load_or_create() {
        Ok(key) => Some(key),
        Err(device_identity::DeviceKeyStoreError::Unsupported) => None,
        Err(err) => {
            tracing::warn!(
                stage = "device_admission",
                reason = ?err,
                "device key unavailable; joining without one, so this device will not author 0x03 heads"
            );
            None
        }
    };
    let public = device_key
        .as_ref()
        .map(protocol::device_key::DeviceKeyPair::public_half);

    let admission = DeviceAdmission {
        device_id,
        person_id_hex: protocol::hex::encode_lower(&person_id),
        public,
        salt_hex: credential.salt_hex.clone(),
        iterations: credential.iterations,
        stored_key_hex: credential.stored_key_hex.clone(),
        server_key_hex: credential.server_key_hex.clone(),
    };

    // Persist the PENDING shape before returning the code: `registered == false` with an
    // empty token is exactly what the three-state lifecycle already calls `reserved`, and
    // the device id recorded here is the one enrollment will present, so the row the
    // admitting device writes and the device that later syncs are the same device.
    let auth_path = person_auth_path(host, io)
        .await
        .map_err(|_| SyncDeviceError::Internal)?;
    let auth = PersonAuth {
        person_id_hex: protocol::hex::encode_lower(&person_id),
        device_id_hex: protocol::hex::encode_lower(&device_id),
        registered: false,
        token_hex: String::new(),
        kem_ek_hex: String::new(),
        ed_pk_hex: String::new(),
        mldsa_vk_hex: String::new(),
        device_secret_hex: Some(protocol::hex::encode_lower(secret.as_ref())),
        device_salt_hex: Some(credential.salt_hex),
        device_iterations: Some(credential.iterations),
    };
    write_person_auth(io, &auth_path, &auth)
        .await
        .map_err(|_| SyncDeviceError::Internal)?;

    Ok(AdmissionCodeView {
        code: admission.encode(),
        sas: admission.sas(),
        device_id_hex: protocol::hex::encode_lower(&device_id),
        has_device_key: public.is_some(),
    })
}

/// What the admitting device reports back to its own screen.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AdmitOutcomeView {
    pub device_id_hex: String,
    pub sas: String,
    /// Whether the binding row was written, i.e. whether this device could sign for the
    /// new one. False when this device holds no person identity (the account is
    /// registered but the identity is locked) or when the active vault is not B2B yet.
    pub bound: bool,
}

/// Admit the device a code describes: install its credential, approve it server-side, and
/// bind it in the active vault.
///
/// `confirmed_sas` is the string the USER read on the other screen and typed here. The
/// write is bound to it, so the code cannot change between "the screen showed me 1a2b-3c4d"
/// and "I pressed confirm": a substituted code produces a different SAS and is refused
/// before anything is installed.
pub async fn admit_device_from_host(
    host: &dyn crate::host::HostCtx,
    io: &dyn VaultIo,
    state: &crate::plugins::vault_unlock::state::VaultRuntimeState,
    code: &str,
    confirmed_sas: &str,
) -> Result<AdmitOutcomeView, SyncDeviceError> {
    let admission = DeviceAdmission::decode(code).map_err(|_| SyncDeviceError::BadRequest)?;
    let sas = admission.sas();
    // Case- and separator-insensitive comparison, because a human retypes this string: the
    // entropy lives in the eight hex characters, not in the dash the display adds.
    let norm = |s: &str| -> String {
        s.chars()
            .filter(|c| c.is_ascii_hexdigit())
            .map(|c| c.to_ascii_lowercase())
            .collect()
    };
    if norm(&sas) != norm(confirmed_sas) {
        return Err(SyncDeviceError::SasMismatch);
    }

    // This device may only admit a device into the account it is itself signed in to.
    // Without this check a code naming somebody else's account would be installed into
    // OURS, which would bind a stranger's device to our account rather than theirs.
    let own_person_id = state
        .clone_person_id()
        .await
        .ok_or(SyncDeviceError::NotEnrolled)?;
    if protocol::hex::encode_lower(&own_person_id) != admission.person_id_hex {
        return Err(SyncDeviceError::WrongAccount);
    }

    // The token is what authorises the install, and it is read from the stored credential
    // rather than passed in: the caller is a screen, and a screen has no business holding
    // a bearer token.
    let auth_path = person_auth_path(host, io)
        .await
        .map_err(|_| SyncDeviceError::Internal)?;
    let auth = read_person_auth(io, &auth_path)
        .await
        .map_err(|_| SyncDeviceError::Internal)?
        .ok_or(SyncDeviceError::NotEnrolled)?;
    if auth.token_hex.is_empty() {
        return Err(SyncDeviceError::NotEnrolled);
    }
    // The account plane's own transport, not a hand-rolled one: which endpoint and which
    // plane (person or vault account) is a decision `account_plane_transport_from_host`
    // already makes, and a second copy of it here is how the two would drift.
    let (plane, transport) =
        super::devices::account_plane_transport_from_host(host, io, state).await?;
    let plane_token = plane.token_hex.as_str();
    let credential = enroll::DeviceCredential {
        salt_hex: admission.salt_hex.clone(),
        iterations: admission.iterations,
        stored_key_hex: admission.stored_key_hex.clone(),
        server_key_hex: admission.server_key_hex.clone(),
    };
    enroll::install_device_credential(
        transport.as_ref(),
        plane_token,
        &admission.device_id,
        &credential,
    )?;

    // The row is written AFTER the credential: a device that can authenticate but has no
    // row is a device that syncs and cannot author a head, which is recoverable; the
    // reverse (a row for a device that cannot authenticate) is a binding nobody can use.
    let bound = bind_admitted_device(host, io, state, &admission).await?;

    Ok(AdmitOutcomeView {
        device_id_hex: protocol::hex::encode_lower(&admission.device_id),
        sas,
        bound,
    })
}

/// Sign and store the new device's binding row in the ACTIVE vault, when this device can.
///
/// Returns whether it wrote. `false` is not a failure: an owner whose identity is locked
/// can still admit the device server-side, and a vault that is not B2B yet has no binding
/// store to write into. Both cases leave the device usable and say so on the screen.
async fn bind_admitted_device(
    _host: &dyn crate::host::HostCtx,
    io: &dyn VaultIo,
    state: &crate::plugins::vault_unlock::state::VaultRuntimeState,
    admission: &DeviceAdmission,
) -> Result<bool, SyncDeviceError> {
    let Some(person) = state.clone_person_identity().await else {
        return Ok(false);
    };
    let Some(shared) = state.peek_unlocked_shared_singleton_key().await else {
        return Ok(false);
    };
    let Some(group_key) = shared.group_bytes() else {
        return Ok(false);
    };
    let base = _host
        .app_data_dir()
        .map_err(|_| SyncDeviceError::Internal)?;
    let root = crate::paths::active_vault_root_from_base(&base, state.active_vault_id().await);
    // A meta that cannot be READ is treated exactly like a meta that is not B2B yet: the
    // row is not written, and the caller is told so (`bound: false`). Propagating here was
    // wrong in a way that hides: the credential install has already succeeded by this
    // point, so an error would abort a half-finished admission and report it as a
    // transport failure, and a brand-new vault whose meta was never written would fail
    // admission outright instead of degrading.
    let Ok(bytes) = io.read(&root.join("vault.meta")).await else {
        return Ok(false);
    };
    let Ok(b2b) = protocol::parse_b2b_tail_any(&bytes) else {
        return Ok(false);
    };
    let bindings_key = crate::plugins::device_binding::bindings_key_for_group(
        &group_key,
        b2b.base.account_number_hash,
        b2b.group_key_epoch,
    );
    let mut rng = rand_core::UnwrapErr(crate::rng::OsRng);
    crate::plugins::device_binding::admit_other_in_dir(
        io,
        &root,
        &bindings_key.borrow(),
        &person,
        &admission.device_id,
        admission.public.as_ref(),
        &mut rng,
    )
    .await
    .map_err(|_| SyncDeviceError::Internal)?;
    Ok(true)
}

/// Authenticate with THIS device's own credential, once an admitting device installed it.
///
/// Returns the token and stores it, which is the moment the device stops being "reserved".
/// The `path` is `Password` on purpose and it is the honest declaration: this device did not
/// present the account's recovery credential, and it must not claim the self-approving gate.
pub async fn claim_admission_from_host(
    host: &dyn crate::host::HostCtx,
    io: &dyn VaultIo,
    state: &crate::plugins::vault_unlock::state::VaultRuntimeState,
) -> Result<bool, SyncDeviceError> {
    let auth_path = person_auth_path(host, io)
        .await
        .map_err(|_| SyncDeviceError::Internal)?;
    let auth = read_person_auth(io, &auth_path)
        .await
        .map_err(|_| SyncDeviceError::Internal)?
        .ok_or(SyncDeviceError::NotEnrolled)?;
    let secret_hex = auth
        .device_secret_hex
        .as_deref()
        .ok_or(SyncDeviceError::NotEnrolled)?;
    let secret = Zeroizing::new(
        protocol::hex::decode_lower_vec(secret_hex).ok_or(SyncDeviceError::Internal)?,
    );
    let person_id = devices::hex16(&auth.person_id_hex).ok_or(SyncDeviceError::Internal)?;
    let device_id = devices::hex16(&auth.device_id_hex).ok_or(SyncDeviceError::Internal)?;
    let (_plane, transport) =
        super::devices::account_plane_transport_from_host(host, io, state).await?;
    let username = enroll::device_credential_username(&device_id);
    let mut nonce_bytes = [0u8; 16];
    getrandom::getrandom(&mut nonce_bytes).map_err(|_| SyncDeviceError::Internal)?;
    let client_nonce = protocol::hex::encode_lower(&nonce_bytes);
    let outcome = enroll::enroll_with_username(
        transport.as_ref(),
        &person_id,
        secret.as_ref(),
        enroll::EnrollPath::Password,
        &client_nonce,
        device_id,
        Some(&username),
    )?;
    if !outcome.approved {
        // The admitting device has not installed the credential yet, so nothing is wrong:
        // this is the waiting state and the screen polls it.
        let _ = state;
        return Ok(false);
    }
    let mut next = auth;
    next.token_hex = protocol::hex::encode_lower(&outcome.token);
    next.registered = true;
    write_person_auth(io, &auth_path, &next)
        .await
        .map_err(|_| SyncDeviceError::Internal)?;
    Ok(true)
}

/// Read the pending admission this device is holding, if any, so an interrupted join can be
/// resumed rather than restarted (which would mint a second device id and leave the owner
/// approving a row nobody can use).
pub async fn pending_admission_from_host(
    host: &dyn crate::host::HostCtx,
    io: &dyn VaultIo,
) -> Result<Option<AdmissionCodeView>, SyncDeviceError> {
    let auth_path = person_auth_path(host, io)
        .await
        .map_err(|_| SyncDeviceError::Internal)?;
    let Some(auth) = read_person_auth(io, &auth_path)
        .await
        .map_err(|_| SyncDeviceError::Internal)?
    else {
        return Ok(None);
    };
    let (Some(secret_hex), Some(salt_hex), Some(iterations)) = (
        auth.device_secret_hex.as_deref(),
        auth.device_salt_hex.as_deref(),
        auth.device_iterations,
    ) else {
        return Ok(None);
    };
    let device_id = devices::hex16(&auth.device_id_hex).ok_or(SyncDeviceError::Internal)?;
    let secret = Zeroizing::new(
        protocol::hex::decode_lower_vec(secret_hex).ok_or(SyncDeviceError::Internal)?,
    );
    let credential = enroll::DeviceCredential {
        salt_hex: salt_hex.to_string(),
        iterations,
        stored_key_hex: String::new(),
        server_key_hex: String::new(),
    };
    let (stored_key_hex, server_key_hex) = credential.verifier(secret.as_ref());
    let public = device_identity::load()
        .ok()
        .flatten()
        .map(|key| key.public_half());
    let admission = DeviceAdmission {
        device_id,
        person_id_hex: auth.person_id_hex,
        public,
        salt_hex: credential.salt_hex,
        iterations,
        stored_key_hex,
        server_key_hex,
    };
    Ok(Some(AdmissionCodeView {
        code: admission.encode(),
        sas: admission.sas(),
        device_id_hex: protocol::hex::encode_lower(&device_id),
        has_device_key: public.is_some(),
    }))
}
