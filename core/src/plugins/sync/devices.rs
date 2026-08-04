//! Device-management client (MYND-425 tasks 6 + 9): the authed device roster +
//! approval gate + token revocation over the server auth surface.
//!
//! - [`list_devices`] — `GET /auth/devices` → the roster (the input the device
//!   list UI + the pending-discovery render). Pending devices are the entries
//!   with `approved == false`; the approving device shows them and calls
//!   [`approve_device`]. Discovery is **passive** — the roster is read on the
//!   existing sync poll, no new wake channel (SYNC-6).
//! - [`approve_device`] — `POST /auth/devices/approve` (the existing unlocked
//!   device approves a pending one). The pending device then re-runs the SCRAM
//!   enroll to collect its token (CompleteApproval, server-side).
//! - [`revoke_device`] — `POST /auth/devices/revoke` ("Remove device"): revokes
//!   the token (sync stops to that device) + retires the registry record. The
//!   `device_id` is NOT destroyed (SYNC-2); this is availability, not a
//!   cryptographic lockout (the honest copy in `load-bearing-copy.ts`).
//!
//! All three are authed via the caller's per-device token (Bearer).

use super::transport::{HttpMethod, SyncTransport, TransportError};
use serde::{Deserialize, Serialize};

/// One device in the roster.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
pub struct DeviceEntry {
    /// 16-byte device_id, hex.
    pub device_id_hex: String,
    /// True once approved (false = pending the approval gate).
    pub approved: bool,
    /// True once retired (removed).
    pub retired: bool,
    /// True for the device this client is running on (the roster the server
    /// returns never sets it — `sync_list_devices` marks it client-side by
    /// matching the locally-stored `device_id`). Lets the UI badge "This device".
    #[serde(default)]
    pub is_current: bool,
}

#[derive(Debug, Clone, Deserialize)]
struct DevicesResp {
    #[serde(default)]
    devices: Vec<DeviceEntry>,
}

/// Device-management failures.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DeviceMgmtError {
    /// 401 — token rejected / revoked.
    Unauthenticated,
    /// 404 — the named device is not on the account.
    DeviceNotFound,
    /// Malformed server response.
    BadResponse,
    /// Transport-level failure.
    Transport(TransportError),
}

impl From<TransportError> for DeviceMgmtError {
    fn from(e: TransportError) -> Self {
        DeviceMgmtError::Transport(e)
    }
}

use super::to_hex as hex_encode;

/// Read the device roster (authed). The list UI renders this; pending discovery
/// is `entries.iter().filter(|d| !d.approved)`.
pub fn list_devices(
    transport: &dyn SyncTransport,
    token: &str,
) -> Result<Vec<DeviceEntry>, DeviceMgmtError> {
    let resp = transport.request(HttpMethod::Get, "/auth/devices", &[], Some(token))?;
    match resp.status {
        200 => {
            let wire: DevicesResp =
                serde_json::from_slice(&resp.body).map_err(|_| DeviceMgmtError::BadResponse)?;
            let mut devices = wire.devices;
            // Defensive deterministic order (MYND-588). The server SHOULD return a
            // stable order, but a client talks to arbitrary — possibly older —
            // self-hosted servers (TB5) and cannot assume it was fixed: an unsorted
            // server hands back a freshly shuffled roster on every poll, so the list
            // teleports under the cursor (a wrong-device-removal hazard on the
            // per-row Remove button). Sort by the immutable `device_id_hex`, never a
            // name or last-activity (those would jump rows on rename/sync — the same
            // bug in a subtler form). `is_current` is stamped by the caller and does
            // not reorder.
            devices.sort_by(|a, b| a.device_id_hex.cmp(&b.device_id_hex));
            Ok(devices)
        }
        401 => Err(DeviceMgmtError::Unauthenticated),
        _ => Err(DeviceMgmtError::BadResponse),
    }
}

/// Filter the roster to the pending (awaiting-approval) devices.
pub fn pending_devices(roster: &[DeviceEntry]) -> Vec<&DeviceEntry> {
    roster
        .iter()
        .filter(|d| !d.approved && !d.retired)
        .collect()
}

fn device_action(
    transport: &dyn SyncTransport,
    token: &str,
    path: &str,
    device_id: &[u8; 16],
) -> Result<(), DeviceMgmtError> {
    let body = format!("{{\"device_id_hex\":\"{}\"}}", hex_encode(device_id)).into_bytes();
    let resp = transport.request(HttpMethod::Post, path, &body, Some(token))?;
    match resp.status {
        200 => Ok(()),
        401 => Err(DeviceMgmtError::Unauthenticated),
        404 => Err(DeviceMgmtError::DeviceNotFound),
        _ => Err(DeviceMgmtError::BadResponse),
    }
}

/// Approve a pending device (the existing unlocked device authorizes it).
///
/// Gated on `Slot::Unlocked`, which makes that sentence true rather than
/// aspirational (myne#382). The reason here is UNIFORMITY, not data loss —
/// approving destroys nothing local — and the gate lives in this function
/// rather than in `authed_transport_from_host`, through which the read-only
/// roster calls and the deliberately pre-unlock `sync_reset_local` also route.
///
/// It refuses nothing a user can reach: every client opens this panel only
/// post-unlock (desktop `SyncPanel` → `SettingsModal`, mounted only by the
/// editor screen; mobile the same through `SettingsSheet`). That is an audited
/// claim about reachability rather than a compiler-checked one, and
/// `sync-replication.e2e.ts` `sr1` is what would notice if a future
/// "approve from the pending screen" affordance broke it.
pub fn approve_device(
    transport: &dyn SyncTransport,
    token: &str,
    device_id: &[u8; 16],
) -> Result<(), DeviceMgmtError> {
    device_action(transport, token, "/auth/devices/approve", device_id)
}

/// Revoke a device's token ("Remove device" — availability only, SYNC-2).
pub fn revoke_device(
    transport: &dyn SyncTransport,
    token: &str,
    device_id: &[u8; 16],
) -> Result<(), DeviceMgmtError> {
    device_action(transport, token, "/auth/devices/revoke", device_id)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::plugins::sync::transport::FakeTransport;

    /// The two device MUTATIONS refuse before they resolve a vault root or read
    /// a token, when nothing is unlocked (myne#382).
    ///
    /// Driven with `TestHost`, NOT `NoopHost`: `NoopHost::app_data_dir()` fails,
    /// so the ungated path would answer `Internal` anyway and the test would
    /// pass against the unfixed tree, proving nothing. With a real scratch root
    /// the ungated path resolves it, finds no token file and answers
    /// `NotEnrolled`; the gated one answers `Internal` without touching disk.
    ///
    /// A valid 32-char hex device id, so the assertion still reaches the guard
    /// if a later refactor moves it below `hex16`.
    #[test]
    fn device_mutations_refuse_while_locked() {
        crate::test_support::block_on(async {
            let tmp = crate::test_support::ScopedTempDir::new("devices-locked").unwrap();
            let host = crate::host::test_host::TestHost::new(tmp.path());
            let state = crate::plugins::vault_unlock::state::VaultRuntimeState::default();
            let io = &crate::vault_io::StdVaultIo;
            let id = "01".repeat(16);

            assert_eq!(
                approve_device_from_host(&host, io, &state, &id).await,
                Err(SyncDeviceError::Internal),
            );
            assert_eq!(
                remove_device_from_host(&host, io, &state, &id).await,
                Err(SyncDeviceError::Internal),
            );
        });
    }

    /// Moved here from `commands` with the function (MYND-635). It gains
    /// coverage rather than losing it: `commands` is `tauri-ipc`-gated, so this
    /// golden vector was never checked on the wasm build — which now uses the
    /// same encoding for the same eye-compare.
    #[test]
    fn head_fingerprint_of_hex_matches_golden_vector() {
        use protocol::HEAD_ID_LEN;
        // head-fingerprint/v0.1/all-zero golden: head_id = 0x00×32 → "TYRS-N318".
        // Proves the encoding delegates to the vector-locked primitive verbatim
        // (no re-derivation, one encoding — SYNC-17).
        let all_zero = "0".repeat(HEAD_ID_LEN * 2);
        assert_eq!(
            head_fingerprint_of_hex(&all_zero),
            Some(String::from("TYRS-N318"))
        );
        // Malformed input → None (no panic, no fallback encoding).
        assert_eq!(
            head_fingerprint_of_hex(
                "not-hex-not-hex-not-hex-not-hex-not-hex-not-hex-not-hex-not-hex!"
            ),
            None
        );
        assert_eq!(head_fingerprint_of_hex("00"), None); // wrong length
    }

    fn roster_json() -> Vec<u8> {
        b"{\"devices\":[\
            {\"device_id_hex\":\"01010101010101010101010101010101\",\"approved\":true,\"retired\":false},\
            {\"device_id_hex\":\"02020202020202020202020202020202\",\"approved\":false,\"retired\":false}\
        ]}"
        .to_vec()
    }

    #[test]
    fn list_devices_parses_roster() {
        let t = FakeTransport::new();
        t.on(HttpMethod::Get, "/auth/devices", 200, roster_json());
        let devices = list_devices(&t, "tok").unwrap();
        assert_eq!(devices.len(), 2);
        assert!(devices[0].approved);
        assert!(!devices[1].approved);
        // The request carried the bearer token.
        assert_eq!(t.requests()[0].3.as_deref(), Some("tok"));
    }

    #[test]
    fn list_devices_sorts_by_device_id_hex() {
        // MYND-588: the server may return the roster in any order (a Go map's
        // iteration is randomised). The client sorts defensively so an older /
        // unfixed server cannot reshuffle rows under the cursor. Feed a scrambled
        // wire order and assert it comes back sorted by device_id_hex.
        let t = FakeTransport::new();
        t.on(
            HttpMethod::Get,
            "/auth/devices",
            200,
            b"{\"devices\":[\
                {\"device_id_hex\":\"03030303030303030303030303030303\",\"approved\":true,\"retired\":false},\
                {\"device_id_hex\":\"01010101010101010101010101010101\",\"approved\":true,\"retired\":false},\
                {\"device_id_hex\":\"02020202020202020202020202020202\",\"approved\":false,\"retired\":false}\
            ]}"
            .to_vec(),
        );
        let order: Vec<String> = list_devices(&t, "tok")
            .unwrap()
            .into_iter()
            .map(|d| d.device_id_hex)
            .collect();
        assert_eq!(
            order,
            vec![
                "01010101010101010101010101010101",
                "02020202020202020202020202020202",
                "03030303030303030303030303030303",
            ]
        );
    }

    #[test]
    fn pending_filter_finds_unapproved() {
        let t = FakeTransport::new();
        t.on(HttpMethod::Get, "/auth/devices", 200, roster_json());
        let devices = list_devices(&t, "tok").unwrap();
        let pending = pending_devices(&devices);
        assert_eq!(pending.len(), 1);
        assert_eq!(pending[0].device_id_hex, "02020202020202020202020202020202");
    }

    #[test]
    fn approve_posts_device_id() {
        let t = FakeTransport::new();
        t.on(
            HttpMethod::Post,
            "/auth/devices/approve",
            200,
            b"{\"ok\":true}".to_vec(),
        );
        approve_device(&t, "tok", &[0x02; 16]).unwrap();
        let seen = t.requests();
        assert!(String::from_utf8_lossy(&seen[0].2).contains(&"02".repeat(16)));
    }

    #[test]
    fn revoke_posts_and_handles_404() {
        let t = FakeTransport::new();
        t.on(
            HttpMethod::Post,
            "/auth/devices/revoke",
            200,
            b"{\"ok\":true}".to_vec(),
        );
        revoke_device(&t, "tok", &[0x01; 16]).unwrap();

        let t404 = FakeTransport::new();
        t404.on(
            HttpMethod::Post,
            "/auth/devices/revoke",
            404,
            b"{\"error_code\":\"device_not_found\"}".to_vec(),
        );
        assert_eq!(
            revoke_device(&t404, "tok", &[0x09; 16]).unwrap_err(),
            DeviceMgmtError::DeviceNotFound
        );
    }

    #[test]
    fn unauthed_surfaces_401() {
        let t = FakeTransport::new();
        t.on(HttpMethod::Get, "/auth/devices", 401, b"{}".to_vec());
        assert_eq!(
            list_devices(&t, "bad").unwrap_err(),
            DeviceMgmtError::Unauthenticated
        );
    }
}

// ── the command cores, lifted out of the host-gated `commands.rs` ───────────
//
// phase3-web-client task 84. The three request builders above were already
// target-independent; what was not was everything AROUND them — resolving the
// vault root, reading the token, building the transport, and marking which
// roster row is this device. That lived in `commands.rs` behind `AppHandle`, so
// a browser could not reach it even though nothing in it is host-shaped.
//
// The blocking network call goes through `crate::task::run_blocking`, which is
// exactly the seam for this: `spawn_blocking` on the native arm (so a tokio
// worker is not parked on a round trip) and inline on wasm (where the Worker
// blocking IS the design — the transport is synchronous XHR by decision, task
// 35). One call site, two correct behaviours, no `cfg` here.

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
    /// A first-run bootstrap found a vault container already holding a
    /// **different** account (phase3-web-client task 85).
    ///
    /// Its own variant rather than a `BadRequest`, because the remedy is
    /// different in kind: nothing the user retypes fixes it. The container has
    /// to be erased first (task 72's "sign out and erase this browser's copy"),
    /// and a message telling them to check their password would send them round
    /// a loop that cannot terminate. Reachable only where one container is
    /// pinned to one constant id, i.e. the web client — a desktop mints a fresh
    /// id per join and never collides.
    AccountMismatch,
    /// Tor routing is on and the join carried no expected certificate
    /// fingerprint (MYND-650 task 5).
    ///
    /// Its own variant for the same reason `AccountMismatch` is: the remedy is
    /// different in kind. Nothing the user retypes about their account fixes
    /// it — they have to fetch the fingerprint their server publishes and
    /// supply it. **Nothing was written**: no endpoint, no pin, no vault.
    PinConfirmationRequired,
    /// The certificate served does not match the fingerprint the user
    /// confirmed (MYND-650 task 5) — a typo, or a man in the middle, and from
    /// here those are indistinguishable. The join aborts with nothing stored,
    /// and the captured fingerprint is deliberately not reported
    /// (`super::pin_confirm`'s module doc).
    FingerprintMismatch,
    /// The vault's Argon2id parameters are affordable to the protocol but not
    /// to this host (#349).
    ///
    /// `validate_kdf_params` accepts up to `MAX_KDF_M_KIB` (4 GiB); a host's
    /// own ceiling (`HostCtx::max_kdf_memory_kib`, 1 GiB in the browser) can be
    /// far lower. Passing the protocol range is therefore not the same as being
    /// derivable here, and an unaffordable `m_kib` aborts inside the allocation
    /// — in the browser, a dead Worker with no cause.
    ///
    /// Its own variant for the same reason `AccountMismatch` is: the remedy is
    /// different in kind. The credentials are right and re-typing them cannot
    /// help; the vault has to be opened on a machine that can afford its KDF.
    /// Reported rather than swallowed so the user is not sent round a
    /// check-your-password loop that cannot terminate.
    KdfTooLargeForHost,
    /// The account is FROZEN — the server said so, in the 403 body (#268).
    ///
    /// Its own variant for the same reason `AccountMismatch` is: the remedy is
    /// different in kind. The account number, password and phrase are all
    /// correct; re-typing them can never work. Flattened into
    /// `Unauthenticated`, it produced the non-distinguishing "Account number,
    /// password, or recovery phrase is incorrect" banner — a message the server
    /// had already contradicted.
    AccountFrozen,
    /// The account is at its device cap (server 403 `device_limit`, #268).
    /// Correct credentials, different remedy: remove a device first.
    DeviceLimitReached,
    /// The device is registered and still awaiting approval (server 403
    /// `pending_approval`, #268) — not a credential problem either.
    AwaitingApproval,
    /// Internal (task join, IO).
    Internal,
}

impl From<super::enroll::EnrollError> for SyncDeviceError {
    /// #268: preserve the reason the server gave.
    ///
    /// Both enrolment call sites used a blanket
    /// `.map_err(|_| SyncDeviceError::Unauthenticated)`, which flattened a
    /// frozen account, a hit device cap, a pending approval and a genuine
    /// credential failure into one message — and three of those four are not
    /// credential failures at all.
    fn from(e: super::enroll::EnrollError) -> Self {
        use super::enroll::EnrollError as E;
        match e {
            E::Frozen => SyncDeviceError::AccountFrozen,
            E::DeviceLimit => SyncDeviceError::DeviceLimitReached,
            E::PendingApproval => SyncDeviceError::AwaitingApproval,
            E::ServerSignatureMismatch => SyncDeviceError::FingerprintMismatch,
            E::Unauthenticated => SyncDeviceError::Unauthenticated,
            E::BadResponse | E::Transport(_) => SyncDeviceError::Transport,
        }
    }
}

/// The fingerprint gate's refusals, projected onto this command's enum
/// (MYND-650 task 5) — the twin of [`super::config::SyncConfigError`]'s impl.
/// See it for why this is a `From` rather than a `match` at the call site, and
/// why both are host-only.
#[cfg(not(target_arch = "wasm32"))]
impl From<super::pin_confirm::PinConfirmError> for SyncDeviceError {
    fn from(e: super::pin_confirm::PinConfirmError) -> Self {
        use super::pin_confirm::PinConfirmError as P;
        match e {
            P::ConfirmationRequired => SyncDeviceError::PinConfirmationRequired,
            P::FingerprintMismatch => SyncDeviceError::FingerprintMismatch,
            P::Transport => SyncDeviceError::Transport,
        }
    }
}

impl SyncDeviceError {
    pub(crate) fn from_mgmt(e: DeviceMgmtError) -> Self {
        match e {
            DeviceMgmtError::Unauthenticated => SyncDeviceError::Unauthenticated,
            DeviceMgmtError::DeviceNotFound => SyncDeviceError::DeviceNotFound,
            _ => SyncDeviceError::Transport,
        }
    }
}

/// Parse a 32-char hex device id.
pub fn hex16(s: &str) -> Option<[u8; 16]> {
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
///
/// The precondition for every authed command below, and the reason they could be
/// ported as a group: none of them needs `root_key` (device management is
/// token-authed), so this is the whole of what they required from the host.
pub async fn authed_transport_from_host(
    host: &dyn crate::host::HostCtx,
    io: &dyn crate::vault_io::VaultIo,
    state: &crate::plugins::vault_unlock::state::VaultRuntimeState,
) -> Result<(String, Box<dyn SyncTransport>), SyncDeviceError> {
    use super::token_store::TokenStore as _;
    let dir = crate::paths::active_vault_root_io_from_host(host, state.active_vault_id().await)
        .map_err(|_| SyncDeviceError::Internal)?;
    let token = super::token_store::default_store()
        .read(io, &dir)
        .await
        .map_err(|_| SyncDeviceError::Internal)?
        .ok_or(SyncDeviceError::NotEnrolled)?;
    let token_hex = super::to_hex(&token);
    let cfg_path = super::config::config_path_from_host(host, io)
        .await
        .map_err(|_| SyncDeviceError::Internal)?;
    let cfg = super::config::read_config(io, &cfg_path)
        .await
        .map_err(|_| SyncDeviceError::NotConfigured)?;
    let pins = super::config::config_pins(&cfg);
    let url = cfg.endpoint_url.ok_or(SyncDeviceError::NotConfigured)?;
    let transport = super::http_transport::build_transport(&url, pins)
        .map_err(|_| SyncDeviceError::Transport)?;
    Ok((token_hex, transport))
}

/// The server's `GET /account/status` projection (MYND-506 server-side; MYND-570
/// client surface). Mirrors `accountStatusView` in `myne-server`
/// (`internal/httpapi/server.go`) field-for-field.
///
/// Both ceilings are the **effective** values — the server resolves
/// `override ?? global default` through the same `EffectiveQuota` /
/// `EffectiveMaxDevices` functions its enforcement guard uses, so a reported
/// ceiling and a quota rejection cannot disagree. **`0` means unlimited**, never
/// a ceiling of zero; a client must not render a meter against it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AccountStatusView {
    /// Deduplicated ciphertext bytes stored for this account (the AS17 total).
    pub stored_bytes: u64,
    /// Enrolled, non-retired devices.
    pub device_count: u64,
    /// Operator freeze: push + enroll blocked, pull never blocked.
    pub frozen: bool,
    /// Effective storage ceiling in bytes; `0` = unlimited.
    pub quota_bytes: u64,
    /// Effective device cap; `0` = unlimited.
    pub max_devices: u64,
}

/// List the account's devices, marking which row is this device.
pub async fn list_devices_from_host(
    host: &dyn crate::host::HostCtx,
    io: &dyn crate::vault_io::VaultIo,
    state: &crate::plugins::vault_unlock::state::VaultRuntimeState,
) -> Result<Vec<DeviceEntry>, SyncDeviceError> {
    // The locally-stored device_id identifies which roster entry is "this
    // device" (the server roster never marks it — it cannot know which client is
    // asking). Read it BEFORE the transport call, which consumes the token.
    let current_device =
        match crate::paths::active_vault_root_io_from_host(host, state.active_vault_id().await) {
            // `.ok()` is deliberate HERE and nowhere else (task 86): nothing is
            // written back, and the only consequence of not knowing our own
            // `device_id` is that the roster does not mark which row is this
            // device. A cosmetic degrade on a read-only path.
            Ok(dir) => super::state::read_sync_state(io, &dir)
                .await
                .ok()
                .and_then(|st| st.device_id_hex),
            Err(_) => None,
        };
    let (token, transport) = authed_transport_from_host(host, io, state).await?;
    let mut roster = crate::task::run_blocking(move || list_devices(transport.as_ref(), &token))
        .await
        .map_err(|_| SyncDeviceError::Internal)?
        .map_err(SyncDeviceError::from_mgmt)?;
    for d in &mut roster {
        d.is_current = Some(&d.device_id_hex) == current_device.as_ref();
    }
    Ok(roster)
}

/// Approve a pending device (the existing unlocked device authorizes it).
pub async fn approve_device_from_host(
    host: &dyn crate::host::HostCtx,
    io: &dyn crate::vault_io::VaultIo,
    state: &crate::plugins::vault_unlock::state::VaultRuntimeState,
    device_id_hex: &str,
) -> Result<(), SyncDeviceError> {
    use crate::plugins::vault_unlock::state::SlotKind;
    if !matches!(state.slot_kind_active().await, SlotKind::Unlocked) {
        return Err(SyncDeviceError::Internal);
    }

    let id = hex16(device_id_hex).ok_or(SyncDeviceError::BadRequest)?;
    let (token, transport) = authed_transport_from_host(host, io, state).await?;
    crate::task::run_blocking(move || approve_device(transport.as_ref(), &token, &id))
        .await
        .map_err(|_| SyncDeviceError::Internal)?
        .map_err(SyncDeviceError::from_mgmt)
}

/// Remove a device — revoke its token (availability; not a crypto lockout, SYNC-2).
///
/// Gated on `Slot::Unlocked` for the same reason as its sibling above:
/// uniformity, not data loss. See `approve_device_from_host`.
pub async fn remove_device_from_host(
    host: &dyn crate::host::HostCtx,
    io: &dyn crate::vault_io::VaultIo,
    state: &crate::plugins::vault_unlock::state::VaultRuntimeState,
    device_id_hex: &str,
) -> Result<(), SyncDeviceError> {
    use crate::plugins::vault_unlock::state::SlotKind;
    if !matches!(state.slot_kind_active().await, SlotKind::Unlocked) {
        return Err(SyncDeviceError::Internal);
    }

    let id = hex16(device_id_hex).ok_or(SyncDeviceError::BadRequest)?;
    let (token, transport) = authed_transport_from_host(host, io, state).await?;
    crate::task::run_blocking(move || revoke_device(transport.as_ref(), &token, &id))
        .await
        .map_err(|_| SyncDeviceError::Internal)?
        .map_err(SyncDeviceError::from_mgmt)
}

/// Read this account's own usage + effective ceilings for Settings → Sync.
///
/// Returns `Ok(None)` — never an error — when the projection is simply not
/// available: sync unconfigured, this device not enrolled, the server too old to
/// serve the route (404), or the request failed. The panel omits its usage block
/// in that case rather than showing an error, so a self-hosted or older server
/// degrades to a neutral state with no hosted-only concept surfaced.
///
/// Read-at-rest only. A refused push does NOT come through here — the refusal
/// carries its own `error_code` in the response body — so nothing adds a request
/// on the rate-limited refusal path, where a 429 could mask the very 507 being
/// explained.
pub async fn account_status_from_host(
    host: &dyn crate::host::HostCtx,
    io: &dyn crate::vault_io::VaultIo,
    state: &crate::plugins::vault_unlock::state::VaultRuntimeState,
) -> Result<Option<AccountStatusView>, super::config::SyncConfigError> {
    let Ok((token, transport)) = authed_transport_from_host(host, io, state).await else {
        return Ok(None);
    };
    let parsed = crate::task::run_blocking(move || {
        let resp = transport
            .request(HttpMethod::Get, "/account/status", &[], Some(&token))
            .ok()?;
        if resp.status != 200 {
            return None;
        }
        serde_json::from_slice::<AccountStatusView>(&resp.body).ok()
    })
    .await
    .unwrap_or(None);
    Ok(parsed)
}

// ── the SAS fingerprint + the local un-enrol (MYND-635) ─────────────────────
//
// Both moved here from `commands`, which is `tauri-ipc`-gated and therefore
// invisible to the wasm build — the reason the web client had neither. They sit
// beside `approve_device_from_host` because that is the flow they belong to: the
// fingerprint is what the two devices compare after an approval, and the reset
// is what the comparing device does when the two do not match.

/// Decode a 32-byte `head_id` hex → the frozen SAS fingerprint. Delegates to the
/// vector-locked [`protocol::head_fingerprint`] — no re-derivation, one encoding
/// (SYNC-17). Returns `None` only on a malformed hex string (wrong length /
/// non-hex). Factored out so the encoding is host-unit-testable against the
/// `head-fingerprint` golden vector without a live vault.
pub(crate) fn head_fingerprint_of_hex(head_id_hex: &str) -> Option<String> {
    use protocol::HEAD_ID_LEN;
    if head_id_hex.len() != HEAD_ID_LEN * 2 || !head_id_hex.bytes().all(|b| b.is_ascii_hexdigit()) {
        return None;
    }
    let mut head_id = [0u8; HEAD_ID_LEN];
    for (i, b) in head_id.iter_mut().enumerate() {
        *b = u8::from_str_radix(&head_id_hex[i * 2..i * 2 + 2], 16).ok()?;
    }
    Some(protocol::head_fingerprint(&head_id))
}

/// This device's latest head observation as a SAS fingerprint, or `None` when it
/// has adopted no head yet.
///
/// `None` is the normal answer for the entire time a device is pending, and the
/// web entry screen polls for the transition to `Some` as its signal that an
/// approval landed. That makes the honest `None` load-bearing: a stub answering
/// anything else would advance a screen whose whole job is to wait.
pub async fn head_fingerprint_from_host(
    host: &dyn crate::host::HostCtx,
    io: &dyn crate::vault_io::VaultIo,
    state: &crate::plugins::vault_unlock::state::VaultRuntimeState,
) -> Result<Option<String>, SyncDeviceError> {
    let dir = crate::paths::active_vault_root_io_from_host(host, state.active_vault_id().await)
        .map_err(|_| SyncDeviceError::Internal)?;
    let sync_state = super::state::read_sync_state(io, &dir)
        .await
        .map_err(|_| SyncDeviceError::Internal)?;
    match sync_state.vv_log.last() {
        Some(obs) => Ok(Some(
            head_fingerprint_of_hex(&obs.head_id_hex).ok_or(SyncDeviceError::Internal)?,
        )),
        None => Ok(None),
    }
}

/// Reset this device's sync enrolment locally: clear the device-local token and
/// the sync baseline for the active vault, returning it to a clean "not
/// enrolled, unsynced" state.
///
/// **Deliberately NOT slot-gated**, unlike its two neighbours (myne#382). This
/// is the PRE-UNLOCK escape hatch: three of its four call sites run with
/// nothing unlocked — the SAS-mismatch and "start over" paths on the
/// account-bootstrap screen, and the join modal reached from `welcome`. The web
/// capability table says the same in its own words ("`sync_reset_local` is that
/// screen's 'the fingerprints don't match' escape hatch"). Gating it re-creates
/// the wedge it exists to close.
///
/// NEVER touches `notes/`, attachments or `vault.meta`, and never calls the
/// server — a rejected token cannot authenticate a server-side remove, and the
/// server-side row is reaped by the existing approval/retire path.
///
/// Its failure must surface to the caller. The reason to invoke it is that the
/// device no longer trusts what it adopted, so an error swallowed on the way
/// back reads as "un-enrolled" when nothing was cleared.
pub async fn reset_local_from_host(
    host: &dyn crate::host::HostCtx,
    io: &dyn crate::vault_io::VaultIo,
    state: &crate::plugins::vault_unlock::state::VaultRuntimeState,
) -> Result<(), SyncDeviceError> {
    // Serialize against an in-flight cycle: without this a reset can clear the
    // token / device-local sync files while a cycle's blocking half is
    // finishing, and the cycle then writes them back — reviving the enrolment
    // and baseline the reset removed.
    let _cycle_guard = super::cycle::sync_cycle_mutex().lock().await;
    let dir = crate::paths::active_vault_root_io_from_host(host, state.active_vault_id().await)
        .map_err(|_| SyncDeviceError::Internal)?;
    use super::token_store::TokenStore as _;
    super::token_store::default_store()
        .clear(io, &dir)
        .await
        .map_err(|_| SyncDeviceError::Internal)?;
    super::state::clear_device_local_sync(io, &dir)
        .await
        .map_err(|_| SyncDeviceError::Internal)?;
    // Nudge both the status indicator and the device roster to re-read
    // immediately — they poll independently (5 s / 4 s), so without this they
    // would disagree (one still "Synced") for up to a poll interval.
    host.emit("sync://enrollment-changed", crate::host::EventPayload::Unit);
    Ok(())
}
