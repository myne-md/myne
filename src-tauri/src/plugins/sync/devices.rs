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
            Ok(wire.devices)
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
