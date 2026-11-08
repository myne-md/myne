// SPDX-License-Identifier: AGPL-3.0
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
    use crate::plugins::vault_unlock::state::VaultRuntimeState;
    use crate::vault_io::VaultIo as _;

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

    /// myne#462 named this coverage hole and it was real: `head_fingerprint_from_host`
    /// had **no tests at all**, so nothing pinned WHICH `vv_log` entry the eye-compare
    /// displays, and nothing anywhere seeded a log with more than one observation.
    ///
    /// Every other test in the tree proves `head_id → fingerprint` is a correct,
    /// frozen, deterministic function. None of them proves the two devices feed it
    /// the same `head_id`, which is the entire defect.
    ///
    /// The answer is the LAST observation — the head this device currently holds.
    /// That is load-bearing rather than arbitrary: the joining device's log starts
    /// empty, so its first non-null answer is the head it adopted at bootstrap,
    /// which is what `sync-protocol.md` §6.3 prescribes.
    #[test]
    fn head_fingerprint_from_host_reads_the_last_observation() {
        use protocol::HEAD_ID_LEN;
        crate::test_support::block_on(async {
            let tmp = crate::test_support::ScopedTempDir::new("sas-vvlog").unwrap();
            let host = crate::host::test_host::TestHost::new(tmp.path());
            let state = crate::plugins::vault_unlock::state::VaultRuntimeState::default();
            let io: &dyn crate::vault_io::VaultIo = &crate::vault_io::StdVaultIo;
            let dir = crate::paths::active_vault_root_io_from_host(&host, None).unwrap();
            io.create_dir_all(&dir).await.unwrap();

            // An empty log is the honest "this device has adopted no head yet",
            // and it is load-bearing: the joining screen polls for the
            // None → Some transition as its signal that an approval landed.
            let mut st = super::super::state::SyncState::default();
            super::super::state::write_sync_state(io, &dir, &st)
                .await
                .unwrap();
            assert_eq!(
                head_fingerprint_from_host(&host, io, &state).await,
                Ok(None),
                "no adopted head → no code, not a stale or invented one"
            );

            // Three observations, oldest first. The all-zero head is the golden
            // vector, deliberately placed FIRST: if the reader ever regressed to
            // `vv_log.first()`, the assertion below would report "TYRS-N318" and
            // name the regression instead of merely failing.
            let heads = [
                [0x00u8; HEAD_ID_LEN],
                [0x11u8; HEAD_ID_LEN],
                [0x22u8; HEAD_ID_LEN],
            ];
            for h in &heads {
                st.record_observation(h, &[]);
            }
            assert_eq!(st.vv_log.len(), 3, "the log really does hold three");
            super::super::state::write_sync_state(io, &dir, &st)
                .await
                .unwrap();

            assert_eq!(
                head_fingerprint_from_host(&host, io, &state).await,
                Ok(head_fingerprint_of_hex(&super::super::to_hex(&heads[2]))),
                "the compare shows the head this device holds NOW — the last \
                 observation, not the first one it ever adopted"
            );
            assert_ne!(
                head_fingerprint_from_host(&host, io, &state).await,
                Ok(Some(String::from("TYRS-N318"))),
                "…and specifically not the oldest, which is the all-zero golden"
            );
        });
    }

    /// The property the eye-compare actually asserts, stated as a test: two
    /// devices sitting on the same head show the same string. Trivially true of
    /// the primitive, and worth pinning at THIS layer because the primitive is
    /// not where it broke — the two sides read the value at different moments.
    #[test]
    fn two_devices_on_the_same_head_show_the_same_code() {
        use protocol::HEAD_ID_LEN;
        crate::test_support::block_on(async {
            let head = [0x5Au8; HEAD_ID_LEN];
            let mut fps = Vec::new();
            for name in ["sas-dev-a", "sas-dev-b"] {
                let tmp = crate::test_support::ScopedTempDir::new(name).unwrap();
                let host = crate::host::test_host::TestHost::new(tmp.path());
                let state = crate::plugins::vault_unlock::state::VaultRuntimeState::default();
                let io: &dyn crate::vault_io::VaultIo = &crate::vault_io::StdVaultIo;
                let dir = crate::paths::active_vault_root_io_from_host(&host, None).unwrap();
                io.create_dir_all(&dir).await.unwrap();
                let mut st = super::super::state::SyncState::default();
                st.record_observation(&head, &[]);
                super::super::state::write_sync_state(io, &dir, &st)
                    .await
                    .unwrap();
                fps.push(head_fingerprint_from_host(&host, io, &state).await.unwrap());
            }
            assert!(fps[0].is_some(), "both devices produced a code");
            assert_eq!(fps[0], fps[1], "same head ⇒ same eye-compare string");
        });
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

    // ── the account plane (myne-md/myne, 2026-10-16) ─────────────────────────
    //
    // The defect these pin: a member vault's `sync-token` file holds a
    // `(person, vault)` MEMBERSHIP token, and the account routes refuse it
    // (`server-protocol.md` §3.1 lists the routes it is accepted on; `/auth/devices`
    // is not one, because it carries no device id). Sending it anyway answered
    // `Unauthenticated`, and the device panel renders that as "the server rejected
    // this device's sign-in" beside a "Reset sync on this device" button that
    // clears the very token the whole vault syncs on.

    /// The plane follows the SESSION's authority, which is the only thing that
    /// decides it. Written as a pair because the failure is asymmetric: an owner
    /// vault mis-resolved to the person plane would read the wrong account's
    /// roster, and a member vault mis-resolved to the vault plane is the bug.
    #[test]
    fn the_account_plane_follows_the_session_authority() {
        crate::test_support::block_on(async {
            use crate::plugins::vault_unlock::state::UnlockedVault;
            use zeroize::Zeroizing;
            let state = VaultRuntimeState::default();
            let id = crate::vault_id::VaultId::mint();

            state
                .set_unlocked(
                    id,
                    UnlockedVault::owner(
                        Zeroizing::new([1u8; 32]),
                        Some(Zeroizing::new([2u8; 32])),
                        Zeroizing::new([3u8; 32]),
                        [4u8; 16],
                        0,
                        [5u8; 32],
                    ),
                )
                .await;
            assert_eq!(account_plane_from_host(&state).await, AccountPlane::Vault);

            // A member session is constructed without a root key.
            state
                .set_unlocked(
                    id,
                    UnlockedVault::member(
                        Zeroizing::new([2u8; 32]),
                        Zeroizing::new([3u8; 32]),
                        [4u8; 16],
                        0,
                        [5u8; 32],
                    ),
                )
                .await;
            assert_eq!(account_plane_from_host(&state).await, AccountPlane::Person);
        });
    }

    /// The defect itself, plus the boundary the fix must not cross.
    ///
    /// On a member vault: the account plane hands back the PERSON token and the
    /// person device id; with no person credential on the device the answer is the
    /// honest `NotEnrolled`; and the VAULT-plane resolver still returns the vault
    /// directory's membership token, because `ensure_owner_member_token` depends on
    /// that resolver NOT quietly becoming member-aware.
    #[test]
    fn a_member_vaults_account_plane_is_the_person_account_not_the_vault_token() {
        crate::test_support::block_on(async {
            use crate::plugins::sync::config::{
                config_path_from_host, write_config, SyncEndpointConfig,
            };
            use crate::plugins::sync::person_auth::{
                person_auth_path, write_person_auth, PersonAuth,
            };
            use crate::plugins::sync::token_store::TokenStore as _;
            use crate::plugins::vault_unlock::state::UnlockedVault;
            use zeroize::Zeroizing;

            let tmp = crate::test_support::ScopedTempDir::new("account-plane").unwrap();
            let host = crate::host::test_host::TestHost::new(tmp.path());
            let io = &crate::vault_io::StdVaultIo;
            let state = VaultRuntimeState::default();
            let vault_id = crate::vault_id::VaultId::mint();

            // The vault directory holds the membership token, exactly as
            // `materialize_member_vault` leaves it.
            let dir = crate::paths::vault_dir_for_id_from_host_io(&host, io, Some(vault_id))
                .await
                .unwrap();
            io.create_dir_all(&dir).await.unwrap();
            super::super::token_store::default_store()
                .store(io, &dir, b"membership-token")
                .await
                .unwrap();

            // A configured endpoint, so the transport builds and the assertion
            // reads the TOKEN rather than a `NotConfigured` refusal.
            let cfg_path = config_path_from_host(&host, io).await.unwrap();
            write_config(
                io,
                &cfg_path,
                &SyncEndpointConfig {
                    // Loopback http: `build_transport` constructs without dialing.
                    endpoint_url: Some("http://127.0.0.1:9".to_string()),
                    ..Default::default()
                },
            )
            .await
            .unwrap();

            state
                .set_unlocked(
                    vault_id,
                    UnlockedVault::member(
                        Zeroizing::new([2u8; 32]),
                        Zeroizing::new([3u8; 32]),
                        [4u8; 16],
                        0,
                        [5u8; 32],
                    ),
                )
                .await;

            // No person credential on this device (never set up, or the identity
            // is locked/forgotten): NOT `Unauthenticated`. That distinction is the
            // whole safety property — the panel's reset button is gated on the
            // refusals, and this arm must not reach it.
            assert_eq!(
                list_devices_from_host(&host, io, &state).await.unwrap_err(),
                SyncDeviceError::NotEnrolled,
            );

            // With one, the ACCOUNT plane returns the person token + the person
            // device id.
            let auth_path = person_auth_path(&host, io).await.unwrap();
            let person_device = "bb".repeat(16);
            write_person_auth(
                io,
                &auth_path,
                &PersonAuth {
                    person_id_hex: "aa".repeat(16),
                    device_id_hex: person_device.clone(),
                    registered: false,
                    token_hex: "cc".repeat(32),
                    ..Default::default()
                },
            )
            .await
            .unwrap();
            let (credential, _transport) = account_plane_transport_from_host(&host, io, &state)
                .await
                .unwrap();
            assert_eq!(
                credential.token_hex,
                "cc".repeat(32),
                "a member vault's account plane must carry the PERSON token"
            );
            assert_eq!(
                credential.device_id_hex.as_deref(),
                Some(person_device.as_str()),
                "the roster's This-device marker matches the PERSON device id, not \
                 the vault directory's CRDT actor id"
            );

            // …and the VAULT plane is untouched: the membership token, hex-encoded.
            let (vault_token, _t) = authed_transport_from_host(&host, io, &state).await.unwrap();
            let mut expected = String::new();
            for b in b"membership-token" {
                expected.push_str(&format!("{b:02x}"));
            }
            assert_eq!(
                vault_token, expected,
                "the vault-plane resolver keeps reading the vault directory, which is \
                 what the owner registration needs"
            );
        });
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
    /// The explicit owner-approved NTV5 to NTV6 migration must commit before
    /// an invite can be created.
    MigrationRequired,
    /// The vault IS migrated (`NTV6`), but invite creation needs the group-key
    /// session tier the migration introduces: an `NTV6` invite wraps the shared
    /// `group_key` into a signed recipient package, not the `itemsKey` into the
    /// legacy membership roster, and the slot does not yet carry the group tier.
    /// Split out of `BadRequest` because the vault is valid and the user did
    /// nothing wrong: a migrated owner who invites must see the state, not
    /// "bad request".
    GroupRosterInviteUnavailable,
    /// The server rejected the token (revoked / invalid).
    Unauthenticated,
    /// The named device is not on the account.
    DeviceNotFound,
    /// Transport / server / internal failure.
    Transport,
    /// Certificate trust, hostname or TLS negotiation failed.
    TlsFailure,
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
    /// SCRAM server-signature mismatch. Despite the legacy variant name, this
    /// is not a TLS certificate fingerprint or a certificate-pinning refusal.
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
    /// This device already holds a DIFFERENT credential on the account (server 409
    /// `already_installed`, `decisions/protocol/0735`). Nothing is broken: the device is
    /// already admitted, and the fix is to sign in on it rather than to admit it again.
    AlreadyInstalled,
    /// Member removal is parked until the roster wire ships (B2B,
    /// myne-md/myne#698). The rotation the removal would run is local-only
    /// with no peer propagation and no tombstone convergence, so the entry
    /// point refuses rather than stranding peers on a retired key. Carries
    /// the reason in words on the Rust side
    /// (`member_removal::MemberRemovalError::unavailable_message`):
    /// "Member removal is disabled until the roster wire ships."
    RemovalUnavailable,
    /// The caller holds a member authority but the command needs the owner
    /// (B2B, myne-md/myne#714). Split out of `NotEnrolled` and `BadRequest`
    /// because the remedy is different in kind: nothing the member retypes
    /// fixes it, only the owner can run the command. The UI hides
    /// owner-only affordances from members, so this is the backend contract
    /// for the future member client rather than a button a member sees.
    NotOwner,
    /// The vault is person-born (`NTV7`) and no person session is installed, so
    /// there is no credential that could publish it (myne-md/myne#911 task 8).
    ///
    /// Its own variant rather than `NotEnrolled`: this device IS the owner and
    /// holds the identity, it is merely locked. "Enrol this device" would send
    /// the user to a join flow they do not need; unlocking the identity is the
    /// remedy, and it is one action.
    PersonSessionRequired,
    /// The vault is person-born and the identity exists on this device but has
    /// never been REGISTERED with a server, so it holds no token to publish with
    /// (myne-md/myne#911 task 8).
    ///
    /// Its own variant rather than [`Self::PersonSessionRequired`] because the
    /// two refusals carry OPPOSITE remedies and the surface worded them the same
    /// way: an unregistered identity is already unlocked, so "unlock your
    /// identity first" sends the user to a control that will not change
    /// anything, while the act that fixes it (registration, which asks for the
    /// 24 words) lives on the identity home. Publishing cannot register on the
    /// user's behalf: the SCRAM secret derives from the phrase, and the session
    /// deliberately holds only the derived keypair.
    PersonNotRegistered,
    /// The scanned QR named one person and the phrase belongs to another
    /// (myne-md/myne#911 task 9).
    ///
    /// Its own variant rather than `BadRequest` because the two halves of the
    /// join disagree with each other rather than one of them being wrong in
    /// isolation: the code came from a screen the user is looking at and the
    /// phrase is what they wrote down, so the message has to say the CODE and the
    /// PHRASE do not match, not that one of them is invalid.
    PersonMismatch,
    /// A create was asked for on a device that already holds a sealed person
    /// identity under a different phrase (myne-md/myne#780).
    ///
    /// Its own variant rather than `BadRequest` because the remedy is different
    /// in kind: `sync_person_setup` generated a fresh phrase that cannot open the
    /// sealed keypair the device already holds, and nothing the user retypes
    /// fixes it. The fix is either to recover with the original phrase or to
    /// explicitly forget the held identity first. On the RECOVER path a
    /// `CannotDecrypt` stays `BadRequest` — there it means the phrase is wrong.
    AlreadyHeldIdentity,
    /// The server gates new accounts behind an invite code and none was sent
    /// (server 403 `invite_code_required`). Same reasoning as `AccountFrozen`:
    /// the credentials are right, and the remedy is to type the code the
    /// operator gave the user.
    InviteCodeRequired,
    /// The invite code sent did not match the server's (server 403
    /// `invite_code_invalid`). Distinct from `InviteCodeRequired` so the field
    /// can say "that code is wrong" rather than "a code is needed".
    InviteCodeInvalid,
    /// This device already holds a vault for the account this invite names
    /// (member-devices task 7).
    ///
    /// Its own variant rather than a `BadRequest`, for the reason the comment at
    /// the `local_vault_holds_account` call site gives: the remedy is to open the
    /// vault already here, not to retry and not to go looking for a trust anchor.
    /// `BadRequest` in this command already carries the OPPOSITE remedy (the
    /// person profile has no pinned owner identity code, so the vault has to be
    /// opened once on a device that has it and the join retried), and a single
    /// sentence cannot name two opposite remedies: myne-md/myne#794 is the defect
    /// `accept-invite.ts` exists as a six-arm mapper to fix. Not
    /// `AccountMismatch` either: that is the reverse case, a container pinned to a
    /// DIFFERENT account, whose remedy is to erase it. This is the routine arm
    /// rather than an edge: a claimed invite row stays listed on the identity
    /// home, so joining a vault this device already holds reaches it every time,
    /// whether the vault was accepted here or joined here.
    VaultAlreadyHeld,
    /// The SAS the human confirmed is not the SAS derived from the code in hand
    /// (`decisions/protocol/0735` decision 3; myne-md/myne#938 task 11).
    ///
    /// Its own variant rather than `BadRequest` because the refusal has a specific meaning
    /// the surface must word: the code changed between the screen that showed the string and
    /// the button that accepted it, which is the attack the SAS exists to catch. Nothing was
    /// written on either side.
    SasMismatch,
    /// There is no minted admission waiting to be confirmed: the ceremony was cancelled, or
    /// the vault locked, and the RAM slot that held the secret is gone.
    ///
    /// Its own variant rather than `Internal`: nothing is broken, the user simply has to
    /// start the exchange again, and the secret is deliberately never on disk before the
    /// confirm.
    NoPendingAdmission,
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
            E::AlreadyInstalled => SyncDeviceError::AlreadyInstalled,
            E::InviteCodeRequired => SyncDeviceError::InviteCodeRequired,
            E::InviteCodeInvalid => SyncDeviceError::InviteCodeInvalid,
            E::ServerSignatureMismatch => SyncDeviceError::FingerprintMismatch,
            E::Unauthenticated => SyncDeviceError::Unauthenticated,
            // Ahead of the catch-all: this is the arm the payload is matched
            // for. A certificate the client refused reaching the panel as a bare
            // "Transport" is what the panel's own hint was written to guess at.
            E::Transport(super::transport::TransportError::Tls) => SyncDeviceError::TlsFailure,
            E::BadResponse | E::Transport(_) => SyncDeviceError::Transport,
        }
    }
}

/// The management-plane refusals, projected onto this command's enum. A `From`
/// rather than a `match` at each call site because the mapping is one-to-one
/// and a match would let a new variant skip it silently.
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
///
/// **Lenient**, through `protocol::hex::decode_ci`, and that is a deliberate
/// difference from the conversation-id helpers beside it: a device id arrives
/// from the SERVER (the enrolment response and the device list), so its case is
/// not this client's to fix, and refusing an uppercase spelling would read as
/// "no such device" rather than as a malformed id. Aşama 3's R1.2 named the two
/// policies; before that this function accepted `A`–`F` while
/// `orchestrator::from_hex16` rejected it, with nothing saying which was meant.
pub fn hex16(s: &str) -> Option<[u8; 16]> {
    protocol::hex::decode_ci(s)
}

/// Which ACCOUNT the device-management + account-status plane speaks for.
///
/// `Vault` is the vault account itself: the token in the vault directory is that
/// account's per-device token, so it authorizes the sync routes AND `/auth/*`.
///
/// `Person` is the MEMBER's own account, and it exists because the VAULT plane
/// cannot serve a member. A member vault's `sync-token` file holds the
/// `(person, vault)` **membership token** written at accept/join
/// (`person_account.rs`), and the server refuses that credential on the account
/// routes: `myne-agents/docs/spec/server-protocol.md` §3.1 lists the routes a membership
/// token is accepted on (`/sync/*`, `/account/status`) and `/auth/devices` is not
/// among them, because the token is bound to a binding and **carries no device
/// id**. The member's own account plane is authenticated instead by the
/// device-scoped token in `person-auth.json` — a §3.1 device token of the person
/// account, which those routes DO accept.
///
/// Getting this wrong is not a cosmetic error, which is why it is an enum at one
/// resolver rather than a bool at one call site: on a member vault the vault
/// token is PRESENT and REJECTED, so the roster call answers `Unauthenticated`,
/// which the device panel renders as "the server rejected this device's
/// sign-in" beside a **"Reset sync on this device"** button. That button clears
/// the member's membership token — the credential the entire vault syncs on,
/// which no UI path can restore (myne-md/myne, 2026-10-16).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AccountPlane {
    Vault,
    Person,
}

/// Which account plane the DEVICE-MANAGEMENT commands speak for, on a
/// person-born vault (myne-md/myne#911 task 9).
///
/// [`account_plane_from_host`] answers "is this a member session", which is the
/// whole question for a vault that has an account of its own. It is NOT the whole
/// question for an `NTV7` vault: an OWNER of one is not a member and still has no
/// vault account, so the vault plane would read a token that does not exist and
/// the roster would answer `NotEnrolled` on the device a user is holding.
///
/// Kept as a separate resolver rather than folded into `account_plane_from_host`
/// because the MEMBER QR command needs the narrower question: it must refuse an
/// owner (a QR that led an owner down the member path would create a member
/// device for a vault they own), and a person-born owner is an owner.
pub async fn account_plane_io_from_host(
    host: &dyn crate::host::HostCtx,
    io: &dyn crate::vault_io::VaultIo,
    state: &crate::plugins::vault_unlock::state::VaultRuntimeState,
) -> AccountPlane {
    if account_plane_from_host(state).await == AccountPlane::Person {
        return AccountPlane::Person;
    }
    let Ok(root) =
        crate::paths::active_vault_root_io_from_host(host, state.active_vault_id().await)
    else {
        return AccountPlane::Vault;
    };
    // Both person generations, through the classifier: an `NTV8` vault is addressed with
    // the person token and its own selector exactly as `NTV7` is, and reading it as a
    // vault-account vault sends the request under a credential it does not have.
    let person_born = io
        .read(&root.join("vault.meta"))
        .await
        .ok()
        .is_some_and(|bytes| super::meta_kind::is_person_born(&bytes));
    if person_born {
        AccountPlane::Person
    } else {
        AccountPlane::Vault
    }
}

/// The ACTIVE vault's account plane.
///
/// Read off the unlock slot rather than off disk, because
/// [`crate::plugins::vault_unlock::state::UnlockedVault::authority`] is exactly
/// this question (it is `root_key.is_some()`, the same fact `sync_list_roster`
/// branches on to pick the owner's own identity over the pinned one) and a
/// member session is constructed without a root key by definition.
///
/// The Settings panels decide the same thing from disk, through
/// `sync_member_vault_status` → the device-local member credential
/// (`vault.member-unlock`), which is the predicate `VaultPanel` already uses to
/// hide the owner password section (`myne-md/myne#858`). The two cannot disagree
/// in practice: a member vault is materialized with that store or not at all, and
/// a missing store refuses the materialization rather than producing a half-member
/// session. Since myne-md/myne#938 task 12 it is also the ONLY member store, so
/// the disk predicate has one candidate rather than two.
///
/// Public because two other callers ask the same question: the member QR command
/// (`sync_member_join_qr`, which only a member session may render) and this
/// module's own tests.
pub async fn account_plane_from_host(
    state: &crate::plugins::vault_unlock::state::VaultRuntimeState,
) -> AccountPlane {
    use crate::plugins::vault_unlock::state::{Slot, VaultAuthority};
    let slot = state.slot_read_active().await;
    match &*slot {
        Slot::Unlocked(uv) if matches!(uv.authority(), VaultAuthority::Member) => {
            AccountPlane::Person
        }
        _ => AccountPlane::Vault,
    }
}

/// The account plane's bearer token (hex) + the device id that identifies THIS
/// device **on that plane**, for the roster's "This device" marker.
pub(crate) struct AccountPlaneCredential {
    /// Hex bearer token for the account routes. Never logged, never crosses IPC.
    pub(crate) token_hex: String,
    /// The `device_id` this device is registered under on that plane. `None`
    /// when it cannot be read — the marker is cosmetic, so the roster still
    /// renders rather than failing over a label.
    ///
    /// The two planes store different ids, and this is the field a reader is
    /// most likely to get wrong: on a member vault the vault directory's
    /// `device_id_hex` is a freshly minted **CRDT actor id**
    /// (`materialize_member_vault`), NOT the person account's device id, so
    /// matching the person roster against it would mark no row at all.
    device_id_hex: Option<String>,
}

/// Resolve the active vault's account-plane credential + a transport for the
/// configured endpoint.
///
/// The precondition for the four account-plane commands below
/// ([`list_devices_from_host`], [`approve_device_from_host`],
/// [`remove_device_from_host`], [`account_status_from_host`]). It is NOT the
/// sync plane: the sync cycle reads its token straight off the vault directory
/// (`cycle.rs`), where a membership token is exactly right, and neither
/// function may be swapped for the other in either direction.
pub(crate) async fn account_plane_transport_from_host(
    host: &dyn crate::host::HostCtx,
    io: &dyn crate::vault_io::VaultIo,
    state: &crate::plugins::vault_unlock::state::VaultRuntimeState,
) -> Result<(AccountPlaneCredential, Box<dyn SyncTransport>), SyncDeviceError> {
    let credential = match account_plane_io_from_host(host, io, state).await {
        AccountPlane::Person => person_plane_credential_from_host(host, io).await?,
        AccountPlane::Vault => vault_plane_credential_from_host(host, io, state).await?,
    };
    let cfg_path = super::config::config_path_from_host(host, io)
        .await
        .map_err(|_| SyncDeviceError::Internal)?;
    let cfg = super::config::read_config(io, &cfg_path)
        .await
        .map_err(|_| SyncDeviceError::NotConfigured)?;
    let url = cfg.endpoint_url.ok_or(SyncDeviceError::NotConfigured)?;
    let transport =
        super::http_transport::build_transport(&url).map_err(|_| SyncDeviceError::Transport)?;
    Ok((credential, transport))
}

/// The member's OWN account credential: the device-scoped person token.
///
/// `NotEnrolled` when this device holds no person account, or holds one whose
/// identity is locked/forgotten (an empty token). That is the honest answer and
/// the safe one: the panel then says this device is not connected to sync rather
/// than offering the destructive local reset.
async fn person_plane_credential_from_host(
    host: &dyn crate::host::HostCtx,
    io: &dyn crate::vault_io::VaultIo,
) -> Result<AccountPlaneCredential, SyncDeviceError> {
    let path = super::person_auth::person_auth_path_for_read(host)
        .map_err(|_| SyncDeviceError::Internal)?;
    let auth = super::person_auth::read_person_auth(io, &path)
        .await
        .map_err(|_| SyncDeviceError::Internal)?;
    let (token_hex, device_id_hex) = match auth {
        Some(a) => (a.token_hex, Some(a.device_id_hex)),
        None => (String::new(), None),
    };
    if token_hex.is_empty() {
        return Err(SyncDeviceError::NotEnrolled);
    }
    Ok(AccountPlaneCredential {
        token_hex,
        device_id_hex,
    })
}

/// The VAULT account's credential: the per-device token in the vault directory.
async fn vault_plane_credential_from_host(
    host: &dyn crate::host::HostCtx,
    io: &dyn crate::vault_io::VaultIo,
    state: &crate::plugins::vault_unlock::state::VaultRuntimeState,
) -> Result<AccountPlaneCredential, SyncDeviceError> {
    use super::token_store::TokenStore as _;
    let dir = crate::paths::active_vault_root_io_from_host(host, state.active_vault_id().await)
        .map_err(|_| SyncDeviceError::Internal)?;
    let token = super::token_store::default_store()
        .read(io, &dir)
        .await
        .map_err(|_| SyncDeviceError::Internal)?
        .ok_or(SyncDeviceError::NotEnrolled)?;
    // Nothing is written back, and the only consequence of not knowing our own
    // `device_id` is that the roster does not mark which row is this device: a
    // cosmetic degrade on a read-only path. Read through the one reader, because
    // reading only the enrolment record left a person-born vault's row unmarked
    // on a device that knows perfectly well who it is (myne-md/myne#958).
    let device_id_hex = super::device_actor::durable_device_id(host, io, &dir)
        .await
        .map(|id| super::to_hex(&id));
    Ok(AccountPlaneCredential {
        token_hex: super::to_hex(&token),
        device_id_hex,
    })
}

/// The per-device token of the vault account + a transport for the configured
/// endpoint.
///
/// **This is the VAULT plane and nothing else.** It is the credential the owner
/// registration needs (`ensure_owner_member_token`), which is an owner-only call
/// site, and it deliberately does NOT learn about member vaults: on a member
/// vault the file it reads holds a membership token that `/auth/*` refuses, and
/// a caller that needs the account plane must use
/// [`account_plane_transport_from_host`] instead.
pub async fn authed_transport_from_host(
    host: &dyn crate::host::HostCtx,
    io: &dyn crate::vault_io::VaultIo,
    state: &crate::plugins::vault_unlock::state::VaultRuntimeState,
) -> Result<(String, Box<dyn SyncTransport>), SyncDeviceError> {
    let credential = vault_plane_credential_from_host(host, io, state).await?;
    let cfg_path = super::config::config_path_from_host(host, io)
        .await
        .map_err(|_| SyncDeviceError::Internal)?;
    let cfg = super::config::read_config(io, &cfg_path)
        .await
        .map_err(|_| SyncDeviceError::NotConfigured)?;
    let url = cfg.endpoint_url.ok_or(SyncDeviceError::NotConfigured)?;
    let transport =
        super::http_transport::build_transport(&url).map_err(|_| SyncDeviceError::Transport)?;
    Ok((credential.token_hex, transport))
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
    /// True when `stored_bytes` is an ACCOUNT total over `vault_count` owned
    /// vaults rather than one vault's own figure (myne-md/myne#911 task 11).
    ///
    /// The server reports one figure per person account, and a client that
    /// ignored this bit would render that total as a per-vault figure against a
    /// ceiling no single vault is judged against. `serde(default)` so an older
    /// server's body (no `person` field) still parses, which is the same
    /// tolerance `AccountStatusView` has always had for a body that predates a
    /// field.
    #[serde(default)]
    pub person: bool,
    /// How many owned vaults the account total covers; `0` for a vault session.
    #[serde(default)]
    pub vault_count: u64,
}

/// List the account's devices, marking which row is this device.
///
/// "The account" is the active vault's account PLANE, not necessarily the vault:
/// on a member vault this lists the member's OWN person-account devices, because
/// that is the account whose device registry the caller can authenticate against
/// (see [`AccountPlane`]).
pub async fn list_devices_from_host(
    host: &dyn crate::host::HostCtx,
    io: &dyn crate::vault_io::VaultIo,
    state: &crate::plugins::vault_unlock::state::VaultRuntimeState,
) -> Result<Vec<DeviceEntry>, SyncDeviceError> {
    // The plane resolves the token AND the id that identifies this device on it,
    // because the server roster never marks it — it cannot know which client is
    // asking. Both come from the same read, so the marker cannot match against
    // the wrong plane's id (on a member vault the vault directory's id is a CRDT
    // actor id, not a device id).
    let (credential, transport) = account_plane_transport_from_host(host, io, state).await?;
    let AccountPlaneCredential {
        token_hex,
        device_id_hex,
    } = credential;
    let mut roster =
        crate::task::run_blocking(move || list_devices(transport.as_ref(), &token_hex))
            .await
            .map_err(|_| SyncDeviceError::Internal)?
            .map_err(SyncDeviceError::from_mgmt)?;
    for d in &mut roster {
        d.is_current = Some(&d.device_id_hex) == device_id_hex.as_ref();
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
    let (credential, transport) = account_plane_transport_from_host(host, io, state).await?;
    let token = credential.token_hex;
    let outcome =
        crate::task::run_blocking(move || approve_device(transport.as_ref(), &token, &id))
            .await
            .map_err(|_| SyncDeviceError::Internal)?
            .map_err(SyncDeviceError::from_mgmt);
    // Arm the device-verification push hold here as well as from the WebView
    // (myne#462). Belt and braces, deliberately: an approval is *always*
    // followed by the SYNC-40 eye-compare, so the window this protects opens
    // exactly here — and arming it in the core means a client whose verify
    // screen forgets to call `sync_verify_hold_begin` still gets a stable head
    // to compare. Bounded by the same lease as every other arm, so a client that
    // never pings simply lets it lapse.
    //
    // Only on success: an approval the server refused starts no ceremony, and
    // holding this device's pushes for a compare that will not happen would be a
    // pure cost.
    if outcome.is_ok() {
        super::verify_hold::verify_hold().begin(host.now_unix_millis());
    }
    outcome
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
    let (credential, transport) = account_plane_transport_from_host(host, io, state).await?;
    let token = credential.token_hex;
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
    let Ok((credential, transport)) = account_plane_transport_from_host(host, io, state).await
    else {
        return Ok(None);
    };
    let token = credential.token_hex;
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
    // Lenient (`protocol::hex::decode_ci`): a head id arrives from the server,
    // so its case is not this client's to fix (R1.2).
    let head_id = protocol::hex::decode_ci::<HEAD_ID_LEN>(head_id_hex)?;
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
