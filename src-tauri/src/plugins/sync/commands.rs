//! `sync` plugin command handlers (MYND-424 task 3).
//!
//! v0.1 surface is the **endpoint-config** pair (SYNC-14) — the only commands
//! reachable pre-auth. The data-plane commands (push/pull/sync-now/status) land
//! in later tasks and will be gated on an authenticated session (deny-by-default
//! holds: nothing here moves vault bytes).
//!
//! The endpoint config is device-local plaintext app-config; it is read/written
//! at `<app_config_dir>/sync-config.json` and is NOT gated on `Slot::Unlocked`
//! (an operator configures the server before unlocking/enrolling).

use super::config::{
    read_config, validate_endpoint_url, write_config, SyncConfigError, SyncEndpointConfig,
};
use serde::Serialize;
use std::path::PathBuf;
use tauri::{AppHandle, Manager, Runtime};

/// The runtime sync status surfaced to the UI (MYND-424 task 10). The live
/// `syncing` / `error` / `conflicts` states light up once the engine loop is
/// wired over a real transport (task 2, R3-blocked); until then the status is
/// derived honestly from whether an endpoint is configured.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "state", rename_all = "snake_case")]
pub enum SyncRuntimeStatus {
    /// No endpoint configured — sync is off.
    Disabled,
    /// Configured and idle (no sync in flight).
    Idle,
    /// A pull/push is in flight.
    Syncing,
    /// The last sync attempt failed.
    Error {
        /// A bounded, non-secret reason tag.
        detail: String,
    },
    /// Unresolved conflict copies are present (count surfaced to the UI).
    Conflicts {
        /// Number of `conflict:`-marked notes awaiting resolution.
        count: u32,
    },
}

/// Resolve `<app_config_dir>/sync-config.json` (the `themes` plugin precedent).
fn config_path<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf, SyncConfigError> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|_| SyncConfigError::Io {
            io_error_kind: crate::io_failure_kind::IoFailureKind::Other,
        })?;
    std::fs::create_dir_all(&dir)?;
    Ok(dir.join("sync-config.json"))
}

/// Read the device-local sync endpoint config. Absent → `{ endpoint_url: null }`.
#[tauri::command]
pub async fn sync_get_endpoint<R: Runtime>(
    app: AppHandle<R>,
) -> Result<SyncEndpointConfig, SyncConfigError> {
    let path = config_path(&app)?;
    read_config(&path)
}

/// Set (or clear, with `None`) the device-local sync endpoint URL. Validates the
/// URL against the A4/TB5 policy before persisting (atomic replace).
#[tauri::command]
pub async fn sync_set_endpoint<R: Runtime>(
    app: AppHandle<R>,
    endpoint_url: Option<String>,
) -> Result<(), SyncConfigError> {
    if let Some(url) = endpoint_url.as_deref() {
        validate_endpoint_url(url)?;
    }
    let path = config_path(&app)?;
    write_config(&path, &SyncEndpointConfig { endpoint_url })
}

/// Derive the runtime status from the available signals. With the engine loop
/// not yet live over a real transport (task 2, R3-blocked), the honest status is
/// `Disabled` when unconfigured, else `Idle`. When the loop lands, this reads the
/// engine's in-flight / error / conflict-count state instead.
fn derive_status<R: Runtime>(app: &AppHandle<R>) -> Result<SyncRuntimeStatus, SyncConfigError> {
    let cfg = read_config(&config_path(app)?)?;
    Ok(match cfg.endpoint_url {
        None => SyncRuntimeStatus::Disabled,
        Some(_) => SyncRuntimeStatus::Idle,
    })
}

/// Report the current sync status for the status indicator (task 10).
#[tauri::command]
pub async fn sync_status<R: Runtime>(
    app: AppHandle<R>,
) -> Result<SyncRuntimeStatus, SyncConfigError> {
    derive_status(&app)
}

/// Outcome of one orchestrated sync cycle, shared by `sync_now` (manual) and the
/// background loop (`loop_control`). Honest "not ready" states (locked /
/// unenrolled) are distinct from a genuine transport/protocol failure.
pub enum CycleOutcome {
    /// No endpoint configured — sync is off.
    Disabled,
    /// Configured, but the vault is locked or this device is not enrolled.
    NotReady,
    /// One cycle ran; carries what it moved (pulled / pushed counts).
    Ran(super::orchestrator::SyncSummary),
    /// A transport / protocol failure.
    Failed,
}

/// Gather the active vault's sync inputs (endpoint, enrollment identity, token,
/// `root_key`) and run one [`run_sync_cycle`](super::orchestrator::run_sync_cycle)
/// off-thread. `allow_push=false` is a poll-driven pull-only cycle (coalescing —
/// see `loop_control`); `true` also pushes pending local changes. Used by both
/// the `sync_now` command and the background loop, so the gathering lives once.
pub async fn run_active_cycle<R: Runtime>(app: &AppHandle<R>, allow_push: bool) -> CycleOutcome {
    let Ok(cfg) = config_path(app).and_then(|p| read_config(&p)) else {
        return CycleOutcome::Failed;
    };
    let Some(url) = cfg.endpoint_url else {
        return CycleOutcome::Disabled;
    };
    let Some(state) = app.try_state::<VaultRuntimeState>() else {
        return CycleOutcome::NotReady;
    };
    let Ok(dir) = crate::paths::active_vault_root_io(app, state.active_vault_id().await) else {
        return CycleOutcome::NotReady;
    };
    let st = super::state::read_sync_state(&dir).unwrap_or_default();
    let (Some(acct_hex), Some(dev_hex)) = (st.account_hash_hex, st.device_id_hex) else {
        return CycleOutcome::NotReady; // not enrolled
    };
    let (Some(account_hash), Some(device_id)) = (hex16(&acct_hex), hex16(&dev_hex)) else {
        return CycleOutcome::Failed;
    };
    let token = match super::token_store::read_token_fallback(&dir) {
        Ok(Some(t)) => t,
        _ => return CycleOutcome::NotReady, // no token → not enrolled
    };
    let Some(root_key) = state.peek_unlocked_root_key_clone().await else {
        return CycleOutcome::NotReady; // vault locked
    };

    let mut token_hex = String::with_capacity(token.len() * 2);
    for b in &token {
        token_hex.push_str(&format!("{b:02x}"));
    }
    let notes_dir = dir.join("notes");

    let res = tokio::task::spawn_blocking(move || {
        let transport = super::http_transport::build_transport(&url, Vec::new()).map_err(|_| ())?;
        super::orchestrator::run_sync_cycle(
            transport.as_ref(),
            &root_key,
            account_hash,
            device_id,
            &token_hex,
            &notes_dir,
            &dir,
            allow_push,
        )
        .map_err(|_| ())
    })
    .await;

    match res {
        Ok(Ok(summary)) => CycleOutcome::Ran(summary),
        _ => CycleOutcome::Failed,
    }
}

/// Request an immediate sync ("sync now" affordance, task 10). Runs one real
/// full cycle (pull head-verify + rollback-reject → download → write to disk →
/// push local changes under a fresh head → persist). Returns the resulting
/// status — `Disabled`/`Idle` for the honest not-ready states, `Error` only on a
/// genuine transport/protocol failure.
#[tauri::command]
pub async fn sync_now<R: Runtime>(app: AppHandle<R>) -> Result<SyncRuntimeStatus, SyncConfigError> {
    Ok(match run_active_cycle(&app, true).await {
        CycleOutcome::Disabled => SyncRuntimeStatus::Disabled,
        CycleOutcome::NotReady | CycleOutcome::Ran(_) => SyncRuntimeStatus::Idle,
        CycleOutcome::Failed => SyncRuntimeStatus::Error {
            detail: "sync_failed".into(),
        },
    })
}

// --- Device management commands (MYND-425 tasks 7/8) ---
//
// Authed device roster + approve/remove over the server auth surface. The token
// comes from the device-local token store (task 4 fallback); the transport from
// the configured endpoint via the build_transport factory (loopback-http for
// dev/harness, pinned rustls for https). No root_key needed (device-mgmt is
// token-authed); enrollment (which needs root_key) is a separate command.

use super::devices::{self, DeviceEntry, DeviceMgmtError};
use super::transport::SyncTransport;
use crate::plugins::vault_unlock::state::VaultRuntimeState;
use tauri::State;

/// Device-management command failures (serde-serialized to the WebView).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "kind")]
pub enum SyncDeviceError {
    /// No sync endpoint configured (SYNC-14).
    NotConfigured,
    /// No per-device token stored — this device is not enrolled.
    NotEnrolled,
    /// The server rejected the token (revoked / invalid).
    Unauthenticated,
    /// The named device is not on the account.
    DeviceNotFound,
    /// Transport / server / internal failure.
    Transport,
    /// Bad input (e.g. malformed device id).
    BadRequest,
    /// Internal (task join, IO).
    Internal,
}

impl SyncDeviceError {
    fn from_mgmt(e: DeviceMgmtError) -> Self {
        match e {
            DeviceMgmtError::Unauthenticated => SyncDeviceError::Unauthenticated,
            DeviceMgmtError::DeviceNotFound => SyncDeviceError::DeviceNotFound,
            _ => SyncDeviceError::Transport,
        }
    }
}

fn hex16(s: &str) -> Option<[u8; 16]> {
    if s.len() != 32 || !s.bytes().all(|b| b.is_ascii_hexdigit()) {
        return None;
    }
    let mut out = [0u8; 16];
    for (i, byte) in out.iter_mut().enumerate() {
        *byte = u8::from_str_radix(&s[i * 2..i * 2 + 2], 16).ok()?;
    }
    Some(out)
}

/// Resolve the per-device token (hex) + a transport for the configured endpoint.
async fn authed_transport<R: Runtime>(
    app: &AppHandle<R>,
    state: &VaultRuntimeState,
) -> Result<(String, Box<dyn SyncTransport>), SyncDeviceError> {
    let dir = crate::paths::active_vault_root_io(app, state.active_vault_id().await)
        .map_err(|_| SyncDeviceError::Internal)?;
    let token = super::token_store::read_token_fallback(&dir)
        .map_err(|_| SyncDeviceError::Internal)?
        .ok_or(SyncDeviceError::NotEnrolled)?;
    let mut token_hex = String::with_capacity(token.len() * 2);
    for b in &token {
        token_hex.push_str(&format!("{b:02x}"));
    }
    let cfg_path = config_path(app).map_err(|_| SyncDeviceError::Internal)?;
    let cfg = read_config(&cfg_path).map_err(|_| SyncDeviceError::NotConfigured)?;
    let url = cfg.endpoint_url.ok_or(SyncDeviceError::NotConfigured)?;
    let transport = super::http_transport::build_transport(&url, Vec::new())
        .map_err(|_| SyncDeviceError::Transport)?;
    Ok((token_hex, transport))
}

/// List the account's devices (the device-list UI + pending-discovery render).
#[tauri::command]
pub async fn sync_list_devices<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, VaultRuntimeState>,
) -> Result<Vec<DeviceEntry>, SyncDeviceError> {
    let (token, transport) = authed_transport(&app, state.inner()).await?;
    tokio::task::spawn_blocking(move || devices::list_devices(transport.as_ref(), &token))
        .await
        .map_err(|_| SyncDeviceError::Internal)?
        .map_err(SyncDeviceError::from_mgmt)
}

/// Approve a pending device (the existing unlocked device authorizes it).
#[tauri::command]
pub async fn sync_approve_device<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, VaultRuntimeState>,
    device_id_hex: String,
) -> Result<(), SyncDeviceError> {
    let id = hex16(&device_id_hex).ok_or(SyncDeviceError::BadRequest)?;
    let (token, transport) = authed_transport(&app, state.inner()).await?;
    tokio::task::spawn_blocking(move || devices::approve_device(transport.as_ref(), &token, &id))
        .await
        .map_err(|_| SyncDeviceError::Internal)?
        .map_err(SyncDeviceError::from_mgmt)
}

/// Remove a device — revoke its token (availability; not a crypto lockout, SYNC-2).
#[tauri::command]
pub async fn sync_remove_device<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, VaultRuntimeState>,
    device_id_hex: String,
) -> Result<(), SyncDeviceError> {
    let id = hex16(&device_id_hex).ok_or(SyncDeviceError::BadRequest)?;
    let (token, transport) = authed_transport(&app, state.inner()).await?;
    tokio::task::spawn_blocking(move || devices::revoke_device(transport.as_ref(), &token, &id))
        .await
        .map_err(|_| SyncDeviceError::Internal)?
        .map_err(SyncDeviceError::from_mgmt)
}

// --- Enrollment command (MYND-425 task 5; bootstrap resolved) ---
//
// New-device enrollment: fetch vault.meta (pre-auth, by account_number_hash) →
// derive root_key from {account# + password} OR {account# + 24-word phrase} →
// ServerAuth secret = DeriveSubkey(root_key, ServerAuth) → SCRAM enroll → store
// the per-device token. The vault.meta is AEAD-protected (useless without the
// credential), so fetching it by account# is the accepted A4-equivalent exposure
// (the same posture as 24-word recovery). The heavy Argon2id + the blocking
// transport run in spawn_blocking; the credential is Zeroizing-wrapped.

use super::enroll::{self, EnrollPath};
use protocol::{
    aad_password_wrap, aad_recovery_wrap, aead_open_ctx, derive_password_wrap_key,
    derive_recovery_wrap_key_from_normalized, derive_subkey, normalize_user_phrase,
    parse_account_number, parse_vault_meta, SubkeyRole, AEAD_KEY_LEN,
};
use zeroize::Zeroizing;

/// Which credential the enrolling device proves account ownership with.
#[derive(Debug, Clone, Copy, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum EnrollCredential {
    Password,
    Recovery,
}

/// Outcome of an enrollment attempt surfaced to the UI.
#[derive(Debug, Clone, Serialize)]
pub struct EnrollResult {
    /// True when the device was approved + a token issued (false = pending approval).
    pub approved: bool,
}

/// Enroll this device against the configured server using {account# + credential}.
#[tauri::command]
pub async fn sync_enroll<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, VaultRuntimeState>,
    account_number: String,
    credential: String,
    credential_kind: EnrollCredential,
) -> Result<EnrollResult, SyncDeviceError> {
    let credential = Zeroizing::new(credential);

    // Resolve the vault dir (token storage) + the endpoint transport.
    let dir = crate::paths::active_vault_root_io(&app, state.active_vault_id().await)
        .map_err(|_| SyncDeviceError::Internal)?;
    let cfg_path = config_path(&app).map_err(|_| SyncDeviceError::Internal)?;
    let cfg = read_config(&cfg_path).map_err(|_| SyncDeviceError::NotConfigured)?;
    let url = cfg.endpoint_url.ok_or(SyncDeviceError::NotConfigured)?;

    let account =
        parse_account_number(account_number.trim()).map_err(|_| SyncDeviceError::BadRequest)?;
    let path = match credential_kind {
        EnrollCredential::Password => EnrollPath::Password,
        EnrollCredential::Recovery => EnrollPath::Recovery,
    };
    // The SCRAM username is the canonical account number (stable per account).
    let username = account.display.clone();

    let outcome = tokio::task::spawn_blocking(move || -> Result<bool, SyncDeviceError> {
        let transport = super::http_transport::build_transport(&url, Vec::new())
            .map_err(|_| SyncDeviceError::Transport)?;

        // 1. Obtain vault.meta. A returning device fetches it pre-auth from the
        //    server; the FIRST device (the owner enabling sync) has no server
        //    copy yet (404) and falls back to its local vault.meta — which it
        //    seeds to the server after enrolling (step 6).
        let acct_hex = {
            let mut s = String::with_capacity(32);
            for b in &account.hash {
                s.push_str(&format!("{b:02x}"));
            }
            s
        };
        let meta_resp = transport
            .request(
                super::transport::HttpMethod::Get,
                &format!("/vault.meta?account={acct_hex}"),
                &[],
                None,
            )
            .map_err(|_| SyncDeviceError::Transport)?;
        let meta_bytes: Vec<u8> = match meta_resp.status {
            200 => meta_resp.body,
            404 => std::fs::read(dir.join("vault.meta")).map_err(|_| SyncDeviceError::Transport)?,
            _ => return Err(SyncDeviceError::Transport),
        };
        let meta = parse_vault_meta(&meta_bytes).map_err(|_| SyncDeviceError::Internal)?;

        // 2. Derive root_key from the credential + the meta salts.
        let root_key: Zeroizing<[u8; AEAD_KEY_LEN]> = match path {
            EnrollPath::Password => {
                let wrap = derive_password_wrap_key(
                    &credential,
                    &meta.random_salt_password,
                    &meta.account_number_hash,
                    &meta.kdf_params,
                )
                .map_err(|_| SyncDeviceError::BadRequest)?;
                let opened = aead_open_ctx(
                    &wrap,
                    &meta.nonce_password_wrap,
                    &meta.enc_root_key_password,
                    &aad_password_wrap(&meta.kdf_params),
                )
                .map_err(|_| SyncDeviceError::BadRequest)?;
                let mut rk = Zeroizing::new([0u8; AEAD_KEY_LEN]);
                if opened.len() != AEAD_KEY_LEN {
                    return Err(SyncDeviceError::Internal);
                }
                rk.copy_from_slice(&opened);
                rk
            }
            EnrollPath::Recovery => {
                let normalized = normalize_user_phrase(&credential);
                let wrap = derive_recovery_wrap_key_from_normalized(
                    normalized.as_str(),
                    &meta.random_salt_recovery,
                    &meta.account_number_hash,
                    &meta.kdf_params,
                )
                .map_err(|_| SyncDeviceError::BadRequest)?;
                let opened = aead_open_ctx(
                    &wrap,
                    &meta.nonce_recovery_wrap,
                    &meta.enc_root_key_recovery,
                    &aad_recovery_wrap(&meta.kdf_params),
                )
                .map_err(|_| SyncDeviceError::BadRequest)?;
                let mut rk = Zeroizing::new([0u8; AEAD_KEY_LEN]);
                if opened.len() != AEAD_KEY_LEN {
                    return Err(SyncDeviceError::Internal);
                }
                rk.copy_from_slice(&opened);
                rk
            }
        };

        // 3. ServerAuth secret.
        let secret = derive_subkey(&root_key, SubkeyRole::ServerAuth);

        // 4. Register the SCRAM verifier (idempotent — a 409 already_registered
        //    is success; the first device's stored salt is what every later
        //    handshake reuses). Keyed on the canonical `account.hash` (the same
        //    value the server namespaces on), so register + enroll agree.
        enroll::register_verifier(
            transport.as_ref(),
            &account.hash,
            &username,
            secret.as_slice(),
        )
        .map_err(|_| SyncDeviceError::Transport)?;

        // 5. SCRAM enroll.
        let device_id = enroll::generate_device_id();
        let mut nonce_bytes = [0u8; 16];
        getrandom::getrandom(&mut nonce_bytes).map_err(|_| SyncDeviceError::Internal)?;
        let mut client_nonce = String::with_capacity(32);
        for b in &nonce_bytes {
            client_nonce.push_str(&format!("{b:02x}"));
        }

        let out = enroll::enroll(
            transport.as_ref(),
            &account.hash,
            &username,
            secret.as_slice(),
            path,
            &client_nonce,
            device_id,
        )
        .map_err(|_| SyncDeviceError::Unauthenticated)?;

        // 6. On approval: store the token, seed vault.meta to the server (so the
        //    next device can fetch it), and persist the account/device identity
        //    sync_now needs to author heads.
        if out.approved && !out.token.is_empty() {
            super::token_store::store_token_fallback(&dir, &out.token)
                .map_err(|_| SyncDeviceError::Internal)?;
            let mut token_hex = String::with_capacity(out.token.len() * 2);
            for b in &out.token {
                token_hex.push_str(&format!("{b:02x}"));
            }
            // Best-effort seed (a returning device's meta already matches).
            let _ = enroll::put_vault_meta(transport.as_ref(), &token_hex, &meta_bytes);

            let mut st = super::state::read_sync_state(&dir).unwrap_or_default();
            st.account_hash_hex = Some(acct_hex.clone());
            let mut dev_hex = String::with_capacity(32);
            for b in &device_id {
                dev_hex.push_str(&format!("{b:02x}"));
            }
            st.device_id_hex = Some(dev_hex);
            let _ = super::state::write_sync_state(&dir, &st);
        }
        Ok(out.approved)
    })
    .await
    .map_err(|_| SyncDeviceError::Internal)??;

    Ok(EnrollResult { approved: outcome })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hex16_accepts_valid_lowercase() {
        // 32 lowercase hex chars → the exact 16 bytes they encode.
        let id = hex16("0123456789abcdeffedcba9876543210").expect("valid lowercase hex");
        assert_eq!(
            id,
            [
                0x01, 0x23, 0x45, 0x67, 0x89, 0xab, 0xcd, 0xef, 0xfe, 0xdc, 0xba, 0x98, 0x76, 0x54,
                0x32, 0x10,
            ]
        );
    }

    #[test]
    fn hex16_accepts_valid_uppercase() {
        // Uppercase hex is accepted (is_ascii_hexdigit covers A–F) and decodes
        // to the same bytes as the lowercase spelling.
        let id = hex16("0123456789ABCDEFFEDCBA9876543210").expect("valid uppercase hex");
        assert_eq!(
            id,
            [
                0x01, 0x23, 0x45, 0x67, 0x89, 0xab, 0xcd, 0xef, 0xfe, 0xdc, 0xba, 0x98, 0x76, 0x54,
                0x32, 0x10,
            ]
        );
    }

    #[test]
    fn hex16_mixed_case_accepted() {
        // Mixed case must not be rejected — it is valid hex.
        assert!(hex16("AbCdEf0123456789aBcDeF0123456789").is_some());
    }

    #[test]
    fn hex16_rejects_short_length() {
        // 31 chars — one short of the required 32.
        assert!(hex16("0123456789abcdeffedcba987654321").is_none());
    }

    #[test]
    fn hex16_rejects_long_length() {
        // 33 chars — one over the required 32.
        assert!(hex16("0123456789abcdeffedcba98765432100").is_none());
    }

    #[test]
    fn hex16_rejects_empty() {
        assert!(hex16("").is_none());
    }

    #[test]
    fn hex16_rejects_non_hex_chars() {
        // 'g' is not a hex digit (wrong char, correct length).
        assert!(hex16("0123456789abcdeffedcba987654321g").is_none());
        // A unicode/punctuation char at correct length is also rejected.
        assert!(hex16("0123456789abcdeffedcba98765432-0").is_none());
        // Whitespace is not a hex digit.
        assert!(hex16("0123456789abcdef fedcba9876543210").is_none());
    }

    #[test]
    fn hex16_round_trips_known_bytes() {
        // [u8;16] → lowercase hex via the same `{:02x}` formatting the
        // production code uses (see token_hex / acct_hex above) → hex16 → bytes.
        let bytes: [u8; 16] = [
            0x00, 0xff, 0x10, 0x20, 0x30, 0x40, 0x50, 0x60, 0x70, 0x80, 0x90, 0xa0, 0xb0, 0xc0,
            0xde, 0xad,
        ];
        let mut hex = String::with_capacity(32);
        for b in &bytes {
            hex.push_str(&format!("{b:02x}"));
        }
        assert_eq!(hex.len(), 32);
        let back = hex16(&hex).expect("round-trip hex must parse");
        assert_eq!(back, bytes);
    }
}
