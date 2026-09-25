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
    enroll, generate_device_id, register_verifier, EnrollError, EnrollOutcome, EnrollPath,
};
use super::person_auth::{
    person_auth_path, person_auth_path_for_read, read_person_auth, write_person_auth, PersonAuth,
};
use super::transport::{HttpMethod, SyncTransport, TransportResponse};
use crate::host::HostCtx;
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
pub fn register_and_enroll_person(
    transport: &dyn SyncTransport,
    person_id: &[u8; 16],
    secret: &[u8],
) -> Result<EnrollOutcome, EnrollError> {
    register_verifier(transport, person_id, secret)?;
    let device_id = generate_device_id();
    let mut nonce_bytes = [0u8; 16];
    getrandom::getrandom(&mut nonce_bytes).map_err(|_| EnrollError::BadResponse)?;
    let mut client_nonce = String::with_capacity(32);
    for b in &nonce_bytes {
        client_nonce.push_str(&format!("{b:02x}"));
    }
    enroll(
        transport,
        person_id,
        secret,
        EnrollPath::Password,
        &client_nonce,
        device_id,
    )
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

    // Derive + seal + hold the identity. An absent sealed file is first
    // enrolment; `unlock_person_identity` returns a signed transition record
    // when a legacy CSPRNG identity migrated.
    let (pair, mut transition) =
        crate::account::person_identity::unlock_person_identity(host, io, &normalized)
            .await
            .map_err(|e| {
                use crate::account::person_identity::PersonIdentityError as E;
                match e {
                    E::BadPhrase | E::CannotDecrypt => SyncDeviceError::BadRequest,
                    E::Io | E::Csprng => SyncDeviceError::Transport,
                }
            })?;
    if transition.is_none() {
        transition = crate::account::person_identity::read_pending_person_key_transition(host, io)
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
    let pins = super::config::config_pins(&cfg);
    let url = cfg.endpoint_url.ok_or(SyncDeviceError::NotConfigured)?;

    let outcome: EnrollOutcome =
        crate::task::run_blocking(move || -> Result<EnrollOutcome, SyncDeviceError> {
            let transport = super::http_transport::build_transport(&url, pins)
                .map_err(|_| SyncDeviceError::Transport)?;
            register_and_enroll_person(transport.as_ref(), &person_id, secret.as_slice())
                .map_err(|_| SyncDeviceError::Transport)
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
    })
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
    let pins = super::config::config_pins(&cfg);
    let url = cfg.endpoint_url.ok_or(SyncDeviceError::NotConfigured)?;

    crate::task::run_blocking(move || -> Result<Vec<InviteSummary>, SyncDeviceError> {
        let transport = super::http_transport::build_transport(&url, pins)
            .map_err(|_| SyncDeviceError::Transport)?;
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

/// The endpoint URL + cert pins, the precondition every relay call needs.
async fn endpoint_from_host(
    host: &dyn HostCtx,
    io: &dyn VaultIo,
) -> Result<(String, Vec<[u8; 32]>), SyncDeviceError> {
    let cfg_path = super::config::config_path_from_host(host, io)
        .await
        .map_err(|_| SyncDeviceError::Internal)?;
    let cfg = super::config::read_config(io, &cfg_path)
        .await
        .map_err(|_| SyncDeviceError::NotConfigured)?;
    let pins = super::config::config_pins(&cfg);
    let url = cfg.endpoint_url.ok_or(SyncDeviceError::NotConfigured)?;
    Ok((url, pins))
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
    let (url, pins) = endpoint_from_host(host, io).await?;

    let account_hash_for_req = account_hash_hex.clone();
    let owner_hex = owner_person_id_hex.to_string();
    let issued = crate::task::run_blocking(move || {
        let transport = super::http_transport::build_transport(&url, pins)
            .map_err(|_| SyncDeviceError::Transport)?;
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
    let (url, pins) = endpoint_from_host(host, io).await?;
    let token = owner_token_hex.to_string();
    let recipient = recipient_person_id_hex.to_string();
    let frame = frame.to_vec();
    crate::task::run_blocking(move || {
        let transport = super::http_transport::build_transport(&url, pins)
            .map_err(|_| SyncDeviceError::Transport)?;
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
pub async fn list_vault_invites_from_host(
    host: &dyn HostCtx,
    io: &dyn VaultIo,
    state: &VaultRuntimeState,
) -> Result<Vec<VaultInviteSummary>, SyncDeviceError> {
    let owner_person_id = state
        .clone_person_id()
        .await
        .ok_or(SyncDeviceError::NotEnrolled)?;
    let token = ensure_owner_member_token(
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
    let sync_state = super::state::read_sync_state(io, &root)
        .await
        .map_err(|_| SyncDeviceError::Internal)?;
    let account_hash_hex = sync_state
        .account_hash_hex
        .clone()
        .filter(|s| !s.is_empty())
        .ok_or(SyncDeviceError::NotEnrolled)?;
    let (url, pins) = endpoint_from_host(host, io).await?;
    let path = format!("/b2b/vaults/{account_hash_hex}/invites");

    crate::task::run_blocking(move || {
        let transport = super::http_transport::build_transport(&url, pins)
            .map_err(|_| SyncDeviceError::Transport)?;
        let resp = transport
            .request(HttpMethod::Get, &path, &[], Some(&token))
            .map_err(|_| SyncDeviceError::Transport)?;
        match resp.status {
            200 => {
                let parsed: VaultInvitesResp =
                    serde_json::from_slice(&resp.body).map_err(|_| SyncDeviceError::Transport)?;
                Ok(parsed.invites)
            }
            401 | 403 => Err(SyncDeviceError::Unauthenticated),
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
    list_vault_invites_from_host(
        &crate::host::tauri_host::TauriHost::new(app.clone()),
        &crate::vault_io::StdVaultIo,
        state.inner(),
    )
    .await
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
) -> Result<AcceptedInviteView, SyncDeviceError> {
    use super::token_store::TokenStore as _;

    let normalized = zeroize::Zeroizing::new(protocol::normalize_user_phrase(phrase));
    let person_id = protocol::person_id_hash(normalized.as_str());
    let generation = state.person_session_generation().await;
    let owner = super::invite::decode_person_identity_code(owner_code)
        .map_err(|_| SyncDeviceError::BadRequest)?;

    let auth_path = person_auth_path_for_read(host).map_err(|_| SyncDeviceError::Internal)?;
    let auth = read_person_auth(io, &auth_path)
        .await
        .map_err(|_| SyncDeviceError::Internal)?
        .filter(|a| !a.token_hex.is_empty())
        .ok_or(SyncDeviceError::NotEnrolled)?;
    if auth.person_id_hex != crate::account::person_identity::hex_lower(&person_id) {
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
        match error {
            E::BadPhrase | E::CannotDecrypt => SyncDeviceError::BadRequest,
            E::Io | E::Csprng => SyncDeviceError::Transport,
        }
    })?;
    let transition = crate::account::person_identity::read_pending_person_key_transition(host, io)
        .await
        .map_err(|_| SyncDeviceError::Transport)?;
    let (url, pins) = endpoint_from_host(host, io).await?;

    let invite_id = invite_id_hex.to_string();
    let person_token = auth.token_hex.clone();
    let (claimed, meta_bytes) = crate::task::run_blocking(move || {
        let transport = super::http_transport::build_transport(&url, pins)
            .map_err(|_| SyncDeviceError::Transport)?;
        let claimed = claim_invite_request(transport.as_ref(), &person_token, &invite_id)?;
        let meta = fetch_vault_meta_request(transport.as_ref(), &claimed.vault_account_hash_hex)?;
        Ok::<_, SyncDeviceError>((claimed, meta))
    })
    .await
    .map_err(|_| SyncDeviceError::Internal)??;

    let account_hash = super::devices::hex16(&claimed.vault_account_hash_hex)
        .ok_or(SyncDeviceError::BadRequest)?;
    let payload = {
        use base64::Engine as _;
        base64::engine::general_purpose::STANDARD
            .decode(&claimed.payload_b64)
            .map_err(|_| SyncDeviceError::BadRequest)?
    };
    let package = protocol::person_invite::decode_signed_group_package(&payload)
        .ok_or(SyncDeviceError::BadRequest)?;

    let b2b =
        protocol::parse_vault_meta_ntv6(&meta_bytes).map_err(|_| SyncDeviceError::BadRequest)?;
    if b2b.base.account_number_hash != account_hash {
        return Err(SyncDeviceError::BadRequest);
    }
    let (group_key, epoch, owner_fingerprint_hex) =
        super::invite::accept_group_package(&owner.public, &member, &package, &account_hash)
            .map_err(|_| SyncDeviceError::BadRequest)?;
    let group = protocol::GroupKey::new(*group_key);
    let items_key =
        protocol::unlock_items_key_ntv6(&b2b, &group).map_err(|_| SyncDeviceError::BadRequest)?;
    let items_key_id = b2b.base.items_key_id;

    // Materialize a fresh local member vault: create-only meta, a member slot
    // with no root key, and the member's per-vault token device-local.
    let base = host.app_data_dir().map_err(|_| SyncDeviceError::Internal)?;
    let vault_id = crate::vault_registry::mint_unique_vault_id(&base);
    let vault_dir = crate::paths::vault_dir_for_id_from_host_io(host, io, Some(vault_id))
        .await
        .map_err(|_| SyncDeviceError::Internal)?;
    let meta_path = vault_dir.join("vault.meta");
    super::enroll::write_bootstrap_meta(io, &meta_path, &meta_bytes, &account_hash).await?;

    // Persist the member keys, sealed under the member's own phrase, so the
    // vault can be re-unlocked later without a password (task 25). Written
    // BEFORE the slot install, which consumes the key values.
    super::member_key_store::write_member_key_store(
        io,
        &vault_dir,
        vault_id.as_uuid().as_bytes(),
        &account_hash,
        epoch,
        &items_key_id,
        &b2b.base.kdf_params,
        &normalized,
        &group_key,
        &items_key,
    )
    .await
    .map_err(|_| SyncDeviceError::Internal)?;

    use sha2::Digest as _;
    let meta_hash: [u8; 32] = sha2::Sha256::digest(&meta_bytes).into();
    let mut st = super::state::read_sync_state(io, &vault_dir)
        .await
        .map_err(|_| SyncDeviceError::Internal)?;
    st.account_hash_hex = Some(claimed.vault_account_hash_hex.clone());
    st.owner_identity_code = Some(owner_code.to_string());
    st.device_id_hex = Some(crate::account::person_identity::hex_lower(
        &super::enroll::generate_device_id(),
    ));
    super::state::write_sync_state(io, &vault_dir, &st)
        .await
        .map_err(|_| SyncDeviceError::Internal)?;
    let token = hex_to_bytes(&claimed.token_hex).ok_or(SyncDeviceError::BadRequest)?;
    super::token_store::default_store()
        .store(io, &vault_dir, &token)
        .await
        .map_err(|_| SyncDeviceError::Internal)?;

    let profile_id = protocol::person_profile_id(&person_id, &account_hash);
    let profile = protocol::derive_person_vault_profile_key(
        normalized.as_str(),
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
        let _ = io.remove_dir_all(&vault_dir).await;
        return Err(SyncDeviceError::Transport);
    }

    Ok(AcceptedInviteView {
        vault_id: vault_id.to_string(),
        vault_account_hash_hex: claimed.vault_account_hash_hex,
        owner_fingerprint_hex,
        group_key_epoch: epoch,
    })
}

#[cfg(all(feature = "tauri-ipc", not(target_arch = "wasm32")))]
#[tauri::command]
pub async fn sync_person_accept_invite<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    state: tauri::State<'_, VaultRuntimeState>,
    invite_id_hex: String,
    owner_code: String,
    phrase: String,
) -> Result<AcceptedInviteView, SyncDeviceError> {
    let phrase = zeroize::Zeroizing::new(phrase);
    accept_invite_from_host(
        &crate::host::tauri_host::TauriHost::new(app.clone()),
        &crate::vault_io::StdVaultIo,
        state.inner(),
        &invite_id_hex,
        &owner_code,
        &phrase,
    )
    .await
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
    let keys = super::member_key_store::read_member_key_store(
        io,
        &vault_dir,
        vault_id.as_uuid().as_bytes(),
        &b2b.base.kdf_params,
        &normalized,
    )
    .await
    .ok_or(SyncDeviceError::BadRequest)?;

    let pair = crate::account::person_identity::open_person_identity_without_mutation(
        host,
        io,
        &normalized,
    )
    .await
    .map_err(|_| SyncDeviceError::BadRequest)?;
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

/// After a group rotation, push the rotated `vault.meta` under the owner's
/// per-vault token, record the namespace retirement, and revoke the removed
/// member's binding + token (myne-md/myne#711 task 14). `person_id_hex` is `None`
/// for a row migrated from the pre-B2B roster (no person account to revoke).
#[allow(clippy::too_many_arguments)]
pub async fn push_and_revoke_removed_member_from_host(
    host: &dyn HostCtx,
    io: &dyn VaultIo,
    state: &VaultRuntimeState,
    person_id_hex: Option<&str>,
    retired_epoch: u64,
    replacement_epoch: u64,
    reclaim_sync_ids_hex: &[String],
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
    let (url, pins) = endpoint_from_host(host, io).await?;
    let pid = person_id_hex.map(str::to_string);
    let reclaim = reclaim_sync_ids_hex.to_vec();

    crate::task::run_blocking(move || {
        let transport = super::http_transport::build_transport(&url, pins)
            .map_err(|_| SyncDeviceError::Transport)?;
        // The rotated meta must reach the server before the revoke, so the
        // removed device cannot pull the new epoch even once before its token
        // dies.
        super::enroll::put_vault_meta(transport.as_ref(), &owner_token, &meta_bytes)
            .map_err(|_| SyncDeviceError::Transport)?;
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
        Ok(())
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
    let (url, pins) = endpoint_from_host(host, io).await?;
    let path = profile_path(&account_hash, &profile_id);
    let token = auth.token_hex.clone();
    crate::task::run_blocking(move || {
        let transport = super::http_transport::build_transport(&url, pins)
            .map_err(|_| SyncDeviceError::Transport)?;
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
    let (url, pins) = endpoint_from_host(host, io).await?;
    let path = profile_path(&account_hash, &profile_id);
    let token = auth.token_hex.clone();
    let blob = crate::task::run_blocking(move || -> Result<Option<Vec<u8>>, SyncDeviceError> {
        let transport = super::http_transport::build_transport(&url, pins)
            .map_err(|_| SyncDeviceError::Transport)?;
        let resp = transport
            .request(HttpMethod::Get, &path, &[], Some(&token))
            .map_err(|_| SyncDeviceError::Transport)?;
        match resp.status {
            200 => Ok(Some(resp.body)),
            404 => Ok(None),
            401 | 403 => Err(SyncDeviceError::Unauthenticated),
            _ => Err(SyncDeviceError::Transport),
        }
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
        let err = register_and_enroll_person(&t, &person_id, &[0u8; 32]).unwrap_err();
        assert_eq!(err, EnrollError::Unauthenticated);

        let reqs = t.requests();
        assert_eq!(reqs.len(), 1, "register must run before any init: {reqs:?}");
        assert_eq!(reqs[0].1, "/auth/register");

        let body: serde_json::Value = serde_json::from_slice(&reqs[0].2).expect("register json");
        assert_eq!(body["account_hash_hex"], "11".repeat(16));
        assert_eq!(body["username"], "11".repeat(16));
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
}
