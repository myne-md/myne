// SPDX-License-Identifier: AGPL-3.0

//! Identity-only setup: a vault-less person identity and its server account
//! (myne-md/myne#711, decisions/protocol/0603).
//!
//! A person can create an identity (phrase + sealed keypair) and register a
//! person-level server account without ever creating a vault, so an invite can
//! be addressed to them before they own anything. The credential derives from
//! the phrase under `"myne.v0.2 argon2id-person-server-auth|"` (never leaves the
//! device); the server stores only the SCRAM verifier, keyed by
//! `person_id_hash`, on the same `/auth/*` namespace a vault account uses
//! (`server-protocol.md` §3.1a, task 7).
//!
//! The per-device person token is stored device-scoped in
//! [`super::person_auth`], not under a vault.

use zeroize::Zeroizing;

use super::devices::SyncDeviceError;
use super::enroll::{
    enroll, generate_device_id, register_verifier_with_code, EnrollError, EnrollOutcome, EnrollPath,
};
use super::person_auth::{
    person_auth_path, person_auth_path_for_read, read_person_auth, write_person_auth, PersonAuth,
};
use super::token_store::TokenStore as _;
use super::transport::{HttpMethod, SyncTransport, TransportResponse};
use crate::host::HostCtx;
// The member-vault unlock credentials are the MEMBER surface's and are gated off
// wasm32 with the functions that use this trait (myne-md/myne#911 task 13).
#[cfg(not(target_arch = "wasm32"))]
use crate::plugins::quick_unlock::provider::QuickUnlockProvider;
use crate::plugins::vault_unlock::state::VaultRuntimeState;
use crate::vault_io::VaultIo;

/// The durable record that a person identity EXISTS on this device.
///
/// A file rather than a field somewhere else, and a file the web client does not
/// hold volatile: on the browser `person-auth.json` and the sealed keypair are
/// deliberately session-only (`web/wasm/src/person_io.rs`), so after a reload
/// `person_status_from_host` answers "no state" for a device whose identity is
/// perfectly fine. That answer reaches `creation_person_from_host`, which used to
/// read it as ABSENCE and hand the user the legacy `NTV5` birth: a second
/// 24-word phrase, and a vault the identity does not open (myne-md/myne#911
/// review). The marker separates "never created here" from "not loaded this
/// session", so the second case asks for the phrase instead of minting a second
/// identity. It records a boolean and a timestamp, never a phrase, a key or a
/// person id, so it is not a secret and a copy of it opens nothing.
pub fn identity_marker_path(host: &dyn HostCtx) -> Result<std::path::PathBuf, SyncDeviceError> {
    host.app_config_dir()
        .map(|dir| dir.join("person-identity-created"))
        .map_err(|_| SyncDeviceError::Internal)
}

/// Record that an identity now exists. Best-effort by design: a failed marker
/// must not fail the identity it describes, and its absence only restores the
/// pre-marker behaviour (a device that reads as `Absent`).
pub async fn mark_identity_created(host: &dyn HostCtx, io: &dyn VaultIo) {
    let Ok(path) = identity_marker_path(host) else {
        return;
    };
    // The HOST clock, never `std::time`: this module is compiled for wasm32, where
    // the std clock compiles and then panics, and `check-core-task-seam.mjs` is
    // red on the std call (myne-md/myne#911 review). `now_unix_millis` is the seam
    // primitive for a wall clock.
    let stamp = host.now_unix_millis();
    let _ = io
        .write(
            &path,
            stamp.to_string().as_bytes(),
            crate::vault_io::WriteOpts {
                replace: true,
                ..Default::default()
            },
        )
        .await;
}

/// Whether an identity has ever been created on this device.
pub async fn identity_marker_present(host: &dyn HostCtx, io: &dyn VaultIo) -> bool {
    let Ok(path) = identity_marker_path(host) else {
        return false;
    };
    io.exists(&path).await.unwrap_or(false)
}

/// Clear the marker when the identity is forgotten, so a later device reads as a
/// genuinely fresh one.
pub async fn clear_identity_marker(host: &dyn HostCtx, io: &dyn VaultIo) {
    let Ok(path) = identity_marker_path(host) else {
        return;
    };
    let _ = io.remove_file(&path).await;
}

/// Identity-only setup result. `phrase` is `Some` ONLY when this call generated
/// one (a new identity); a recovery echoes nothing back. Deliberately NO
/// `Debug`: the type holds the one-time recovery phrase, and a derived `Debug`
/// turns one future `tracing::debug!(?view)` into a phrase disclosure.
#[derive(Clone, serde::Serialize)]
pub struct PersonSetupView {
    pub phrase: Option<String>,
    pub fingerprint_hex: String,
    pub person_id_hex: String,
    /// The out-of-band person identity code (myne-md/myne#711 task 11): the
    /// addressable person id plus the public halves an owner pastes to invite
    /// this person. Public material only; never a secret.
    pub identity_code: String,
    /// Always `false` on the two arms [`person_setup_from_host`] can take:
    /// neither the create nor the recover path registers, so neither can know
    /// whether this device is awaiting approval. Only
    /// [`person_register_from_host`] computes it. A caller that needs the real
    /// lifecycle reads `sync_person_status`'s three-state field instead.
    pub approved: bool,
}

/// Register the person's SCRAM verifier and run the first-device enrollment,
/// over any transport. Split from the host wiring so a test drives the exact
/// call order with [`super::transport::FakeTransport`].
///
/// `register_verifier` first: the verifier upload is first-write-only and
/// idempotent (a 409 is success), so it is safe to call on every setup and on
/// recovery. The device token comes from the handshake.
///
/// `path` is the approval gate this enrolment declares, and it is a parameter
/// rather than a constant for the reason [`enroll_path_for`] records: a person
/// device that has only the phrase has no other way to be admitted.
pub fn register_and_enroll_person(
    transport: &dyn SyncTransport,
    person_id: &[u8; 16],
    secret: &[u8],
    invite_code: Option<&str>,
    path: EnrollPath,
) -> Result<EnrollOutcome, EnrollError> {
    register_verifier_with_code(transport, person_id, secret, invite_code)?;
    let device_id = generate_device_id();
    let mut nonce_bytes = [0u8; 16];
    getrandom::getrandom(&mut nonce_bytes).map_err(|_| EnrollError::BadResponse)?;
    let mut client_nonce = String::with_capacity(32);
    for b in &nonce_bytes {
        client_nonce.push_str(&format!("{b:02x}"));
    }
    enroll(transport, person_id, secret, path, &client_nonce, device_id)
}

/// The approval gate a person setup must declare, from the one fact that
/// decides it: did THIS call generate the phrase?
///
/// A generated phrase is a brand-new person account, so the device is that
/// account's **first** and the gate self-approves it whatever it declares
/// (server-protocol §3.1). A supplied phrase is an existing person's device
/// arriving with the person's only credential, and this path declares
/// `recovery`, which self-approves.
///
/// **This is the SETUP path, and it is deliberately not the join path.** Adding a
/// NEW device by a scanned code goes through `person_join_device_from_host`,
/// which declares `Password` so the phrase alone cannot attach it: an existing
/// device of the account releases it (`/auth/devices/approve`), which is the one
/// place the person plane does have an approver. The distinction is a posture,
/// not an enforcement, and saying so matters: the server cannot verify the
/// declaration (a person id and a vault id are both 16 opaque bytes), so a client
/// that declares `recovery` is believed. That is why `docs/threat-model.md` §5
/// states the phrase as account takeover rather than the phrase plus a click.
///
/// The declaration adds no authority the account did not already have, and this
/// is the reason it is safe rather than the reason it is convenient: SCRAM runs
/// against a verifier derived from that same phrase, so whoever completes the
/// handshake already holds the phrase, and the phrase is full account takeover
/// on both planes (the accepted hole §3.1 records). `path` selects the gate and
/// changes no cryptographic input.
fn enroll_path_for(generated: bool) -> EnrollPath {
    if generated {
        EnrollPath::Password
    } else {
        EnrollPath::Recovery
    }
}

/// Identity setup as one call: **create** (no phrase) or **recover** (phrase),
/// locally and offline. It does NOT register.
///
/// The local half cannot fail on the network, and that is the feature
/// (myne-md/myne#911). The previous shape sealed the keypair, then demanded an
/// endpoint two lines later, and on `NotConfigured` it ERASED the seal: a device
/// with no sync server reached a phrase, never saw it, and lost the identity it
/// had just written. Now the phrase is returned on success as it always was, and
/// nothing deletes a sealed file.
///
/// Registration is the SEPARATE explicit act ([`person_register_from_host`]), and
/// it no longer happens here (myne-md/myne#911 review). It used to run whenever the
/// device already had an endpoint, which made "creating an identity transmits
/// nothing" false on the client where an endpoint always exists, and put a server
/// account behind no consent screen.
pub async fn person_setup_from_host(
    host: &dyn HostCtx,
    io: &dyn VaultIo,
    state: &VaultRuntimeState,
    phrase: Option<String>,
) -> Result<PersonSetupView, SyncDeviceError> {
    // Wrapped before it is read, as `src-tauri/AGENTS.md`'s Zeroizing pattern
    // requires and as `person_register_from_host` already does: every early return
    // past this line then drops a zeroed buffer rather than a live copy of the
    // account's only credential (myne-md/myne#911 review).
    let phrase = phrase.map(Zeroizing::new);
    // **No silent registration (myne-md/myne#911 review).** This used to
    // register the new identity whenever the device already had an endpoint, which
    // made "creating an identity transmits nothing" false on exactly the client
    // where an endpoint always exists (the browser), and put a server account
    // behind no consent screen: `useBetaTermsGate` stands in front of three other
    // doors and `SyncPanel` calls a consent screen at one door not a consent
    // screen. Registration is now the explicit act it is documented as, from the
    // identity home or Settings, and THAT door carries the gate.
    match phrase {
        None => person_create_identity_from_host(host, io, state).await,
        Some(supplied) => {
            person_recover_identity_from_host(host, io, state, (*supplied).clone()).await
        }
    }
}

/// Create a brand-new person identity, offline (myne-md/myne#911 task 4).
///
/// Derives the phrase, seals the keypair, writes the device credential with NO
/// token, and installs the session. No network: a device with no sync server
/// gets a complete identity, which is the feature.
pub async fn person_create_identity_from_host(
    host: &dyn HostCtx,
    io: &dyn VaultIo,
    state: &VaultRuntimeState,
) -> Result<PersonSetupView, SyncDeviceError> {
    let phrase: Zeroizing<String> = protocol::generate_recovery_phrase()
        .map_err(|_| SyncDeviceError::Internal)?
        .join_normalized();
    let normalized = Zeroizing::new(protocol::normalize_user_phrase(&phrase));
    let person_id = protocol::person_id_hash(&normalized);
    let generation = state.person_session_generation().await;

    let (pair, transition) =
        crate::account::person_identity::unlock_person_identity(host, io, &normalized)
            .await
            .map_err(|e| {
                use crate::account::person_identity::PersonIdentityError as E;
                match e {
                    // A CREATE that cannot open the sealed frame means this
                    // device already holds an identity it did not write. Creating
                    // over it would destroy a live identity's only copy.
                    E::CannotDecrypt => SyncDeviceError::AlreadyHeldIdentity,
                    E::BadPhrase => SyncDeviceError::BadRequest,
                    E::Io | E::Csprng => SyncDeviceError::Transport,
                }
            })?;

    let public = pair.public_half();
    let fingerprint_hex = crate::account::person_identity::hex_lower(pair.fingerprint());
    let identity_code = super::invite::encode_person_identity_code(&person_id, &public);
    let auth = PersonAuth {
        person_id_hex: crate::account::person_identity::hex_lower(&person_id),
        // No device id yet: the server issues one at enrollment, and a reserved
        // identity has never spoken to one.
        device_id_hex: String::new(),
        registered: false,
        token_hex: String::new(),
        kem_ek_hex: crate::account::person_identity::hex_lower(public.kem_ek()),
        ed_pk_hex: crate::account::person_identity::hex_lower(public.ed_pk()),
        mldsa_vk_hex: crate::account::person_identity::hex_lower(public.mldsa_vk()),
    };

    // The vault-bound carrier is a NATIVE convenience and stays off wasm32
    // (myne-md/myne#911 task 13): its purpose is to let a later vault unlock
    // install the person session WITHOUT the phrase, and the web client's decided
    // posture is the opposite: no person credential at rest, the phrase
    // re-entered on every load. It applies to an `NTV6` vault only.
    #[cfg(not(target_arch = "wasm32"))]
    super::person_vault_carrier::refresh_carrier_best_effort(host, io, state, &person_id, &pair)
        .await;
    let install = crate::plugins::vault_unlock::state::PersonSessionInstall {
        pair,
        person_id,
        profile: None,
        transition,
    };
    let installed_generation = generation.wrapping_add(1);
    if !state
        .install_person_session_if_generation(generation, install)
        .await
    {
        return Err(SyncDeviceError::Transport);
    }
    let path = match person_auth_path(host, io).await {
        Ok(path) => path,
        Err(_) => {
            let _ = state
                .clear_person_session_if_generation(installed_generation)
                .await;
            return Err(SyncDeviceError::Internal);
        }
    };
    if write_person_auth(io, &path, &auth).await.is_err() {
        let _ = state
            .clear_person_session_if_generation(installed_generation)
            .await;
        return Err(SyncDeviceError::Internal);
    }

    // The durable "an identity exists here" record, written only after the
    // credential is on disk: a marker written for an identity that failed to
    // persist would send a later session to the phrase prompt for nothing.
    mark_identity_created(host, io).await;

    Ok(PersonSetupView {
        // Shown once, for the kit. Never logged.
        phrase: Some((*phrase).clone()),
        fingerprint_hex,
        person_id_hex: crate::account::person_identity::hex_lower(&person_id),
        identity_code,
        approved: false,
    })
}

/// Recover an existing identity from its phrase, with no network access.
///
/// The sealed frame is opened under the supplied phrase, so a wrong phrase is the
/// non-distinguishing `BadRequest`. Nothing is registered: the identity comes back
/// `reserved` (or as it was), and registration is the separate explicit act.
pub async fn person_recover_identity_from_host(
    host: &dyn HostCtx,
    io: &dyn VaultIo,
    state: &VaultRuntimeState,
    phrase: String,
) -> Result<PersonSetupView, SyncDeviceError> {
    let phrase = Zeroizing::new(phrase);
    let normalized = Zeroizing::new(protocol::normalize_user_phrase(&phrase));
    let person_id = protocol::person_id_hash(&normalized);
    let generation = state.person_session_generation().await;

    let (pair, transition) =
        crate::account::person_identity::unlock_person_identity(host, io, &normalized)
            .await
            .map_err(|e| {
                use crate::account::person_identity::PersonIdentityError as E;
                match e {
                    E::BadPhrase | E::CannotDecrypt => SyncDeviceError::BadRequest,
                    E::Io | E::Csprng => SyncDeviceError::Transport,
                }
            })?;

    let public = pair.public_half();
    let fingerprint_hex = crate::account::person_identity::hex_lower(pair.fingerprint());
    let identity_code = super::invite::encode_person_identity_code(&person_id, &public);
    let person_id_hex = crate::account::person_identity::hex_lower(&person_id);

    let path = person_auth_path(host, io)
        .await
        .map_err(|_| SyncDeviceError::Internal)?;
    let existing = read_person_auth(io, &path)
        .await
        .map_err(|_| SyncDeviceError::Internal)?;
    let auth = match existing {
        Some(mut a) => {
            // The token, device id and `registered` flag are facts about THIS
            // DEVICE, not about the phrase, which is what makes carrying them over
            // correct when the phrase names the same person. It is wrong when it
            // does not: `forget_person_from_host` can leave this file behind after
            // the sealed keypair is gone, so a recovery with a DIFFERENT phrase
            // would otherwise keep account A's token under person B's id, and every
            // sync request would authenticate as A while `person_status` reported B.
            if a.person_id_hex != person_id_hex {
                a.token_hex.clear();
                a.device_id_hex.clear();
                a.registered = false;
            }
            a.person_id_hex = person_id_hex.clone();
            a.kem_ek_hex = crate::account::person_identity::hex_lower(public.kem_ek());
            a.ed_pk_hex = crate::account::person_identity::hex_lower(public.ed_pk());
            a.mldsa_vk_hex = crate::account::person_identity::hex_lower(public.mldsa_vk());
            a
        }
        None => PersonAuth {
            person_id_hex: person_id_hex.clone(),
            device_id_hex: String::new(),
            registered: false,
            token_hex: String::new(),
            kem_ek_hex: crate::account::person_identity::hex_lower(public.kem_ek()),
            ed_pk_hex: crate::account::person_identity::hex_lower(public.ed_pk()),
            mldsa_vk_hex: crate::account::person_identity::hex_lower(public.mldsa_vk()),
        },
    };

    #[cfg(not(target_arch = "wasm32"))]
    super::person_vault_carrier::refresh_carrier_best_effort(host, io, state, &person_id, &pair)
        .await;
    let install = crate::plugins::vault_unlock::state::PersonSessionInstall {
        pair,
        person_id,
        profile: None,
        transition,
    };
    let installed_generation = generation.wrapping_add(1);
    if !state
        .install_person_session_if_generation(generation, install)
        .await
    {
        return Err(SyncDeviceError::Transport);
    }
    if write_person_auth(io, &path, &auth).await.is_err() {
        let _ = state
            .clear_person_session_if_generation(installed_generation)
            .await;
        return Err(SyncDeviceError::Internal);
    }
    mark_identity_created(host, io).await;

    Ok(PersonSetupView {
        // A RECOVERY never echoes the phrase back: the user already has it, and
        // returning it would put a second live copy on the wire for no reason.
        phrase: None,
        fingerprint_hex,
        person_id_hex,
        identity_code,
        approved: false,
    })
}

/// Register an existing identity with the configured server
/// (myne-md/myne#911).
///
/// Explicit, and the phrase is the proof: this is the one act that turns a
/// `reserved` identity into `pending` or `enrolled`. It does not create
/// anything, so a wrong phrase cannot seal a new identity over the one on disk
/// (the non-distinguishing `BadRequest`, the same class a wrong offset does).
///
/// Failing here changes nothing about the identity: a device with no endpoint, a
/// down server or a refused handshake stays `reserved` and stays usable, which
/// is the property that lets registration be offered without a warning.
pub async fn person_register_from_host(
    host: &dyn HostCtx,
    io: &dyn VaultIo,
    state: &VaultRuntimeState,
    phrase: String,
) -> Result<PersonSetupView, SyncDeviceError> {
    person_register_with_path(host, io, state, phrase, enroll_path_for(false)).await
}

/// [`person_register_from_host`] with the approval gate chosen by the caller.
///
/// The gate is the server's word for "must an existing device approve this",
/// NOT the kind of credential presented: both paths prove the phrase here. The
/// first registration on a device uses the bootstrap exception (self-approve);
/// a SECOND device joining an account that already has devices must land pending,
/// because a stolen phrase alone must not silently attach a device (story 16,
/// myne-md/myne#911 task 9).
pub async fn person_register_with_path(
    host: &dyn HostCtx,
    io: &dyn VaultIo,
    state: &VaultRuntimeState,
    phrase: String,
    path: super::enroll::EnrollPath,
) -> Result<PersonSetupView, SyncDeviceError> {
    let phrase = Zeroizing::new(phrase);
    let normalized = Zeroizing::new(protocol::normalize_user_phrase(&phrase));
    let person_id = protocol::person_id_hash(&normalized);

    // Open the identity this device already holds. This both proves possession
    // locally and gives us the public halves to persist.
    let (pair, transition) =
        crate::account::person_identity::unlock_person_identity(host, io, &normalized)
            .await
            .map_err(|e| {
                use crate::account::person_identity::PersonIdentityError as E;
                match e {
                    E::BadPhrase | E::CannotDecrypt => SyncDeviceError::BadRequest,
                    E::Io | E::Csprng => SyncDeviceError::Transport,
                }
            })?;

    let secret = protocol::derive_person_server_auth_key(
        &normalized,
        &person_id,
        &protocol::DEFAULT_V0_1_KDF_PARAMS,
    )
    .map_err(|_| SyncDeviceError::Internal)?;

    let cfg_path = super::config::config_path_from_host(host, io)
        .await
        .map_err(|_| SyncDeviceError::Internal)?;
    let cfg = super::config::read_config(io, &cfg_path)
        .await
        .map_err(|_| SyncDeviceError::NotConfigured)?;
    let invite_code = cfg.invite_code.clone();
    let url = cfg.endpoint_url.ok_or(SyncDeviceError::NotConfigured)?;

    let outcome: EnrollOutcome =
        crate::task::run_blocking(move || -> Result<EnrollOutcome, SyncDeviceError> {
            let transport = super::http_transport::build_transport(&url)
                .map_err(|_| SyncDeviceError::Transport)?;
            register_and_enroll_person(
                transport.as_ref(),
                &person_id,
                secret.as_slice(),
                invite_code.as_deref(),
                // The gate the CALLER chose, not one re-derived here:
                // `enroll_path_for(true)` for a generated phrase (a new account's
                // first device), the join path's explicit `Password` when a NEW
                // device is being added to an existing account.
                path,
            )
            .map_err(SyncDeviceError::from)
        })
        .await
        .map_err(|_| SyncDeviceError::Internal)??;

    let public = pair.public_half();
    let fingerprint_hex = crate::account::person_identity::hex_lower(pair.fingerprint());
    let identity_code = super::invite::encode_person_identity_code(&person_id, &public);
    let generation = state.person_session_generation().await;
    // The installation refreshes the public halves and any migrated transition,
    // so a register call made with the identity locked leaves it unlocked.
    let install = crate::plugins::vault_unlock::state::PersonSessionInstall {
        pair,
        person_id,
        profile: None,
        transition,
    };
    let installed_generation = generation.wrapping_add(1);
    if !state
        .install_person_session_if_generation(generation, install)
        .await
    {
        return Err(SyncDeviceError::Transport);
    }

    let auth = PersonAuth {
        person_id_hex: crate::account::person_identity::hex_lower(&person_id),
        device_id_hex: crate::account::person_identity::hex_lower(&outcome.device_id),
        registered: true,
        token_hex: if outcome.approved && !outcome.token.is_empty() {
            crate::account::person_identity::hex_lower(&outcome.token)
        } else {
            String::new()
        },
        kem_ek_hex: crate::account::person_identity::hex_lower(public.kem_ek()),
        ed_pk_hex: crate::account::person_identity::hex_lower(public.ed_pk()),
        mldsa_vk_hex: crate::account::person_identity::hex_lower(public.mldsa_vk()),
    };
    let path = person_auth_path(host, io).await.map_err(|_| {
        // The credential write is the only act that could leave the device
        // claiming a registration it did not record; drop the session rather
        // than leave a live identity whose state disagrees with disk.
        SyncDeviceError::Internal
    })?;
    if write_person_auth(io, &path, &auth).await.is_err() {
        let _ = state
            .clear_person_session_if_generation(installed_generation)
            .await;
        return Err(SyncDeviceError::Internal);
    }

    // The durable "an identity exists here" record, written only after the
    // credential is on disk: a marker written for an identity that failed to
    // persist would send a later session to the phrase prompt for nothing.
    mark_identity_created(host, io).await;

    Ok(PersonSetupView {
        phrase: None,
        fingerprint_hex,
        person_id_hex: crate::account::person_identity::hex_lower(&person_id),
        identity_code,
        approved: outcome.approved,
    })
}

/// What a scanned person QR plus a phrase produced (myne-md/myne#911 task 9).
#[derive(Debug, Clone, serde::Serialize)]
pub struct PersonJoinView {
    /// The person this device now belongs to, 32 lowercase hex. It must equal the
    /// id the QR carried; a phrase for anyone else is refused.
    pub person_id_hex: String,
    /// False when the device is registered and awaiting approval, which is the
    /// ordinary answer: one QR and one phrase admit the device only after an
    /// existing device approves it.
    pub approved: bool,
}

/// Admit THIS device to a person's account from a scanned QR and the 24 words.
///
/// The two halves it composes already existed: `person_recover_identity_from_host`
/// seals the identity from the phrase with no network, and
/// `person_register_from_host` registers the SCRAM verifier and enrols this
/// device on the person account. What is new is the CHECK between them (the
/// scanned person id is what this device was told to join, so a phrase for
/// somebody else is refused before anything is written) and the cached claim
/// secret, which is what lets the device finish on its own once approved
/// (decision: cache the derived secret, never the phrase).
pub async fn person_join_device_from_host(
    host: &dyn HostCtx,
    io: &dyn VaultIo,
    state: &crate::plugins::vault_unlock::state::VaultRuntimeState,
    scanned_person_id_hex: String,
    endpoint_url: String,
    phrase: String,
) -> Result<PersonJoinView, SyncDeviceError> {
    // Same wrap, same reason: this is one of the four entry points that take the
    // identity phrase, and the other three now wrap it first.
    let phrase = Zeroizing::new(phrase);
    let expected =
        super::devices::hex16(scanned_person_id_hex.trim()).ok_or(SyncDeviceError::BadRequest)?;

    // The id check runs FIRST and on the normalized phrase alone, before the
    // endpoint is written and before an identity is sealed. Doing it after would
    // mean rolling a sealed frame back on every mismatch, and a rollback that
    // fails leaves the device claiming an identity nobody meant to add.
    let normalized = Zeroizing::new(protocol::normalize_user_phrase(&phrase));
    let person_id = protocol::person_id_hash(&normalized);
    if person_id != expected {
        return Err(SyncDeviceError::PersonMismatch);
    }
    // Derived once, here, for the pending claim. The register call below derives
    // it again for its own handshake; a join is a one-time ceremony and two
    // Argon2id runs cost a second, which is the wrong place to trade correctness
    // for latency.
    let claim_secret = protocol::derive_person_server_auth_key(
        &normalized,
        &person_id,
        &protocol::DEFAULT_V0_1_KDF_PARAMS,
    )
    .map_err(|_| SyncDeviceError::Internal)?;
    drop(normalized);

    // The endpoint first, verified exactly as every later sync request will be.
    super::enroll::verify_join_tls(&endpoint_url)
        .await
        .map_err(|e| match e {
            super::transport::TransportError::Tls => SyncDeviceError::TlsFailure,
            _ => SyncDeviceError::Transport,
        })?;
    super::config::set_endpoint(host, io, Some(endpoint_url), None, None)
        .await
        .map_err(|_| SyncDeviceError::NotConfigured)?;

    // Seal the identity locally (no network), then register and enrol. A wrong
    // phrase now fails at the id check above with the same non-distinguishing
    // refusal the sealed-frame open would have produced.
    let recovered = person_recover_identity_from_host(host, io, state, (*phrase).clone()).await?;

    // A device that already registered and is STILL PENDING (the app was closed
    // between the phrase and the approval, and the user came back to the code
    // step) does not register again: a second registration mints a second device
    // id, so the owner would be looking at two pending rows for one phone and
    // would have to delete one. Re-entering the phrase only re-derives the claim
    // secret.
    let auth_path = person_auth_path(host, io)
        .await
        .map_err(|_| SyncDeviceError::Internal)?;
    let existing = read_person_auth(io, &auth_path)
        .await
        .map_err(|_| SyncDeviceError::Internal)?;
    let already_pending = existing
        .filter(|a| a.registered && a.token_hex.is_empty())
        .is_some_and(|a| a.person_id_hex == recovered.person_id_hex);
    if already_pending {
        state.set_pending_claim_secret(claim_secret).await;
        return Ok(PersonJoinView {
            person_id_hex: recovered.person_id_hex,
            approved: false,
        });
    }

    // The PENDING gate, deliberately: this device is joining an account that
    // already has devices, and the whole point of the approval step is that a
    // phrase alone cannot attach one silently. The bootstrap exception stays
    // where it belongs, on the device that registers the account.
    let registered = person_register_with_path(
        host,
        io,
        state,
        (*phrase).clone(),
        super::enroll::EnrollPath::Password,
    )
    .await?;

    // Cached AFTER a successful register: a failure between the two leaves no
    // secret behind for a device that never enrolled.
    state.set_pending_claim_secret(claim_secret).await;

    Ok(PersonJoinView {
        person_id_hex: recovered.person_id_hex,
        approved: registered.approved,
    })
}

/// Finish a pending device's enrolment once an existing device approved it
/// (myne-md/myne#911 task 9).
///
/// Re-runs the SCRAM handshake with the SAME device id the enrolment persisted,
/// using the cached secret. Returns `approved: false` while the approval has not
/// landed, so a pending screen can poll this. With no cached secret (a restart, a
/// lock, or a device that only ever ran `sync_person_register`) the caller is told
/// to ask for the phrase again rather than silently doing nothing.
pub async fn person_claim_device_from_host(
    host: &dyn HostCtx,
    io: &dyn VaultIo,
    state: &crate::plugins::vault_unlock::state::VaultRuntimeState,
) -> Result<PersonJoinView, SyncDeviceError> {
    let path = person_auth_path_for_read(host).map_err(|_| SyncDeviceError::Internal)?;
    let auth = read_person_auth(io, &path)
        .await
        .map_err(|_| SyncDeviceError::Internal)?
        .ok_or(SyncDeviceError::PersonSessionRequired)?;
    if !auth.token_hex.is_empty() {
        // Already claimed: idempotent, and the pending screen that polls this
        // must not be told to enter the phrase again.
        state.clear_pending_claim_secret().await;
        return Ok(PersonJoinView {
            person_id_hex: auth.person_id_hex,
            approved: true,
        });
    }
    let person_id = super::devices::hex16(&auth.person_id_hex).ok_or(SyncDeviceError::Internal)?;
    let device_id = super::devices::hex16(&auth.device_id_hex).ok_or(SyncDeviceError::Internal)?;
    let secret = state
        .pending_claim_secret()
        .await
        .ok_or(SyncDeviceError::PersonSessionRequired)?;

    let cfg_path = super::config::config_path_from_host(host, io)
        .await
        .map_err(|_| SyncDeviceError::Internal)?;
    let cfg = super::config::read_config(io, &cfg_path)
        .await
        .map_err(|_| SyncDeviceError::NotConfigured)?;
    let url = cfg.endpoint_url.ok_or(SyncDeviceError::NotConfigured)?;
    let invite_code = cfg.invite_code.clone();

    let outcome: super::enroll::EnrollOutcome = crate::task::run_blocking(
        move || -> Result<super::enroll::EnrollOutcome, SyncDeviceError> {
            let transport = super::http_transport::build_transport(&url)
                .map_err(|_| SyncDeviceError::Transport)?;
            let mut nonce_bytes = [0u8; 16];
            getrandom::getrandom(&mut nonce_bytes).map_err(|_| SyncDeviceError::Internal)?;
            let mut client_nonce = String::with_capacity(32);
            for b in &nonce_bytes {
                client_nonce.push_str(&format!("{b:02x}"));
            }
            let _ = invite_code;
            super::enroll::enroll(
                transport.as_ref(),
                &person_id,
                secret.as_slice(),
                // The same pending gate the join declared. Claiming must not
                // upgrade a pending device to self-approved: the approval is
                // what the claim is waiting FOR.
                super::enroll::EnrollPath::Password,
                &client_nonce,
                device_id,
            )
            .map_err(SyncDeviceError::from)
        },
    )
    .await
    .map_err(|_| SyncDeviceError::Internal)??;

    if !outcome.approved || outcome.token.is_empty() {
        // Still pending: keep the secret for the next poll and say so.
        return Ok(PersonJoinView {
            person_id_hex: auth.person_id_hex,
            approved: false,
        });
    }

    let mut next = auth;
    next.token_hex = crate::account::person_identity::hex_lower(&outcome.token);
    next.device_id_hex = crate::account::person_identity::hex_lower(&outcome.device_id);
    next.registered = true;
    write_person_auth(io, &path, &next)
        .await
        .map_err(|_| SyncDeviceError::Internal)?;
    state.clear_pending_claim_secret().await;
    Ok(PersonJoinView {
        person_id_hex: next.person_id_hex,
        approved: true,
    })
}

/// IPC wrapper. The phrase crosses IPC once, exactly as the identity-unlock path
/// does; no private seed ever crosses again.
#[cfg(all(feature = "tauri-ipc", not(target_arch = "wasm32")))]
#[tauri::command]
pub async fn sync_person_join_device<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    state: tauri::State<'_, VaultRuntimeState>,
    person_id_hex: String,
    endpoint_url: String,
    phrase: String,
) -> Result<PersonJoinView, SyncDeviceError> {
    person_join_device_from_host(
        &crate::host::tauri_host::TauriHost::new(app.clone()),
        &crate::vault_io::StdVaultIo,
        state.inner(),
        person_id_hex,
        endpoint_url,
        phrase,
    )
    .await
}

/// IPC wrapper: finish a pending enrolment after approval.
#[cfg(all(feature = "tauri-ipc", not(target_arch = "wasm32")))]
#[tauri::command]
pub async fn sync_person_claim_device<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    state: tauri::State<'_, VaultRuntimeState>,
) -> Result<PersonJoinView, SyncDeviceError> {
    person_claim_device_from_host(
        &crate::host::tauri_host::TauriHost::new(app.clone()),
        &crate::vault_io::StdVaultIo,
        state.inner(),
    )
    .await
}

/// IPC wrapper (desktop + mobile). `phrase: None` = create a new identity.
#[cfg(all(feature = "tauri-ipc", not(target_arch = "wasm32")))]
#[tauri::command]
pub async fn sync_person_setup<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    state: tauri::State<'_, VaultRuntimeState>,
    phrase: Option<String>,
) -> Result<PersonSetupView, SyncDeviceError> {
    person_setup_from_host(
        &crate::host::tauri_host::TauriHost::new(app.clone()),
        &crate::vault_io::StdVaultIo,
        state.inner(),
        phrase,
    )
    .await
}

/// The person's account number, canonical form, for the surface that names the
/// identity (myne-md/myne#911 review).
///
/// It is DERIVED, so the only thing this needs is the person id the credential
/// already carries: no phrase, no network, no key material. The display form is
/// the caller's job (`@myne/client-core`'s `formatPersonAccountNumber`), so the
/// grouping lives in one place across the three clients while the Crockford
/// encoding and its frozen check character stay in the protocol crate.
///
/// `None` when this device holds no identity. An absent number is the honest
/// answer there, not an error: the surface simply has nothing to show.
pub async fn person_account_number_from_host(
    host: &dyn HostCtx,
    io: &dyn VaultIo,
    state: &VaultRuntimeState,
) -> Option<String> {
    let status = person_status_from_host(host, io, state).await.ok()?;
    let person_id = super::devices::hex16(status.person_id_hex.as_deref()?)?;
    // The CANONICAL body, not the display form: grouping is presentation and
    // lives in `@myne/client-core` so all three clients group it identically.
    Some(
        String::from_utf8_lossy(&protocol::account_number_from_person_id(&person_id).canonical)
            .into_owned(),
    )
}

/// IPC wrapper (desktop + mobile). The account number the identity home shows.
#[cfg(all(feature = "tauri-ipc", not(target_arch = "wasm32")))]
#[tauri::command]
pub async fn sync_person_account_number<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    state: tauri::State<'_, VaultRuntimeState>,
) -> Result<Option<String>, SyncDeviceError> {
    Ok(person_account_number_from_host(
        &crate::host::tauri_host::TauriHost::new(app),
        &crate::vault_io::StdVaultIo,
        state.inner(),
    )
    .await)
}

/// IPC wrapper (desktop + mobile). The explicit registration act: the phrase is
/// the proof, and this is what turns a `reserved` identity into `pending` or
/// `enrolled`.
#[cfg(all(feature = "tauri-ipc", not(target_arch = "wasm32")))]
#[tauri::command]
pub async fn sync_person_register<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    state: tauri::State<'_, VaultRuntimeState>,
    phrase: String,
) -> Result<PersonSetupView, SyncDeviceError> {
    person_register_from_host(
        &crate::host::tauri_host::TauriHost::new(app.clone()),
        &crate::vault_io::StdVaultIo,
        state.inner(),
        phrase,
    )
    .await
}

/// Whether this device holds a person account, and whose it is. The identity
/// home is shown when an identity exists at all, which since myne-md/myne#911
/// means any of the three states below rather than only `enrolled`.
#[derive(Debug, Clone, serde::Serialize)]
pub struct PersonStatusView {
    pub enrolled: bool,
    /// The three-state account lifecycle (myne-md/myne#911). `None` means this
    /// device holds no identity at all, which is the only case the first-run
    /// Welcome screen is for.
    ///
    /// - `reserved`: a sealed identity exists and has never been registered
    ///   with a server. The phrase is the account; nothing has been sent, and
    ///   nothing needs to be for the app to be complete.
    /// - `pending`: registered, and this device has no token yet because it is
    ///   awaiting approval.
    /// - `enrolled`: registered and holding a device token.
    pub state: Option<PersonAccountState>,
    pub identity_unlocked: bool,
    pub person_id_hex: Option<String>,
    /// The out-of-band person identity code. A locked device may still expose
    /// the public code from its device-local credential; private operations
    /// require the runtime identity separately.
    pub identity_code: Option<String>,
    /// Whether this device holds a **recoverable sealed person keypair**, even
    /// when no token was ever issued (myne-md/myne#780). Distinct from
    /// `enrolled`, which is only true once a token exists: a device can hold a
    /// live sealed identity with no token, and in that state "Create an
    /// identity" cannot open the sealed frame it did not write. The first-run
    /// UI reads this to steer the user to Recover or an explicit forget rather
    /// than offering a Create that is guaranteed to fail.
    pub sealed_keypair_present: bool,
}

/// The account lifecycle a device is in (myne-md/myne#911).
///
/// Three states rather than the two booleans the surface used to carry, because
/// "has a token" cannot distinguish *never registered* from *registered and
/// awaiting approval*, and those two need opposite copy: one offers an action,
/// the other explains a wait.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "lowercase")]
pub enum PersonAccountState {
    Reserved,
    Pending,
    Enrolled,
}

/// Read the device-local person credential and runtime identity readiness.
pub async fn person_status_from_host(
    host: &dyn HostCtx,
    io: &dyn VaultIo,
    state: &VaultRuntimeState,
) -> Result<PersonStatusView, SyncDeviceError> {
    let path = person_auth_path_for_read(host).map_err(|_| SyncDeviceError::Internal)?;
    let auth = read_person_auth(io, &path)
        .await
        .map_err(|_| SyncDeviceError::Internal)?;
    let runtime = state.person_identity_status().await;
    let enrolled = matches!(auth, Some(ref a) if !a.token_hex.is_empty());
    let auth_person_id = auth
        .as_ref()
        .and_then(|a| super::devices::hex16(&a.person_id_hex));
    let disk_identity_code = auth.as_ref().and_then(identity_code_from_auth);
    let runtime_matches_auth = runtime.as_ref().map_or(auth.is_none(), |snapshot| {
        auth_person_id == Some(snapshot.person_id)
    });
    let identity_unlocked = runtime.is_some() && runtime_matches_auth;
    let runtime_identity_code = runtime
        .as_ref()
        .filter(|_| runtime_matches_auth)
        .map(|snapshot| {
            super::invite::encode_person_identity_code(&snapshot.person_id, &snapshot.public)
        });
    let identity_code = runtime_identity_code.or(disk_identity_code);
    let sealed_keypair_present =
        crate::account::person_identity::sealed_keypair_present(host, io).await;
    // The lifecycle is derived from two facts and never from a stored state
    // string, so it cannot disagree with what is actually on disk.
    //
    // `enrolled` is decided by the TOKEN alone, not by the `registered` flag, so
    // a credential file written before the flag existed (serde defaults it to
    // false) still reads as enrolled. The flag only separates the two token-less
    // states, where it is the one thing on disk that remembers "we did send
    // this".
    let state = if enrolled {
        Some(PersonAccountState::Enrolled)
    } else if auth.is_some() && auth.as_ref().is_some_and(|a| a.registered) {
        Some(PersonAccountState::Pending)
    } else if sealed_keypair_present || auth.is_some() {
        Some(PersonAccountState::Reserved)
    } else {
        None
    };
    let person_id_hex = runtime
        .as_ref()
        .filter(|_| identity_unlocked)
        .map(|snapshot| crate::account::person_identity::hex_lower(&snapshot.person_id))
        .or_else(|| {
            auth_person_id.map(|person_id| crate::account::person_identity::hex_lower(&person_id))
        });
    Ok(PersonStatusView {
        enrolled,
        state,
        identity_unlocked,
        person_id_hex,
        identity_code,
        sealed_keypair_present,
    })
}

/// Erase every device-local trace of the person identity: the sealed keypair
/// and the device-scoped token (`person-auth.json`). The off-boarding path and
/// the "forget the held identity" recovery in the first-run dialog
/// (myne-md/myne#780). An absent token is the ordinary case, not a failure: an
/// identity that never completed enrollment has none.
///
/// No server call and no vault access: this forgets the identity ON THIS DEVICE.
pub async fn forget_person_from_host(
    host: &dyn HostCtx,
    io: &dyn VaultIo,
) -> Result<(), SyncDeviceError> {
    crate::account::person_identity::delete_sealed_file(host, io)
        .await
        .map_err(|_| SyncDeviceError::BadRequest)?;
    if let Ok(path) = person_auth_path_for_read(host) {
        match io.remove_file(&path).await {
            Ok(()) | Err(crate::io_failure_kind::IoFailureKind::NotFound) => {}
            Err(_) => return Err(SyncDeviceError::BadRequest),
        }
    }
    // Last, and only once the credential is gone: the marker exists to tell a
    // later session that an identity is present but not loaded, so clearing it
    // before the credential would turn a half-forgotten device into one that
    // mints a second identity over a sealed frame.
    clear_identity_marker(host, io).await;
    Ok(())
}

fn identity_code_from_auth(a: &PersonAuth) -> Option<String> {
    let public = protocol::person_key::PersonPublicHalf::from_parts_hex(
        &a.kem_ek_hex,
        &a.ed_pk_hex,
        &a.mldsa_vk_hex,
    )
    .ok()?;
    let person_id = super::devices::hex16(&a.person_id_hex)?;
    Some(super::invite::encode_person_identity_code(
        &person_id, &public,
    ))
}

pub(crate) async fn refresh_person_auth_public_material(
    host: &dyn HostCtx,
    io: &dyn VaultIo,
    person_id: [u8; 16],
    public: &protocol::person_key::PersonPublicHalf,
) -> Result<(), SyncDeviceError> {
    let path = person_auth_path(host, io)
        .await
        .map_err(|_| SyncDeviceError::Internal)?;
    let Some(mut auth) = read_person_auth(io, &path)
        .await
        .map_err(|_| SyncDeviceError::Internal)?
    else {
        return Ok(());
    };
    auth.person_id_hex = crate::account::person_identity::hex_lower(&person_id);
    auth.kem_ek_hex = crate::account::person_identity::hex_lower(public.kem_ek());
    auth.ed_pk_hex = crate::account::person_identity::hex_lower(public.ed_pk());
    auth.mldsa_vk_hex = crate::account::person_identity::hex_lower(public.mldsa_vk());
    write_person_auth(io, &path, &auth)
        .await
        .map_err(|_| SyncDeviceError::Internal)
}

/// One invite addressed to this person, as the home lists it. The payload is
/// NOT here: only a claim releases it (`server-protocol.md` §3.1a).
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct InviteSummary {
    pub invite_id_hex: String,
    pub vault_account_hash_hex: String,
    pub claimed: bool,
}
#[derive(serde::Deserialize)]
struct InvitesResp {
    #[serde(default)]
    invites: Vec<InviteSummary>,
}

/// List the invites addressed to this person account (`GET /b2b/invites`, task
/// 8's relay). Reads the device-scoped token + endpoint; nothing else.
pub async fn person_list_invites_from_host(
    host: &dyn HostCtx,
    io: &dyn VaultIo,
) -> Result<Vec<InviteSummary>, SyncDeviceError> {
    let auth_path = person_auth_path_for_read(host).map_err(|_| SyncDeviceError::Internal)?;
    // A credential file with no token is `NotEnrolled`, not `NotConfigured`
    // (2026-10-23). The two name different remedies and the caller renders both:
    // `NotConfigured` means "no sync endpoint is set", which belongs to the
    // config read below, while a person without a device token has sent nothing
    // and needs to REGISTER. Collapsing them told an unregistered identity that
    // its connection or server was broken, which is the one reading that sends a
    // user looking in the wrong place. `usePendingInvites` already documents the
    // `NotEnrolled` answer this now actually produces.
    let auth = read_person_auth(io, &auth_path)
        .await
        .map_err(|_| SyncDeviceError::Internal)?
        .filter(|a| !a.token_hex.is_empty())
        .ok_or(SyncDeviceError::NotEnrolled)?;

    let cfg_path = super::config::config_path_from_host(host, io)
        .await
        .map_err(|_| SyncDeviceError::Internal)?;
    let cfg = super::config::read_config(io, &cfg_path)
        .await
        .map_err(|_| SyncDeviceError::NotConfigured)?;
    let url = cfg.endpoint_url.ok_or(SyncDeviceError::NotConfigured)?;

    crate::task::run_blocking(move || -> Result<Vec<InviteSummary>, SyncDeviceError> {
        let transport =
            super::http_transport::build_transport(&url).map_err(|_| SyncDeviceError::Transport)?;
        let resp = transport
            .request(HttpMethod::Get, "/b2b/invites", &[], Some(&auth.token_hex))
            .map_err(|_| SyncDeviceError::Transport)?;
        if resp.status == 401 {
            return Err(SyncDeviceError::Unauthenticated);
        }
        if resp.status != 200 {
            return Err(SyncDeviceError::Transport);
        }
        let parsed: InvitesResp =
            serde_json::from_slice(&resp.body).map_err(|_| SyncDeviceError::Transport)?;
        Ok(parsed.invites)
    })
    .await
    .map_err(|_| SyncDeviceError::Internal)?
}

#[cfg(all(feature = "tauri-ipc", not(target_arch = "wasm32")))]
#[tauri::command]
pub async fn sync_person_status<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    state: tauri::State<'_, VaultRuntimeState>,
) -> Result<PersonStatusView, SyncDeviceError> {
    person_status_from_host(
        &crate::host::tauri_host::TauriHost::new(app.clone()),
        &crate::vault_io::StdVaultIo,
        state.inner(),
    )
    .await
}

#[cfg(all(feature = "tauri-ipc", not(target_arch = "wasm32")))]
#[tauri::command]
pub async fn sync_person_list_invites<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
) -> Result<Vec<InviteSummary>, SyncDeviceError> {
    person_list_invites_from_host(
        &crate::host::tauri_host::TauriHost::new(app.clone()),
        &crate::vault_io::StdVaultIo,
    )
    .await
}

/// The endpoint URL, the precondition every relay call needs.
pub(crate) async fn endpoint_from_host(
    host: &dyn HostCtx,
    io: &dyn VaultIo,
) -> Result<String, SyncDeviceError> {
    let cfg_path = super::config::config_path_from_host(host, io)
        .await
        .map_err(|_| SyncDeviceError::Internal)?;
    let cfg = super::config::read_config(io, &cfg_path)
        .await
        .map_err(|_| SyncDeviceError::NotConfigured)?;
    let url = cfg.endpoint_url.ok_or(SyncDeviceError::NotConfigured)?;
    Ok(url)
}

/// Decode an even-length hex string. `None` on odd length or a non-hex byte.
pub fn hex_to_bytes(s: &str) -> Option<Vec<u8>> {
    if !s.len().is_multiple_of(2) || !s.bytes().all(|b| b.is_ascii_hexdigit()) {
        return None;
    }
    (0..s.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&s[i..i + 2], 16).ok())
        .collect()
}

#[derive(serde::Deserialize)]
struct BindMemberResp {
    #[serde(default)]
    token_hex: String,
}

/// The vault's 16-byte selector on the wire: the field at offset 6 of `vault.meta`.
///
/// One value with two provenances, and the server cannot tell them apart because it
/// is the same bytes in the same slot (`protocol.md` §9.3):
///
/// - a vault enrolled under an account carries its `account_number_hash`, which is
///   what `sync-state.json` records as `account_hash_hex`;
/// - a vault born under a person identity carries a random NAMESPACE, recorded as
///   `namespace_hex` at publish time. Such a vault never enrols under an account, so
///   `account_hash_hex` stays empty forever and every route that needs a selector has
///   to read this instead.
///
/// `None` means "this device cannot address the vault on the wire yet" (nothing
/// published, nothing enrolled), which every caller already has a typed refusal for.
pub fn vault_selector_hex(sync_state: &super::state::SyncState) -> Option<String> {
    sync_state
        .account_hash_hex
        .clone()
        .filter(|s| !s.is_empty())
        .or_else(|| sync_state.namespace_hex.clone().filter(|s| !s.is_empty()))
}

/// The person session's device token, as the lowercase hex an HTTP `Bearer` header
/// takes. `None` when this device holds no person account, or holds one that never
/// registered (an empty token).
///
/// Read per call rather than cached: re-registration and a person-key rotation both
/// rotate it, and a cached copy would outlive the credential it names. Same reason
/// `cycle::person_token_bytes` reads it per cycle.
///
/// **An IO failure is `Err`, not `None`.** The caller turns "no credential" into
/// `NotEnrolled`, which is an honest answer for a device that holds no person
/// account and a lie for a filesystem that failed to produce one. On a born vault
/// this token is the ONLY credential that can bind the owner, so collapsing the two
/// would report a transient read error as "you have no identity" on the one path
/// where the user cannot tell the difference.
async fn person_device_token_hex(
    host: &dyn HostCtx,
    io: &dyn VaultIo,
) -> Result<Option<String>, SyncDeviceError> {
    let path = super::person_auth::person_auth_path_for_read(host)
        .map_err(|_| SyncDeviceError::Internal)?;
    let auth = super::person_auth::read_person_auth(io, &path)
        .await
        .map_err(|_| SyncDeviceError::Internal)?;
    Ok(auth.and_then(|a| (!a.token_hex.is_empty()).then_some(a.token_hex)))
}

/// Bind the owner person to the active vault once and return the **per-vault
/// owner membership token** (myne-md/myne#711 task 11).
///
/// The first B2B admin call needs the owner bound. Two credentials can do it, and
/// which one applies is decided by the vault's generation rather than by a setting:
///
/// - **An account-enrolled vault** (`NTV5`/`NTV6`): `POST /b2b/vaults/{hash}/members`
///   with `role: "owner"`, authorized by the vault's OWN device session ("owner at
///   registration", `server-protocol.md` §3.1a).
/// - **A person-born vault** (`NTV7`): the same route and body, authorized by the
///   person's own device session instead, because that vault has no vault account to
///   enrol. Without this arm nothing could bind an owner on the birth format that
///   `decisions/storage/0723` makes the only one, so the invite, the roster and the
///   removal would all stay unreachable on every new vault.
///
/// The token is stored in the vault-scoped device-local [`super::state::SyncState`],
/// so a second invite skips the round-trip. A stored token for a DIFFERENT person id
/// (a re-bound owner after a migration) is re-bound rather than reused.
pub async fn ensure_owner_member_token(
    host: &dyn HostCtx,
    io: &dyn VaultIo,
    state: &VaultRuntimeState,
    owner_person_id_hex: &str,
) -> Result<String, SyncDeviceError> {
    let root = crate::paths::active_vault_root_from_base(
        &host.app_data_dir().map_err(|_| SyncDeviceError::Internal)?,
        state.active_vault_id().await,
    );
    let mut sync_state = super::state::read_sync_state(io, &root)
        .await
        .map_err(|_| SyncDeviceError::Internal)?;
    if let (Some(tok), Some(pid)) = (
        sync_state.owner_member_token_hex.as_deref(),
        sync_state.owner_member_person_id_hex.as_deref(),
    ) {
        if pid == owner_person_id_hex && !tok.is_empty() {
            return Ok(tok.to_string());
        }
    }

    let selector_hex = vault_selector_hex(&sync_state).ok_or(SyncDeviceError::NotEnrolled)?;
    // Which credential may bind the owner is the vault's generation, read off the
    // one durable fact that distinguishes them: an account-enrolled vault writes
    // `account_hash_hex`, a person-born one writes only its namespace. Both arms end
    // at the same route with the same body, so the server's answer (the per-vault
    // token) is the same shape either way and nothing downstream branches.
    let person_born = sync_state
        .account_hash_hex
        .as_deref()
        .is_none_or(str::is_empty);
    let owner_hex = owner_person_id_hex.to_string();
    let (credential, url) = if person_born {
        let token = person_device_token_hex(host, io)
            .await?
            .ok_or(SyncDeviceError::NotEnrolled)?;
        (token, endpoint_from_host(host, io).await?)
    } else {
        // The vault's own device session authorizes the owner registration. Its
        // transport is discarded; the relay token below is the owner's, not the
        // device's.
        let (device_token, _device_transport) =
            super::devices::authed_transport_from_host(host, io, state).await?;
        (device_token, endpoint_from_host(host, io).await?)
    };

    let selector_for_req = selector_hex;
    let issued = crate::task::run_blocking(move || {
        let transport =
            super::http_transport::build_transport(&url).map_err(|_| SyncDeviceError::Transport)?;
        bind_owner_request(
            transport.as_ref(),
            &credential,
            &selector_for_req,
            &owner_hex,
        )
    })
    .await
    .map_err(|_| SyncDeviceError::Internal)??;
    sync_state.owner_member_token_hex = Some(issued.clone());
    sync_state.owner_member_person_id_hex = Some(owner_person_id_hex.to_string());
    super::state::write_sync_state(io, &root, &sync_state)
        .await
        .map_err(|_| SyncDeviceError::Internal)?;
    Ok(issued)
}

/// Parse a `POST /b2b/vaults/{hash}/members` response into the issued per-vault
/// token. Split from the transport call so a [`super::transport::FakeTransport`]
/// can drive it directly.
fn parse_issued_token(resp: &TransportResponse) -> Result<String, SyncDeviceError> {
    match resp.status {
        200 => {}
        401 | 403 => return Err(SyncDeviceError::Unauthenticated),
        _ => return Err(SyncDeviceError::Transport),
    }
    let parsed: BindMemberResp =
        serde_json::from_slice(&resp.body).map_err(|_| SyncDeviceError::Transport)?;
    if parsed.token_hex.is_empty() {
        return Err(SyncDeviceError::Transport);
    }
    Ok(parsed.token_hex)
}

/// Bind the owner person via an explicit transport, the shape a unit test
/// drives. Production resolves the transport in [`ensure_owner_member_token`].
pub fn bind_owner_request(
    transport: &dyn SyncTransport,
    device_token: &str,
    account_hash_hex: &str,
    owner_person_id_hex: &str,
) -> Result<String, SyncDeviceError> {
    let body = serde_json::json!({ "person_id_hex": owner_person_id_hex, "role": "owner" });
    let body = serde_json::to_vec(&body).map_err(|_| SyncDeviceError::Internal)?;
    let path = format!("/b2b/vaults/{account_hash_hex}/members");
    let resp = transport
        .request(HttpMethod::Post, &path, &body, Some(device_token))
        .map_err(|_| SyncDeviceError::Transport)?;
    parse_issued_token(&resp)
}

/// Post a sealed invite frame to the relay (`POST /b2b/invites`) with the
/// owner's per-vault membership token. The outer frame is the recipient person
/// id and the vault (carried by the token), so the server reads no fingerprint
/// and no public half.
pub async fn post_sealed_invite(
    host: &dyn HostCtx,
    io: &dyn VaultIo,
    owner_token_hex: &str,
    recipient_person_id_hex: &str,
    frame: &[u8],
) -> Result<(), SyncDeviceError> {
    let url = endpoint_from_host(host, io).await?;
    let token = owner_token_hex.to_string();
    let recipient = recipient_person_id_hex.to_string();
    let frame = frame.to_vec();
    crate::task::run_blocking(move || {
        let transport =
            super::http_transport::build_transport(&url).map_err(|_| SyncDeviceError::Transport)?;
        post_invite_request(transport.as_ref(), &token, &recipient, &frame)
    })
    .await
    .map_err(|_| SyncDeviceError::Internal)?
}

/// Post a sealed invite frame via an explicit transport, the shape a unit test
/// drives. Production resolves the transport in [`post_sealed_invite`].
pub fn post_invite_request(
    transport: &dyn SyncTransport,
    owner_token_hex: &str,
    recipient_person_id_hex: &str,
    frame: &[u8],
) -> Result<(), SyncDeviceError> {
    let payload_b64 = {
        use base64::Engine as _;
        base64::engine::general_purpose::STANDARD.encode(frame)
    };
    let body = serde_json::json!({
        "recipient_person_id_hex": recipient_person_id_hex,
        "payload_b64": payload_b64,
    });
    let body = serde_json::to_vec(&body).map_err(|_| SyncDeviceError::Internal)?;
    let resp = transport
        .request(
            HttpMethod::Post,
            "/b2b/invites",
            &body,
            Some(owner_token_hex),
        )
        .map_err(|_| SyncDeviceError::Transport)?;
    match resp.status {
        200 => Ok(()),
        401 | 403 => Err(SyncDeviceError::Unauthenticated),
        _ => Err(SyncDeviceError::Transport),
    }
}

/// One invitation the owner has sent for the active vault, as the vault-side
/// list projects it (myne-md/myne#711): the recipient person id (which the
/// owner supplied) and whether it has been claimed. The payload is never here.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct VaultInviteSummary {
    pub invite_id_hex: String,
    pub recipient_person_id_hex: String,
    pub claimed: bool,
    /// The recipient refused it (myne-md/myne#911 follow-up). The server dropped
    /// the sealed payload, so this row can never become a member; it exists so the
    /// sender is told what happened rather than watching an invitation that is
    /// never accepted.
    #[serde(default)]
    pub declined: bool,
}

#[derive(serde::Deserialize)]
struct VaultInvitesResp {
    #[serde(default)]
    invites: Vec<VaultInviteSummary>,
}

/// List the invitations the owner has sent for the ACTIVE vault
/// (`GET /b2b/vaults/{account_hash}/invites`, myne-md/myne#711 task 11). This is
/// the owner-side claimed-versus-pending view; `person_list_invites_from_host`
/// is its recipient-scoped twin. Authorized by the owner's per-vault token.
///
/// **A vault that is not shared yet is `ShareOpen::Unshared`, not an error**
/// (myne-md/myne#783). Before this, the whole call collapsed to `NotEnrolled` /
/// `Unauthenticated` / `Transport` and the roster panel rendered its generic
/// "Could not load your invitations" line on a freshly created vault where the
/// user had invited nobody — a legitimate "not shared yet" state reported as a
/// relay failure. The two are separated here: the preconditions that mean
/// "this vault has nothing to list" answer `Ok(None)`, and only a genuine
/// transport/parse failure is an `Err`.
pub async fn list_vault_invites_from_host(
    host: &dyn HostCtx,
    io: &dyn VaultIo,
    state: &VaultRuntimeState,
) -> Result<Option<Vec<VaultInviteSummary>>, SyncDeviceError> {
    let Some(owner_person_id) = state.clone_person_id().await else {
        // No person identity held: there is nothing to list and nothing to
        // report. The panel's own unlock gate already covers this state; it is
        // not a fetch failure.
        return Ok(None);
    };
    let root = crate::paths::active_vault_root_from_base(
        &host.app_data_dir().map_err(|_| SyncDeviceError::Internal)?,
        state.active_vault_id().await,
    );

    // The `NTV5` gate FIRST, and before any network call: an unshared vault has
    // no vault-side invite list to fetch, and reaching for one asks the server
    // a question only a shared vault can answer. `vault.meta` is the authority
    // on which generation this vault is, exactly as `create_invite_from_host`
    // reads it.
    let meta_path = root.join("vault.meta");
    let meta_bytes = io
        .read(&meta_path)
        .await
        .map_err(|_| SyncDeviceError::Transport)?;
    if meta_bytes.get(..4) == Some(protocol::VAULT_META_V0_2_MAGIC.as_slice()) {
        return Ok(None);
    }

    // The "nothing to list" gates come BEFORE any credential work, and the
    // order is load-bearing rather than cosmetic. `ensure_owner_member_token`
    // mints a per-vault owner token from `account_hash_hex`, so on a vault that
    // has none it answers `NotEnrolled`. This function then returned that as an
    // error, and the panel painted "Could not load your invitations" over a
    // vault whose only sin is being published under a person identity (born
    // `NTV7`: `namespace_hex` recorded, no vault account). Two states reach
    // here legitimately and neither is a failure: the frame has no B2B tail at
    // all, and the frame has a tail but this device has not enrolled the vault
    // under an account. Both answer `Ok(None)`.
    let sync_state = super::state::read_sync_state(io, &root)
        .await
        .map_err(|_| SyncDeviceError::Internal)?;
    let Some(selector_hex) = vault_selector_hex(&sync_state) else {
        // Neither enrolled nor published: there is no vault-side invite list to ask
        // for, and reaching for one asks the server a question this device cannot
        // yet address.
        return Ok(None);
    };
    // A person-born vault (`NTV7`) has no `account_hash_hex`; its selector is the
    // namespace it was published under, and its credential is the person session.
    let person_born = sync_state
        .account_hash_hex
        .as_deref()
        .is_none_or(str::is_empty);

    // An unregistered identity cannot have sent an invite, and `NotEnrolled` here
    // would otherwise paint a relay failure over that state (the panel's identity
    // gate already says what the state IS, `decisions/ui/0725`). On an enrolled
    // vault the same error stays an error: it means a token the vault should hold.
    let token = match ensure_owner_member_token(
        host,
        io,
        state,
        &crate::account::person_identity::hex_lower(&owner_person_id),
    )
    .await
    {
        Ok(token) => token,
        Err(SyncDeviceError::NotEnrolled) if person_born => return Ok(None),
        Err(err) => return Err(err),
    };
    let url = endpoint_from_host(host, io).await?;
    let path = format!("/b2b/vaults/{selector_hex}/invites");

    crate::task::run_blocking(move || {
        let transport =
            super::http_transport::build_transport(&url).map_err(|_| SyncDeviceError::Transport)?;
        let resp = transport
            .request(HttpMethod::Get, &path, &[], Some(&token))
            .map_err(|_| SyncDeviceError::Transport)?;
        match resp.status {
            200 => {
                let parsed: VaultInvitesResp =
                    serde_json::from_slice(&resp.body).map_err(|_| SyncDeviceError::Transport)?;
                Ok(Some(parsed.invites))
            }
            // The owner is not bound on this vault (yet). Nothing was sent, so
            // this is the unshared state rather than a failure.
            403 => Ok(None),
            401 => Err(SyncDeviceError::Unauthenticated),
            _ => Err(SyncDeviceError::Transport),
        }
    })
    .await
    .map_err(|_| SyncDeviceError::Internal)?
}

#[cfg(all(feature = "tauri-ipc", not(target_arch = "wasm32")))]
#[tauri::command]
pub async fn sync_list_vault_invites<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    state: tauri::State<'_, VaultRuntimeState>,
) -> Result<Vec<VaultInviteSummary>, SyncDeviceError> {
    // `Ok(None)` means "this vault is not shared yet" (myne-md/myne#783); there
    // is no list to return, and an empty list is the honest answer.
    Ok(list_vault_invites_from_host(
        &crate::host::tauri_host::TauriHost::new(app.clone()),
        &crate::vault_io::StdVaultIo,
        state.inner(),
    )
    .await?
    .unwrap_or_default())
}

/// The result of claiming a sealed invite from the relay.
#[derive(Debug, Clone, serde::Deserialize)]
pub struct ClaimedInvite {
    pub payload_b64: String,
    pub vault_account_hash_hex: String,
    pub token_hex: String,
}

/// Decline an invitation (`DELETE /b2b/invites/{id}`, myne-md/myne#911
/// follow-up) via an explicit transport, the shape a unit test drives.
///
/// The server drops the sealed payload on the spot, so this is the recipient's
/// real exit rather than a client-side hide, and the sender's own list reports
/// the invitation as declined. A retry is idempotent (the server answers `200`
/// for a slot the same recipient already declined), which matters because the
/// caller cannot tell a lost response from a lost request.
///
/// The status mapping matches [`claim_invite_request`] deliberately: `404` is
/// what an unknown id and somebody else's id both answer, and `409` means the
/// invitation was already accepted. The recipient is a member, and ending that
/// is the owner's removal rather than a declined invite.
pub fn decline_invite_request(
    transport: &dyn SyncTransport,
    person_token_hex: &str,
    invite_id_hex: &str,
) -> Result<(), SyncDeviceError> {
    let path = format!("/b2b/invites/{invite_id_hex}");
    let resp = transport
        .request(HttpMethod::Delete, &path, &[], Some(person_token_hex))
        .map_err(|_| SyncDeviceError::Transport)?;
    match resp.status {
        200 => Ok(()),
        401 | 403 => Err(SyncDeviceError::Unauthenticated),
        404 => Err(SyncDeviceError::DeviceNotFound),
        409 => Err(SyncDeviceError::BadRequest),
        _ => Err(SyncDeviceError::Transport),
    }
}

/// Decline one invite addressed to this person account. Reads the same
/// device-scoped token, endpoint and lifecycle as
/// [`person_list_invites_from_host`], and answers `NotEnrolled` for the same
/// honest reason: an identity the server has never seen has no invitation it
/// could have accepted.
pub async fn decline_invite_from_host(
    host: &dyn HostCtx,
    io: &dyn VaultIo,
    invite_id_hex: &str,
) -> Result<(), SyncDeviceError> {
    let auth_path = person_auth_path_for_read(host).map_err(|_| SyncDeviceError::Internal)?;
    let auth = read_person_auth(io, &auth_path)
        .await
        .map_err(|_| SyncDeviceError::Internal)?
        .filter(|a| !a.token_hex.is_empty())
        .ok_or(SyncDeviceError::NotEnrolled)?;

    let cfg_path = super::config::config_path_from_host(host, io)
        .await
        .map_err(|_| SyncDeviceError::Internal)?;
    let cfg = super::config::read_config(io, &cfg_path)
        .await
        .map_err(|_| SyncDeviceError::NotConfigured)?;
    let url = cfg.endpoint_url.ok_or(SyncDeviceError::NotConfigured)?;

    let invite_id = invite_id_hex.to_string();
    let token = auth.token_hex;
    crate::task::run_blocking(move || {
        let transport =
            super::http_transport::build_transport(&url).map_err(|_| SyncDeviceError::Transport)?;
        decline_invite_request(transport.as_ref(), &token, &invite_id)
    })
    .await
    .map_err(|_| SyncDeviceError::Internal)?
}

#[cfg(all(feature = "tauri-ipc", not(target_arch = "wasm32")))]
#[tauri::command]
pub async fn sync_person_decline_invite<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    invite_id_hex: String,
) -> Result<(), SyncDeviceError> {
    decline_invite_from_host(
        &crate::host::tauri_host::TauriHost::new(app.clone()),
        &crate::vault_io::StdVaultIo,
        &invite_id_hex,
    )
    .await
}

/// Claim one invite addressed to this person (`POST /b2b/invites/{id}/claim`)
/// via an explicit transport, the shape a unit test drives. Releases the sealed
/// payload byte-identically, binds the member and issues the member's per-vault
/// token.
pub fn claim_invite_request(
    transport: &dyn SyncTransport,
    person_token_hex: &str,
    invite_id_hex: &str,
) -> Result<ClaimedInvite, SyncDeviceError> {
    let path = format!("/b2b/invites/{invite_id_hex}/claim");
    let resp = transport
        .request(HttpMethod::Post, &path, &[], Some(person_token_hex))
        .map_err(|_| SyncDeviceError::Transport)?;
    match resp.status {
        200 => {}
        401 | 403 => return Err(SyncDeviceError::Unauthenticated),
        404 => return Err(SyncDeviceError::DeviceNotFound),
        409 => return Err(SyncDeviceError::BadRequest),
        _ => return Err(SyncDeviceError::Transport),
    }
    serde_json::from_slice(&resp.body).map_err(|_| SyncDeviceError::Transport)
}

/// Fetch a vault's `vault.meta` pre-auth (`GET /vault.meta?account=…`), the
/// bootstrap every join path uses. The bytes are AEAD-protected and useless
/// without a credential; this only needs the vault's public account hash.
pub fn fetch_vault_meta_request(
    transport: &dyn SyncTransport,
    account_hash_hex: &str,
) -> Result<Vec<u8>, SyncDeviceError> {
    let path = format!("/vault.meta?account={account_hash_hex}");
    let resp = transport
        .request(HttpMethod::Get, &path, &[], None)
        .map_err(|_| SyncDeviceError::Transport)?;
    if resp.status != 200 {
        return Err(SyncDeviceError::DeviceNotFound);
    }
    Ok(resp.body)
}

/// What a successful acceptance reports to the UI: public fields only. The
/// group and items keys stay backend-side in the member slot.
#[derive(Debug, Clone, serde::Serialize)]
pub struct AcceptedInviteView {
    pub vault_id: String,
    pub vault_account_hash_hex: String,
    /// The owner's fingerprint, for the SAS compare. The member confirms it out
    /// of band against the owner's own code before trusting the vault.
    pub owner_fingerprint_hex: String,
    pub group_key_epoch: u64,
}

/// Materialize a local member vault and install the member slot, the tail every
/// path that brings a shared `NTV6` vault onto this device shares: the accept
/// path (which claimed a fresh invite) and the second-device join path (which
/// re-read the pinned owner code and fetched its already-delivered package).
///
/// Deliberately ONE function rather than two copies. Every line here is
/// load-bearing for the same reason: the directory is create-only, so a partial
/// install must remove it rather than leave something the vault list reads as a
/// real vault; the phrase-sealed `vault.member-key` and the mandatory
/// `vault.member-unlock` credential are both written BEFORE the slot install,
/// which consumes the key values; and a failed slot install (`None`, meaning a
/// busy slot or a changed session) is a retryable `Transport`, not a lockout. A
/// second copy of that ordering is a second place for it to drift.
#[allow(clippy::too_many_arguments)]
#[cfg(not(target_arch = "wasm32"))]
async fn materialize_member_vault(
    host: &dyn HostCtx,
    io: &dyn VaultIo,
    state: &VaultRuntimeState,
    generation: u64,
    account_hash: [u8; 16],
    account_hash_hex: &str,
    meta_bytes: &[u8],
    b2b: &protocol::B2bVaultMeta,
    epoch: u64,
    group_key: Zeroizing<[u8; 32]>,
    items_key: Zeroizing<[u8; 32]>,
    person_id: [u8; 16],
    member: protocol::PersonKeyPair,
    transition: Option<Vec<u8>>,
    token: Vec<u8>,
    owner_code: &str,
    phrase_normalized: &str,
    password: &str,
) -> Result<crate::vault_id::VaultId, SyncDeviceError> {
    use super::token_store::TokenStore as _;
    let items_key_id = b2b.base.items_key_id;

    // Materialize a fresh local member vault: create-only meta, a member slot
    // with no root key, and the member's per-vault token device-local.
    let base = host.app_data_dir().map_err(|_| SyncDeviceError::Internal)?;
    let vault_id = crate::vault_registry::mint_unique_vault_id(&base);
    let vault_dir = crate::paths::vault_dir_for_id_from_host_io(host, io, Some(vault_id))
        .await
        .map_err(|_| SyncDeviceError::Internal)?;
    // `vault.meta` is create-only, so a failure here would leave the directory this
    // call just created behind, and the next attempt (or the UI's vault list) reads a
    // partial vault directory as a real vault. Remove it and refuse, the same way the
    // missing fast credential below does.
    let meta_path = vault_dir.join("vault.meta");
    if let Err(e) =
        super::enroll::write_bootstrap_meta(io, &meta_path, meta_bytes, &account_hash).await
    {
        tracing::warn!(
            stage = "member_vault_bootstrap_meta",
            "member vault refused"
        );
        let _ = io.remove_dir_all(&vault_dir).await;
        return Err(e);
    }

    // Persist the member keys, sealed under the member's own phrase, so the
    // vault can be re-unlocked later without a password (task 25). Written
    // BEFORE the slot install, which consumes the key values.
    let member_key_written = super::member_key_store::write_member_key_store(
        io,
        &vault_dir,
        vault_id.as_uuid().as_bytes(),
        &account_hash,
        epoch,
        &items_key_id,
        &b2b.base.kdf_params,
        phrase_normalized,
        &group_key,
        &items_key,
    )
    .await;
    if member_key_written.is_err() {
        tracing::warn!(
            stage = "member_vault_member_key_store",
            "member vault refused"
        );
        let _ = io.remove_dir_all(&vault_dir).await;
        return Err(SyncDeviceError::Internal);
    }

    // The REQUIRED fast credential, written as part of installing the member session and
    // BEFORE the slot install, which consumes the key values. An accepted vault that
    // carries no fast credential would make the mandatory password a lie, so a failure
    // here removes the directory this call just created and refuses: an invite that
    // failed to materialize fully is one the user retries, not one they are locked out
    // of. The phrase-sealed `vault.member-key` above stays the portable fallback.
    write_accept_fast_credential(
        io,
        &vault_dir,
        &vault_id,
        &account_hash,
        epoch,
        &items_key_id,
        &person_id,
        &b2b.base.kdf_params,
        password,
        &group_key,
        &items_key,
        &member,
    )
    .await?;

    use sha2::Digest as _;
    let meta_hash: [u8; 32] = sha2::Sha256::digest(meta_bytes).into();
    let mut st = super::state::read_sync_state(io, &vault_dir)
        .await
        .map_err(|_| SyncDeviceError::Internal)?;
    st.account_hash_hex = Some(account_hash_hex.to_string());
    st.owner_identity_code = Some(owner_code.to_string());
    st.device_id_hex = Some(crate::account::person_identity::hex_lower(
        &super::enroll::generate_device_id(),
    ));
    super::state::write_sync_state(io, &vault_dir, &st)
        .await
        .map_err(|_| SyncDeviceError::Internal)?;
    super::token_store::default_store()
        .store(io, &vault_dir, &token)
        .await
        .map_err(|_| SyncDeviceError::Internal)?;

    let profile_id = protocol::person_profile_id(&person_id, &account_hash);
    let profile = protocol::derive_person_vault_profile_key(
        phrase_normalized,
        &profile_id,
        &b2b.base.kdf_params,
    )
    .ok()
    .map(|key| (profile_id, key));
    let install = crate::plugins::vault_unlock::state::PersonSessionInstall {
        pair: member,
        person_id,
        profile,
        transition,
    };
    let installed = state
        .set_unlocked_locking_others_with_person_session(
            generation,
            vault_id,
            crate::plugins::vault_unlock::state::UnlockedVault::member(
                group_key,
                items_key,
                items_key_id,
                host.now_unix_secs(),
                meta_hash,
            ),
            Some(install),
        )
        .await;
    if installed.is_none() {
        tracing::warn!(
            stage = "member_vault_slot_install",
            "member vault refused: slot busy or session changed"
        );
        let _ = io.remove_dir_all(&vault_dir).await;
        return Err(SyncDeviceError::Transport);
    }

    // The accepting device claims its own binding (member-devices task 3). The session
    // and the device id were both installed above, so the store's own claim core finds
    // everything it needs; the accept path never runs the unlock pipeline, so without
    // this line a freshly accepted device would stay unbound until its second unlock.
    // Best-effort: the invite is already claimed and the vault is materialized, so a
    // failed binding here must not present the user with an error for an accept that
    // succeeded. Native-only: the family's command core borrows the person account
    // plane's session accessors, which do not exist on `wasm32`.
    #[cfg(not(target_arch = "wasm32"))]
    crate::plugins::device_binding::commands::claim_own_binding_best_effort(io, state, &vault_dir)
        .await;

    Ok(vault_id)
}

/// **Accept a sealed invite** (B2B, myne-md/myne#711 task 12). Claims the
/// invite from the relay with the person token, verifies the owner-signed group
/// package against the owner's public half (from the out-of-band owner identity
/// code), unwraps the group key, derives the vault's `itemsKey`, materializes a
/// local member vault, and installs a **member** slot with no root key.
///
/// The owner's public half is a pinned input, never taken from the package, so
/// a server that substitutes it is caught by the SAS compare. The command
/// returns only public fields; the keys live in the slot.
#[cfg(not(target_arch = "wasm32"))] // member surface: refused on web (myne-md/myne#911 task 13)
pub async fn accept_invite_from_host(
    host: &dyn HostCtx,
    io: &dyn VaultIo,
    state: &VaultRuntimeState,
    invite_id_hex: &str,
    owner_code: &str,
    phrase: &str,
    // The REQUIRED device-local fast credential (myne-md/myne#851 task 7).
    password: &str,
) -> Result<AcceptedInviteView, SyncDeviceError> {
    // The project's ONE floor, counted the way the backend counts it (Unicode scalar
    // values), and checked BEFORE the invite is claimed or any directory is created: a
    // password below it must not leave a claimed invite or a half-materialized vault
    // behind. The form gates on the same constant, so this is the enforcement rather
    // than the message.
    protocol::validate_min_length(password).map_err(|_| {
        tracing::warn!(
            stage = "accept_password_floor",
            "b2b accept refused: the password is below the project floor"
        );
        SyncDeviceError::BadRequest
    })?;

    let normalized = zeroize::Zeroizing::new(protocol::normalize_user_phrase(phrase));
    let person_id = protocol::person_id_hash(normalized.as_str());
    let generation = state.person_session_generation().await;
    let owner = super::invite::decode_person_identity_code(owner_code).map_err(|e| {
        tracing::warn!(stage = "accept_owner_code", error = ?e, "b2b accept failed");
        SyncDeviceError::BadRequest
    })?;

    let auth_path = person_auth_path_for_read(host).map_err(|_| SyncDeviceError::Internal)?;
    let auth = read_person_auth(io, &auth_path)
        .await
        .map_err(|_| SyncDeviceError::Internal)?
        .filter(|a| !a.token_hex.is_empty())
        .ok_or(SyncDeviceError::NotEnrolled)?;
    if auth.person_id_hex != crate::account::person_identity::hex_lower(&person_id) {
        tracing::warn!(
            stage = "accept_phrase_mismatch",
            "b2b accept failed: the entered phrase is not this device's identity"
        );
        return Err(SyncDeviceError::NotEnrolled);
    }
    let member = crate::account::person_identity::open_person_identity_without_mutation(
        host,
        io,
        normalized.as_str(),
    )
    .await
    .map_err(|error| {
        use crate::account::person_identity::PersonIdentityError as E;
        tracing::warn!(stage = "accept_open_identity", error = ?error, "b2b accept failed");
        match error {
            E::BadPhrase | E::CannotDecrypt => SyncDeviceError::BadRequest,
            E::Io | E::Csprng => SyncDeviceError::Transport,
        }
    })?;
    let transition = crate::account::person_identity::read_pending_person_key_transition(host, io)
        .await
        .map_err(|_| SyncDeviceError::Transport)?;
    let url = endpoint_from_host(host, io).await?;

    let invite_id = invite_id_hex.to_string();
    let person_token = auth.token_hex.clone();
    let (claimed, meta_bytes) = crate::task::run_blocking(move || {
        let transport =
            super::http_transport::build_transport(&url).map_err(|_| SyncDeviceError::Transport)?;
        let claimed = claim_invite_request(transport.as_ref(), &person_token, &invite_id)?;
        let meta = fetch_vault_meta_request(transport.as_ref(), &claimed.vault_account_hash_hex)?;
        Ok::<_, SyncDeviceError>((claimed, meta))
    })
    .await
    .map_err(|_| SyncDeviceError::Internal)??;

    let account_hash = super::devices::hex16(&claimed.vault_account_hash_hex).ok_or_else(|| {
        tracing::warn!(stage = "accept_claim_account_hash", "b2b accept failed");
        SyncDeviceError::BadRequest
    })?;
    let payload = {
        use base64::Engine as _;
        base64::engine::general_purpose::STANDARD
            .decode(&claimed.payload_b64)
            .map_err(|e| {
                tracing::warn!(stage = "accept_claim_payload_b64", error = ?e, "b2b accept failed");
                SyncDeviceError::BadRequest
            })?
    };
    let package =
        protocol::person_invite::decode_signed_group_package(&payload).ok_or_else(|| {
            tracing::warn!(stage = "accept_decode_package", "b2b accept failed");
            SyncDeviceError::BadRequest
        })?;

    // The tail, whichever generation carries it: a member accepting an invite to a
    // vault born under the owner's identity receives an `NTV7` frame, whose tail is
    // `NTV6`'s byte for byte. Parsing only `NTV6` here made an `NTV7` invite
    // unclaimable, which would have been an invite the product sends and cannot
    // honour.
    let b2b = protocol::parse_b2b_tail_any(&meta_bytes).map_err(|e| {
        tracing::warn!(
            stage = "accept_parse_b2b_tail",
            protocol_error_kind = crate::protocol_error_kind::protocol_error_kind(&e),
            "b2b accept failed"
        );
        SyncDeviceError::BadRequest
    })?;
    if b2b.base.account_number_hash != account_hash {
        tracing::warn!(stage = "accept_account_hash_mismatch", "b2b accept failed");
        return Err(SyncDeviceError::BadRequest);
    }
    let (group_key, epoch, owner_fingerprint_hex) =
        super::invite::accept_group_package(&owner.public, &member, &package, &account_hash)
            .map_err(|e| {
                tracing::warn!(stage = "accept_group_package", error = ?e, "b2b accept failed");
                SyncDeviceError::BadRequest
            })?;
    let group = protocol::GroupKey::new(*group_key);
    let items_key = protocol::unlock_items_key_ntv6(&b2b, &group).map_err(|e| {
        tracing::warn!(
            stage = "accept_unlock_items_key",
            protocol_error_kind = crate::protocol_error_kind::protocol_error_kind(&e),
            "b2b accept failed"
        );
        SyncDeviceError::BadRequest
    })?;
    let token = hex_to_bytes(&claimed.token_hex).ok_or(SyncDeviceError::BadRequest)?;

    // Everything from here is the shared member-vault install tail, so the accept
    // path and the second-device join path cannot drift apart on the ordering that
    // keeps a failed install from leaving a half-materialized vault behind.
    let vault_id = materialize_member_vault(
        host,
        io,
        state,
        generation,
        account_hash,
        &claimed.vault_account_hash_hex,
        &meta_bytes,
        &b2b,
        epoch,
        group_key,
        items_key,
        person_id,
        member,
        transition,
        token,
        owner_code,
        normalized.as_str(),
        password,
    )
    .await?;

    Ok(AcceptedInviteView {
        vault_id: vault_id.to_string(),
        vault_account_hash_hex: claimed.vault_account_hash_hex,
        owner_fingerprint_hex,
        group_key_epoch: epoch,
    })
}

/// Write the fast credential an ACCEPT must carry (`vault.member-unlock`,
/// myne-md/myne#851 task 7), or remove the vault directory and refuse.
///
/// Split out of [`accept_invite_from_host`] because every input is a value the accept
/// has already derived, so this half is testable without a server: the seal is the one
/// [`super::member_unlock_store::write_member_unlock_password`] writes for the Privacy
/// screen and the unlock path, with the accept-time `group_key` / `items_key` /
/// `items_key_id` / epoch / `person_id` and the same person keypair. There is exactly
/// one credential format, so "the password set during accept opens the vault next
/// session" is true by construction rather than by two agreeing code paths.
///
/// Ordering is the point. This runs BEFORE the slot install, so a failure leaves no
/// session and no accepted vault; and it removes the directory it just populated,
/// because `vault.meta` is create-only, so a retry over a half-written directory would
/// fail forever. The invite is already claimed at this point (the claim is the first
/// network call), and that is deliberate: the claim is idempotent and re-claiming on a
/// retry returns the same package.
#[allow(clippy::too_many_arguments)]
async fn write_accept_fast_credential(
    io: &dyn VaultIo,
    vault_dir: &std::path::Path,
    vault_id: &crate::vault_id::VaultId,
    account_hash: &[u8; 16],
    group_key_epoch: u64,
    items_key_id: &[u8; 16],
    person_id: &[u8; 16],
    kdf_params: &protocol::KdfParams,
    password: &str,
    group_key: &[u8; 32],
    items_key: &[u8; 32],
    pair: &protocol::PersonKeyPair,
) -> Result<(), SyncDeviceError> {
    let written = super::member_unlock_store::write_member_unlock_password(
        io,
        vault_dir,
        vault_id.as_uuid().as_bytes(),
        account_hash,
        group_key_epoch,
        items_key_id,
        person_id,
        kdf_params,
        password,
        group_key,
        items_key,
        pair,
    )
    .await;
    if written.is_err() {
        tracing::warn!(
            stage = "accept_member_unlock_store",
            "b2b accept failed: the fast credential could not be written; removing the half-materialized vault"
        );
        let _ = io.remove_dir_all(vault_dir).await;
        return Err(SyncDeviceError::Internal);
    }
    Ok(())
}

#[cfg(all(feature = "tauri-ipc", not(target_arch = "wasm32")))]
#[tauri::command]
pub async fn sync_person_accept_invite<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    state: tauri::State<'_, VaultRuntimeState>,
    hooks: tauri::State<'_, crate::hooks::Hooks>,
    invite_id_hex: String,
    owner_code: String,
    phrase: String,
    password: String,
) -> Result<AcceptedInviteView, SyncDeviceError> {
    let phrase = zeroize::Zeroizing::new(phrase);
    let password = zeroize::Zeroizing::new(password);
    let host = crate::host::tauri_host::TauriHost::new(app.clone());
    let io = crate::vault_io::StdVaultIo;
    let accepted = accept_invite_from_host(
        &host,
        &io,
        state.inner(),
        &invite_id_hex,
        &owner_code,
        &phrase,
        &password,
    )
    .await?;
    // The accepted vault is now the ACTIVE member slot, so run the shared
    // post-unlock pipeline here too. It resolves the vault's label from the
    // decrypted prefs and writes the device-local `vault.label`, which is what the
    // LOCKED picker reads. Skipping it left the member reading "Vault N" until some
    // later sync cycle or unlock (myne-md/myne#856).
    //
    // Best-effort: the invite is already claimed and the vault materialized, so a
    // label hiccup must not turn a successful accept into a failure the user would
    // retry: the retry would find the invite already claimed.
    let vault_id = crate::vault_id::VaultId::parse(&accepted.vault_id)
        .map_err(|_| SyncDeviceError::BadRequest)?;
    if run_member_post_unlock(&host, state.inner(), hooks.inner(), &io, vault_id)
        .await
        .is_err()
    {
        tracing::warn!(
            stage = "accept_post_unlock",
            "the post-accept label pipeline did not complete; the vault name resolves on the next unlock or sync"
        );
    }
    Ok(accepted)
}

/// Resolve the PINNED owner identity code for a member vault this device is
/// unlocking, from whichever of the two places holds it.
///
/// The device-local `SyncState` copy is preferred: it is written only by the
/// accepting device, needs no network, and is the copy `accept_invite_from_host`
/// recorded straight from the out-of-band invite. A device that never accepted -
/// a member's second device - has no such copy by construction, and reads the same
/// pin from this person's own sealed `MYY5` profile instead, where the first device
/// pushed it. Neither source is the sync plane's own word for who the owner is, and
/// neither is ever taken from a group package.
async fn resolve_member_owner_pin(
    host: &dyn HostCtx,
    io: &dyn VaultIo,
    vault_dir: &std::path::Path,
    phrase_normalized: &str,
    b2b: &protocol::B2bVaultMeta,
) -> Result<String, SyncDeviceError> {
    let device_local = super::state::read_sync_state(io, vault_dir)
        .await
        .map_err(|_| SyncDeviceError::Internal)?
        .owner_identity_code
        .filter(|c| !c.is_empty());
    match device_local {
        Some(code) => Ok(code),
        None => member_owner_pin_read_from_host(host, io, phrase_normalized, b2b).await,
    }
}

/// **Join a shared vault as a member's SECOND device** (`member-devices` task 7).
///
/// The gap this closes: `accept_invite_from_host` materializes the vault and
/// records the pinned owner code **on the device that accepted**, so a member's
/// other device could see the person's account but not the vault. This path needs
/// no owner action and no fresh invite, and it takes no owner code from the user:
/// it reads the pin the first device published, from this person's own sealed
/// `MYY5` profile, which the same recovery phrase opens.
///
/// Order is the security property, not an implementation detail. The vault's
/// `vault.meta` is fetched first (it carries the `kdf_params` the profile key is
/// derived under and the B2B envelope), the PIN is read and decoded from the
/// profile second, and only then is the invite re-claimed. So the claim is never
/// what decides who the owner is, and a vault with no pin is refused before
/// anything on this device is created.
///
/// The re-claim is the same route the first device used. It is idempotent for the
/// invite's own recipient and mints a **fresh** per-vault membership token
/// (`decisions/protocol/0672`), which is the whole mechanism: the token, not the
/// keys, is what a second device otherwise has no way to obtain. A person the
/// owner has since removed gets the same `404` and cannot re-claim their way back
/// in.
#[cfg(not(target_arch = "wasm32"))] // member surface: refused on web (myne-md/myne#911 task 13)
pub async fn member_join_vault_from_host(
    host: &dyn HostCtx,
    io: &dyn VaultIo,
    state: &VaultRuntimeState,
    invite_id_hex: &str,
    vault_account_hash_hex: &str,
    phrase: &str,
    password: &str,
) -> Result<AcceptedInviteView, SyncDeviceError> {
    // Same floor, and checked at the same point as accept: before anything is
    // claimed and before any directory exists, so a short password cannot leave a
    // claimed invite or a half-materialized vault behind.
    protocol::validate_min_length(password).map_err(|_| {
        tracing::warn!(
            stage = "join_password_floor",
            "b2b join refused: the password is below the project floor"
        );
        SyncDeviceError::BadRequest
    })?;

    let normalized = Zeroizing::new(protocol::normalize_user_phrase(phrase));
    let person_id = protocol::person_id_hash(normalized.as_str());
    let generation = state.person_session_generation().await;

    let auth_path = person_auth_path_for_read(host).map_err(|_| SyncDeviceError::Internal)?;
    let auth = read_person_auth(io, &auth_path)
        .await
        .map_err(|_| SyncDeviceError::Internal)?
        .filter(|a| !a.token_hex.is_empty())
        .ok_or(SyncDeviceError::NotEnrolled)?;
    if auth.person_id_hex != crate::account::person_identity::hex_lower(&person_id) {
        tracing::warn!(
            stage = "join_phrase_mismatch",
            "b2b join failed: the entered phrase is not this device's identity"
        );
        return Err(SyncDeviceError::NotEnrolled);
    }
    let account_hash = super::devices::hex16(vault_account_hash_hex).ok_or_else(|| {
        tracing::warn!(stage = "join_account_hash", "b2b join failed");
        SyncDeviceError::BadRequest
    })?;

    // Already held? The picker hides these, but the backend does not lean on the
    // picker: a second local copy of one remote vault would mint a second device id
    // and sync the same namespace from two directories, which is a mess no error
    // message later in the flow can explain. Refuse, and name the vault already held.
    let base = host.app_data_dir().map_err(|_| SyncDeviceError::Internal)?;
    if local_vault_holds_account(&base, io, &account_hash).await? {
        tracing::warn!(
            stage = "join_already_held",
            "b2b join refused: this device already holds a vault for that account"
        );
        // `VaultAlreadyHeld`, not `BadRequest` and not `AccountMismatch`: this
        // device holds the SAME account, so the remedy is to open the vault it
        // already has. `AccountMismatch` is the opposite case (a DIFFERENT
        // account, remedy = erase), and a bare `BadRequest` would put this in the
        // same arm as the pin-absent refusal below, whose remedy is to open the
        // vault elsewhere first and retry. One message cannot name two opposite
        // remedies, and this is the ROUTINE case rather than an edge: a claimed
        // invite stays listed on the identity home, so clicking join on a vault
        // this device already holds lands here every time (myne-md/myne#794).
        return Err(SyncDeviceError::VaultAlreadyHeld);
    }

    // 1. The vault's metadata, BEFORE the claim: kdf params + the B2B envelope.
    let url = endpoint_from_host(host, io).await?;
    let meta_bytes = {
        let url = url.clone();
        let account_hash_hex = vault_account_hash_hex.to_string();
        crate::task::run_blocking(move || {
            let transport = super::http_transport::build_transport(&url)
                .map_err(|_| SyncDeviceError::Transport)?;
            fetch_vault_meta_request(transport.as_ref(), &account_hash_hex)
        })
        .await
        .map_err(|_| SyncDeviceError::Internal)??
    };
    let b2b = protocol::parse_b2b_tail_any(&meta_bytes).map_err(|e| {
        tracing::warn!(
            stage = "join_parse_b2b_tail",
            protocol_error_kind = crate::protocol_error_kind::protocol_error_kind(&e),
            "b2b join failed"
        );
        SyncDeviceError::BadRequest
    })?;
    if b2b.base.account_number_hash != account_hash {
        tracing::warn!(stage = "join_account_hash_mismatch", "b2b join failed");
        return Err(SyncDeviceError::BadRequest);
    }

    // 2. The PINNED owner half, read from this person's own sealed profile. A vault
    // with no pin on the profile plane is refused here, before the claim and before
    // any directory exists.
    let owner_code = member_owner_pin_read_from_host(host, io, normalized.as_str(), &b2b).await?;
    let owner = super::invite::decode_person_identity_code(&owner_code).map_err(|e| {
        tracing::warn!(stage = "join_owner_code", error = ?e, "b2b join failed");
        SyncDeviceError::BadRequest
    })?;

    // 3. This device's person identity, opened from the phrase.
    let member = crate::account::person_identity::open_person_identity_without_mutation(
        host,
        io,
        normalized.as_str(),
    )
    .await
    .map_err(|error| {
        use crate::account::person_identity::PersonIdentityError as E;
        tracing::warn!(stage = "join_open_identity", error = ?error, "b2b join failed");
        match error {
            E::BadPhrase | E::CannotDecrypt => SyncDeviceError::BadRequest,
            E::Io | E::Csprng => SyncDeviceError::Transport,
        }
    })?;
    let transition = crate::account::person_identity::read_pending_person_key_transition(host, io)
        .await
        .map_err(|_| SyncDeviceError::Transport)?;

    // 4. Re-claim: the fresh per-vault membership token, and the retained sealed
    // package. A 409 here would mean the widened re-claim rule is not deployed.
    let invite_id = invite_id_hex.to_string();
    let person_token = auth.token_hex.clone();
    let claimed = crate::task::run_blocking(move || {
        let transport =
            super::http_transport::build_transport(&url).map_err(|_| SyncDeviceError::Transport)?;
        claim_invite_request(transport.as_ref(), &person_token, &invite_id)
    })
    .await
    .map_err(|_| SyncDeviceError::Internal)??;
    if claimed.vault_account_hash_hex != vault_account_hash_hex {
        tracing::warn!(stage = "join_claim_account_mismatch", "b2b join failed");
        return Err(SyncDeviceError::BadRequest);
    }
    let payload = {
        use base64::Engine as _;
        base64::engine::general_purpose::STANDARD
            .decode(&claimed.payload_b64)
            .map_err(|e| {
                tracing::warn!(stage = "join_claim_payload_b64", error = ?e, "b2b join failed");
                SyncDeviceError::BadRequest
            })?
    };
    let package =
        protocol::person_invite::decode_signed_group_package(&payload).ok_or_else(|| {
            tracing::warn!(stage = "join_decode_package", "b2b join failed");
            SyncDeviceError::BadRequest
        })?;
    // Verified against the PIN, never against anything the claim supplied. A package
    // that does not open under the pinned owner half is a refusal, not a retry.
    let (group_key, epoch, owner_fingerprint_hex) =
        super::invite::accept_group_package(&owner.public, &member, &package, &account_hash)
            .map_err(|e| {
                tracing::warn!(stage = "join_group_package", error = ?e, "b2b join failed");
                SyncDeviceError::BadRequest
            })?;
    let group = protocol::GroupKey::new(*group_key);
    let items_key = protocol::unlock_items_key_ntv6(&b2b, &group).map_err(|e| {
        tracing::warn!(
            stage = "join_unlock_items_key",
            protocol_error_kind = crate::protocol_error_kind::protocol_error_kind(&e),
            "b2b join failed"
        );
        SyncDeviceError::BadRequest
    })?;
    let token = hex_to_bytes(&claimed.token_hex).ok_or(SyncDeviceError::BadRequest)?;

    // 5. Materialize and install through the SAME tail accept uses, so the two
    // paths cannot drift on an ordering that decides whether a partial install is
    // cleaned up.
    let vault_id = materialize_member_vault(
        host,
        io,
        state,
        generation,
        account_hash,
        vault_account_hash_hex,
        &meta_bytes,
        &b2b,
        epoch,
        group_key,
        items_key,
        person_id,
        member,
        transition,
        token,
        &owner_code,
        normalized.as_str(),
        password,
    )
    .await?;
    Ok(AcceptedInviteView {
        vault_id: vault_id.to_string(),
        vault_account_hash_hex: vault_account_hash_hex.to_string(),
        owner_fingerprint_hex,
        group_key_epoch: epoch,
    })
}

/// Whether this device already holds a vault for `account_hash`.
///
/// Reads only the device-local cleartext `SyncState` of each discovered vault: the
/// account hash is not a secret, and the sealed stores are not opened. Used to
/// refuse a second local copy of one remote vault (`member-devices` task 7).
async fn local_vault_holds_account(
    base: &std::path::Path,
    io: &dyn VaultIo,
    account_hash: &[u8; 16],
) -> Result<bool, SyncDeviceError> {
    let want = crate::account::person_identity::hex_lower(account_hash);
    for discovered in crate::vault_registry::discover_vaults(base) {
        // A read failure is NOT the answer "does not hold this account".
        // Swallowing it with `if let Ok(..)` made this duplicate-copy guard
        // skippable by a transient or corruption-class fault, and the
        // consequence is the exact thing the guard exists to prevent: a second
        // local copy of one remote vault, i.e. two vault directories carrying
        // the same account hash. `read_sync_state` answers `Ok(SyncState::default())`
        // for an ABSENT file (the ordinary pre-enrolment case, `account_hash_hex:
        // None`, which correctly falls through), so only a present-and-unreadable
        // one reaches this arm and it is a real fault worth reporting.
        let st = super::state::read_sync_state(io, &discovered.root)
            .await
            .map_err(|_| SyncDeviceError::Internal)?;
        if st.account_hash_hex.as_deref() == Some(want.as_str()) {
            return Ok(true);
        }
    }
    Ok(false)
}

#[cfg(all(feature = "tauri-ipc", not(target_arch = "wasm32")))]
#[tauri::command]
pub async fn sync_member_join_vault<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    state: tauri::State<'_, VaultRuntimeState>,
    hooks: tauri::State<'_, crate::hooks::Hooks>,
    invite_id_hex: String,
    vault_account_hash_hex: String,
    phrase: String,
    password: String,
) -> Result<AcceptedInviteView, SyncDeviceError> {
    let phrase = zeroize::Zeroizing::new(phrase);
    let password = zeroize::Zeroizing::new(password);
    let host = crate::host::tauri_host::TauriHost::new(app.clone());
    let io = crate::vault_io::StdVaultIo;
    let accepted = member_join_vault_from_host(
        &host,
        &io,
        state.inner(),
        &invite_id_hex,
        &vault_account_hash_hex,
        &phrase,
        &password,
    )
    .await?;
    // The joined vault is now the ACTIVE member slot, so the shared post-unlock
    // pipeline runs here too, for the same reason accept runs it: it resolves the
    // vault's label from the decrypted prefs and writes the device-local
    // `vault.label` the LOCKED picker reads. Best-effort, as there: the join has
    // already succeeded and a retry would be refused as already held.
    let vault_id = crate::vault_id::VaultId::parse(&accepted.vault_id)
        .map_err(|_| SyncDeviceError::BadRequest)?;
    if run_member_post_unlock(&host, state.inner(), hooks.inner(), &io, vault_id)
        .await
        .is_err()
    {
        tracing::warn!(
            stage = "join_post_unlock",
            "the post-join label pipeline did not complete; the vault name resolves on the next unlock or sync"
        );
    }
    Ok(accepted)
}

/// **Re-unlock a member vault from the recovery phrase** (myne-md/myne#711
/// task 25). A member has no vault password, so the boot probe routes a member
/// vault to this instead of the password Unlock: it opens the device-local
/// sealed member-key store with the phrase, re-derives the person identity, and
/// installs the member slot.
#[cfg(not(target_arch = "wasm32"))] // member surface: refused on web (myne-md/myne#911 task 13)
pub async fn unlock_member_vault_from_host(
    host: &dyn HostCtx,
    io: &dyn VaultIo,
    state: &VaultRuntimeState,
    vault_id: crate::vault_id::VaultId,
    phrase: &str,
) -> Result<(), SyncDeviceError> {
    let normalized = zeroize::Zeroizing::new(protocol::normalize_user_phrase(phrase));
    let generation = state.person_session_generation().await;
    let vault_dir = crate::paths::vault_dir_for_id_from_host_io(host, io, Some(vault_id))
        .await
        .map_err(|_| SyncDeviceError::Internal)?;
    let meta_bytes = io
        .read(&vault_dir.join("vault.meta"))
        .await
        .map_err(|_| SyncDeviceError::BadRequest)?;
    let b2b = protocol::parse_b2b_tail_any(&meta_bytes).map_err(|_| SyncDeviceError::BadRequest)?;
    let stored = super::member_key_store::read_member_key_store(
        io,
        &vault_dir,
        vault_id.as_uuid().as_bytes(),
        &b2b.base.kdf_params,
        &normalized,
    )
    .await;

    let pair = crate::account::person_identity::open_person_identity_without_mutation(
        host,
        io,
        &normalized,
    )
    .await
    .map_err(|_| SyncDeviceError::BadRequest)?;

    // An owner group-key rotation may have advanced `vault.meta` past the epoch
    // this device's member-key store holds (`collab-b2b-sessions` task 1). Fetch
    // our delivered package, verify it against the PINNED owner half, unwrap the
    // new group key, and re-seal the store at the new epoch so a later unlock is
    // not refused as stale. The re-seal needs the member's phrase, which is
    // available only here; the running-session path (`member_adopt_rotation_...`)
    // updates the live slot without it.
    //
    // **The offline case this refuses, on purpose.** A store that already holds
    // the current epoch unlocks offline with no fetch at all. When the keys have to
    // be fetched there is no offline unlock to fall back on: the re-seal is an
    // Argon2id over the phrase, so the running-session adoption cannot write it and
    // the alternative to fetching is using a RETIRED epoch's keys, which is the
    // silent-loss path this branch exists to prevent. Reachability is therefore a
    // real availability requirement for that one case, stated rather than implied.
    //
    // **Two triggers, one path** (`member-devices` task 7). ABSENT is the case this
    // device has never held this vault's keys at all, which is a member's SECOND
    // device: the vault directory and `vault.meta` are already here (the join wrote
    // them), and the keys arrive over the group-package route. STALE is the rotation
    // case above. Both are the same fetch, the same verification against the PINNED
    // owner half, and the same re-seal; only the pin's usual source differs, which
    // `resolve_member_owner_pin` handles.
    let needs_package = match &stored {
        Some(k) => b2b.group_key_epoch > k.group_key_epoch,
        None => true,
    };
    let keys = match stored {
        Some(k) if !needs_package => k,
        other => {
            let owner_code =
                resolve_member_owner_pin(host, io, &vault_dir, &normalized, &b2b).await?;
            // The package MUST be obtained before the slot is installed (`collab-verification`
            // D8): installing keys that do not match the `vault.meta` in hand would seal every
            // later local write under a key the vault no longer has (silent loss to the member,
            // unreadable to the owner). So an absent package or an unreachable server REFUSES the
            // unlock rather than degrading. The typed `Transport` refusal is retryable, which is
            // the correct posture: the fix is reachability, not re-enrolment. A package that
            // arrives but does NOT verify is a different answer and stays a refusal (`Err`), so a
            // tampered package cannot loop the user through an infinite retry.
            let opened = fetch_and_open_rotation_package(
                host,
                io,
                &b2b,
                b2b.group_key_epoch,
                &owner_code,
                &pair,
            )
            .await?;
            let Some((group_key, items_key)) = opened else {
                tracing::warn!(
                    stage = "member_unlock_package_pending",
                    "refusing to unlock: the group package for this epoch is not reachable"
                );
                return Err(SyncDeviceError::Transport);
            };
            // The id that belongs to the `vault.meta` just verified. A store that was
            // present at a retired epoch contributes its own id only when the vault
            // has no id of its own to give, which it always does.
            let items_key_id = other
                .as_ref()
                .map(|k| k.items_key_id)
                .unwrap_or(b2b.base.items_key_id);
            // Re-key this device's LOCAL content from the retired itemsKey to the
            // new one BEFORE the new keys are installed or the phrase store is
            // re-sealed (myne-md/myne#797). An unsynced local note is wrapped
            // under the retired key and has no server copy, so skipping this
            // makes it unreadable the moment the slot moves: and the store's
            // epoch advancing past the blobs would remove the trigger that would
            // otherwise notice. The content-epoch marker makes the step
            // idempotent across a crash.
            if let Some(old) = other.as_ref() {
                // A read failure is a refusal, not a guess: answering the
                // retired epoch re-runs a re-key that already landed.
                let content_epoch = crate::plugins::sync::state::read_content_epoch(io, &vault_dir)
                    .await
                    .map_err(|_| SyncDeviceError::Internal)?
                    .unwrap_or(old.group_key_epoch);
                if content_epoch < b2b.group_key_epoch {
                    crate::plugins::sync::member_removal::rekey_local_content_for_member(
                        io,
                        &vault_dir,
                        &items_key_id,
                        &old.items_key,
                        &items_key,
                        &meta_bytes,
                        b2b.group_key_epoch,
                    )
                    .await
                    .map_err(|_| SyncDeviceError::Internal)?;
                }
            }
            super::member_key_store::write_member_key_store(
                io,
                &vault_dir,
                vault_id.as_uuid().as_bytes(),
                &b2b.base.account_number_hash,
                b2b.group_key_epoch,
                &items_key_id,
                &b2b.base.kdf_params,
                &normalized,
                &group_key,
                &items_key,
            )
            .await
            .map_err(|_| SyncDeviceError::Internal)?;
            super::member_key_store::MemberKeys {
                group_key,
                items_key,
                group_key_epoch: b2b.group_key_epoch,
                items_key_id,
                account_hash: b2b.base.account_number_hash,
            }
        }
    };

    use sha2::Digest as _;
    let meta_hash: [u8; 32] = sha2::Sha256::digest(&meta_bytes).into();
    let person_id = protocol::person_id_hash(normalized.as_str());
    let profile_id = protocol::person_profile_id(&person_id, &b2b.base.account_number_hash);
    let profile = protocol::derive_person_vault_profile_key(
        normalized.as_str(),
        &profile_id,
        &b2b.base.kdf_params,
    )
    .ok()
    .map(|key| (profile_id, key));
    let transition = crate::account::person_identity::read_pending_person_key_transition(host, io)
        .await
        .map_err(|_| SyncDeviceError::Transport)?;
    let install = crate::plugins::vault_unlock::state::PersonSessionInstall {
        pair,
        person_id,
        profile,
        transition,
    };
    state
        .set_unlocked_locking_others_with_person_session(
            generation,
            vault_id,
            crate::plugins::vault_unlock::state::UnlockedVault::member(
                keys.group_key,
                keys.items_key,
                keys.items_key_id,
                host.now_unix_secs(),
                meta_hash,
            ),
            Some(install),
        )
        .await
        .ok_or(SyncDeviceError::Transport)?;
    // Deliberately does NOT call `mark_full_unlock_done()`. That flag is a
    // PROCESS-GLOBAL gate the owner quick-unlock path reads
    // (`quick_unlock::requires_full_unlock_first`), and its contract is "an owner
    // vault's master password was entered this process" (MYND-641/A6). A member
    // credential must not open it: a member unlock would otherwise let a PIN
    // quick-unlock on a DIFFERENT owner vault in the same process skip that
    // vault's master password after a restart. The member fast path, when it
    // lands, needs its own per-vault gate rather than this one.
    Ok(())
}

#[cfg(all(feature = "tauri-ipc", not(target_arch = "wasm32")))]
#[tauri::command]
pub async fn sync_person_unlock_member_vault<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    state: tauri::State<'_, VaultRuntimeState>,
    hooks: tauri::State<'_, crate::hooks::Hooks>,
    vault_id_hex: String,
    phrase: String,
) -> Result<(), SyncDeviceError> {
    let phrase = zeroize::Zeroizing::new(phrase);
    let vault_id =
        crate::vault_id::VaultId::parse(&vault_id_hex).map_err(|_| SyncDeviceError::BadRequest)?;
    let host = crate::host::tauri_host::TauriHost::new(app.clone());
    let io = crate::vault_io::StdVaultIo;
    unlock_member_vault_from_host(&host, &io, state.inner(), vault_id, &phrase).await?;
    if state.inner().active_vault_id().await != Some(vault_id) {
        return Err(SyncDeviceError::Transport);
    }
    crate::plugins::vault_unlock::commands::run_post_unlock_pipeline(
        &host,
        state.inner(),
        hooks.inner(),
        &io,
        crate::vault_label::key::platform_keychain(),
    )
    .await;
    Ok(())
}

/// The material every member-credential WRITE seals: the active member vault's
/// keys, its identity, and the vault.meta fields the credential needs.
struct MemberSealMaterial {
    vault_id: crate::vault_id::VaultId,
    vault_dir: std::path::PathBuf,
    account_hash: [u8; 16],
    kdf_params: protocol::KdfParams,
    group_key_epoch: u64,
    items_key_id: [u8; 16],
    person_id: [u8; 16],
    group_key: Zeroizing<[u8; 32]>,
    items_key: Zeroizing<[u8; 32]>,
    pair: protocol::PersonKeyPair,
}

/// Gather the material a member-credential write seals. Requires an unlocked
/// member slot (the peek rejects an owner vault, whose `root_key` is `Some`) and
/// a held person session.
async fn member_seal_material(
    host: &dyn HostCtx,
    io: &dyn VaultIo,
    state: &VaultRuntimeState,
) -> Result<MemberSealMaterial, SyncDeviceError> {
    let active = state
        .active_vault_id()
        .await
        .ok_or(SyncDeviceError::NotEnrolled)?;
    let (group_key, items_key, items_key_id) = state
        .peek_unlocked_member_keys_clone()
        .await
        .ok_or(SyncDeviceError::BadRequest)?;
    let pair = state
        .clone_person_identity()
        .await
        .ok_or(SyncDeviceError::BadRequest)?;
    let person_id = state
        .clone_person_id()
        .await
        .ok_or(SyncDeviceError::BadRequest)?;
    let vault_dir = crate::paths::vault_dir_for_id_from_host_io(host, io, Some(active))
        .await
        .map_err(|_| SyncDeviceError::Internal)?;
    let meta_bytes = io
        .read(&vault_dir.join("vault.meta"))
        .await
        .map_err(|_| SyncDeviceError::BadRequest)?;
    let b2b = protocol::parse_b2b_tail_any(&meta_bytes).map_err(|_| SyncDeviceError::BadRequest)?;
    Ok(MemberSealMaterial {
        vault_id: active,
        vault_dir,
        account_hash: b2b.base.account_number_hash,
        kdf_params: b2b.base.kdf_params,
        group_key_epoch: b2b.group_key_epoch,
        items_key_id,
        person_id,
        group_key,
        items_key,
        pair,
    })
}

/// The secret a member-unlock credential is (re)sealed under. Carried into
/// [`install_member_unlock_credential`] so a stale-epoch credential can be
/// re-sealed under the SAME secret without the caller re-deriving it
/// (myne-md/myne#797).
enum MemberUnlockSecret<'a> {
    Password(&'a str),
    Provider {
        method: &'a str,
        salt: &'a [u8; 16],
        wrap_key: &'a [u8; 32],
    },
}

/// Install the member slot + person session from an opened credential
/// (myne-md/myne#797).
///
/// A stale `group_key_epoch`: the credential is a generation behind after an
/// owner group-key rotation: is repaired rather than refused: the member
/// re-fetches its delivered package at the current epoch, verifies it against the
/// PINNED owner half, re-keys the local content, and re-seals this store under
/// the SAME password / PIN / biometric wrap key, then installs. Before this the
/// only recovery was the 24-word phrase, so a member who had set a fast
/// credential was locked out of it by any rotation.
///
/// A WRONG secret stays a wrong-secret failure: the store is opened (AEAD) by the
/// caller BEFORE this function runs, so reaching the stale branch proves the
/// secret was right. A package that has not landed yet is a retryable
/// [`SyncDeviceError::Transport`], never a silent install of retired keys.
///
/// Deliberately does NOT open the process-global owner quick-unlock gate: a
/// member credential must not let a PIN quick-unlock on another owner vault skip
/// its password after a restart (MYND-641/A6).
#[allow(clippy::too_many_arguments)]
#[cfg(not(target_arch = "wasm32"))]
async fn install_member_unlock_credential(
    host: &dyn HostCtx,
    io: &dyn VaultIo,
    state: &VaultRuntimeState,
    vault_id: crate::vault_id::VaultId,
    mut cred: super::member_unlock_store::MemberUnlockCredential,
    meta_bytes: &[u8],
    current_epoch: u64,
    vault_root: &std::path::Path,
    b2b: &protocol::B2bVaultMeta,
    secret: MemberUnlockSecret<'_>,
) -> Result<(), SyncDeviceError> {
    if cred.group_key_epoch != current_epoch {
        // The vault rotated past this credential. Re-fetch and verify the
        // member's own package at the CURRENT epoch; the owner half is PINNED.
        let sync_state = super::state::read_sync_state(io, vault_root)
            .await
            .map_err(|_| SyncDeviceError::Internal)?;
        let owner_code = sync_state
            .owner_identity_code
            .clone()
            .filter(|s| !s.is_empty())
            .ok_or(SyncDeviceError::NotEnrolled)?;
        let Some((new_group_key, new_items_key)) =
            fetch_and_open_rotation_package(host, io, b2b, current_epoch, &owner_code, &cred.pair)
                .await?
        else {
            // Not delivered yet: the credential stays stale and the caller may
            // fall back to the phrase. Retryable, not a refusal.
            return Err(SyncDeviceError::Transport);
        };
        // Re-key local content BEFORE the store is re-sealed, so a crash leaves
        // the old credential still describing the old key (and the marker
        // records whichever step actually landed).
        let content_epoch = crate::plugins::sync::state::read_content_epoch(io, vault_root)
            .await
            .map_err(|_| SyncDeviceError::Internal)?
            .unwrap_or(cred.group_key_epoch);
        if content_epoch < current_epoch {
            crate::plugins::sync::member_removal::rekey_local_content_for_member(
                io,
                vault_root,
                &cred.items_key_id,
                &cred.items_key,
                &new_items_key,
                meta_bytes,
                current_epoch,
            )
            .await
            .map_err(|_| SyncDeviceError::Internal)?;
        }
        let vault_id_bytes = vault_id.as_uuid().as_bytes();
        let sealed = match secret {
            MemberUnlockSecret::Password(password) => {
                super::member_unlock_store::write_member_unlock_password(
                    io,
                    vault_root,
                    vault_id_bytes,
                    &cred.account_hash,
                    current_epoch,
                    &cred.items_key_id,
                    &cred.person_id,
                    &b2b.base.kdf_params,
                    password,
                    &new_group_key,
                    &new_items_key,
                    &cred.pair,
                )
                .await
            }
            MemberUnlockSecret::Provider {
                method,
                salt,
                wrap_key,
            } => {
                super::member_unlock_store::write_member_unlock_provider(
                    io,
                    vault_root,
                    vault_id_bytes,
                    &cred.account_hash,
                    method,
                    salt,
                    wrap_key,
                    current_epoch,
                    &cred.items_key_id,
                    &cred.person_id,
                    &new_group_key,
                    &new_items_key,
                    &cred.pair,
                )
                .await
            }
        };
        sealed.map_err(|_| SyncDeviceError::Internal)?;
        cred.group_key = new_group_key;
        cred.items_key = new_items_key;
        cred.group_key_epoch = current_epoch;
    }
    use sha2::Digest as _;
    let generation = state.person_session_generation().await;
    let meta_hash: [u8; 32] = sha2::Sha256::digest(meta_bytes).into();
    let transition = crate::account::person_identity::read_pending_person_key_transition(host, io)
        .await
        .map_err(|_| SyncDeviceError::Transport)?;
    let install = crate::plugins::vault_unlock::state::PersonSessionInstall {
        pair: cred.pair,
        person_id: cred.person_id,
        profile: None,
        transition,
    };
    state
        .set_unlocked_locking_others_with_person_session(
            generation,
            vault_id,
            crate::plugins::vault_unlock::state::UnlockedVault::member(
                cred.group_key,
                cred.items_key,
                cred.items_key_id,
                host.now_unix_secs(),
                meta_hash,
            ),
            Some(install),
        )
        .await
        .ok_or(SyncDeviceError::Transport)?;
    Ok(())
}

/// Device-local failed-attempt counter for the member PIN path.
const MEMBER_ATTEMPT_FILE: &str = "vault.member-unlock.attempts";

async fn read_member_attempts(
    io: &dyn VaultIo,
    path: &std::path::Path,
) -> crate::plugins::quick_unlock::attempt::AttemptState {
    use crate::plugins::quick_unlock::attempt::{AttemptState, MAX_QUICK_UNLOCK_ATTEMPTS};
    match io.read(path).await {
        Ok(b) => crate::plugins::quick_unlock::attempt::parse_attempt_count(&b)
            .unwrap_or_else(|| AttemptState::from_count(MAX_QUICK_UNLOCK_ATTEMPTS)),
        // Absent → fresh. Any other read error (present but unreadable) is
        // fail-safe clamped to the cap, matching the owner counter's posture.
        Err(crate::io_failure_kind::IoFailureKind::NotFound) => AttemptState::fresh(),
        Err(_) => AttemptState::from_count(MAX_QUICK_UNLOCK_ATTEMPTS),
    }
}

async fn write_member_attempts(
    io: &dyn VaultIo,
    path: &std::path::Path,
    state: &crate::plugins::quick_unlock::attempt::AttemptState,
) {
    let _ = io
        .write(
            path,
            &crate::plugins::quick_unlock::attempt::encode_attempt_count(state),
            crate::vault_io::WriteOpts::default(),
        )
        .await;
}

/// Remove the member-unlock store and its attempt counter (cap reached), and
/// destroy the OS-keychain item the member's biometric credential uses.
///
/// **The file is not the whole credential** (myne-md/myne#761). The member's
/// biometric fast unlock reuses the owner's provider, so its wrap key lives in
/// the same Keychain item as the owner's quick-unlock key: service
/// `md.myne.quickunlock`, account `hex(account_number_hash):vault_id`. Removing
/// the store file leaves that item with no consumer, exactly as disabling the
/// owner's quick unlock would, and the owner path already destroys it there
/// (`quick_unlock::commands::cleanup_os_credential`). This is the member half of
/// the same rule (`design-notes/security/0709`).
async fn wipe_member_unlock(
    io: &dyn VaultIo,
    vault_dir: &std::path::Path,
    keychain: &dyn crate::plugins::quick_unlock::device_secret::DeviceSecretKeychain,
) {
    let _ = io
        .remove_file(&vault_dir.join(super::member_unlock_store::MEMBER_UNLOCK_STORE_FILE))
        .await;
    let _ = io.remove_file(&vault_dir.join(MEMBER_ATTEMPT_FILE)).await;
    let _ = erase_member_device_secret_with(io, vault_dir, keychain).await;
}

/// [`erase_member_device_secret_with`] over the platform keychain, bounded and
/// logged the way `vault_delete`'s teardown is: `Unavailable` is the honest
/// no-op on a platform that never created the item, `Backend` is a secret that
/// outlived its consumer and must not be silent.
async fn erase_member_device_secret(io: &dyn VaultIo, vault_dir: &std::path::Path) {
    use crate::plugins::quick_unlock::device_secret::{self, SecretDeleteFailure};
    match erase_member_device_secret_with(io, vault_dir, device_secret::quick_unlock_keychain())
        .await
    {
        Ok(()) => {}
        Err(SecretDeleteFailure::Unavailable) => {}
        Err(failure) => tracing::warn!(
            stage = "member_device_secret",
            failure = ?failure,
            "per-vault device-local secret outlived the credential it belonged to"
        ),
    }
}

/// Best-effort destroy of the shared per-vault Keychain item for `vault_dir`.
///
/// Same shape as `vault_delete`'s teardown: the address is derived from
/// `vault.meta`, read while the vault is still on disk, and an unreadable or
/// unparseable meta means the item cannot be addressed (which `vault_delete`
/// logs and this path does not, because this is not an erase and the vault
/// survives). A platform with no Keychain answers `Unavailable`, the honest
/// no-op rather than a claimed erase. The keychain is a parameter rather than
/// `platform_keychain()` read in here so the wiring is testable on a machine
/// with no Keychain at all.
async fn erase_member_device_secret_with(
    io: &dyn VaultIo,
    vault_dir: &std::path::Path,
    keychain: &dyn crate::plugins::quick_unlock::device_secret::DeviceSecretKeychain,
) -> Result<(), crate::plugins::quick_unlock::device_secret::SecretDeleteFailure> {
    use crate::plugins::quick_unlock::device_secret;
    let Ok(bytes) = io.read(&vault_dir.join("vault.meta")).await else {
        return Ok(());
    };
    let Ok(meta) = protocol::parse_vault_meta_any(&bytes) else {
        return Ok(());
    };
    let id = crate::paths::vault_id_from_root(vault_dir);
    device_secret::erase_for_vault(&meta.account_number_hash, id, keychain)
}

/// **Set (or replace) the device-local member vault password.** Requires the
/// active vault to be an unlocked member vault whose person session is held: the
/// store seals exactly the material the phrase path installs (`group_key`,
/// `items_key`, and the person keypair), so it can only be written while that
/// material is available. The recovery phrase stays the portable fallback.
#[cfg(not(target_arch = "wasm32"))] // member surface: refused on web (myne-md/myne#911 task 13)
pub async fn set_member_password_from_host(
    host: &dyn HostCtx,
    io: &dyn VaultIo,
    state: &VaultRuntimeState,
    password: &str,
) -> Result<(), SyncDeviceError> {
    protocol::validate_min_length(password).map_err(|_| SyncDeviceError::BadRequest)?;
    let m = member_seal_material(host, io, state).await?;
    super::member_unlock_store::write_member_unlock_password(
        io,
        &m.vault_dir,
        m.vault_id.as_uuid().as_bytes(),
        &m.account_hash,
        m.group_key_epoch,
        &m.items_key_id,
        &m.person_id,
        &m.kdf_params,
        password,
        &m.group_key,
        &m.items_key,
        &m.pair,
    )
    .await
    .map_err(|_| SyncDeviceError::Internal)?;
    // Same rule as the PIN setter: a password credential consumes no Keychain
    // item, so a biometric one left behind has no owner (myne-md/myne#761).
    erase_member_device_secret(io, &m.vault_dir).await;
    Ok(())
}

#[cfg(all(feature = "tauri-ipc", not(target_arch = "wasm32")))]
#[tauri::command]
pub async fn sync_person_set_member_password<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    state: tauri::State<'_, VaultRuntimeState>,
    password: String,
) -> Result<(), SyncDeviceError> {
    let password = zeroize::Zeroizing::new(password);
    let host = crate::host::tauri_host::TauriHost::new(app.clone());
    set_member_password_from_host(
        &host,
        &crate::vault_io::StdVaultIo,
        state.inner(),
        &password,
    )
    .await
}

/// **Re-unlock a member vault from its device-local password.** The fast path
/// that replaces re-typing the recovery phrase every session: it opens the
/// device-local member-unlock store, installs the member slot AND the person
/// session (the store bundles the keypair), so sync runs without the phrase.
#[cfg(not(target_arch = "wasm32"))] // member surface: refused on web (myne-md/myne#911 task 13)
pub async fn unlock_member_vault_with_password_from_host(
    host: &dyn HostCtx,
    io: &dyn VaultIo,
    state: &VaultRuntimeState,
    vault_id: crate::vault_id::VaultId,
    password: &str,
) -> Result<(), SyncDeviceError> {
    let vault_dir = crate::paths::vault_dir_for_id_from_host_io(host, io, Some(vault_id))
        .await
        .map_err(|_| SyncDeviceError::Internal)?;
    let meta_bytes = io
        .read(&vault_dir.join("vault.meta"))
        .await
        .map_err(|_| SyncDeviceError::BadRequest)?;
    let b2b = protocol::parse_b2b_tail_any(&meta_bytes).map_err(|_| SyncDeviceError::BadRequest)?;
    let cred = super::member_unlock_store::read_member_unlock_password(
        io,
        &vault_dir,
        vault_id.as_uuid().as_bytes(),
        &b2b.base.kdf_params,
        password,
    )
    .await
    .ok_or(SyncDeviceError::BadRequest)?;
    install_member_unlock_credential(
        host,
        io,
        state,
        vault_id,
        cred,
        &meta_bytes,
        b2b.group_key_epoch,
        &vault_dir,
        &b2b,
        MemberUnlockSecret::Password(password),
    )
    .await
}

#[cfg(all(feature = "tauri-ipc", not(target_arch = "wasm32")))]
#[tauri::command]
pub async fn sync_person_unlock_member_vault_with_password<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    state: tauri::State<'_, VaultRuntimeState>,
    hooks: tauri::State<'_, crate::hooks::Hooks>,
    vault_id_hex: String,
    password: String,
) -> Result<(), SyncDeviceError> {
    let password = zeroize::Zeroizing::new(password);
    let vault_id =
        crate::vault_id::VaultId::parse(&vault_id_hex).map_err(|_| SyncDeviceError::BadRequest)?;
    let host = crate::host::tauri_host::TauriHost::new(app.clone());
    let io = crate::vault_io::StdVaultIo;
    unlock_member_vault_with_password_from_host(&host, &io, state.inner(), vault_id, &password)
        .await?;
    if state.inner().active_vault_id().await != Some(vault_id) {
        return Err(SyncDeviceError::Transport);
    }
    crate::plugins::vault_unlock::commands::run_post_unlock_pipeline(
        &host,
        state.inner(),
        hooks.inner(),
        &io,
        crate::vault_label::key::platform_keychain(),
    )
    .await;
    Ok(())
}

/// **Set (or replace) the device-local member vault PIN.** Reuses the owner
/// quick-unlock PIN provider (`PinProvider`): it derives a wrap key from the PIN
/// via the vault's Argon2id parameters, and the same member payload is sealed
/// under it. Setting a PIN replaces a password or a biometric credential.
#[cfg(not(target_arch = "wasm32"))] // member surface: refused on web (myne-md/myne#911 task 13)
pub async fn set_member_pin_from_host(
    host: &dyn HostCtx,
    io: &dyn VaultIo,
    state: &VaultRuntimeState,
    pin: &str,
) -> Result<(), SyncDeviceError> {
    crate::plugins::quick_unlock::pin::validate_pin(pin)
        .map_err(|_| SyncDeviceError::BadRequest)?;
    let m = member_seal_material(host, io, state).await?;
    let provider = crate::plugins::quick_unlock::pin::PinProvider::new(
        Zeroizing::new(pin.to_string()),
        m.account_hash,
        m.kdf_params,
    );
    let secret = crate::task::run_blocking(move || provider.create())
        .await
        .map_err(|_| SyncDeviceError::Internal)?
        .map_err(|_| SyncDeviceError::Internal)?;
    super::member_unlock_store::write_member_unlock_provider(
        io,
        &m.vault_dir,
        m.vault_id.as_uuid().as_bytes(),
        &m.account_hash,
        super::member_unlock_store::METHOD_PIN,
        &secret.pin_salt,
        &secret.wrap_key,
        m.group_key_epoch,
        &m.items_key_id,
        &m.person_id,
        &m.group_key,
        &m.items_key,
        &m.pair,
    )
    .await
    .map_err(|_| SyncDeviceError::Internal)?;
    // A PIN credential has no Keychain item, so a biometric item left from the
    // method this replaced has lost its only consumer (myne-md/myne#761).
    erase_member_device_secret(io, &m.vault_dir).await;
    Ok(())
}

#[cfg(all(feature = "tauri-ipc", not(target_arch = "wasm32")))]
#[tauri::command]
pub async fn sync_person_set_member_pin<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    state: tauri::State<'_, VaultRuntimeState>,
    pin: String,
) -> Result<(), SyncDeviceError> {
    let pin = zeroize::Zeroizing::new(pin);
    let host = crate::host::tauri_host::TauriHost::new(app.clone());
    set_member_pin_from_host(&host, &crate::vault_io::StdVaultIo, state.inner(), &pin).await
}

/// **Set (or replace) the device-local member vault biometric credential.** Reuses
/// the owner quick-unlock Apple provider. `HardwareUnavailable` off Apple targets.
#[cfg(not(target_arch = "wasm32"))] // member surface: refused on web (myne-md/myne#911 task 13)
pub async fn set_member_biometric_from_host(
    host: &dyn HostCtx,
    io: &dyn VaultIo,
    state: &VaultRuntimeState,
) -> Result<(), SyncDeviceError> {
    #[cfg(any(target_os = "macos", target_os = "ios"))]
    {
        let m = member_seal_material(host, io, state).await?;
        let provider = crate::plugins::quick_unlock::apple::AppleBiometricProvider::new(
            m.account_hash,
            m.vault_id,
        );
        let secret = crate::task::run_blocking(move || provider.create())
            .await
            .map_err(|_| SyncDeviceError::Internal)?
            .map_err(|_| SyncDeviceError::Internal)?;
        super::member_unlock_store::write_member_unlock_provider(
            io,
            &m.vault_dir,
            m.vault_id.as_uuid().as_bytes(),
            &m.account_hash,
            super::member_unlock_store::METHOD_BIOMETRIC,
            &secret.pin_salt,
            &secret.wrap_key,
            m.group_key_epoch,
            &m.items_key_id,
            &m.person_id,
            &m.group_key,
            &m.items_key,
            &m.pair,
        )
        .await
        .map_err(|_| SyncDeviceError::Internal)
    }
    #[cfg(not(any(target_os = "macos", target_os = "ios")))]
    {
        let _ = (host, io, state);
        Err(SyncDeviceError::BadRequest)
    }
}

#[cfg(all(feature = "tauri-ipc", not(target_arch = "wasm32")))]
#[tauri::command]
pub async fn sync_person_set_member_biometric<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    state: tauri::State<'_, VaultRuntimeState>,
) -> Result<(), SyncDeviceError> {
    set_member_biometric_from_host(
        &crate::host::tauri_host::TauriHost::new(app.clone()),
        &crate::vault_io::StdVaultIo,
        state.inner(),
    )
    .await
}

/// **Re-unlock a member vault from its device-local PIN.** A wrong PIN burns an
/// attempt; the fifth wipes the credential and the user falls back to the phrase.
#[cfg(not(target_arch = "wasm32"))] // member surface: refused on web (myne-md/myne#911 task 13)
pub async fn unlock_member_vault_with_pin_from_host(
    host: &dyn HostCtx,
    io: &dyn VaultIo,
    state: &VaultRuntimeState,
    vault_id: crate::vault_id::VaultId,
    pin: &str,
) -> Result<(), SyncDeviceError> {
    let vault_dir = crate::paths::vault_dir_for_id_from_host_io(host, io, Some(vault_id))
        .await
        .map_err(|_| SyncDeviceError::Internal)?;
    let meta_bytes = io
        .read(&vault_dir.join("vault.meta"))
        .await
        .map_err(|_| SyncDeviceError::BadRequest)?;
    let b2b = protocol::parse_b2b_tail_any(&meta_bytes).map_err(|_| SyncDeviceError::BadRequest)?;
    let header = super::member_unlock_store::member_unlock_header(
        io,
        &vault_dir,
        vault_id.as_uuid().as_bytes(),
    )
    .await
    .ok_or(SyncDeviceError::BadRequest)?;
    if header.method != super::member_unlock_store::METHOD_PIN {
        return Err(SyncDeviceError::BadRequest);
    }
    let attempt_path = vault_dir.join(MEMBER_ATTEMPT_FILE);
    let mut attempts = read_member_attempts(io, &attempt_path).await;
    if attempts.must_wipe() {
        wipe_member_unlock(
            io,
            &vault_dir,
            crate::plugins::quick_unlock::device_secret::quick_unlock_keychain(),
        )
        .await;
        return Err(SyncDeviceError::BadRequest);
    }
    let provider = crate::plugins::quick_unlock::pin::PinProvider::new(
        Zeroizing::new(pin.to_string()),
        b2b.base.account_number_hash,
        b2b.base.kdf_params,
    );
    let salt = header.salt;
    let wrap = crate::task::run_blocking(move || provider.retrieve(&salt))
        .await
        .map_err(|_| SyncDeviceError::Internal)?
        .map_err(|_| SyncDeviceError::BadRequest)?;
    match super::member_unlock_store::read_member_unlock_with_wrap_key(
        io,
        &vault_dir,
        vault_id.as_uuid().as_bytes(),
        &wrap,
    )
    .await
    {
        Some(cred) => {
            install_member_unlock_credential(
                host,
                io,
                state,
                vault_id,
                cred,
                &meta_bytes,
                b2b.group_key_epoch,
                &vault_dir,
                &b2b,
                MemberUnlockSecret::Provider {
                    method: super::member_unlock_store::METHOD_PIN,
                    salt: &salt,
                    wrap_key: &wrap,
                },
            )
            .await?;
            write_member_attempts(
                io,
                &attempt_path,
                &crate::plugins::quick_unlock::attempt::AttemptState::fresh(),
            )
            .await;
            Ok(())
        }
        None => {
            match attempts.record_failure() {
                crate::plugins::quick_unlock::attempt::AttemptOutcome::Wipe => {
                    wipe_member_unlock(
                        io,
                        &vault_dir,
                        crate::plugins::quick_unlock::device_secret::quick_unlock_keychain(),
                    )
                    .await;
                }
                crate::plugins::quick_unlock::attempt::AttemptOutcome::Allowed { .. } => {
                    write_member_attempts(io, &attempt_path, &attempts).await;
                }
            }
            Err(SyncDeviceError::BadRequest)
        }
    }
}

#[cfg(all(feature = "tauri-ipc", not(target_arch = "wasm32")))]
#[tauri::command]
pub async fn sync_person_unlock_member_vault_with_pin<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    state: tauri::State<'_, VaultRuntimeState>,
    hooks: tauri::State<'_, crate::hooks::Hooks>,
    vault_id_hex: String,
    pin: String,
) -> Result<(), SyncDeviceError> {
    let pin = zeroize::Zeroizing::new(pin);
    let vault_id =
        crate::vault_id::VaultId::parse(&vault_id_hex).map_err(|_| SyncDeviceError::BadRequest)?;
    let host = crate::host::tauri_host::TauriHost::new(app.clone());
    let io = crate::vault_io::StdVaultIo;
    unlock_member_vault_with_pin_from_host(&host, &io, state.inner(), vault_id, &pin).await?;
    run_member_post_unlock(&host, state.inner(), hooks.inner(), &io, vault_id).await
}

/// **Re-unlock a member vault from its device-local biometric credential.**
/// `HardwareUnavailable` off Apple targets.
#[cfg(not(target_arch = "wasm32"))] // member surface: refused on web (myne-md/myne#911 task 13)
pub async fn unlock_member_vault_with_biometric_from_host(
    host: &dyn HostCtx,
    io: &dyn VaultIo,
    state: &VaultRuntimeState,
    vault_id: crate::vault_id::VaultId,
) -> Result<(), SyncDeviceError> {
    #[cfg(any(target_os = "macos", target_os = "ios"))]
    {
        let vault_dir = crate::paths::vault_dir_for_id_from_host_io(host, io, Some(vault_id))
            .await
            .map_err(|_| SyncDeviceError::Internal)?;
        let meta_bytes = io
            .read(&vault_dir.join("vault.meta"))
            .await
            .map_err(|_| SyncDeviceError::BadRequest)?;
        let b2b =
            protocol::parse_b2b_tail_any(&meta_bytes).map_err(|_| SyncDeviceError::BadRequest)?;
        let header = super::member_unlock_store::member_unlock_header(
            io,
            &vault_dir,
            vault_id.as_uuid().as_bytes(),
        )
        .await
        .ok_or(SyncDeviceError::BadRequest)?;
        if header.method != super::member_unlock_store::METHOD_BIOMETRIC {
            return Err(SyncDeviceError::BadRequest);
        }
        let provider = crate::plugins::quick_unlock::apple::AppleBiometricProvider::new(
            b2b.base.account_number_hash,
            vault_id,
        );
        let zero_salt = [0u8; protocol::quick_unlock_blob::QUICK_UNLOCK_PIN_SALT_LEN];
        let wrap = crate::task::run_blocking(move || provider.retrieve(&zero_salt))
            .await
            .map_err(|_| SyncDeviceError::Internal)?
            .map_err(|_| SyncDeviceError::BadRequest)?;
        let cred = super::member_unlock_store::read_member_unlock_with_wrap_key(
            io,
            &vault_dir,
            vault_id.as_uuid().as_bytes(),
            &wrap,
        )
        .await
        .ok_or(SyncDeviceError::BadRequest)?;
        install_member_unlock_credential(
            host,
            io,
            state,
            vault_id,
            cred,
            &meta_bytes,
            b2b.group_key_epoch,
            &vault_dir,
            &b2b,
            MemberUnlockSecret::Provider {
                method: super::member_unlock_store::METHOD_BIOMETRIC,
                salt: &zero_salt,
                wrap_key: &wrap,
            },
        )
        .await
    }
    #[cfg(not(any(target_os = "macos", target_os = "ios")))]
    {
        let _ = (host, io, state, vault_id);
        Err(SyncDeviceError::BadRequest)
    }
}

/// Run the shared post-unlock pipeline after a member fast unlock, confirming the
/// target vault is the active one (the vault-switch discipline every unlock path
/// observes).
async fn run_member_post_unlock(
    host: &dyn HostCtx,
    state: &VaultRuntimeState,
    hooks: &crate::hooks::Hooks,
    io: &dyn VaultIo,
    vault_id: crate::vault_id::VaultId,
) -> Result<(), SyncDeviceError> {
    if state.active_vault_id().await != Some(vault_id) {
        return Err(SyncDeviceError::Transport);
    }
    crate::plugins::vault_unlock::commands::run_post_unlock_pipeline(
        host,
        state,
        hooks,
        io,
        crate::vault_label::key::platform_keychain(),
    )
    .await;
    Ok(())
}

#[cfg(all(feature = "tauri-ipc", not(target_arch = "wasm32")))]
#[tauri::command]
pub async fn sync_person_unlock_member_vault_with_biometric<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    state: tauri::State<'_, VaultRuntimeState>,
    hooks: tauri::State<'_, crate::hooks::Hooks>,
    vault_id_hex: String,
) -> Result<(), SyncDeviceError> {
    let vault_id =
        crate::vault_id::VaultId::parse(&vault_id_hex).map_err(|_| SyncDeviceError::BadRequest)?;
    let host = crate::host::tauri_host::TauriHost::new(app.clone());
    let io = crate::vault_io::StdVaultIo;
    unlock_member_vault_with_biometric_from_host(&host, &io, state.inner(), vault_id).await?;
    run_member_post_unlock(&host, state.inner(), hooks.inner(), &io, vault_id).await
}

/// Remove the device-local member fast-unlock credential for the active vault.
#[cfg(not(target_arch = "wasm32"))] // member surface: refused on web (myne-md/myne#911 task 13)
pub async fn clear_member_unlock_from_host(
    host: &dyn HostCtx,
    io: &dyn VaultIo,
    state: &VaultRuntimeState,
) -> Result<(), SyncDeviceError> {
    let active = state
        .active_vault_id()
        .await
        .ok_or(SyncDeviceError::NotEnrolled)?;
    let vault_dir = crate::paths::vault_dir_for_id_from_host_io(host, io, Some(active))
        .await
        .map_err(|_| SyncDeviceError::Internal)?;
    wipe_member_unlock(
        io,
        &vault_dir,
        crate::plugins::quick_unlock::device_secret::quick_unlock_keychain(),
    )
    .await;
    Ok(())
}

#[cfg(all(feature = "tauri-ipc", not(target_arch = "wasm32")))]
#[tauri::command]
pub async fn sync_person_clear_member_unlock<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    state: tauri::State<'_, VaultRuntimeState>,
) -> Result<(), SyncDeviceError> {
    clear_member_unlock_from_host(
        &crate::host::tauri_host::TauriHost::new(app.clone()),
        &crate::vault_io::StdVaultIo,
        state.inner(),
    )
    .await
}

/// The configured member-unlock method (`"password"` / `"pin"` / `"biometric"`),
/// or `null`, so the Unlock surface offers the right credential instead of the
/// recovery phrase.
#[cfg(not(target_arch = "wasm32"))] // member surface: refused on web (myne-md/myne#911 task 13)
pub async fn member_unlock_method_from_host(
    host: &dyn HostCtx,
    io: &dyn VaultIo,
    vault_id: crate::vault_id::VaultId,
) -> Result<Option<String>, SyncDeviceError> {
    let vault_dir = crate::paths::vault_dir_for_id_from_host_io(host, io, Some(vault_id))
        .await
        .map_err(|_| SyncDeviceError::Internal)?;
    Ok(super::member_unlock_store::member_unlock_method(io, &vault_dir).await)
}

#[cfg(all(feature = "tauri-ipc", not(target_arch = "wasm32")))]
#[tauri::command]
pub async fn sync_member_unlock_status<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    vault_id_hex: String,
) -> Result<Option<String>, SyncDeviceError> {
    let vault_id =
        crate::vault_id::VaultId::parse(&vault_id_hex).map_err(|_| SyncDeviceError::BadRequest)?;
    member_unlock_method_from_host(
        &crate::host::tauri_host::TauriHost::new(app.clone()),
        &crate::vault_io::StdVaultIo,
        vault_id,
    )
    .await
}

/// Whether a vault is a member vault (has a device-local member-key store), so
/// the Unlock surface can ask for the phrase instead of a password.
#[cfg(not(target_arch = "wasm32"))] // member surface: refused on web (myne-md/myne#911 task 13)
pub async fn member_vault_status_from_host(
    host: &dyn HostCtx,
    io: &dyn VaultIo,
    vault_id: crate::vault_id::VaultId,
) -> Result<bool, SyncDeviceError> {
    let vault_dir = crate::paths::vault_dir_for_id_from_host_io(host, io, Some(vault_id))
        .await
        .map_err(|_| SyncDeviceError::Internal)?;
    Ok(super::member_key_store::member_key_store_exists(io, &vault_dir).await)
}

#[cfg(all(feature = "tauri-ipc", not(target_arch = "wasm32")))]
#[tauri::command]
pub async fn sync_member_vault_status<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    vault_id_hex: String,
) -> Result<bool, SyncDeviceError> {
    let vault_id =
        crate::vault_id::VaultId::parse(&vault_id_hex).map_err(|_| SyncDeviceError::BadRequest)?;
    member_vault_status_from_host(
        &crate::host::tauri_host::TauriHost::new(app.clone()),
        &crate::vault_io::StdVaultIo,
        vault_id,
    )
    .await
}

/// Revoke one member's server binding and per-vault token
/// (`DELETE /b2b/vaults/{hash}/members/{person_id}`) with the owner's per-vault
/// token. A `404` is success (already absent): revoke is idempotent.
pub fn revoke_member_request(
    transport: &dyn SyncTransport,
    owner_token_hex: &str,
    account_hash_hex: &str,
    person_id_hex: &str,
) -> Result<(), SyncDeviceError> {
    let path = format!("/b2b/vaults/{account_hash_hex}/members/{person_id_hex}");
    let resp = transport
        .request(HttpMethod::Delete, &path, &[], Some(owner_token_hex))
        .map_err(|_| SyncDeviceError::Transport)?;
    match resp.status {
        200 | 404 => Ok(()),
        401 | 403 => Err(SyncDeviceError::Unauthenticated),
        _ => Err(SyncDeviceError::Transport),
    }
}

/// Record an owner-only namespace retirement (myne-md/myne#711 task 30,
/// `decisions/protocol/0609`): the retired epoch's shared-singleton sync-ids are
/// named so a write to one is refused and its blob is reclaimed after the grace.
pub fn retire_namespace_request(
    transport: &dyn SyncTransport,
    owner_token_hex: &str,
    account_hash_hex: &str,
    retired_epoch: u64,
    replacement_epoch: u64,
    reclaim_sync_ids_hex: &[String],
) -> Result<(), SyncDeviceError> {
    let path = format!("/b2b/vaults/{account_hash_hex}/retire");
    let body = serde_json::json!({
        "retired_epoch": retired_epoch,
        "replacement_epoch": replacement_epoch,
        "namespace_kind": "group-key",
        "namespace_id_hex": account_hash_hex,
        "reclaim_sync_ids_hex": reclaim_sync_ids_hex,
    });
    let bytes = serde_json::to_vec(&body).map_err(|_| SyncDeviceError::Internal)?;
    let resp = transport
        .request(HttpMethod::Post, &path, &bytes, Some(owner_token_hex))
        .map_err(|_| SyncDeviceError::Transport)?;
    match resp.status {
        200 => Ok(()),
        401 | 403 => Err(SyncDeviceError::Unauthenticated),
        _ => Err(SyncDeviceError::Transport),
    }
}

/// The vault-scoped delivery route for one member's rotation package
/// (`collab-b2b-sessions` task 1, `docs/spec/server-protocol.md` §3.4).
fn group_package_path(account_hash_hex: &str, person_id_hex: &str) -> String {
    format!("/b2b/vaults/{account_hash_hex}/group-packages/{person_id_hex}")
}

/// Owner POST of one remaining member's rotation package at `epoch`, under the
/// owner's per-vault membership token. `frame` is the canonical signed group
/// package ([`protocol::person_invite::encode_signed_group_package`]); the
/// server stores it verbatim and parses no payload.
pub fn post_group_package_request(
    transport: &dyn SyncTransport,
    owner_token_hex: &str,
    account_hash_hex: &str,
    person_id_hex: &str,
    epoch: u64,
    frame: &[u8],
) -> Result<(), SyncDeviceError> {
    use base64::Engine as _;
    let path = group_package_path(account_hash_hex, person_id_hex);
    let body = serde_json::json!({
        "epoch": epoch,
        "package_b64": base64::engine::general_purpose::STANDARD.encode(frame),
    });
    let bytes = serde_json::to_vec(&body).map_err(|_| SyncDeviceError::Internal)?;
    let resp = transport
        .request(HttpMethod::Put, &path, &bytes, Some(owner_token_hex))
        .map_err(|_| SyncDeviceError::Transport)?;
    match resp.status {
        200 => Ok(()),
        401 | 403 => Err(SyncDeviceError::Unauthenticated),
        _ => Err(SyncDeviceError::Transport),
    }
}

/// A member's GET of its OWN rotation package, authored with the recipient's
/// person session token. `Ok(None)` when the owner has not written one yet (the
/// delivery is in flight, or the member has no package at this epoch): the
/// caller retries on the next cycle rather than failing.
pub fn fetch_group_package_request(
    transport: &dyn SyncTransport,
    person_token_hex: &str,
    account_hash_hex: &str,
    person_id_hex: &str,
) -> Result<Option<(u64, Vec<u8>)>, SyncDeviceError> {
    use base64::Engine as _;
    let path = group_package_path(account_hash_hex, person_id_hex);
    let resp = transport
        .request(HttpMethod::Get, &path, &[], Some(person_token_hex))
        .map_err(|_| SyncDeviceError::Transport)?;
    match resp.status {
        200 => {
            let v: serde_json::Value =
                serde_json::from_slice(&resp.body).map_err(|_| SyncDeviceError::BadRequest)?;
            let epoch = v
                .get("epoch")
                .and_then(|e| e.as_u64())
                .ok_or(SyncDeviceError::BadRequest)?;
            let b64 = v
                .get("package_b64")
                .and_then(|p| p.as_str())
                .ok_or(SyncDeviceError::BadRequest)?;
            let pkg = base64::engine::general_purpose::STANDARD
                .decode(b64)
                .map_err(|_| SyncDeviceError::BadRequest)?;
            Ok(Some((epoch, pkg)))
        }
        404 => Ok(None),
        401 | 403 => Err(SyncDeviceError::Unauthenticated),
        _ => Err(SyncDeviceError::Transport),
    }
}

/// The group-key epoch this vault's device-local member-key store was sealed at,
/// read WITHOUT the phrase (the epoch is cleartext routing metadata in the
/// envelope). `None` on an absent or unparseable store. Used to detect that
/// `vault.meta` has advanced past the keys this device holds, which is the
/// member-side trigger for adopting a rotation (`collab-b2b-sessions` task 1).
pub async fn member_key_store_epoch(io: &dyn VaultIo, vault_root: &std::path::Path) -> Option<u64> {
    let bytes = io
        .read(&vault_root.join(super::member_key_store::MEMBER_KEY_STORE_FILE))
        .await
        .ok()?;
    let v: serde_json::Value = serde_json::from_slice(&bytes).ok()?;
    v.get("group_key_epoch")?.as_u64()
}

/// After a group rotation, push the rotated `vault.meta` under the owner's
/// per-vault token, record the namespace retirement, deliver one package to each
/// remaining member, and revoke the removed member's binding + token
/// (myne-md/myne#711 task 14; `collab-b2b-sessions` task 1). `person_id_hex` is
/// `None` for a row migrated from the pre-B2B roster (no person account to
/// revoke).
#[allow(clippy::too_many_arguments)]
#[cfg(not(target_arch = "wasm32"))] // member surface: refused on web (myne-md/myne#911 task 13)
pub async fn push_and_revoke_removed_member_from_host(
    host: &dyn HostCtx,
    io: &dyn VaultIo,
    state: &VaultRuntimeState,
    person_id_hex: Option<&str>,
    retired_epoch: u64,
    replacement_epoch: u64,
    reclaim_sync_ids_hex: &[String],
    packages: &[super::member_removal::GroupPackageDelivery],
) -> Result<(), SyncDeviceError> {
    let owner_person_id = state
        .clone_person_id()
        .await
        .ok_or(SyncDeviceError::NotEnrolled)?;
    let owner_token = ensure_owner_member_token(
        host,
        io,
        state,
        &crate::account::person_identity::hex_lower(&owner_person_id),
    )
    .await?;
    let root = crate::paths::active_vault_root_from_base(
        &host.app_data_dir().map_err(|_| SyncDeviceError::Internal)?,
        state.active_vault_id().await,
    );
    let meta_bytes = io
        .read(&root.join("vault.meta"))
        .await
        .map_err(|_| SyncDeviceError::Internal)?;
    let sync_state = super::state::read_sync_state(io, &root)
        .await
        .map_err(|_| SyncDeviceError::Internal)?;
    let account_hash_hex = sync_state
        .account_hash_hex
        .clone()
        .filter(|s| !s.is_empty())
        .ok_or(SyncDeviceError::NotEnrolled)?;
    let url = endpoint_from_host(host, io).await?;
    let pid = person_id_hex.map(str::to_string);
    let reclaim = reclaim_sync_ids_hex.to_vec();
    // Canonicalize each remaining member's package to its opaque wire frame
    // before entering the blocking closure. A package whose frame cannot be
    // encoded is a programming error, not a transient fault; refuse the whole
    // delivery rather than silently dropping one member's re-key.
    let post_packages: Vec<(String, Vec<u8>)> = packages
        .iter()
        .map(|d| {
            protocol::person_invite::encode_signed_group_package(&d.package)
                .map(|frame| (d.person_id_hex.clone(), frame))
                .ok_or(SyncDeviceError::Internal)
        })
        .collect::<Result<_, _>>()?;

    crate::task::run_blocking(move || {
        let transport =
            super::http_transport::build_transport(&url).map_err(|_| SyncDeviceError::Transport)?;
        // The rotated meta must reach the server before the revoke, so the
        // removed device cannot pull the new epoch even once before its token
        // dies.
        super::enroll::put_vault_meta(transport.as_ref(), &owner_token, &meta_bytes)
            .map_err(|_| SyncDeviceError::Transport)?;
        // Deliver one package per remaining member, so a member that observes the
        // greater epoch can fetch, verify and re-key (`collab-b2b-sessions` task
        // 1). Posted before the revoke: the removed member is never a recipient.
        //
        // A single recipient's failure must not abandon the rest. The meta is
        // already rotated, so a member left without its package can never re-key
        // and would be stranded on the retired epoch; try EVERY recipient, keep the
        // first error, and still run the revoke below (leaving a removed member
        // able to pull would be the worse outcome).
        let mut first_post_error: Option<SyncDeviceError> = None;
        for (recipient_hex, frame) in &post_packages {
            if let Err(e) = post_group_package_request(
                transport.as_ref(),
                &owner_token,
                &account_hash_hex,
                recipient_hex,
                replacement_epoch,
                frame,
            ) {
                first_post_error.get_or_insert(e);
            }
        }
        // Retire the old epoch's namespace: a write to a retired sync-id is
        // refused and its blob is reclaimed after the grace (decision 0609).
        if retired_epoch != 0 && replacement_epoch == retired_epoch + 1 {
            retire_namespace_request(
                transport.as_ref(),
                &owner_token,
                &account_hash_hex,
                retired_epoch,
                replacement_epoch,
                &reclaim,
            )?;
        }
        if let Some(pid) = pid {
            revoke_member_request(transport.as_ref(), &owner_token, &account_hash_hex, &pid)?;
        }
        // Report a package-delivery failure AFTER the revoke, so the caller retries
        // the deliveries rather than re-running the rotation from scratch.
        if let Some(e) = first_post_error {
            return Err(e);
        }
        Ok(())
    })
    .await
    .map_err(|_| SyncDeviceError::Internal)??;
    // The delivery is finished: drop the durable outbox THE ROTATION WROTE, and
    // only if it is still that one. A second removal can commit while this
    // delivery is in flight, and deleting its record would destroy the only copy
    // of its packages (myne-md/myne#797). Best-effort: leaving it repeats an
    // idempotent retire/revoke, which is harmless.
    // The owner's rotation outbox is the MEMBER surface's, gated with it.
    #[cfg(not(target_arch = "wasm32"))]
    let still_ours = super::rotation_outbox::read_rotation_outbox(io, &root)
        .await
        .ok()
        .flatten()
        .map(|r| r.replacement_epoch == replacement_epoch)
        .unwrap_or(false);
    #[cfg(not(target_arch = "wasm32"))]
    if still_ours {
        let _ = super::rotation_outbox::clear_rotation_outbox(io, &root).await;
    }
    Ok(())
}

/// Fetch, verify and OPEN this member's delivered rotation package for
/// `expected_epoch`, returning the new `group_key` and `items_key`, or `None`
/// when the package has not landed or the server holds none (a retryable
/// condition). A tampered package or a wrong pinned owner key is `Err`.
///
/// The owner public half is PINNED (`owner_code`, the out-of-band identity code
/// recorded at accept); it is never taken from the package, so a server that
/// substitutes the owner material is refused rather than trusted.
#[allow(clippy::too_many_arguments)]
async fn fetch_and_open_rotation_package(
    host: &dyn HostCtx,
    io: &dyn VaultIo,
    b2b: &protocol::B2bVaultMeta,
    expected_epoch: u64,
    owner_code: &str,
    member: &protocol::PersonKeyPair,
) -> Result<Option<(Zeroizing<[u8; 32]>, Zeroizing<[u8; 32]>)>, SyncDeviceError> {
    let owner = super::invite::decode_person_identity_code(owner_code)
        .map_err(|_| SyncDeviceError::BadRequest)?;
    let auth = read_person_auth(
        io,
        &person_auth_path_for_read(host).map_err(|_| SyncDeviceError::Internal)?,
    )
    .await
    .map_err(|_| SyncDeviceError::Internal)?
    .filter(|a| !a.token_hex.is_empty())
    .ok_or(SyncDeviceError::NotEnrolled)?;
    let person_id =
        super::devices::hex16(&auth.person_id_hex).ok_or(SyncDeviceError::BadRequest)?;
    let account_hash_hex =
        crate::account::person_identity::hex_lower(&b2b.base.account_number_hash);
    let pid_hex = crate::account::person_identity::hex_lower(&person_id);
    let person_token = auth.token_hex.clone();
    let url = endpoint_from_host(host, io).await?;
    let fetched = crate::task::run_blocking(move || {
        let transport =
            super::http_transport::build_transport(&url).map_err(|_| SyncDeviceError::Transport)?;
        fetch_group_package_request(
            transport.as_ref(),
            &person_token,
            &account_hash_hex,
            &pid_hex,
        )
    })
    .await
    .map_err(|_| SyncDeviceError::Internal)?;
    let Some((pkg_epoch, frame)) = fetched? else {
        return Ok(None);
    };
    // A package at an epoch other than the one we expected is not ours to adopt
    // silently; the strictly-greater rule keeps a stale or replayed package from
    // regressing the keys.
    if pkg_epoch != expected_epoch {
        return Ok(None);
    }
    let package = protocol::person_invite::decode_signed_group_package(&frame)
        .ok_or(SyncDeviceError::BadRequest)?;
    let group_key = protocol::person_invite::open_group_package(
        &owner.public,
        member,
        &package,
        &b2b.base.account_number_hash,
        expected_epoch,
    )
    .map_err(|_| SyncDeviceError::BadRequest)?;
    let group = protocol::GroupKey::new(*group_key);
    let items_key =
        protocol::unlock_items_key_ntv6(b2b, &group).map_err(|_| SyncDeviceError::BadRequest)?;
    Ok(Some((group_key, items_key)))
}

/// A member's adoption of a group rotation it has observed
/// (`collab-b2b-sessions` task 1). Idempotent and cheap when there is nothing to
/// do.
///
/// **Trigger: the SERVER's `vault.meta` epoch, not the local one** (myne-md/myne#797).
/// A member device cannot verify a `vault.meta` epoch itself, so the sync meta
/// phase deliberately HOLDS a strictly-greater server epoch instead of writing
/// it (a hostile server that mints one must not make the member commit it
/// irreversibly). This function is what commits it, and only after the member's
/// OWN delivered package has been fetched and opened at exactly that epoch
/// against the PINNED owner public half. If the package is absent it writes
/// nothing and retries next cycle.
///
/// On a verified package it: (1) writes the server's `vault.meta` verbatim and
/// clears the per-blob CAS baselines so the next pull re-fetches every content
/// header the owner rewrapped; (2) re-keys this device's LOCAL content blobs
/// from the retired `itemsKey` to the new one: an unsynced local note has no
/// server copy, so installing the new keys without this makes it unreadable
/// forever (myne-md/myne#797); (3) installs the new group + items keys on the
/// live slot so the running session re-keys.
///
/// Delivery-tolerant: a member whose package has not landed yet, or a transport
/// hiccup, returns `Ok(())` and retries on the next cycle.
pub async fn member_adopt_rotation_from_host(
    host: &dyn HostCtx,
    io: &dyn VaultIo,
    state: &VaultRuntimeState,
) -> Result<(), SyncDeviceError> {
    let root = crate::paths::active_vault_root_from_base(
        &host.app_data_dir().map_err(|_| SyncDeviceError::Internal)?,
        state.active_vault_id().await,
    );
    let Ok(local_bytes) = io.read(&root.join("vault.meta")).await else {
        return Ok(());
    };
    if !protocol::has_b2b_tail(&local_bytes) {
        return Ok(());
    }
    let Ok(local_b2b) = protocol::parse_b2b_tail_any(&local_bytes) else {
        return Ok(());
    };
    let local_epoch = local_b2b.group_key_epoch;
    // What the local CONTENT is wrapped at. Absent marker → the keys this device
    // last held (the store's epoch), falling back to the local meta's own epoch
    // for a device that has never held keys (a fresh second device).
    let store_epoch = member_key_store_epoch(io, &root)
        .await
        .unwrap_or(local_epoch);
    let content_epoch = crate::plugins::sync::state::read_content_epoch(io, &root)
        .await
        .map_err(|_| SyncDeviceError::Internal)?
        .unwrap_or(store_epoch);

    // The server's epoch is the trigger. A member holds no root key, so it never
    // writes a meta epoch it has not verified through its own package.
    let Some(server_bytes) = fetch_server_vault_meta_from_host(host, io, &root).await? else {
        return Ok(());
    };
    if !protocol::has_b2b_tail(&server_bytes) {
        return Ok(());
    }
    let Ok(server_b2b) = protocol::parse_b2b_tail_any(&server_bytes) else {
        return Ok(());
    };
    let server_epoch = server_b2b.group_key_epoch;
    // A lower server epoch is a rollback; equal with the content already re-keyed
    // is nothing to do.
    if server_epoch < local_epoch {
        tracing::warn!(
            stage = "member_rotation_adopt",
            event = "ntv6_epoch_rollback_refused",
            "refusing a lower group-key epoch as a rollback"
        );
        return Ok(());
    }
    if server_epoch == local_epoch && content_epoch >= local_epoch {
        return Ok(()); // nothing to adopt
    }

    let sync_state = crate::plugins::sync::state::read_sync_state(io, &root)
        .await
        .map_err(|_| SyncDeviceError::Internal)?;
    let owner_code = sync_state
        .owner_identity_code
        .clone()
        .filter(|s| !s.is_empty())
        .ok_or(SyncDeviceError::NotEnrolled)?;
    let member = state
        .clone_person_identity()
        .await
        .ok_or(SyncDeviceError::NotEnrolled)?;
    // The live slot must still be on the member tier: the new keys are installed
    // only at the end, so a crash before that leaves the slot (and the next
    // unlock's derivation) where it was.
    if state.peek_unlocked_member_keys_clone().await.is_none() {
        return Ok(());
    }
    let target_b2b = if server_epoch > local_epoch {
        &server_b2b
    } else {
        &local_b2b
    };
    let Some((new_group_key, new_items_key)) =
        fetch_and_open_rotation_package(host, io, target_b2b, server_epoch, &owner_code, &member)
            .await?
    else {
        // Not delivered yet. Nothing is written: the member stays on the old
        // epoch, coherently, and retries next cycle.
        return Ok(());
    };

    let Some(id) = state.active_vault_id().await else {
        return Ok(());
    };

    // (1) Commit the verified meta verbatim, then move the slot. The LOCAL
    // content re-key is deliberately NOT here: it needs the key that sealed the
    // blobs, which lives in a store sealed under a credential this path does not
    // hold (the phrase or the member password). Doing it here rewrote the blobs
    // while leaving the store behind, so a second rotation before the next unlock
    // left blobs sealed under an intermediate key nothing could derive, and the
    // unlock then failed forever (myne-md/myne#797). It runs at the next unlock,
    // where the credential is in hand, and it re-seals that store in the same
    // step. The cost is stated rather than implied: until that unlock, a session
    // cannot read blobs written before the rotation, and nothing is lost.
    //
    // The per-blob CAS baselines are KEPT for the same reason they were removed
    // before: a rewrap preserves `content_nonce`, so they still describe the
    // server's copy, and clearing them makes the next cycle present every note as
    // a create at base 0.
    if server_epoch > local_epoch {
        io.write(
            &root.join("vault.meta"),
            &server_bytes,
            crate::vault_io::WriteOpts::default(),
        )
        .await
        .map_err(|_| SyncDeviceError::Internal)?;
        let mut next = sync_state;
        use sha2::Digest as _;
        let hash: [u8; 32] = sha2::Sha256::digest(&server_bytes).into();
        next.meta_baseline_hex = Some(crate::plugins::sync::to_hex(&hash));
        crate::plugins::sync::state::write_sync_state(io, &root, &next)
            .await
            .map_err(|_| SyncDeviceError::Internal)?;
        let _ = crate::plugins::sync::state::clear_vault_meta_dirty(io, &root).await;
    }

    // (3) The running session moves to the new tiers.
    state.replace_items_key(id, new_items_key).await;
    state.set_group_key(id, new_group_key).await;
    Ok(())
}

/// Read the server's current `vault.meta` with this device's token. `Ok(None)`
/// when the device is not enrolled, the server holds no meta, or the endpoint is
/// unconfigured; `Err` only for a transport failure.
async fn fetch_server_vault_meta_from_host(
    host: &dyn HostCtx,
    io: &dyn VaultIo,
    root: &std::path::Path,
) -> Result<Option<Vec<u8>>, SyncDeviceError> {
    let token = match super::token_store::default_store().read(io, root).await {
        Ok(Some(t)) if !t.is_empty() => crate::plugins::sync::to_hex(&t),
        _ => return Ok(None),
    };
    let url = match endpoint_from_host(host, io).await {
        Ok(u) => u,
        Err(_) => return Ok(None),
    };
    crate::task::run_blocking(move || {
        let transport =
            super::http_transport::build_transport(&url).map_err(|_| SyncDeviceError::Transport)?;
        let resp = transport
            .request(HttpMethod::Get, "/vault.meta", &[], Some(&token))
            .map_err(|_| SyncDeviceError::Transport)?;
        match resp.status {
            200 => Ok(Some(resp.body)),
            404 => Ok(None),
            401 | 403 => Err(SyncDeviceError::Unauthenticated),
            _ => Err(SyncDeviceError::Transport),
        }
    })
    .await
    .map_err(|_| SyncDeviceError::Internal)?
}

/// The active vault's `account_number_hash`, from its `vault.meta`.
async fn active_vault_account_hash(
    host: &dyn HostCtx,
    io: &dyn VaultIo,
    state: &VaultRuntimeState,
) -> Result<[u8; 16], SyncDeviceError> {
    let root = crate::paths::active_vault_root_from_base(
        &host.app_data_dir().map_err(|_| SyncDeviceError::Internal)?,
        state.active_vault_id().await,
    );
    let bytes = io
        .read(&root.join("vault.meta"))
        .await
        .map_err(|_| SyncDeviceError::Internal)?;
    let meta = protocol::parse_vault_meta_any(&bytes).map_err(|_| SyncDeviceError::BadRequest)?;
    Ok(meta.account_number_hash)
}

fn profile_path(account_hash: &[u8; 16], profile_id: &[u8; 16]) -> String {
    format!(
        "/b2b/vaults/{}/profiles/{}",
        crate::account::person_identity::hex_lower(account_hash),
        crate::account::person_identity::hex_lower(profile_id)
    )
}

/// Write this person's private `MYY5` profile for the active vault
/// (myne-md/myne#711 task 16): seal `plaintext` under the held person-profile
/// key and PUT it to the vault-scoped, person-authorized namespace. The profile
/// never enters the shared group manifest.
pub async fn person_profile_write_from_host(
    host: &dyn HostCtx,
    io: &dyn VaultIo,
    state: &VaultRuntimeState,
    plaintext: &[u8],
) -> Result<(), SyncDeviceError> {
    let (profile_id, profile_key) = state
        .clone_person_profile()
        .await
        .ok_or(SyncDeviceError::NotEnrolled)?;
    let account_hash = active_vault_account_hash(host, io, state).await?;
    let blob =
        protocol::encode_person_profile_blob(&profile_key, &profile_id, &account_hash, plaintext)
            .map_err(|_| SyncDeviceError::BadRequest)?;
    let auth_path = person_auth_path_for_read(host).map_err(|_| SyncDeviceError::Internal)?;
    let auth = read_person_auth(io, &auth_path)
        .await
        .map_err(|_| SyncDeviceError::Internal)?
        .filter(|a| !a.token_hex.is_empty())
        .ok_or(SyncDeviceError::NotEnrolled)?;
    let url = endpoint_from_host(host, io).await?;
    let path = profile_path(&account_hash, &profile_id);
    let token = auth.token_hex.clone();
    crate::task::run_blocking(move || {
        let transport =
            super::http_transport::build_transport(&url).map_err(|_| SyncDeviceError::Transport)?;
        let resp = transport
            .request(HttpMethod::Put, &path, &blob, Some(&token))
            .map_err(|_| SyncDeviceError::Transport)?;
        match resp.status {
            200 => Ok(()),
            401 | 403 => Err(SyncDeviceError::Unauthenticated),
            _ => Err(SyncDeviceError::Transport),
        }
    })
    .await
    .map_err(|_| SyncDeviceError::Internal)?
}

/// Read this person's private `MYY5` profile for the active vault, or `None` when
/// none has been written yet.
pub async fn person_profile_read_from_host(
    host: &dyn HostCtx,
    io: &dyn VaultIo,
    state: &VaultRuntimeState,
) -> Result<Option<zeroize::Zeroizing<Vec<u8>>>, SyncDeviceError> {
    let (profile_id, profile_key) = state
        .clone_person_profile()
        .await
        .ok_or(SyncDeviceError::NotEnrolled)?;
    let account_hash = active_vault_account_hash(host, io, state).await?;
    let auth_path = person_auth_path_for_read(host).map_err(|_| SyncDeviceError::Internal)?;
    let auth = read_person_auth(io, &auth_path)
        .await
        .map_err(|_| SyncDeviceError::Internal)?
        .filter(|a| !a.token_hex.is_empty())
        .ok_or(SyncDeviceError::NotEnrolled)?;
    let url = endpoint_from_host(host, io).await?;
    let token = auth.token_hex.clone();
    let blob = crate::task::run_blocking(move || -> Result<Option<Vec<u8>>, SyncDeviceError> {
        let transport =
            super::http_transport::build_transport(&url).map_err(|_| SyncDeviceError::Transport)?;
        person_profile_read_request(transport.as_ref(), &token, &account_hash, &profile_id)
    })
    .await
    .map_err(|_| SyncDeviceError::Internal)??;
    match blob {
        Some(bytes) => {
            protocol::decode_person_profile_blob(&profile_key, &profile_id, &account_hash, &bytes)
                .map(Some)
                .map_err(|_| SyncDeviceError::BadRequest)
        }
        None => Ok(None),
    }
}

/// GET this person's `MYY5` profile bytes for `(account_hash, profile_id)` from
/// the vault-scoped, person-authorized profile route, over an injected transport
/// so the route and its refusals are testable without a host. `Ok(None)` is a
/// 404, i.e. no profile has been written yet.
pub fn person_profile_read_request(
    transport: &dyn SyncTransport,
    person_token_hex: &str,
    account_hash: &[u8; 16],
    profile_id: &[u8; 16],
) -> Result<Option<Vec<u8>>, SyncDeviceError> {
    let path = profile_path(account_hash, profile_id);
    let resp = transport
        .request(HttpMethod::Get, &path, &[], Some(person_token_hex))
        .map_err(|_| SyncDeviceError::Transport)?;
    match resp.status {
        200 => Ok(Some(resp.body)),
        404 => Ok(None),
        401 | 403 => Err(SyncDeviceError::Unauthenticated),
        _ => Err(SyncDeviceError::Transport),
    }
}

/// **Read the PINNED owner identity code** out of this person's own sealed
/// `MYY5` profile for a shared vault (`member-devices` task 7).
///
/// This is the SECOND device's only trustworthy source for the owner public
/// half. The first device recorded the owner code from the out-of-band invite
/// and pushed it into this profile, sealed under a key derived from the person's
/// own recovery phrase; a second device derives the same key from the same
/// phrase, so the pin arrives over the network but is authenticated by the
/// phrase rather than by the server. Nothing else on this device carries it: the
/// device-local `SyncState` copy exists only on the device that accepted, which
/// is exactly the gap this reads across.
///
/// A phrase that is not this device's person is refused before the profile key is
/// even derived, so a wrong phrase cannot be used to probe a profile. A profile
/// that is absent, unopenable, unparseable, or that carries no pin is a typed
/// refusal ([`SyncDeviceError::BadRequest`]) rather than a proceed: without a pin
/// there is no owner half to verify a group package against, and proceeding would
/// mean trusting whatever the server offered.
pub async fn member_owner_pin_read_from_host(
    host: &dyn HostCtx,
    io: &dyn VaultIo,
    phrase_normalized: &str,
    b2b: &protocol::B2bVaultMeta,
) -> Result<String, SyncDeviceError> {
    let person_id = protocol::person_id_hash(phrase_normalized);
    let account_hash = b2b.base.account_number_hash;
    let auth_path = person_auth_path_for_read(host).map_err(|_| SyncDeviceError::Internal)?;
    let auth = read_person_auth(io, &auth_path)
        .await
        .map_err(|_| SyncDeviceError::Internal)?
        .filter(|a| !a.token_hex.is_empty())
        .ok_or(SyncDeviceError::NotEnrolled)?;
    if auth.person_id_hex != crate::account::person_identity::hex_lower(&person_id) {
        tracing::warn!(
            stage = "member_owner_pin_phrase_mismatch",
            "refusing to join: the entered phrase is not this device's person"
        );
        return Err(SyncDeviceError::NotEnrolled);
    }
    let profile_id = protocol::person_profile_id(&person_id, &account_hash);
    let profile_key = protocol::derive_person_vault_profile_key(
        phrase_normalized,
        &profile_id,
        &b2b.base.kdf_params,
    )
    .map_err(|_| {
        tracing::warn!(
            stage = "member_owner_pin_key",
            "refusing to join: the person profile key does not derive"
        );
        SyncDeviceError::BadRequest
    })?;
    let url = endpoint_from_host(host, io).await?;
    let token = auth.token_hex.clone();
    let sealed = crate::task::run_blocking(move || {
        let transport =
            super::http_transport::build_transport(&url).map_err(|_| SyncDeviceError::Transport)?;
        person_profile_read_request(transport.as_ref(), &token, &account_hash, &profile_id)
    })
    .await
    .map_err(|_| SyncDeviceError::Internal)??;
    let Some(sealed) = sealed else {
        tracing::warn!(
            stage = "member_owner_pin_absent",
            "refusing to join: this vault has no person profile on this account"
        );
        return Err(SyncDeviceError::BadRequest);
    };
    let plaintext =
        protocol::decode_person_profile_blob(&profile_key, &profile_id, &account_hash, &sealed)
            .map_err(|_| {
                tracing::warn!(
            stage = "member_owner_pin_decode",
            "refusing to join: the person profile does not open under the phrase-derived key"
        );
                SyncDeviceError::BadRequest
            })?;
    owner_pin_from_profile_plaintext(&plaintext)
}

/// The pin out of an already-decrypted `MYY5` profile plaintext, or the typed
/// refusal (`member-devices` task 7).
///
/// Split out of [`member_owner_pin_read_from_host`] so the refusal half is
/// testable without a server: the container's shape is pure data, and the
/// question "is an absent pin a proceed or a refusal" has nothing to do with the
/// network. It is a refusal, and a typed one rather than a `Transport`, because
/// retrying cannot produce a pin: without one there is no owner half to verify
/// the group package against, and the only alternative to refusing is trusting
/// whatever the server offered.
#[allow(clippy::result_large_err)]
fn owner_pin_from_profile_plaintext(plaintext: &[u8]) -> Result<String, SyncDeviceError> {
    let state = super::person_ai_store::decode_person_ai_state(plaintext).ok_or_else(|| {
        tracing::warn!(
            stage = "member_owner_pin_plaintext",
            "refusing to join: the person profile plaintext is not a person AI state"
        );
        SyncDeviceError::BadRequest
    })?;
    state
        .owner_identity_code()
        .map(str::to_string)
        .ok_or_else(|| {
            tracing::warn!(
                stage = "member_owner_pin_absent",
                "refusing to join: the person profile carries no pinned owner identity code"
            );
            SyncDeviceError::BadRequest
        })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::plugins::sync::transport::{FakeTransport, HttpMethod};

    // A group rotation retires the old epoch's shared-singleton sync-ids; the
    // owner-only call must name them, the vault and both epochs (decision 0609).
    #[test]
    fn retire_namespace_request_posts_the_group_key_retirement() {
        let t = FakeTransport::new();
        t.on(
            HttpMethod::Post,
            "/b2b/vaults/aa/retire",
            200,
            b"{\"ok\":true}".to_vec(),
        );
        retire_namespace_request(&t, "tok", "aa", 1, 2, &["bb".to_string(), "cc".to_string()])
            .expect("retire");
        let reqs = t.requests();
        assert_eq!(reqs[0].0, HttpMethod::Post);
        assert_eq!(reqs[0].1, "/b2b/vaults/aa/retire");
        let body = String::from_utf8_lossy(&reqs[0].2);
        assert!(body.contains("\"namespace_kind\":\"group-key\""), "{body}");
        assert!(body.contains("\"namespace_id_hex\":\"aa\""), "{body}");
        assert!(body.contains("\"retired_epoch\":1"), "{body}");
        assert!(body.contains("\"replacement_epoch\":2"), "{body}");
        assert!(
            body.contains("\"reclaim_sync_ids_hex\":[\"bb\",\"cc\"]"),
            "{body}"
        );
    }

    // The recipient's refusal (myne-md/myne#911 follow-up). The status mapping is
    // the whole contract this function has, and each arm means something different
    // to the caller: `NotFound` is "this identity does not hold that invitation" (a
    // stale row in a dialog that has been open), `Conflict` is "already a member",
    // and `Unauthenticated` is the token, not the invitation.
    #[test]
    fn decline_request_maps_each_status_to_its_own_answer() {
        let cases = [
            (200u16, None),
            (401, Some("Unauthenticated")),
            (403, Some("Unauthenticated")),
            (404, Some("DeviceNotFound")),
            (409, Some("BadRequest")),
            (500, Some("Transport")),
        ];
        for (status, want) in cases {
            let t = FakeTransport::new();
            t.on(
                HttpMethod::Delete,
                "/b2b/invites/aa11",
                status,
                b"{}".to_vec(),
            );
            let got = decline_invite_request(&t, "tok", "aa11");
            match want {
                None => assert!(got.is_ok(), "status {status} should succeed"),
                Some(kind) => {
                    let err = got.expect_err("a refusal must not be Ok");
                    assert_eq!(format!("{err:?}"), kind, "status {status}");
                }
            }
            // The id travels in the PATH and the credential in the token: the
            // invitation is deleted by address, with no body for a proxy to alter.
            let reqs = t.requests();
            assert_eq!(reqs[0].0, HttpMethod::Delete);
            assert_eq!(reqs[0].1, "/b2b/invites/aa11");
            assert!(reqs[0].2.is_empty(), "DELETE carries no body");
            assert_eq!(reqs[0].3.as_deref(), Some("tok"));
        }
    }

    // The identity home is shown on `enrolled: true`, so the status probe must
    // flip exactly when a usable token lands, and must be false (not an error)
    // on a device with no person account.
    #[test]
    fn status_is_false_until_a_person_token_is_stored() {
        crate::test_support::block_on(async {
            let tmp = crate::test_support::ScopedTempDir::new("person-status").expect("temp dir");
            let host = crate::host::test_host::TestHost::new(tmp.path());
            let io = crate::vault_io::StdVaultIo;
            let state = VaultRuntimeState::default();

            let before = person_status_from_host(&host, &io, &state)
                .await
                .expect("status");

            assert!(!before.enrolled, "no credential on a fresh device");

            let path = person_auth_path(&host, &io)
                .await
                .expect("person auth path");
            write_person_auth(
                &io,
                &path,
                &PersonAuth {
                    person_id_hex: "11".repeat(16),
                    device_id_hex: "22".repeat(16),
                    registered: false,
                    token_hex: "33".repeat(32),
                    ..Default::default()
                },
            )
            .await
            .expect("write credential");

            let after = person_status_from_host(&host, &io, &state)
                .await
                .expect("status");
            assert!(after.enrolled, "a stored token means enrolled");
            assert!(
                !after.identity_unlocked,
                "a stored token alone is not a runtime unlock"
            );

            let pair = protocol::PersonKeyPair::generate_raw(&[1u8; 64], &[2u8; 32], &[3u8; 32]);
            let person_id = [0x44u8; 16];
            state
                .set_person_identity_and_id(pair.clone(), person_id)
                .await;
            let mismatched = person_status_from_host(&host, &io, &state)
                .await
                .expect("status");
            assert!(!mismatched.identity_unlocked);
            assert_eq!(mismatched.identity_code, None);

            let public = pair.public_half();
            write_person_auth(
                &io,
                &path,
                &PersonAuth {
                    person_id_hex: crate::account::person_identity::hex_lower(&person_id),
                    device_id_hex: "22".repeat(16),
                    registered: false,
                    token_hex: "33".repeat(32),
                    kem_ek_hex: crate::account::person_identity::hex_lower(public.kem_ek()),
                    ed_pk_hex: crate::account::person_identity::hex_lower(public.ed_pk()),
                    mldsa_vk_hex: crate::account::person_identity::hex_lower(public.mldsa_vk()),
                },
            )
            .await
            .expect("write matching credential");
            let unlocked = person_status_from_host(&host, &io, &state)
                .await
                .expect("status");
            assert!(unlocked.identity_unlocked);
            assert_eq!(
                unlocked.identity_code.as_deref(),
                Some(
                    crate::plugins::sync::invite::encode_person_identity_code(&person_id, &public,)
                        .as_str(),
                )
            );

            state.take_person_identity().await.expect("take identity");
            let locked = person_status_from_host(&host, &io, &state)
                .await
                .expect("status");
            assert!(!locked.identity_unlocked);
            assert_eq!(locked.identity_code, unlocked.identity_code);

            assert_eq!(after.person_id_hex.as_deref(), Some(&*"11".repeat(16)));
        });
    }

    // A token-less identity has nothing addressed to it, and the honest refusal
    // is `NotEnrolled` (2026-10-23). `NotConfigured` names a MISSING SYNC SERVER,
    // a different remedy, and the identity home rendered it as "check your
    // connection and sync server" on a state that is normal first run.
    //
    // Injection check: reverting the mapping to `NotConfigured` makes this test
    // fail by naming the variant, which is the whole point of pinning it.
    #[test]
    fn listing_invites_without_a_person_token_is_not_enrolled() {
        crate::test_support::block_on(async {
            let tmp =
                crate::test_support::ScopedTempDir::new("person-invites-unenrolled").expect("tmp");
            let host = crate::host::test_host::TestHost::new(tmp.path());
            let io = crate::vault_io::StdVaultIo;

            let refused = person_list_invites_from_host(&host, &io)
                .await
                .expect_err("an identity with no device token cannot list invites");
            assert!(
                matches!(refused, SyncDeviceError::NotEnrolled),
                "expected NotEnrolled, got {refused:?}"
            );
        });
    }

    // The registration step runs BEFORE any handshake, and it registers under
    // the PERSON id: the account hash and username in the body are the hex of
    // person_id_hash, which is what makes the server treat it as a person
    // account on the id-generic /auth namespace (server-protocol §3.1a).
    #[test]
    fn registers_the_person_id_then_enrolls() {
        let t = FakeTransport::new();
        // Register refuses (401) so the flow stops there and we can assert the
        // first request without needing a SCRAM server.
        t.on(HttpMethod::Post, "/auth/register", 401, b"{}".to_vec());

        let person_id = [0x11u8; 16];
        let err =
            register_and_enroll_person(&t, &person_id, &[0u8; 32], None, EnrollPath::Password)
                .unwrap_err();
        assert_eq!(err, EnrollError::Unauthenticated);

        let reqs = t.requests();
        assert_eq!(reqs.len(), 1, "register must run before any init: {reqs:?}");
        assert_eq!(reqs[0].1, "/auth/register");

        let body: serde_json::Value = serde_json::from_slice(&reqs[0].2).expect("register json");
        assert_eq!(body["account_hash_hex"], "11".repeat(16));
        assert_eq!(body["username"], "11".repeat(16));
    }

    // A generated phrase means a brand-new person account, so the device is its
    // first and the gate admits it either way; a supplied phrase means an existing
    // person's device arriving with their only credential, and the person plane
    // holds no device that could ever approve it, so it must declare `recovery`.
    // This was a hardcoded `Password` and every other test here passed with it.
    #[test]
    fn a_supplied_phrase_declares_the_recovery_gate() {
        assert_eq!(enroll_path_for(true), EnrollPath::Password);
        assert_eq!(enroll_path_for(false), EnrollPath::Recovery);
    }

    // And the choice is not decorative: the declared gate is what goes on the wire.
    // Driven with the request log read rather than the outcome, because the point
    // is the request the server's gate reads.
    #[test]
    fn the_setup_path_reaches_the_enrol_wire() {
        crate::test_support::block_on(async {
            let t = FakeTransport::new();
            t.on(HttpMethod::Post, "/auth/register", 200, b"{}".to_vec());
            t.on(
                HttpMethod::Post,
                "/auth/scram/init",
                200,
                b"{\"handshake_id\":\"hid\",\"combined_nonce\":\"sn\",\"salt_hex\":\"11\",\"iterations\":1}"
                    .to_vec(),
            );
            t.on(
                HttpMethod::Post,
                "/auth/scram/final",
                200,
                b"{\"approved\":false,\"token_hex\":\"\",\"server_signature_b64\":\"\"}".to_vec(),
            );

            let person_id = [0x11u8; 16];
            // The server signature cannot verify against a canned response, so the
            // call fails after the request is sent. That is the point: the request
            // is what the gate reads.
            let _ = register_and_enroll_person(
                &t,
                &person_id,
                &[0u8; 32],
                None,
                enroll_path_for(false),
            );

            let final_req = t
                .requests()
                .into_iter()
                .find(|r| r.1 == "/auth/scram/final")
                .expect("the enrol reached /auth/scram/final");
            let body: serde_json::Value = serde_json::from_slice(&final_req.2).expect("final json");
            assert_eq!(body["path"], "recovery");
        });
    }

    // The owner bind: authorized by the VAULT's device token, role `owner`, and
    // the returned per-vault token is parsed out. The path carries the vault's
    // account hash, which is how the server scopes the binding.
    #[test]
    fn bind_owner_posts_with_the_device_token_and_parses_the_issued_token() {
        let t = FakeTransport::new();
        let vault_hash = "aa".repeat(16);
        let owner = "bb".repeat(16);
        t.on(
            HttpMethod::Post,
            &format!("/b2b/vaults/{vault_hash}/members"),
            200,
            serde_json::to_vec(&serde_json::json!({ "token_hex": "cc".repeat(32) })).unwrap(),
        );

        let token = bind_owner_request(&t, "device-token-hex", &vault_hash, &owner).expect("bind");
        assert_eq!(token, "cc".repeat(32));

        let reqs = t.requests();
        assert_eq!(reqs.len(), 1);
        assert_eq!(reqs[0].1, format!("/b2b/vaults/{vault_hash}/members"));
        assert_eq!(
            reqs[0].3.as_deref(),
            Some("device-token-hex"),
            "the bind must carry the vault's DEVICE token, not a membership one"
        );
        let body: serde_json::Value = serde_json::from_slice(&reqs[0].2).expect("bind json");
        assert_eq!(body["person_id_hex"], owner);
        assert_eq!(body["role"], "owner");
    }

    // An already-owned vault (a lost device-local token) is NOT a silent
    // success: it is refused rather than reported as a fresh token.
    #[test]
    fn bind_owner_refuses_an_already_owned_vault() {
        let t = FakeTransport::new();
        t.on(
            HttpMethod::Post,
            "/b2b/vaults/aa/members",
            409,
            b"{}".to_vec(),
        );
        let err = bind_owner_request(&t, "dev", "aa", &"bb".repeat(16)).unwrap_err();
        assert_eq!(err, SyncDeviceError::Transport);
    }

    // The relay post: authorized by the OWNER's per-vault token, addressed to
    // the recipient person id, and the frame travels base64-encoded out of the
    // hex the invite command produced.
    #[test]
    fn post_invite_posts_the_frame_to_the_relay() {
        use base64::Engine as _;
        let t = FakeTransport::new();
        t.on(HttpMethod::Post, "/b2b/invites", 200, b"{}".to_vec());

        let frame = vec![0x01u8, 0x02, 0x03, 0x04];
        post_invite_request(&t, "owner-token", &"dd".repeat(16), &frame).expect("post");

        let reqs = t.requests();
        assert_eq!(reqs.len(), 1);
        assert_eq!(reqs[0].1, "/b2b/invites");
        assert_eq!(reqs[0].3.as_deref(), Some("owner-token"));
        let body: serde_json::Value = serde_json::from_slice(&reqs[0].2).expect("invite json");
        assert_eq!(body["recipient_person_id_hex"], "dd".repeat(16));
        let payload = base64::engine::general_purpose::STANDARD
            .decode(body["payload_b64"].as_str().expect("payload_b64"))
            .expect("base64");
        assert_eq!(payload, frame);
    }

    // A relay refusal is surfaced, and a 403 (the member token tried, or a
    // revoked owner) is distinguishable as unauthenticated.
    #[test]
    fn post_invite_refuses_a_non_200() {
        let t = FakeTransport::new();
        t.on(HttpMethod::Post, "/b2b/invites", 403, b"{}".to_vec());
        let err = post_invite_request(&t, "owner", &"dd".repeat(16), &[0u8]).unwrap_err();
        assert_eq!(err, SyncDeviceError::Unauthenticated);
    }

    // Claiming releases the sealed payload with the person token, and the
    // payload/token round-trip out of the response.
    #[test]
    fn claim_invite_posts_with_the_person_token_and_parses_the_release() {
        let t = FakeTransport::new();
        t.on(
            HttpMethod::Post,
            "/b2b/invites/ab/inv/claim",
            200,
            serde_json::to_vec(&serde_json::json!({
                "payload_b64": "AAEC",
                "vault_account_hash_hex": "ee".repeat(16),
                "token_hex": "ff".repeat(32),
            }))
            .unwrap(),
        );
        let claimed = claim_invite_request(&t, "person-token", "ab/inv").expect("claim");
        assert_eq!(claimed.payload_b64, "AAEC");
        assert_eq!(claimed.vault_account_hash_hex, "ee".repeat(16));
        assert_eq!(claimed.token_hex, "ff".repeat(32));
        let reqs = t.requests();
        assert_eq!(reqs[0].3.as_deref(), Some("person-token"));
    }

    #[test]
    fn claim_invite_maps_its_refusals() {
        let not_found = FakeTransport::new();
        not_found.on(
            HttpMethod::Post,
            "/b2b/invites/x/claim",
            404,
            b"{}".to_vec(),
        );
        assert_eq!(
            claim_invite_request(&not_found, "p", "x").unwrap_err(),
            SyncDeviceError::DeviceNotFound
        );
        let already = FakeTransport::new();
        already.on(
            HttpMethod::Post,
            "/b2b/invites/x/claim",
            409,
            b"{}".to_vec(),
        );
        assert_eq!(
            claim_invite_request(&already, "p", "x").unwrap_err(),
            SyncDeviceError::BadRequest
        );
    }

    // The pre-auth meta fetch is keyed on the vault's public account hash.    #[test]
    fn fetch_vault_meta_reads_the_account_namespace() {
        let t = FakeTransport::new();
        t.on(
            HttpMethod::Get,
            "/vault.meta?account=aabb",
            200,
            b"meta-bytes".to_vec(),
        );
        assert_eq!(
            fetch_vault_meta_request(&t, "aabb").expect("meta"),
            b"meta-bytes"
        );
        let reqs = t.requests();
        assert_eq!(reqs[0].1, "/vault.meta?account=aabb");
        assert_eq!(reqs[0].3, None, "the meta fetch is pre-auth");

        let missing = FakeTransport::new();
        missing.on(HttpMethod::Get, "/vault.meta?account=aa", 404, b"".to_vec());
        assert_eq!(
            fetch_vault_meta_request(&missing, "aa").unwrap_err(),
            SyncDeviceError::DeviceNotFound
        );
    }
    // Revoking a removed member's server binding uses DELETE and is idempotent.
    #[test]
    fn revoke_member_deletes_the_binding_and_is_idempotent() {
        let t = FakeTransport::new();
        t.on(
            HttpMethod::Delete,
            "/b2b/vaults/aa/members/bb",
            200,
            b"{}".to_vec(),
        );
        revoke_member_request(&t, "owner-token", "aa", "bb").expect("revoke");
        let reqs = t.requests();
        assert_eq!(reqs[0].0, HttpMethod::Delete);
        assert_eq!(reqs[0].1, "/b2b/vaults/aa/members/bb");
        assert_eq!(reqs[0].3.as_deref(), Some("owner-token"));

        // A 404 (already absent) is success: revoke is idempotent.
        let gone = FakeTransport::new();
        gone.on(
            HttpMethod::Delete,
            "/b2b/vaults/aa/members/bb",
            404,
            b"".to_vec(),
        );
        revoke_member_request(&gone, "o", "aa", "bb").expect("idempotent");
    }

    // myne-md/myne#911 REPLACED this test's premise. It used to assert that a
    // generated setup failing on `NotConfigured` erased the seal it had just
    // written, because a keypair whose phrase was never shown is unopenable.
    // That "fix" destroyed the identity instead of showing it: the phrase is the
    // account now, and nothing may delete a sealed copy of it.
    //
    // What the same scenario asserts today: a device with no endpoint reaches a
    // working, `reserved` identity and the phrase is returned for the kit.
    #[test]
    fn a_generated_setup_with_no_endpoint_creates_a_reserved_identity() {
        crate::test_support::block_on(async {
            let tmp =
                crate::test_support::ScopedTempDir::new("person-setup-offline").expect("temp dir");
            let host = crate::host::test_host::TestHost::new(tmp.path());
            let io = crate::vault_io::StdVaultIo;
            let state = VaultRuntimeState::default();
            crate::plugins::sync::config::config_path_from_host(&host, &io)
                .await
                .expect("app config dir");

            let view = person_setup_from_host(&host, &io, &state, None)
                .await
                .expect("an identity must be creatable with no sync server");
            assert!(
                view.phrase.is_some(),
                "the kit needs the phrase: it is the only recovery credential"
            );
            assert!(
                !view.approved,
                "nothing was registered, so nothing can be approved"
            );
            assert!(
                crate::account::person_identity::sealed_keypair_present(&host, &io).await,
                "the identity this call created is the user's only copy of the phrase"
            );

            // The state machine says `reserved`, not `pending`: no server has
            // been told this identity exists.
            let status = person_status_from_host(&host, &io, &state)
                .await
                .expect("status");
            assert_eq!(status.state, Some(PersonAccountState::Reserved));
            assert!(!status.enrolled);

            // And the credential carries the fact rather than a token.
            let path = person_auth_path_for_read(&host).expect("path");
            let auth = read_person_auth(&io, &path)
                .await
                .expect("read")
                .expect("a credential exists");
            assert!(!auth.registered, "reserved means never registered");
            assert!(auth.token_hex.is_empty(), "no token without a server");

            // A second create cannot open the frame it did not write, and the
            // refusal must leave the first identity alone.
            let Err(second) = person_setup_from_host(&host, &io, &state, None).await else {
                panic!("a second create must not mint a second identity");
            };
            assert_eq!(second, SyncDeviceError::AlreadyHeldIdentity);
            assert!(
                crate::account::person_identity::sealed_keypair_present(&host, &io).await,
                "a refused create must not erase the identity already here"
            );
        });
    }

    // The other half of the same rule: recovery is local now. It used to demand
    // an endpoint and then erase the seal on the way out.
    #[test]
    fn a_recovery_with_no_endpoint_keeps_the_identity_and_refuses_a_wrong_phrase() {
        crate::test_support::block_on(async {
            let tmp =
                crate::test_support::ScopedTempDir::new("person-setup-keep").expect("temp dir");
            let host = crate::host::test_host::TestHost::new(tmp.path());
            let io = crate::vault_io::StdVaultIo;
            let state = VaultRuntimeState::default();
            crate::plugins::sync::config::config_path_from_host(&host, &io)
                .await
                .expect("app config dir");

            let phrase = protocol::generate_recovery_phrase()
                .expect("csprng")
                .join_normalized();
            let generated = person_create_identity_from_host(&host, &io, &state)
                .await
                .expect("create");
            let own_phrase = generated.phrase.expect("a create returns its phrase");
            let _ = phrase;

            let recovered = person_setup_from_host(&host, &io, &state, Some(own_phrase.clone()))
                .await
                .expect("recovery needs no server");
            assert!(
                recovered.phrase.is_none(),
                "a recovery never re-shows the phrase"
            );

            // A wrong phrase is the one non-distinguishing refusal, and it must
            // not touch the frame: the device's own copy is intact.
            let Err(err) =
                person_setup_from_host(&host, &io, &state, Some("wrong".to_owned())).await
            else {
                panic!("a wrong phrase must not recover");
            };
            assert_eq!(err, SyncDeviceError::BadRequest);
            assert!(
                crate::account::person_identity::sealed_keypair_present(&host, &io).await,
                "a failed recover must NOT erase an identity this device already held: \
                 it is the user's only copy, and other vaults' wraps are sealed to its \
                 fingerprint"
            );
        });
    }

    // The leg the other two cannot see, and the reason the gate is "did THIS
    // call seal it" rather than `generated` (= `phrase.is_none()`).
    //
    // On a device that already holds an identity, pressing "Create an identity"
    // is `phrase: None`, so `generated` is TRUE — and the call still seals
    // nothing: `unlock_person_identity` takes the `Ok(bytes)` arm, refuses the
    // freshly generated phrase, and returns `BadRequest`. An erase gated on
    // `generated` therefore fires on a setup that created nothing and destroys
    // the identity the device was already holding. #766's own fix would have
    // shipped that.
    #[test]
    fn a_generated_create_on_a_device_that_already_held_an_identity_keeps_it() {
        crate::test_support::block_on(async {
            let tmp =
                crate::test_support::ScopedTempDir::new("person-setup-held").expect("temp dir");
            let host = crate::host::test_host::TestHost::new(tmp.path());
            let io = crate::vault_io::StdVaultIo;
            let state = VaultRuntimeState::default();
            crate::plugins::sync::config::config_path_from_host(&host, &io)
                .await
                .expect("app config dir");

            let phrase = protocol::generate_recovery_phrase()
                .expect("csprng")
                .join_normalized();
            let normalized = protocol::normalize_user_phrase(&phrase);
            crate::account::person_identity::unlock_person_identity(&host, &io, &normalized)
                .await
                .expect("seed a sealed keypair");

            // `None` = the "Create an identity" button, on a device that is not
            // empty. The phrase it generates is necessarily not the seeded one.
            let Err(err) = person_setup_from_host(&host, &io, &state, None).await else {
                panic!("a second create cannot open the sealed keypair it did not write");
            };
            assert_eq!(err, SyncDeviceError::AlreadyHeldIdentity);

            assert!(
                crate::account::person_identity::sealed_keypair_present(&host, &io).await,
                "a create that sealed nothing must not erase the identity already here"
            );
        });
    }

    // myne-md/myne#780: the "forget the held identity" recovery clears BOTH
    // device-local traces, so `sealed_keypair_present` is false (a create can
    // now proceed) and a stale token cannot keep `enrolled` true.
    #[test]
    fn forgetting_the_held_identity_clears_the_sealed_keypair_and_the_token() {
        crate::test_support::block_on(async {
            let tmp = crate::test_support::ScopedTempDir::new("person-forget").expect("temp dir");
            let host = crate::host::test_host::TestHost::new(tmp.path());
            let io = crate::vault_io::StdVaultIo;
            crate::plugins::sync::config::config_path_from_host(&host, &io)
                .await
                .expect("app config dir");

            let phrase = protocol::generate_recovery_phrase()
                .expect("csprng")
                .join_normalized();
            let normalized = protocol::normalize_user_phrase(&phrase);
            crate::account::person_identity::unlock_person_identity(&host, &io, &normalized)
                .await
                .expect("seed a sealed keypair");

            let auth_path = person_auth_path(&host, &io).await.expect("auth path");
            write_person_auth(
                &io,
                &auth_path,
                &PersonAuth {
                    person_id_hex: "11".repeat(16),
                    device_id_hex: "22".repeat(16),
                    registered: false,
                    token_hex: "33".repeat(32),
                    ..Default::default()
                },
            )
            .await
            .expect("write token");
            assert!(read_person_auth(&io, &auth_path)
                .await
                .expect("read")
                .is_some());

            forget_person_from_host(&host, &io).await.expect("forget");

            assert!(
                !crate::account::person_identity::sealed_keypair_present(&host, &io).await,
                "the sealed keypair is gone, so a create can proceed"
            );
            assert_eq!(
                read_person_auth(&io, &auth_path).await.expect("read"),
                None,
                "the device-scoped token goes with the identity"
            );
        });
    }

    // myne-md/myne#783: an `NTV5` (unshared) vault answers `Ok(None)` — a state,
    // not a failure — even with a HOLDING person identity and a configured
    // endpoint, which is the state the real report was in.
    //
    // Both preconditions matter and are why the fixture is shaped this way. A
    // held identity is what makes the OLD code proceed to `ensure_owner_member_token`
    // (and fail); without it the first guard returns `Ok(None)` and the test
    // passes whether or not the NTV5 gate exists — the vacuous-fixture shape.
    // A real `NTV5` `vault.meta` on disk is what the gate reads; a test that only
    // set a runtime state would never reach the magic check.
    #[test]
    fn an_unshared_vault_lists_no_invites_and_is_not_a_failure() {
        crate::test_support::block_on(async {
            let tmp = crate::test_support::ScopedTempDir::new("person-unshared").expect("temp dir");
            let host = crate::host::test_host::TestHost::new(tmp.path());
            let io = crate::vault_io::StdVaultIo;
            let state = VaultRuntimeState::default();
            crate::plugins::sync::config::config_path_from_host(&host, &io)
                .await
                .expect("app config dir");

            // A person identity is HELD in the runtime, so the call does not
            // short-circuit on "no identity": that early guard is what made an
            // earlier version of this test pass with the NTV5 gate reverted.
            let phrase = protocol::generate_recovery_phrase()
                .expect("csprng")
                .join_normalized();
            let normalized = protocol::normalize_user_phrase(&phrase);
            let (pair, _) =
                crate::account::person_identity::unlock_person_identity(&host, &io, &normalized)
                    .await
                    .expect("seed a sealed keypair");
            let person_id = protocol::person_id_hash(&normalized);
            state.set_person_identity_and_id(pair, person_id).await;

            // A real v0.2 birth-format vault: `NTV5` magic at offset 0, at the
            // root `active_vault_root_from_base` resolves. `TestHost::new` puts
            // `app_data_dir` at `<base>/data`, so the vault lives under
            // `data/vaults/<id>/`. The directory name must be a parseable
            // `VaultId`, so it is minted rather than typed.
            let vault_root = tmp
                .path()
                .join("data")
                .join("vaults")
                .join(crate::vault_id::VaultId::mint().to_string());
            std::fs::create_dir_all(&vault_root).expect("vault root");
            let session = crate::plugins::vault_creation::commands::build_session(
                crate::vault_id::VaultId::mint(),
                "CanaryPass-9-animals!",
                crate::test_support::FAST_TEST_KDF,
            )
            .expect("build_session");
            let meta =
                crate::plugins::vault_creation::commands::build_and_serialize_vault_meta(&session)
                    .expect("serialize NTV5 vault.meta");
            assert_eq!(&meta[..4], b"NTV5", "the fixture must be an NTV5 vault");
            std::fs::write(vault_root.join("vault.meta"), meta).expect("write meta");

            let out = list_vault_invites_from_host(&host, &io, &state)
                .await
                .expect("an unshared vault is not an error");
            assert!(
                out.is_none(),
                "an NTV5 vault has no roster to list: {:?}",
                out.map(|v| v.len())
            );
        });
    }

    /// **A person-born (`NTV7`) vault answers "nothing to list", not a failure.**
    ///
    /// This is the red line from the 2026-10-25 owner report ("I cannot share this
    /// vault, and it says it could not load my invitations"): the panel's invites
    /// section asked for a list on a vault whose `shared` flag is true (a born-`NTV7`
    /// vault carries epoch 1 and an owner roster from birth), the backend minted an
    /// owner token FIRST and that mint needs `account_hash_hex`, which such a vault
    /// never writes. So the reader errored `NotEnrolled` and the UI reported a relay
    /// failure over a legitimate state.
    ///
    /// The fixture is a real serialized `NTV7` frame with a populated
    /// `sync-state.json`, so the frame reaches the account-hash guard rather than
    /// short-circuiting earlier: reverting the guard above the mint makes this fail
    /// with a `NotEnrolled` error instead of `None`.
    #[test]
    fn a_person_born_vault_lists_no_invites_and_is_not_a_failure() {
        crate::test_support::block_on(async {
            let tmp =
                crate::test_support::ScopedTempDir::new("person-born-invites").expect("temp dir");
            let host = crate::host::test_host::TestHost::new(tmp.path());
            let io = crate::vault_io::StdVaultIo;
            let state = VaultRuntimeState::default();
            crate::plugins::sync::config::config_path_from_host(&host, &io)
                .await
                .expect("app config dir");

            let phrase = protocol::generate_recovery_phrase()
                .expect("csprng")
                .join_normalized();
            let normalized = protocol::normalize_user_phrase(&phrase);
            let (pair, _) =
                crate::account::person_identity::unlock_person_identity(&host, &io, &normalized)
                    .await
                    .expect("seed a sealed keypair");
            let person_id = protocol::person_id_hash(&normalized);
            state.set_person_identity_and_id(pair, person_id).await;

            let vault_root = tmp
                .path()
                .join("data")
                .join("vaults")
                .join(crate::vault_id::VaultId::mint().to_string());
            std::fs::create_dir_all(&vault_root).expect("vault root");
            let meta = crate::test_support::person_born_meta_frame(0x7c);
            assert_eq!(&meta[..4], b"NTV7", "the fixture must be an NTV7 vault");
            std::fs::write(vault_root.join("vault.meta"), &meta).expect("write meta");

            // Published under the person plane: a namespace is recorded and the
            // vault account hash is not. This is the shape that used to error.
            let sync_state = crate::plugins::sync::state::SyncState {
                namespace_hex: Some("5fbdbc0c92d5cad63eefe32c59b811e7".to_string()),
                ..Default::default()
            };
            crate::plugins::sync::state::write_sync_state(&io, &vault_root, &sync_state)
                .await
                .expect("write sync-state");

            let out = list_vault_invites_from_host(&host, &io, &state)
                .await
                .expect("a vault with no vault account is not a relay failure");
            assert!(
                out.is_none(),
                "a person-born vault has no vault-side invite list: {:?}",
                out.map(|v| v.len())
            );
        });
    }

    /// The vault selector is the account hash when there is one and the namespace
    /// when there is not, and never an empty string.
    ///
    /// This one function decides which credential binds the owner (vault device
    /// session or person session) and which path the invite list is fetched from, so
    /// the two provenances have to be asserted together rather than inferred from a
    /// caller.
    #[test]
    fn the_vault_selector_prefers_the_account_hash_and_falls_back_to_the_namespace() {
        let account = "aa".repeat(16);
        let namespace = "bb".repeat(16);

        let mut st = crate::plugins::sync::state::SyncState::default();
        assert_eq!(vault_selector_hex(&st), None, "nothing recorded yet");

        // A person-born vault: published under a namespace, never enrolled under an
        // account.
        st.namespace_hex = Some(namespace.clone());
        assert_eq!(vault_selector_hex(&st).as_deref(), Some(namespace.as_str()));

        // An enrolled vault: the account hash wins, even when a namespace is also on
        // record (a vault that migrated or was discovered).
        st.account_hash_hex = Some(account.clone());
        assert_eq!(vault_selector_hex(&st).as_deref(), Some(account.as_str()));

        // An empty string is absence, not a selector: the sync state is written by
        // several routes and one of them has written `""` before.
        st.account_hash_hex = Some(String::new());
        assert_eq!(vault_selector_hex(&st).as_deref(), Some(namespace.as_str()));
        st.namespace_hex = Some(String::new());
        assert_eq!(vault_selector_hex(&st), None);
    }

    // ---- collab-b2b-sessions task 1: the rotation-package delivery route ----

    // The owner POSTs one member's group package to the vault-scoped route with
    // its per-vault token; the body carries the epoch and the opaque frame.
    #[test]
    fn post_group_package_posts_to_the_vault_scoped_route() {
        use base64::Engine as _;
        let t = FakeTransport::new();
        let vault = "aa".repeat(16);
        let recipient = "bb".repeat(16);
        t.on(
            HttpMethod::Put,
            &format!("/b2b/vaults/{vault}/group-packages/{recipient}"),
            200,
            b"{\"ok\":true}".to_vec(),
        );
        post_group_package_request(&t, "owner-tok", &vault, &recipient, 2, b"opaque-frame")
            .expect("post package");
        let reqs = t.requests();
        assert_eq!(reqs.len(), 1);
        assert_eq!(reqs[0].0, HttpMethod::Put);
        assert_eq!(
            reqs[0].1,
            format!("/b2b/vaults/{vault}/group-packages/{recipient}")
        );
        assert_eq!(reqs[0].3.as_deref(), Some("owner-tok"));
        let body: serde_json::Value = serde_json::from_slice(&reqs[0].2).expect("json");
        assert_eq!(body["epoch"], 2);
        assert_eq!(
            base64::engine::general_purpose::STANDARD
                .decode(body["package_b64"].as_str().unwrap())
                .unwrap(),
            b"opaque-frame"
        );
    }

    // A refusal is mapped by cause rather than collapsed to Transport.
    #[test]
    fn post_group_package_maps_its_refusals() {
        let t = FakeTransport::new();
        t.on(
            HttpMethod::Put,
            "/b2b/vaults/aa/group-packages/bb",
            403,
            b"{}".to_vec(),
        );
        assert_eq!(
            post_group_package_request(&t, "owner-tok", "aa", "bb", 2, b"x").unwrap_err(),
            SyncDeviceError::Unauthenticated
        );
        let t2 = FakeTransport::new();
        t2.on(
            HttpMethod::Put,
            "/b2b/vaults/aa/group-packages/bb",
            500,
            b"{}".to_vec(),
        );
        assert_eq!(
            post_group_package_request(&t2, "owner-tok", "aa", "bb", 2, b"x").unwrap_err(),
            SyncDeviceError::Transport
        );
    }

    // The member GETs its own package with its person session token; a 404 is
    // "not delivered yet" (Ok(None)), an auth failure is a real refusal.
    #[test]
    fn fetch_group_package_reads_own_and_maps_a_miss_to_none() {
        use base64::Engine as _;
        let vault = "aa".repeat(16);
        let me = "bb".repeat(16);
        let path = format!("/b2b/vaults/{vault}/group-packages/{me}");

        let t = FakeTransport::new();
        let body = serde_json::to_vec(&serde_json::json!({
            "epoch": 3,
            "package_b64": base64::engine::general_purpose::STANDARD.encode(b"frame-bytes"),
        }))
        .unwrap();
        t.on(HttpMethod::Get, &path, 200, body);
        let got = fetch_group_package_request(&t, "person-tok", &vault, &me)
            .expect("fetch")
            .expect("present");
        assert_eq!(got.0, 3);
        assert_eq!(got.1, b"frame-bytes");
        assert_eq!(t.requests()[0].3.as_deref(), Some("person-tok"));

        let miss = FakeTransport::new();
        miss.on(HttpMethod::Get, &path, 404, b"{}".to_vec());
        assert!(
            fetch_group_package_request(&miss, "person-tok", &vault, &me)
                .expect("fetch")
                .is_none()
        );

        let denied = FakeTransport::new();
        denied.on(HttpMethod::Get, &path, 401, b"{}".to_vec());
        assert_eq!(
            fetch_group_package_request(&denied, "person-tok", &vault, &me).unwrap_err(),
            SyncDeviceError::Unauthenticated
        );
    }

    // The member-key store's epoch is read WITHOUT the phrase (it is cleartext
    // routing metadata), which is the trigger for adopting a rotation.
    #[test]
    fn member_key_store_epoch_is_readable_without_the_phrase() {
        crate::test_support::block_on(async {
            let tmp = crate::test_support::ScopedTempDir::new("member-epoch").expect("temp dir");
            let io = crate::vault_io::StdVaultIo;
            let root = tmp.path().to_path_buf();
            assert!(member_key_store_epoch(&io, &root).await.is_none());
            let env = serde_json::json!({
                "vault_id_hex": "aa".repeat(16),
                "account_hash_hex": "bb".repeat(16),
                "group_key_epoch": 7,
                "items_key_id_hex": "cc".repeat(16),
                "nonce_hex": "dd".repeat(24),
                "sealed_hex": "ee",
            });
            io.write(
                &root.join(crate::plugins::sync::member_key_store::MEMBER_KEY_STORE_FILE),
                &serde_json::to_vec(&env).unwrap(),
                crate::vault_io::WriteOpts::default(),
            )
            .await
            .expect("write store");
            assert_eq!(member_key_store_epoch(&io, &root).await, Some(7));
        });
    }

    // ── the REQUIRED accept credential (myne-md/myne#851 task 7) ─────────────
    //
    // The floor is checked BEFORE anything else, so a password below it cannot
    // claim the invite or create a vault directory.
    //
    // **The owner code here is VALID and the transport is never built, which is
    // what makes the assertion about the ORDER rather than about the refusal.**
    // An earlier version of this test passed a malformed code, so it went green
    // even with the floor check deleted: `decode_person_identity_code` answered the
    // same `BadRequest` for the same fixture, and the fixture could not reach the
    // state the check exists to prevent (`core/AGENTS.md`, "a fixture that cannot
    // hold the defective state is not a test"). With a real code in hand the next
    // thing the function does is ask the host for the auth path, and `NoopHost`
    // refuses EVERY host call: a version that checked the floor late answers
    // `Internal` here, and only an early check answers `BadRequest`.
    #[test]
    fn a_password_below_the_floor_is_refused_before_the_invite_is_claimed() {
        let io = crate::test_support::ContainerVaultIo;
        let state = VaultRuntimeState::default();
        let owner_pair =
            protocol::PersonKeyPair::generate_raw(&[0x31; 64], &[0x32; 32], &[0x33; 32]);
        let owner_code = super::super::invite::encode_person_identity_code(
            &protocol::person_id_hash("abandon abandon abandon"),
            &owner_pair.public_half(),
        );
        let below_floor = "a".repeat(protocol::MIN_PASSWORD_LEN - 1);
        assert_eq!(below_floor.chars().count(), protocol::MIN_PASSWORD_LEN - 1);
        let err = crate::test_support::block_on(accept_invite_from_host(
            &crate::host::NoopHost,
            &io,
            &state,
            "invite-1",
            &owner_code,
            "abandon abandon abandon",
            &below_floor,
        ))
        .unwrap_err();
        assert_eq!(err, SyncDeviceError::BadRequest);
    }

    // The credential the accept writes is the SAME one the unlock path reads, with
    // the accept-time keys, epoch and person id: "the password set during accept
    // opens the vault next session" holds by construction, because there is one
    // format and one writer.
    #[test]
    fn the_accept_credential_opens_with_the_accept_time_values() {
        crate::test_support::block_on(async {
            let tmp =
                crate::test_support::ScopedTempDir::new("accept-credential").expect("temp dir");
            let io = crate::vault_io::StdVaultIo;
            let root = tmp.path();
            // A fresh v7 id, the same constructor a new vault directory gets.
            let vault_id = crate::vault_id::VaultId::mint();
            let account_hash = [0x5c; 16];
            let group_key = [0x71; 32];
            let items_key = [0x72; 32];
            let items_key_id = [0x73; 16];
            let person_id = [0x74; 16];
            let pair = protocol::PersonKeyPair::generate_raw(&[0x21; 64], &[0x22; 32], &[0x23; 32]);
            let password = "correct horse battery staple";

            write_accept_fast_credential(
                &io,
                root,
                &vault_id,
                &account_hash,
                7,
                &items_key_id,
                &person_id,
                &crate::test_support::FAST_TEST_KDF,
                password,
                &group_key,
                &items_key,
                &pair,
            )
            .await
            .expect("the accept credential is written");

            let opened = super::super::member_unlock_store::read_member_unlock_password(
                &io,
                root,
                vault_id.as_uuid().as_bytes(),
                &crate::test_support::FAST_TEST_KDF,
                password,
            )
            .await
            .expect("the unlock path opens it");
            assert_eq!(*opened.group_key, group_key);
            assert_eq!(*opened.items_key, items_key);
            assert_eq!(opened.group_key_epoch, 7);
            assert_eq!(opened.items_key_id, items_key_id);
            assert_eq!(opened.person_id, person_id);
            assert_eq!(opened.pair.fingerprint(), pair.fingerprint());
            // And a wrong password still fails closed, so the credential is not a
            // skeleton key.
            assert!(
                super::super::member_unlock_store::read_member_unlock_password(
                    &io,
                    root,
                    vault_id.as_uuid().as_bytes(),
                    &crate::test_support::FAST_TEST_KDF,
                    "wrong password",
                )
                .await
                .is_none()
            );
        });
    }

    // myne-md/myne#761, the member half: removing the member fast-unlock store
    // leaves the Keychain item that wraps the same `root_key` with no consumer
    // unless it is destroyed too, exactly as disabling the owner's quick unlock
    // would. The address comes from `vault.meta`, so an unreadable or unparseable
    // meta addresses nothing and must not guess.
    #[test]
    fn wiping_the_member_store_destroys_the_shared_keychain_item() {
        crate::test_support::block_on(async {
            use crate::plugins::quick_unlock::device_secret;
            use crate::vault_id::VaultId;

            let tmp = crate::test_support::ScopedTempDir::new("member-wipe-secret").expect("tmp");
            let io = crate::vault_io::StdVaultIo;
            let id = VaultId::mint();
            // The production layout, because the address is derived from the
            // directory name: `vault_id_from_root` reads the last path segment.
            let vault_dir = tmp.path().join("vaults").join(id.to_string());
            io.create_dir_all(&vault_dir).await.expect("vault dir");
            let hash = [0x4e; 16];
            let meta = protocol::VaultMeta {
                account_number_hash: hash,
                kdf_params: crate::test_support::FAST_TEST_KDF,
                random_salt_password: [1u8; 16],
                random_salt_recovery: [2u8; 16],
                nonce_password_wrap: [3u8; 24],
                enc_root_key_password: [4u8; 64],
                nonce_recovery_wrap: [5u8; 24],
                enc_root_key_recovery: [6u8; 64],
                items_key_id: [7u8; 16],
                items_key_nonce: [8u8; 24],
                enc_items_key: [9u8; 64],
                membership: None,
                person_binding: None,
            };
            io.write(
                &vault_dir.join("vault.meta"),
                &protocol::serialize_vault_meta(&meta),
                crate::vault_io::WriteOpts::default(),
            )
            .await
            .expect("vault.meta");

            let account = device_secret::account_component(&hash, id);
            let keychain = device_secret::fake::FakeDeviceSecretKeychain::empty();
            keychain.put(&account, &[0x7e; 32]);

            wipe_member_unlock(&io, &vault_dir, &keychain).await;

            assert_eq!(
                keychain.calls(),
                vec![format!("delete {account}")],
                "the member's store file is the item's only consumer; the erase must \
                 address the same account the owner's provider uses"
            );
            assert!(keychain.read(&account).is_none(), "and the item is gone");
        });
    }

    #[test]
    fn an_unparseable_meta_addresses_no_item_rather_than_guessing_one() {
        crate::test_support::block_on(async {
            use crate::plugins::quick_unlock::device_secret;

            let tmp = crate::test_support::ScopedTempDir::new("member-wipe-nometa").expect("tmp");
            let io = crate::vault_io::StdVaultIo;
            let vault_dir = tmp.path().join("vault");
            io.create_dir_all(&vault_dir).await.expect("vault dir");
            io.write(
                &vault_dir.join("vault.meta"),
                b"meta bytes",
                crate::vault_io::WriteOpts::default(),
            )
            .await
            .expect("unparseable vault.meta");

            let keychain = device_secret::fake::FakeDeviceSecretKeychain::empty();
            wipe_member_unlock(&io, &vault_dir, &keychain).await;

            assert!(
                keychain.calls().is_empty(),
                "no address means no delete; a guessed account could take a sibling's \
                 live credential"
            );
        });
    }

    // A credential that cannot be written removes the directory the accept just
    // populated and refuses: `vault.meta` is create-only, so a half-materialized
    // vault would make every retry fail. The write is forced to fail by putting a
    // DIRECTORY where the store file goes, which no rename can replace.
    #[test]
    fn a_failed_credential_write_removes_the_half_materialized_vault() {
        crate::test_support::block_on(async {
            let tmp = crate::test_support::ScopedTempDir::new("accept-credential-fail")
                .expect("temp dir");
            let io = crate::vault_io::StdVaultIo;
            let vault_dir = tmp.path().join("vault");
            io.create_dir_all(&vault_dir).await.expect("vault dir");
            io.create_dir_all(
                &vault_dir.join(super::super::member_unlock_store::MEMBER_UNLOCK_STORE_FILE),
            )
            .await
            .expect("block the store path");
            // A fresh v7 id, the same constructor a new vault directory gets.
            let vault_id = crate::vault_id::VaultId::mint();
            let pair = protocol::PersonKeyPair::generate_raw(&[0x21; 64], &[0x22; 32], &[0x23; 32]);

            let err = write_accept_fast_credential(
                &io,
                &vault_dir,
                &vault_id,
                &[0x5c; 16],
                7,
                &[0x73; 16],
                &[0x74; 16],
                &crate::test_support::FAST_TEST_KDF,
                "correct horse battery staple",
                &[0x71; 32],
                &[0x72; 32],
                &pair,
            )
            .await
            .unwrap_err();
            assert_eq!(err, SyncDeviceError::Internal);
            assert!(
                !vault_dir.exists(),
                "the half-materialized vault directory must be gone, so the retry is fresh"
            );
        });
    }

    // member-devices task 7. The already-held refusal is its own arm because its
    // remedy is the OPPOSITE of the other `BadRequest` this command returns: here
    // the fix is to open the vault this device already has (nothing is wrong),
    // while a pin-absent `BadRequest` means "open the vault once where it lives
    // and retry". myne-md/myne#794 is the same defect class one screen over, where
    // a real failure on a member device came back indistinguishable from a wrong
    // owner code for exactly this reason.
    //
    // Pinned by injection as well as by running: the branch is reachable ONLY when
    // a local vault already names the account, so a test that skips creating one
    // would pass with the arm absent. Hence the held vault below, written before
    // the call rather than asserted about after it.
    #[test]
    fn joining_a_vault_this_device_already_holds_is_its_own_refusal() {
        crate::test_support::block_on(async {
            let tmp =
                crate::test_support::ScopedTempDir::new("join-already-held").expect("temp dir");
            let host = crate::host::test_host::TestHost::new(tmp.path());
            let io = crate::vault_io::StdVaultIo;
            let state = VaultRuntimeState::default();

            let phrase =
                "legal winner thank year wave sausage worth useful legal winner thank yellow";
            let normalized = protocol::normalize_user_phrase(phrase);
            let person_id = protocol::person_id_hash(normalized.as_str());

            // The identity check runs BEFORE the duplicate guard, so a device with
            // no person credential would stop at `NotEnrolled` and never reach the
            // arm under test. Write the credential this phrase derives.
            let auth_path = person_auth_path(&host, &io)
                .await
                .expect("person auth path");
            write_person_auth(
                &io,
                &auth_path,
                &PersonAuth {
                    person_id_hex: crate::account::person_identity::hex_lower(&person_id),
                    device_id_hex: "44".repeat(16),
                    registered: false,
                    token_hex: "55".repeat(32),
                    ..Default::default()
                },
            )
            .await
            .expect("write person credential");

            // The vault this device ALREADY holds. A discovered `vaults/<id>/` whose
            // cleartext SyncState names the same account IS the whole predicate
            // `local_vault_holds_account` reads, so this is what makes the branch
            // reachable at all.
            let base = host.app_data_dir().expect("app data dir");
            let account_hash = [0xABu8; 16];
            let account_hash_hex = crate::account::person_identity::hex_lower(&account_hash);
            let held = crate::vault_registry::mint_unique_vault_id(&base);
            let held_root = base
                .join(crate::paths::VAULTS_DIR_NAME)
                .join(held.to_string());
            io.create_dir_all(&held_root).await.expect("held vault dir");
            crate::plugins::sync::state::write_sync_state(
                &io,
                &held_root,
                &crate::plugins::sync::state::SyncState {
                    account_hash_hex: Some(account_hash_hex.clone()),
                    ..Default::default()
                },
            )
            .await
            .expect("write held sync state");

            let err = member_join_vault_from_host(
                &host,
                &io,
                &state,
                &"11".repeat(16),
                &account_hash_hex,
                phrase,
                "correct horse battery staple",
            )
            .await
            .unwrap_err();

            assert_eq!(
                err,
                SyncDeviceError::VaultAlreadyHeld,
                "a vault this device already holds gets its own arm, because the remedy \
                 (open the vault already here) is the opposite of the pin-absent refusal"
            );

            // And it refused BEFORE creating anything: the join must not leave a
            // second local copy of one remote vault behind on the way out.
            let after = crate::vault_registry::discover_vaults(&base);
            assert_eq!(
                after.len(),
                1,
                "the refusal must not materialize a second vault directory"
            );
        });
    }

    /// The OTHER half of the same guard, and the one that used to fail open: a
    /// discovered vault whose `SyncState` is present but UNREADABLE answers
    /// `Err(SyncConfigError::Parse)`, and swallowing that as "does not hold this
    /// account" made the duplicate-copy guard skippable by a corruption-class
    /// fault. The consequence is the exact thing the guard exists to prevent, so
    /// the read failure has to refuse rather than fall through.
    ///
    /// Note what makes this reachable and the absent case NOT: `read_sync_state`
    /// answers `Ok(SyncState::default())` for a file that is merely missing (the
    /// ordinary pre-enrolment vault, `account_hash_hex: None`), which correctly
    /// falls through. Only a present-and-undecodable file reaches the refusal.
    #[test]
    fn an_unreadable_sync_state_refuses_the_join_rather_than_reading_as_absence() {
        crate::test_support::block_on(async {
            let tmp =
                crate::test_support::ScopedTempDir::new("join-unreadable-state").expect("temp dir");
            let host = crate::host::test_host::TestHost::new(tmp.path());
            let io = crate::vault_io::StdVaultIo;
            let state = VaultRuntimeState::default();

            let phrase =
                "legal winner thank year wave sausage worth useful legal winner thank yellow";
            let normalized = protocol::normalize_user_phrase(phrase);
            let person_id = protocol::person_id_hash(normalized.as_str());

            let auth_path = person_auth_path(&host, &io)
                .await
                .expect("person auth path");
            write_person_auth(
                &io,
                &auth_path,
                &PersonAuth {
                    person_id_hex: crate::account::person_identity::hex_lower(&person_id),
                    device_id_hex: "44".repeat(16),
                    registered: false,
                    token_hex: "55".repeat(32),
                    ..Default::default()
                },
            )
            .await
            .expect("write person credential");

            let base = host.app_data_dir().expect("app data dir");
            let account_hash = [0xABu8; 16];
            let account_hash_hex = crate::account::person_identity::hex_lower(&account_hash);
            let held = crate::vault_registry::mint_unique_vault_id(&base);
            let held_root = base
                .join(crate::paths::VAULTS_DIR_NAME)
                .join(held.to_string());
            io.create_dir_all(&held_root).await.expect("held vault dir");
            // Present and garbage: the discovered vault's state cannot be read, so
            // the guard cannot prove this device does not already hold the account.
            io.write(
                &held_root.join(crate::plugins::sync::state::SYNC_STATE_FILE),
                b"{ this is not a SyncState",
                crate::vault_io::WriteOpts::default(),
            )
            .await
            .expect("write unreadable sync state");

            let err = member_join_vault_from_host(
                &host,
                &io,
                &state,
                &"11".repeat(16),
                &account_hash_hex,
                phrase,
                "correct horse battery staple",
            )
            .await
            .unwrap_err();

            assert_eq!(
                err,
                SyncDeviceError::Internal,
                "an unreadable discovered SyncState is a fault, not the answer \"does not \
                 hold this account\"; reading it as absence is what let the duplicate-copy \
                 guard be skipped"
            );
        });
    }

    // member-devices task 7, item 4's transport half. `Ok(None)` is a 404 and
    // means "no profile has been written yet" for this `(person, vault)`, which is
    // a DIFFERENT answer from "the server refused me" and from "the network is
    // down". The pin reader turns that first answer into a typed refusal; if the
    // three collapsed into one arm the reader could not tell them apart.
    #[test]
    fn the_profile_read_keeps_a_missing_profile_distinct_from_a_refusal() {
        let acct = [0x11u8; 16];
        let pid = [0x22u8; 16];
        let path = profile_path(&acct, &pid);

        // 200: the sealed profile body comes back verbatim.
        let t = FakeTransport::new();
        t.on(HttpMethod::Get, &path, 200, b"sealed".to_vec());
        assert_eq!(
            person_profile_read_request(&t, "tok", &acct, &pid).expect("200"),
            Some(b"sealed".to_vec())
        );

        // 404: no profile yet. `None`, NOT an error.
        let t = FakeTransport::new();
        t.on(HttpMethod::Get, &path, 404, b"{}".to_vec());
        assert_eq!(
            person_profile_read_request(&t, "tok", &acct, &pid).expect("404"),
            None
        );

        // 401/403: the person token is refused. Its own arm, because the join
        // re-derives the identity rather than re-reading the pin.
        for status in [401u16, 403] {
            let t = FakeTransport::new();
            t.on(HttpMethod::Get, &path, status, b"{}".to_vec());
            assert_eq!(
                person_profile_read_request(&t, "tok", &acct, &pid).unwrap_err(),
                SyncDeviceError::Unauthenticated,
                "status {status}"
            );
        }

        // Anything else is retryable rather than a credential verdict.
        let t = FakeTransport::new();
        t.on(HttpMethod::Get, &path, 500, b"{}".to_vec());
        assert_eq!(
            person_profile_read_request(&t, "tok", &acct, &pid).unwrap_err(),
            SyncDeviceError::Transport
        );
    }

    // member-devices task 7, item 4's refusal half, and the acceptance criterion
    // "an unverifiable owner refuses": a profile that is absent, unreadable, a
    // container this build does not know, or present-but-unpinned is a typed
    // `BadRequest`, never a proceed. A proceed with no pin would mean verifying the
    // group package against the server's word instead of the owner's.
    #[test]
    fn a_profile_without_a_pin_is_a_typed_refusal_rather_than_a_proceed() {
        // A container with no pin at all.
        let unpinned = super::super::person_ai_store::encode_person_ai_state(
            &super::super::person_ai_store::PersonAiState::empty(),
        )
        .expect("encode");
        assert_eq!(
            owner_pin_from_profile_plaintext(&unpinned).unwrap_err(),
            SyncDeviceError::BadRequest
        );

        // A container that carries one reads it back unchanged, so the refusal
        // above is about the pin's presence and not about the decode step.
        let mut pinned = super::super::person_ai_store::PersonAiState::empty();
        pinned.set_owner_identity_code(Some("MYNE-PERSON-1:aa:bb:cc:dd"));
        let encoded =
            super::super::person_ai_store::encode_person_ai_state(&pinned).expect("encode");
        assert_eq!(
            owner_pin_from_profile_plaintext(&encoded).expect("pin"),
            "MYNE-PERSON-1:aa:bb:cc:dd"
        );

        // A container this build cannot read is refused, not read as empty: a 400
        // from this reader would send the user to look for a pin that does exist.
        for bytes in [&b"not json"[..], &[][..]] {
            assert_eq!(
                owner_pin_from_profile_plaintext(bytes).unwrap_err(),
                SyncDeviceError::BadRequest
            );
        }
    }

    // member-devices task 7, the pin's SOURCE. `resolve_member_owner_pin` prefers the
    // device-local `SyncState` copy, which is the accepting device's own record and
    // is already authenticated by this device's own past, and only falls back to the
    // sealed profile when there is none. The order matters because the fallback is a
    // network read that a wrong or revoked person token can refuse; a device that
    // holds the pin must not be able to lose that to a server answer.
    #[test]
    fn the_device_local_pin_is_preferred_to_the_profile_read() {
        crate::test_support::block_on(async {
            let tmp = crate::test_support::ScopedTempDir::new("pin-source").expect("temp dir");
            let host = crate::host::test_host::TestHost::new(tmp.path());
            let io = crate::vault_io::StdVaultIo;
            let b2b = test_b2b_meta([0x33u8; 16]);

            // No device-local pin and no person credential on this host, so the
            // resolution goes to the profile read and is refused there. That the
            // arm is `NotEnrolled` rather than something else is what proves the
            // fallback was REACHED rather than skipped for another reason.
            let bare = tmp.path().join("bare");
            io.create_dir_all(&bare).await.expect("bare dir");
            assert_eq!(
                resolve_member_owner_pin(&host, &io, &bare, "some phrase", &b2b)
                    .await
                    .unwrap_err(),
                SyncDeviceError::NotEnrolled
            );

            // With the device-local copy present, the same call answers without
            // touching the network at all: there is no endpoint configured on this
            // host, so anything that reached the read would have failed instead.
            crate::plugins::sync::state::write_sync_state(
                &io,
                &bare,
                &crate::plugins::sync::state::SyncState {
                    owner_identity_code: Some("MYNE-PERSON-1:11:22:33:44".to_string()),
                    ..Default::default()
                },
            )
            .await
            .expect("write pin");
            assert_eq!(
                resolve_member_owner_pin(&host, &io, &bare, "some phrase", &b2b)
                    .await
                    .expect("device-local pin"),
                "MYNE-PERSON-1:11:22:33:44"
            );

            // An empty string is not a pin: it must fall through to the read
            // rather than resolve to "", which would then be decoded as an identity
            // code and fail later with nothing to point at.
            crate::plugins::sync::state::write_sync_state(
                &io,
                &bare,
                &crate::plugins::sync::state::SyncState {
                    owner_identity_code: Some(String::new()),
                    ..Default::default()
                },
            )
            .await
            .expect("write empty pin");
            assert_eq!(
                resolve_member_owner_pin(&host, &io, &bare, "some phrase", &b2b)
                    .await
                    .unwrap_err(),
                SyncDeviceError::NotEnrolled
            );
        });
    }

    /// A minimal well-formed `B2bVaultMeta`, for the paths that only carry one
    /// through (the pin's source order, which reads `kdf_params` on the fallback
    /// branch and nothing at all on the device-local one).
    fn test_b2b_meta(account_hash: [u8; 16]) -> protocol::B2bVaultMeta {
        protocol::B2bVaultMeta {
            base: protocol::VaultMeta {
                account_number_hash: account_hash,
                kdf_params: crate::test_support::FAST_TEST_KDF,
                random_salt_password: [0x01; protocol::VAULT_META_SALT_RANDOM_LEN],
                random_salt_recovery: [0x02; protocol::VAULT_META_SALT_RANDOM_LEN],
                nonce_password_wrap: [0x03; protocol::VAULT_META_NONCE_LEN],
                enc_root_key_password: [0x04; protocol::VAULT_META_WRAPPED_ROOT_KEY_LEN],
                nonce_recovery_wrap: [0x05; protocol::VAULT_META_NONCE_LEN],
                enc_root_key_recovery: [0x06; protocol::VAULT_META_WRAPPED_ROOT_KEY_LEN],
                items_key_id: [0x07; protocol::VAULT_META_ITEMS_KEY_ID_LEN],
                items_key_nonce: [0x08; protocol::VAULT_META_NONCE_LEN],
                enc_items_key: [0x09; protocol::VAULT_META_WRAPPED_ITEMS_KEY_LEN],
                membership: None,
                person_binding: None,
            },
            group_key_nonce: [0x0a; protocol::AEAD_NONCE_LEN],
            enc_group_key: [0x0b; protocol::VAULT_META_WRAPPED_ITEMS_KEY_LEN],
            group_key_epoch: 3,
            // Padded to the floor `serialize_vault_meta_ntv6` enforces. Nothing in
            // this fixture verifies the roster: the paths under test refuse before
            // they reach it (the pin read), and the one that would not is the
            // package verification, which is where a test would need a real owner
            // signature rather than a well-formed frame.
            signed_roster_envelope: vec![0u8; protocol::person_invite::SEALED_GROUP_ROSTER_MIN_LEN],
        }
    }

    // member-devices task 7, the whole second-device join, driven through the REAL
    // `_from_host` entry point against a loopback HTTP server. This is the scenario
    // the task names, at the layer where it can actually run: every other test in
    // this file drives one request builder on its own, so a reordering INSIDE
    // `member_join_vault_from_host` would leave all of them green.
    //
    // What is pinned here is the ORDER, which the function's own doc comment calls
    // the security property: `vault.meta` first, the pinned owner code second, the
    // invite claim LAST. So this fixture answers `vault.meta` and 404s the profile,
    // and the assertion is not only the typed refusal but that the server was never
    // ASKED to claim the invite. If the claim moved ahead of the pin read, a
    // server that cannot be trusted to say who the owner is would be the thing that
    // hands out the membership token.
    #[test]
    fn a_join_with_no_pinned_owner_code_refuses_before_it_claims_the_invite() {
        crate::test_support::block_on(async {
            use std::io::{Read, Write};
            use std::net::TcpListener;
            use std::sync::{Arc, Mutex};

            let tmp =
                crate::test_support::ScopedTempDir::new("join-no-pin-flow").expect("temp dir");
            let host = crate::host::test_host::TestHost::new(tmp.path());
            let io = crate::vault_io::StdVaultIo;
            let state = VaultRuntimeState::default();

            let phrase =
                "legal winner thank year wave sausage worth useful legal winner thank yellow";
            let normalized = protocol::normalize_user_phrase(phrase);
            let person_id = protocol::person_id_hash(normalized.as_str());
            let account_hash = [0x5Au8; 16];
            let account_hash_hex = crate::account::person_identity::hex_lower(&account_hash);

            // The server side. Every request line is recorded, so the test can ask
            // what was NOT sent as well as what was.
            let listener = TcpListener::bind("127.0.0.1:0").expect("bind loopback");
            let port = listener.local_addr().expect("addr").port();
            let seen: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));
            let seen_server = Arc::clone(&seen);
            let meta_bytes = protocol::serialize_vault_meta_ntv6(&test_b2b_meta(account_hash))
                .expect("serialize NTV6");
            let _server = std::thread::spawn(move || {
                listener.set_nonblocking(false).expect("blocking accept");
                // Bounded so an unexpected extra request cannot hang the suite; the
                // happy path needs three and a regression needs exactly one more.
                for _ in 0..6 {
                    let Ok((mut sock, _)) = listener.accept() else {
                        return;
                    };
                    let mut buf = [0u8; 2048];
                    let n = sock.read(&mut buf).unwrap_or(0);
                    let head = String::from_utf8_lossy(&buf[..n]).into_owned();
                    let line = head.lines().next().unwrap_or_default().to_string();
                    seen_server.lock().expect("seen").push(line.clone());
                    let (status, body): (&str, Vec<u8>) = if line.contains("/vault.meta") {
                        ("200 OK", meta_bytes.clone())
                    } else if line.contains("/claim") {
                        // Never reached on a correct build. A 200 here rather than a
                        // 4xx so that a reordered build FAILS the assertion below
                        // instead of failing earlier for an unrelated reason.
                        ("200 OK", b"{\"token_hex\":\"00\"}".to_vec())
                    } else {
                        ("404 Not Found", b"{}".to_vec())
                    };
                    let resp = format!(
                        "HTTP/1.1 {status}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                        body.len()
                    );
                    let _ = sock.write_all(resp.as_bytes());
                    let _ = sock.write_all(&body);
                }
            });

            // Point the device at that server.
            let cfg_path = crate::plugins::sync::config::config_path_from_host(&host, &io)
                .await
                .expect("config path");
            crate::plugins::sync::config::write_config(
                &io,
                &cfg_path,
                &crate::plugins::sync::config::SyncEndpointConfig {
                    endpoint_url: Some(format!("http://127.0.0.1:{port}")),
                    ..Default::default()
                },
            )
            .await
            .expect("write config");

            // This person, on this device.
            let auth_path = person_auth_path(&host, &io)
                .await
                .expect("person auth path");
            write_person_auth(
                &io,
                &auth_path,
                &PersonAuth {
                    person_id_hex: crate::account::person_identity::hex_lower(&person_id),
                    device_id_hex: "66".repeat(16),
                    registered: false,
                    token_hex: "77".repeat(32),
                    ..Default::default()
                },
            )
            .await
            .expect("write person credential");

            let err = member_join_vault_from_host(
                &host,
                &io,
                &state,
                &"88".repeat(16),
                &account_hash_hex,
                phrase,
                "correct horse battery staple",
            )
            .await
            .unwrap_err();
            assert_eq!(err, SyncDeviceError::BadRequest);

            let requests = seen.lock().expect("seen").clone();
            assert!(
                requests.iter().any(|l| l.contains("/vault.meta")),
                "the join must fetch the vault meta; saw {requests:?}"
            );
            assert!(
                !requests.iter().any(|l| l.contains("/claim")),
                "the invite must NOT be claimed before the pinned owner code is read; saw {requests:?}"
            );

            // And nothing was created: a refusal that left a vault directory behind
            // would be read as a real vault by the picker on the next launch.
            let base = host.app_data_dir().expect("app data dir");
            assert_eq!(
                crate::vault_registry::discover_vaults(&base).len(),
                0,
                "a refused join materializes nothing"
            );
        });
    }

    // member-devices task 7, item 5: a member device whose `vault.member-key` store is
    // ABSENT (not merely stale) is the SECOND device, and the keys arrive over the
    // group-package route. This drives `unlock_member_vault_from_host` through the real
    // `_from_host` entry against a loopback server, with a genuinely sealed person
    // keypair on disk and a genuinely sealed `MYY5` profile carrying the pin, so the
    // branch is reached the way production reaches it rather than by stubbing.
    //
    // The assertion is the acceptance criterion "an unreachable package reports a typed
    // retry": the server answers the profile and 404s the package, and the answer is
    // `Transport` (retryable) rather than `BadRequest` (a permanent refusal) or an
    // install of keys this device never received.
    #[test]
    fn an_absent_member_key_fetches_the_package_and_reports_a_typed_retry_when_it_is_missing() {
        crate::test_support::block_on(async {
            use std::io::{Read, Write};
            use std::net::TcpListener;
            use std::sync::{Arc, Mutex};

            let tmp =
                crate::test_support::ScopedTempDir::new("member-unlock-absent").expect("temp dir");
            let host = crate::host::test_host::TestHost::new(tmp.path());
            let io = crate::vault_io::StdVaultIo;
            let state = VaultRuntimeState::default();

            let phrase =
                "legal winner thank year wave sausage worth useful legal winner thank yellow";
            let normalized = protocol::normalize_user_phrase(phrase);
            let person_id = protocol::person_id_hash(normalized.as_str());
            let person_id_hex = crate::account::person_identity::hex_lower(&person_id);
            let account_hash = [0x5Au8; 16];
            let b2b = test_b2b_meta(account_hash);

            // The OWNER's half, as the first device recorded it out of band. The pin is
            // a real code because `fetch_and_open_rotation_package` decodes it before it
            // fetches, so a stand-in string would fail one step early and this test would
            // never reach the branch it exists to pin.
            let owner_pair =
                protocol::PersonKeyPair::generate_raw(&[0x31; 64], &[0x32; 32], &[0x33; 32]);
            let owner_id = [0x41u8; 16];
            let pin = crate::plugins::sync::invite::encode_person_identity_code(
                &owner_id,
                &owner_pair.public_half(),
            );

            // The sealed `MYY5` profile carrying that pin, under the key this phrase
            // derives for this `(person, vault)`. Sealed here rather than stubbed so the
            // read under test is the real one.
            let profile_id = protocol::person_profile_id(&person_id, &account_hash);
            let profile_key = protocol::derive_person_vault_profile_key(
                normalized.as_str(),
                &profile_id,
                &b2b.base.kdf_params,
            )
            .expect("profile key");
            let mut profile_state = super::super::person_ai_store::PersonAiState::empty();
            profile_state.set_owner_identity_code(Some(&pin));
            let profile_plaintext =
                super::super::person_ai_store::encode_person_ai_state(&profile_state)
                    .expect("encode profile");
            let sealed_profile = protocol::encode_person_profile_blob(
                &profile_key,
                &profile_id,
                &account_hash,
                &profile_plaintext,
            )
            .expect("seal profile");

            // The loopback server: the profile, and a 404 for everything else (which is
            // the group package, the one request this test is about).
            let listener = TcpListener::bind("127.0.0.1:0").expect("bind loopback");
            let port = listener.local_addr().expect("addr").port();
            let seen: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));
            let seen_server = Arc::clone(&seen);
            let _server = std::thread::spawn(move || {
                for _ in 0..6 {
                    let Ok((mut sock, _)) = listener.accept() else {
                        return;
                    };
                    let mut buf = [0u8; 4096];
                    let n = sock.read(&mut buf).unwrap_or(0);
                    let head = String::from_utf8_lossy(&buf[..n]).into_owned();
                    let line = head.lines().next().unwrap_or_default().to_string();
                    seen_server.lock().expect("seen").push(line.clone());
                    let (status, body): (&str, Vec<u8>) = if line.contains("/profiles/") {
                        ("200 OK", sealed_profile.clone())
                    } else {
                        ("404 Not Found", b"{}".to_vec())
                    };
                    let resp = format!(
                        "HTTP/1.1 {status}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                        body.len()
                    );
                    let _ = sock.write_all(resp.as_bytes());
                    let _ = sock.write_all(&body);
                }
            });

            // The sealed person keypair, in the exact frame `seal_pair_to_file` writes
            // (salt, canonical kdf params, nonce, sealed pair). `FAST_TEST_KDF` rides the
            // frame, which is what the reader honours, so the Argon2id here is the cheap
            // one rather than the production 256 MiB.
            let pair = protocol::PersonKeyPair::generate_raw(&[0x51; 64], &[0x52; 32], &[0x53; 32]);
            let salt = [0x61u8; 16];
            let params = crate::test_support::FAST_TEST_KDF;
            let wrap_key = protocol::derive_person_keypair_wrap_key_from_normalized(
                normalized.as_str(),
                &salt,
                &person_id,
                &params,
            )
            .expect("wrap key");
            let (nonce, ct) = pair.seal(&wrap_key).expect("seal pair");
            let mut frame = Vec::new();
            frame.extend_from_slice(&salt);
            frame.extend_from_slice(&protocol::serialize_kdf_params(&params));
            frame.extend_from_slice(&nonce[..]);
            frame.extend_from_slice(&ct);
            let config_dir = host.app_config_dir().expect("config dir");
            io.create_dir_all(&config_dir).await.expect("config dir");
            io.write(
                &config_dir.join(crate::account::person_identity::PERSON_KEYPAIR_FILE),
                &frame,
                crate::vault_io::WriteOpts::default(),
            )
            .await
            .expect("write sealed keypair");

            // The member vault directory, carrying `vault.meta` and NO `vault.member-key`.
            let base = host.app_data_dir().expect("app data dir");
            let vault_id = crate::vault_registry::mint_unique_vault_id(&base);
            let vault_dir = base
                .join(crate::paths::VAULTS_DIR_NAME)
                .join(vault_id.to_string());
            io.create_dir_all(&vault_dir).await.expect("vault dir");
            io.write(
                &vault_dir.join("vault.meta"),
                &protocol::serialize_vault_meta_ntv6(&b2b).expect("serialize NTV6"),
                crate::vault_io::WriteOpts::default(),
            )
            .await
            .expect("write vault.meta");

            // The person credential and the endpoint.
            let auth_path = person_auth_path(&host, &io)
                .await
                .expect("person auth path");
            write_person_auth(
                &io,
                &auth_path,
                &PersonAuth {
                    person_id_hex: person_id_hex.clone(),
                    device_id_hex: "99".repeat(16),
                    registered: false,
                    token_hex: "aa".repeat(32),
                    ..Default::default()
                },
            )
            .await
            .expect("write person credential");
            let cfg_path = crate::plugins::sync::config::config_path_from_host(&host, &io)
                .await
                .expect("config path");
            crate::plugins::sync::config::write_config(
                &io,
                &cfg_path,
                &crate::plugins::sync::config::SyncEndpointConfig {
                    endpoint_url: Some(format!("http://127.0.0.1:{port}")),
                    ..Default::default()
                },
            )
            .await
            .expect("write config");

            let err = unlock_member_vault_from_host(&host, &io, &state, vault_id, phrase)
                .await
                .unwrap_err();
            assert_eq!(
                err,
                SyncDeviceError::Transport,
                "an absent package on a reachable server is a typed RETRY, not a refusal"
            );

            let requests = seen.lock().expect("seen").clone();
            assert!(
                requests
                    .iter()
                    .any(|l| l.contains(&format!("/group-packages/{person_id_hex}"))),
                "the absent store must reach the group-package route; saw {requests:?}"
            );
            // And nothing was installed: a refused unlock leaves no member slot behind.
            assert!(
                state.active_vault_id().await.is_none(),
                "a refused unlock must not install the member slot"
            );
        });
    }
}

#[cfg(test)]
mod device_join_tests {
    use super::*;
    use crate::host::test_host::TestHost;
    use crate::plugins::vault_unlock::state::VaultRuntimeState;
    use crate::test_support::{block_on, ScopedTempDir};

    /// A scanned code for one person and a phrase for another is refused BEFORE
    /// anything is written (myne-md/myne#911 task 9).
    ///
    /// The order is the claim: the endpoint config is not touched and no identity
    /// is sealed, so a mixed-up join leaves the device exactly as it found it. The
    /// alternative (seal first, roll back on mismatch) makes a failed rollback a
    /// device that reports holding an identity nobody meant to add.
    #[test]
    fn a_phrase_for_another_person_is_refused_before_anything_is_written() {
        let tmp = ScopedTempDir::new("person-join-mismatch").unwrap();
        let host = TestHost::with_dirs(tmp.path(), tmp.path().join("config"));
        let io = crate::vault_io::StdVaultIo;
        let state = VaultRuntimeState::default();

        // A valid 24-word phrase, and a person id that is definitely not its own.
        let phrase = protocol::generate_recovery_phrase()
            .expect("phrase")
            .join_normalized()
            .to_string();
        let other = "aa".repeat(16);
        let endpoint = "http://127.0.0.1:9".to_string();

        block_on(async {
            let refused =
                person_join_device_from_host(&host, &io, &state, other, endpoint, phrase).await;
            assert!(
                matches!(refused, Err(SyncDeviceError::PersonMismatch)),
                "a phrase for a different person must be refused as a mismatch"
            );

            // Nothing written: no endpoint, no sealed identity, no credential.
            let cfg_path = super::super::config::config_path_from_host(&host, &io)
                .await
                .expect("config path");
            assert!(
                io.read(&cfg_path).await.is_err(),
                "the endpoint must not be written for a refused join"
            );
            let auth = person_auth_path_for_read(&host).expect("auth path");
            assert!(
                io.read(&auth).await.is_err(),
                "no person credential may be written for a refused join"
            );
        });
    }

    /// A malformed scanned id is a client error, not a network attempt.
    #[test]
    fn a_malformed_person_id_is_a_bad_request() {
        let tmp = ScopedTempDir::new("person-join-bad-id").unwrap();
        let host = TestHost::with_dirs(tmp.path(), tmp.path().join("config"));
        let io = crate::vault_io::StdVaultIo;
        let state = VaultRuntimeState::default();
        block_on(async {
            for bad in ["", "zz", "abc"] {
                let outcome = person_join_device_from_host(
                    &host,
                    &io,
                    &state,
                    bad.to_string(),
                    "http://127.0.0.1:9".to_string(),
                    "abandon ".repeat(23).trim().to_string() + " about",
                )
                .await;
                assert!(
                    matches!(outcome, Err(SyncDeviceError::BadRequest)),
                    "{bad:?} must be a bad request"
                );
            }
        });
    }
}
