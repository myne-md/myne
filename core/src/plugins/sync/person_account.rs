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
use super::transport::{HttpMethod, SyncTransport, TransportResponse};
use crate::host::HostCtx;
use crate::plugins::quick_unlock::provider::QuickUnlockProvider;
use crate::plugins::vault_unlock::state::VaultRuntimeState;
use crate::vault_io::VaultIo;

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
    /// False when the device is awaiting approval (a second password-path
    /// device); the caller shows "pending" and does not expect a token.
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
/// arriving with the person's only credential, and such a device MUST declare
/// `recovery`: the person plane holds no second device that could ever call
/// `/auth/devices/approve`, so a `password` declaration lands the device pending
/// with no releaser, which is the dead end server-protocol §3.1a exists to name.
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

/// The identity-only setup core. `phrase: None` generates a fresh phrase;
/// `Some` is a recovery (or a re-run on a device that already holds the sealed
/// keypair). Either way it derives the same keypair for the same phrase.
pub async fn person_setup_from_host(
    host: &dyn HostCtx,
    io: &dyn VaultIo,
    state: &VaultRuntimeState,
    phrase: Option<String>,
) -> Result<PersonSetupView, SyncDeviceError> {
    let generated = phrase.is_none();
    let phrase: Zeroizing<String> = match phrase {
        Some(p) => Zeroizing::new(p),
        None => protocol::generate_recovery_phrase()
            .map_err(|_| SyncDeviceError::Internal)?
            .join_normalized(),
    };
    let normalized = Zeroizing::new(protocol::normalize_user_phrase(&phrase));
    let person_id = protocol::person_id_hash(&normalized);
    let generation = state.person_session_generation().await;

    // Did THIS call create the sealed keypair? Asked BEFORE enrolling, because
    // the answer cannot be read off the result and because a pre-existing
    // sealed file is the user's ONLY copy of an identity that may already be
    // shared: erasing it would destroy a live identity rather than clean up
    // after a failure.
    let sealed_before = crate::account::person_identity::sealed_keypair_present(host, io).await;

    // Everything that can fail after the seal is ONE unit, so the erase below
    // has exactly one exit to cover. The defect this closes was a failure path
    // that returned without cleaning up, and a single block removes the class
    // rather than the instance: a future early return added inside it is covered
    // by construction, which is the property a per-site cleanup cannot offer.
    //
    // `CreateVault` states the same rule as normative for the create flow
    // (src/screens/CreateVault.tsx — "The failure path erases. Anything that
    // goes wrong before the phrase is shown leaves nothing behind"). A keypair
    // sealed to a fingerprint other vaults' `itemsKey` wraps are bound to is
    // exactly the orphan class that skipping this would leave behind.
    let view = async move {
        // Derive + seal + hold the identity. An absent sealed file is first
        // enrolment; `unlock_person_identity` returns a signed transition record
        // when a legacy CSPRNG identity migrated.
        let (pair, mut transition) =
            crate::account::person_identity::unlock_person_identity(host, io, &normalized)
                .await
                .map_err(|e| {
                    use crate::account::person_identity::PersonIdentityError as E;
                    match e {
                        // A CREATE (`generated`) that cannot open the sealed
                        // frame means this device already holds an identity it
                        // did not write. On RECOVER the same error is a wrong
                        // phrase, so it stays the non-distinguishing
                        // `BadRequest` (myne-md/myne#780).
                        E::CannotDecrypt if generated => SyncDeviceError::AlreadyHeldIdentity,
                        E::BadPhrase | E::CannotDecrypt => SyncDeviceError::BadRequest,
                        E::Io | E::Csprng => SyncDeviceError::Transport,
                    }
                })?;
        if transition.is_none() {
            transition =
                crate::account::person_identity::read_pending_person_key_transition(host, io)
                    .await
                    .map_err(|_| SyncDeviceError::Transport)?;
        }
        let fingerprint_hex = crate::account::person_identity::hex_lower(pair.fingerprint());

        // The person SCRAM secret. The server never sees it.
        let secret = protocol::derive_person_server_auth_key(
            &normalized,
            &person_id,
            &protocol::DEFAULT_V0_1_KDF_PARAMS,
        )
        .map_err(|_| SyncDeviceError::Internal)?;

        // The device-scoped endpoint (a vault-less identity still has one).
        let cfg_path = super::config::config_path_from_host(host, io)
            .await
            .map_err(|_| SyncDeviceError::Internal)?;
        let cfg = super::config::read_config(io, &cfg_path)
            .await
            .map_err(|_| SyncDeviceError::NotConfigured)?;
        // The gated-server admission code, read before `endpoint_url` moves out.
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
                    enroll_path_for(generated),
                )
                .map_err(SyncDeviceError::from)
            })
            .await
            .map_err(|_| SyncDeviceError::Internal)??;

        // The token only arrives when the server approved this device; a pending
        // device has none. The credential file is written EITHER WAY, because the
        // public halves it now carries are what the identity home renders as the
        // out-of-band invite code, and those exist from setup (task 11).
        let public = pair.public_half();
        let identity_code = super::invite::encode_person_identity_code(&person_id, &public);
        let auth = PersonAuth {
            person_id_hex: crate::account::person_identity::hex_lower(&person_id),
            device_id_hex: crate::account::person_identity::hex_lower(&outcome.device_id),
            token_hex: if outcome.approved && !outcome.token.is_empty() {
                crate::account::person_identity::hex_lower(&outcome.token)
            } else {
                String::new()
            },
            kem_ek_hex: crate::account::person_identity::hex_lower(public.kem_ek()),
            ed_pk_hex: crate::account::person_identity::hex_lower(public.ed_pk()),
            mldsa_vk_hex: crate::account::person_identity::hex_lower(public.mldsa_vk()),
        };

        // Vault-bound carrier (myne-md/myne#792): seal the keypair under the
        // active owner vault's root_key so its next unlock installs this session
        // with no phrase. Best-effort; only fires for an unlocked NTV6 owner
        // vault.
        super::person_vault_carrier::refresh_carrier_best_effort(
            host, io, state, &person_id, &pair,
        )
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

        Ok(PersonSetupView {
            // The phrase is returned ONCE, at generation, for display. Never log it.
            phrase: if generated {
                Some((*phrase).clone())
            } else {
                None
            },
            fingerprint_hex,
            person_id_hex: crate::account::person_identity::hex_lower(&person_id),
            identity_code,
            approved: outcome.approved,
        })
    }
    .await;

    if view.is_err() && !sealed_before {
        let _ = crate::account::person_identity::delete_sealed_file(host, io).await;
    }
    view
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

/// Whether this device holds a person account, and whose it is. The identity
/// home is shown when `enrolled` is true; `person_id_hex` is `None` only in the
/// never-approved case where setup sealed a keypair but no token was stored.
#[derive(Debug, Clone, serde::Serialize)]
pub struct PersonStatusView {
    pub enrolled: bool,
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
    let person_id_hex = runtime
        .as_ref()
        .filter(|_| identity_unlocked)
        .map(|snapshot| crate::account::person_identity::hex_lower(&snapshot.person_id))
        .or_else(|| {
            auth_person_id.map(|person_id| crate::account::person_identity::hex_lower(&person_id))
        });
    Ok(PersonStatusView {
        enrolled,
        identity_unlocked,
        person_id_hex,
        identity_code,
        sealed_keypair_present: crate::account::person_identity::sealed_keypair_present(host, io)
            .await,
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
    let auth = read_person_auth(io, &auth_path)
        .await
        .map_err(|_| SyncDeviceError::Internal)?
        .filter(|a| !a.token_hex.is_empty())
        .ok_or(SyncDeviceError::NotConfigured)?;

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
async fn endpoint_from_host(
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

/// Bind the owner person to the active vault once and return the **per-vault
/// owner membership token** (myne-md/myne#711 task 11).
///
/// The first B2B admin call needs the owner bound: `POST /b2b/vaults/{hash}/members`
/// with `role: "owner"` is authorized by the vault's OWN device session
/// ("owner at registration", `server-protocol.md` §3.1a), and issues a token
/// scoped to (owner person, vault). The token is stored in the vault-scoped
/// device-local [`super::state::SyncState`], so a second invite skips the
/// round-trip. A stored token for a DIFFERENT person id (a re-bound owner after
/// a migration) is re-bound rather than reused.
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

    let account_hash_hex = sync_state
        .account_hash_hex
        .clone()
        .filter(|s| !s.is_empty())
        .ok_or(SyncDeviceError::NotEnrolled)?;
    // The vault's own device session authorizes the owner registration. Its
    // transport is discarded; the relay token below is the owner's, not the
    // device's.
    let (device_token, _device_transport) =
        super::devices::authed_transport_from_host(host, io, state).await?;
    let url = endpoint_from_host(host, io).await?;

    let account_hash_for_req = account_hash_hex.clone();
    let owner_hex = owner_person_id_hex.to_string();
    let issued = crate::task::run_blocking(move || {
        let transport =
            super::http_transport::build_transport(&url).map_err(|_| SyncDeviceError::Transport)?;
        bind_owner_request(
            transport.as_ref(),
            &device_token,
            &account_hash_for_req,
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

    let token = ensure_owner_member_token(
        host,
        io,
        state,
        &crate::account::person_identity::hex_lower(&owner_person_id),
    )
    .await?;
    let sync_state = super::state::read_sync_state(io, &root)
        .await
        .map_err(|_| SyncDeviceError::Internal)?;
    let Some(account_hash_hex) = sync_state
        .account_hash_hex
        .clone()
        .filter(|s| !s.is_empty())
    else {
        // A shared vault with no synced account is a device that has not
        // enrolled: nothing to list, and not a relay failure either.
        return Ok(None);
    };
    let url = endpoint_from_host(host, io).await?;
    let path = format!("/b2b/vaults/{account_hash_hex}/invites");

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

    let b2b = protocol::parse_vault_meta_ntv6(&meta_bytes).map_err(|e| {
        tracing::warn!(
            stage = "accept_parse_ntv6",
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
    let b2b = protocol::parse_vault_meta_ntv6(&meta_bytes).map_err(|e| {
        tracing::warn!(
            stage = "join_parse_ntv6",
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
    let b2b =
        protocol::parse_vault_meta_ntv6(&meta_bytes).map_err(|_| SyncDeviceError::BadRequest)?;
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
    let b2b =
        protocol::parse_vault_meta_ntv6(&meta_bytes).map_err(|_| SyncDeviceError::BadRequest)?;
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

/// Install the member slot + person session from an opened credential, refusing a
/// stale `group_key_epoch` (the cache is a generation behind after an owner
/// group-key rotation; the caller falls back to the recovery phrase). Deliberately
/// does NOT open the process-global owner quick-unlock gate: a member credential
/// must not let a PIN quick-unlock on another owner vault skip its password after
/// a restart (MYND-641/A6).
async fn install_member_unlock_credential(
    host: &dyn HostCtx,
    io: &dyn VaultIo,
    state: &VaultRuntimeState,
    vault_id: crate::vault_id::VaultId,
    cred: super::member_unlock_store::MemberUnlockCredential,
    meta_bytes: &[u8],
    current_epoch: u64,
) -> Result<(), SyncDeviceError> {
    if cred.group_key_epoch != current_epoch {
        return Err(SyncDeviceError::BadRequest);
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

/// Remove the member-unlock store and its attempt counter (cap reached).
async fn wipe_member_unlock(io: &dyn VaultIo, vault_dir: &std::path::Path) {
    let _ = io
        .remove_file(&vault_dir.join(super::member_unlock_store::MEMBER_UNLOCK_STORE_FILE))
        .await;
    let _ = io.remove_file(&vault_dir.join(MEMBER_ATTEMPT_FILE)).await;
}

/// **Set (or replace) the device-local member vault password.** Requires the
/// active vault to be an unlocked member vault whose person session is held: the
/// store seals exactly the material the phrase path installs (`group_key`,
/// `items_key`, and the person keypair), so it can only be written while that
/// material is available. The recovery phrase stays the portable fallback.
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
    .map_err(|_| SyncDeviceError::Internal)
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
    let b2b =
        protocol::parse_vault_meta_ntv6(&meta_bytes).map_err(|_| SyncDeviceError::BadRequest)?;
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
    .map_err(|_| SyncDeviceError::Internal)
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
    let b2b =
        protocol::parse_vault_meta_ntv6(&meta_bytes).map_err(|_| SyncDeviceError::BadRequest)?;
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
        wipe_member_unlock(io, &vault_dir).await;
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
                    wipe_member_unlock(io, &vault_dir).await;
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
        let b2b = protocol::parse_vault_meta_ntv6(&meta_bytes)
            .map_err(|_| SyncDeviceError::BadRequest)?;
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
    wipe_member_unlock(io, &vault_dir).await;
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
    .map_err(|_| SyncDeviceError::Internal)?
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
/// Trigger: this device's `vault.meta` carries a group-key epoch STRICTLY
/// GREATER than the epoch its device-local member-key store was sealed at, i.e.
/// the owner rotated and the sync meta phase has already adopted the new
/// `vault.meta` bytes. On that signal the member fetches its OWN package from
/// the vault-scoped delivery route with its person session, verifies the owner
/// double signature against the PINNED owner public half, unwraps the new group
/// key, derives the vault's `itemsKey` at the new epoch, and installs both on
/// the live slot so the running session re-keys.
///
/// Delivery-tolerant: a member whose package has not landed yet, or a transport
/// hiccup, returns `Ok(())` and retries on the next cycle. The `vault.member-key`
/// store is re-sealed on the next unlock, where the member's phrase is available
/// (`unlock_member_vault_from_host`); between the rotation and that unlock the
/// live slot holds the new keys and the sync plane stays on the new epoch.
pub async fn member_adopt_rotation_from_host(
    host: &dyn HostCtx,
    io: &dyn VaultIo,
    state: &VaultRuntimeState,
) -> Result<(), SyncDeviceError> {
    let root = crate::paths::active_vault_root_from_base(
        &host.app_data_dir().map_err(|_| SyncDeviceError::Internal)?,
        state.active_vault_id().await,
    );
    let Ok(meta_bytes) = io.read(&root.join("vault.meta")).await else {
        return Ok(());
    };
    if meta_bytes.get(..4) != Some(protocol::VAULT_META_NTV6_MAGIC.as_slice()) {
        return Ok(());
    }
    let Ok(b2b) = protocol::parse_vault_meta_ntv6(&meta_bytes) else {
        return Ok(());
    };
    let meta_epoch = b2b.group_key_epoch;
    let Some(store_epoch) = member_key_store_epoch(io, &root).await else {
        return Ok(());
    };
    if meta_epoch <= store_epoch {
        return Ok(()); // nothing to adopt
    }

    let sync_state = super::state::read_sync_state(io, &root)
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
    let Some((new_group_key, new_items_key)) =
        fetch_and_open_rotation_package(host, io, &b2b, meta_epoch, &owner_code, &member).await?
    else {
        return Ok(()); // not delivered yet: retry next cycle
    };

    let Some(id) = state.active_vault_id().await else {
        return Ok(());
    };
    state.replace_items_key(id, new_items_key).await;
    state.set_group_key(id, new_group_key).await;
    Ok(())
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

#[cfg(all(feature = "tauri-ipc", not(target_arch = "wasm32")))]
#[tauri::command]
pub async fn sync_person_profile_write<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    state: tauri::State<'_, VaultRuntimeState>,
    plaintext_b64: String,
) -> Result<(), SyncDeviceError> {
    let plaintext = {
        use base64::Engine as _;
        base64::engine::general_purpose::STANDARD
            .decode(plaintext_b64)
            .map_err(|_| SyncDeviceError::BadRequest)?
    };
    person_profile_write_from_host(
        &crate::host::tauri_host::TauriHost::new(app.clone()),
        &crate::vault_io::StdVaultIo,
        state.inner(),
        &plaintext,
    )
    .await
}

#[cfg(all(feature = "tauri-ipc", not(target_arch = "wasm32")))]
#[tauri::command]
pub async fn sync_person_profile_read<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    state: tauri::State<'_, VaultRuntimeState>,
) -> Result<Option<String>, SyncDeviceError> {
    let plaintext = person_profile_read_from_host(
        &crate::host::tauri_host::TauriHost::new(app.clone()),
        &crate::vault_io::StdVaultIo,
        state.inner(),
    )
    .await?;
    Ok(plaintext.map(|bytes| {
        use base64::Engine as _;
        base64::engine::general_purpose::STANDARD.encode(&*bytes)
    }))
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

    // A generated phrase is shown ONCE, on success, so a keypair sealed for a
    // setup that then failed is a keypair nobody holds the phrase for. Left on
    // disk it is worse than absent: the next "Create an identity" mints a
    // DIFFERENT phrase, `open_sealed_file` refuses that, and the failure the
    // user sees is indistinguishable from the one they just had. Observed on a
    // real fresh install (#766), where the failure is `NotConfigured` because
    // desktop has no sync-server input at zero vaults.
    #[test]
    fn a_failed_generated_setup_leaves_no_sealed_keypair_and_is_not_poisoned() {
        crate::test_support::block_on(async {
            let tmp =
                crate::test_support::ScopedTempDir::new("person-setup-fail").expect("temp dir");
            let host = crate::host::test_host::TestHost::new(tmp.path());
            let io = crate::vault_io::StdVaultIo;
            let state = VaultRuntimeState::default();
            // The app config directory exists on a real install (Tauri creates
            // it at startup); the seal writes into it, so the harness asks the
            // production resolver for it rather than inventing a path.
            crate::plugins::sync::config::config_path_from_host(&host, &io)
                .await
                .expect("app config dir");

            // No sync config on this device at all: `read_config` answers a
            // default, whose `endpoint_url` is `None`.
            // `let..else` rather than `expect_err`: `PersonSetupView` carries the
            // generated phrase, and it deliberately has no `Debug` to print.
            let Err(first) = person_setup_from_host(&host, &io, &state, None).await else {
                panic!("a device with no sync endpoint must not complete a setup");
            };
            assert_eq!(first, SyncDeviceError::NotConfigured);

            assert!(
                !crate::account::person_identity::sealed_keypair_present(&host, &io).await,
                "a setup that failed before the phrase was shown must not leave a \
                 sealed keypair behind: nothing can ever open it"
            );

            // The observable consequence, stated as the property rather than as
            // the error string: a second attempt reaches the SAME endpoint
            // failure instead of turning into `BadRequest`, which is what a
            // leftover sealed file does to it.
            let Err(second) = person_setup_from_host(&host, &io, &state, None).await else {
                panic!("the endpoint is still unconfigured, so this must fail too");
            };
            assert_eq!(
                second,
                SyncDeviceError::NotConfigured,
                "a retry must fail where the first attempt failed, not earlier"
            );
        });
    }

    // The other side of the gate, and the reason it is not `generated` or
    // `is_err()` alone: a keypair this device ALREADY held is the user's only
    // copy of an identity that may already be shared with other vaults. A
    // recover that fails on the endpoint must leave it exactly as it found it.
    #[test]
    fn a_failed_recovery_keeps_the_sealed_keypair_the_device_already_held() {
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
            let normalized = protocol::normalize_user_phrase(&phrase);
            // Seed a live identity the way an earlier successful setup would.
            crate::account::person_identity::unlock_person_identity(&host, &io, &normalized)
                .await
                .expect("seed a sealed keypair");
            assert!(
                crate::account::person_identity::sealed_keypair_present(&host, &io).await,
                "the seeded identity is on disk"
            );

            let Err(err) =
                person_setup_from_host(&host, &io, &state, Some(phrase.as_str().to_owned())).await
            else {
                panic!("a device with no sync endpoint must not complete a setup");
            };
            assert_eq!(err, SyncDeviceError::NotConfigured);

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
