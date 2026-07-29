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

use super::config::{validate_endpoint_url, SyncConfigError};
use crate::host::HostCtx;
use std::path::PathBuf;
// The rest of this module is still Tauri-shaped (task 79 step 9); only the two
// entry points the auth cluster calls have host arms so far.
use tauri::{AppHandle, Manager, Runtime};

/// Re-exported so `generate_handler!`, the mobile crate and the TS mirror keep
/// resolving `commands::SyncRuntimeStatus`; the type moved to `status` with the
/// derivation (task 84).
pub use super::status::{overlay_status, status_from, LiveStatus, SyncRuntimeStatus};

/// Resolve `<app_config_dir>/sync-config.json` (the `themes` plugin precedent).
#[cfg(all(feature = "tauri-ipc", not(target_arch = "wasm32")))]
pub(crate) async fn config_path<R: Runtime>(
    app: &AppHandle<R>,
) -> Result<PathBuf, SyncConfigError> {
    super::config::config_path_from_host(
        &crate::host::tauri_host::TauriHost::new(app.clone()),
        &crate::vault_io::StdVaultIo,
    )
    .await
}

/// Read the device-local sync endpoint config + its derived pin source (SYNC-43).
///
/// A thin wrapper now: the body moved to `config::get_endpoint_view` so the
/// browser dispatches the same code (task 84).
#[tauri::command]
pub async fn sync_get_endpoint<R: Runtime>(
    app: AppHandle<R>,
) -> Result<super::config::SyncEndpointView, SyncConfigError> {
    super::config::get_endpoint_view(
        &crate::host::tauri_host::TauriHost::new(app.clone()),
        &crate::vault_io::StdVaultIo,
        CLIENT_CAN_PIN,
    )
    .await
}

/// Which trust path a scanned QR's cert pin takes (for the confirm-screen label).
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub enum JoinQrPinSource {
    /// Self-host: the QR's cert pin is adopted (TOFU-from-scan). The UI verifies
    /// the connected cert matches this pin before proceeding (grill Q2 transfer).
    SelfHostTofu,
    /// Hosted default: the app's baked-in static pin governs; the QR pin is ignored.
    Hosted,
    /// Self-host with no pin carried: blind TOFU at first connect.
    SelfHostNoPin,
}

/// The decoded, validated view of a scanned device-join QR — everything the mobile
/// confirm screen needs before the user enters their password (MYND-466, Option 1).
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct JoinQrView {
    /// Endpoint URL the QR carried (prefills the join form / endpoint set).
    pub endpoint_url: String,
    /// Canonical account number the QR carried (the UI formats it for display).
    pub account_number: String,
    /// The QR's carried leaf-cert pin (lowercase hex), or `None`. The UI matches
    /// this against the connected cert (`sync_set_endpoint`'s returned fingerprint)
    /// to verify the Q2 trusted-transfer before joining a self-host endpoint.
    pub cert_pin_hex: Option<String>,
    /// Which trust path the pin takes (hosted vs self-host).
    pub pin_source: JoinQrPinSource,
    /// Whether the QR is still fresh (within the ephemeral TTL). A stale QR is
    /// rejected with a "re-scan a fresh one" message (grill Q8 liveness).
    pub fresh: bool,
}

/// Pure decode → view mapping (host-testable; the command supplies `now_unix`).
fn decode_join_qr_view(
    scanned: &str,
    now_unix: u64,
) -> Result<JoinQrView, super::qr_join::QrJoinDecodeError> {
    use super::qr_join::{select_pin_for_qr_join, QrJoinPayload, QrPinSelection, QR_JOIN_TTL_SECS};
    let payload = QrJoinPayload::decode(scanned.trim())?;
    let fresh = payload.is_fresh(now_unix, QR_JOIN_TTL_SECS);
    let pin_source = match select_pin_for_qr_join(&payload) {
        QrPinSelection::Hosted { .. } => JoinQrPinSource::Hosted,
        QrPinSelection::SelfHostAdoptQr { .. } => JoinQrPinSource::SelfHostTofu,
        QrPinSelection::SelfHostNoPin => JoinQrPinSource::SelfHostNoPin,
    };
    Ok(JoinQrView {
        endpoint_url: payload.endpoint_url,
        account_number: payload.account_number,
        cert_pin_hex: payload.cert_pin_hex,
        pin_source,
        fresh,
    })
}

/// Decode + validate a scanned device-join QR for the mobile confirm screen
/// (MYND-466). Pure over the scanned string + the current clock; no vault access.
#[tauri::command]
pub async fn sync_decode_join_qr(
    scanned: String,
) -> Result<JoinQrView, super::qr_join::QrJoinDecodeError> {
    let now_unix = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    decode_join_qr_view(&scanned, now_unix)
}

use super::to_hex as hex_lower;

/// Re-exported: both moved to `config` with the endpoint cores (task 84), where
/// the pin policy belongs beside the config it reads.
pub(crate) use super::config::config_pins;

/// Set (or clear, with `None`) the sync endpoint. Validates against the A4/TB5
/// policy, then — for an `https` endpoint — **TOFU-pins the server's leaf cert**
/// and returns its fingerprint (lowercase SHA-256 hex) for the user to
/// eye-compare across devices (`self-host-policy.md` §6). A loopback `http`
/// endpoint has no TLS, so it returns `None`. Clearing drops the pin too.
/// The endpoint-set result: the pinned fingerprint + its source (SYNC-43), so the
/// UI can render a self-host first-connect TOFU pin ("compare across devices")
/// distinctly from a pre-vetted hosted static pin — never silently normalizing
/// TOFU-for-hosted.
/// Re-exported so the desktop's `generate_handler!` and the TS mirror keep
/// resolving `commands::EndpointPinInfo`; the type moved to `config` with the
/// core (task 84).
pub use super::config::EndpointPinInfo;

/// Set (or clear, with `None`) the sync endpoint.
///
/// This wrapper owns ONE thing the core cannot: acquiring the TOFU pin, which
/// means completing a TLS handshake and reading the leaf certificate over
/// `rustls_transport` — host-only, with no browser equivalent (a page never sees
/// the certificate). Everything after that — URL policy, persistence, derived
/// pin source — is `config::set_endpoint`, shared with the web dispatch.
#[tauri::command]
pub async fn sync_set_endpoint<R: Runtime>(
    app: AppHandle<R>,
    endpoint_url: Option<String>,
) -> Result<EndpointPinInfo, SyncConfigError> {
    let cert_pin_hex = match endpoint_url.as_deref() {
        Some(url) => {
            // Validate BEFORE reaching out: an invalid URL must fail as an
            // invalid URL, not as an unreachable server.
            validate_endpoint_url(url)?;
            let (scheme, host, port) =
                super::http_transport::parse_endpoint(url).ok_or(SyncConfigError::InvalidUrl)?;
            if scheme == "https" {
                // Reach the server once, accept-and-record its cert, pin it.
                let pin = tokio::task::spawn_blocking(move || {
                    super::rustls_transport::tofu_fetch_pin(&host, port)
                })
                .await
                .map_err(|_| SyncConfigError::Io {
                    io_error_kind: crate::io_failure_kind::IoFailureKind::Other,
                })?
                .map_err(|_| SyncConfigError::InvalidUrl)?; // couldn't reach / handshake
                Some(hex_lower(&pin))
            } else {
                None // loopback http: no TLS, nothing to pin
            }
        }
        None => None,
    };
    super::config::set_endpoint(
        &crate::host::tauri_host::TauriHost::new(app.clone()),
        &crate::vault_io::StdVaultIo,
        endpoint_url,
        cert_pin_hex,
        CLIENT_CAN_PIN,
    )
    .await
}

/// Whether this client can pin a server certificate.
///
/// A browser cannot: it never sees the leaf cert, and `decisions.md` 2026-07-26
/// records that as permanent rather than deferred. Named here rather than
/// spelled `cfg!(…)` at the two call sites so the two readers of the endpoint
/// config cannot drift apart on it.
#[cfg(not(target_arch = "wasm32"))]
pub(crate) const CLIENT_CAN_PIN: bool = true;
#[cfg(target_arch = "wasm32")]
pub(crate) const CLIENT_CAN_PIN: bool = false;

/// Process-wide live-status cell (app-managed, like `SyncLocalChange`). The loop
/// and `sync_now` set it; `sync_status` reads it. `None` = no overlay (fall back
/// to the base config state / conflicts). Desktop + mobile both register it; when
/// unregistered, `try_state` → `None`, so producers are a safe no-op.
#[derive(Default)]
pub struct SyncRuntimeStatusCell(std::sync::Mutex<Option<LiveStatus>>);

impl SyncRuntimeStatusCell {
    /// Publish "a cycle is in flight".
    pub fn set_syncing(&self) {
        *self.0.lock().unwrap() = Some(LiveStatus::Syncing);
    }
    /// Publish "the last cycle failed" with a bounded, non-secret detail tag.
    pub fn set_error(&self, detail: impl Into<String>) {
        *self.0.lock().unwrap() = Some(LiveStatus::Error(detail.into()));
    }
    /// Clear the overlay (a clean/idle cycle → fall back to base + conflicts).
    pub fn clear(&self) {
        *self.0.lock().unwrap() = None;
    }
    pub(crate) fn get(&self) -> Option<LiveStatus> {
        self.0.lock().unwrap().clone()
    }
}

/// Report the current sync status for the status indicator (task 10).
///
/// A thin wrapper now: the derivation moved to `status::read_status` so the
/// browser reports the same states (task 84). What stays here is the one
/// host-shaped input — the app-managed [`SyncRuntimeStatusCell`], which is a
/// `Manager::try_state` singleton and has no browser counterpart yet.
#[tauri::command]
pub async fn sync_status<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, VaultRuntimeState>,
) -> Result<SyncRuntimeStatus, SyncConfigError> {
    let live = app
        .try_state::<SyncRuntimeStatusCell>()
        .and_then(|c| c.get());
    super::status::read_status(
        &crate::host::tauri_host::TauriHost::new(app.clone()),
        &crate::vault_io::StdVaultIo,
        state.inner(),
        live,
    )
    .await
}

/// Report which notes the server has **not** acknowledged (phase3-web-client
/// task 23).
///
/// A sibling of [`sync_status`], not a field on it, and read-only in the same
/// way: it derives everything from disk (each note's `MY01` header nonce and the
/// `sync-state.json` baselines) and touches no key material, so it costs a
/// directory scan and a prefix read per note rather than a vault-wide decrypt.
/// Unlike `sync_status` it has no host-shaped input at all, so the whole body is
/// the shared core — the browser dispatches the same function.
#[tauri::command]
pub async fn sync_unsynced_edits<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, VaultRuntimeState>,
) -> Result<super::unsynced::UnsyncedEdits, SyncConfigError> {
    super::unsynced::read_unsynced(
        &crate::host::tauri_host::TauriHost::new(app.clone()),
        &crate::vault_io::StdVaultIo,
        state.inner(),
    )
    .await
}

/// How far through materialising a vault this device is (phase3-web-client task
/// 39). Read-only, lock-free, no IO — three atomic loads — so a UI may poll it
/// on a short beat while a first sync of thousands of notes is running.
#[tauri::command]
pub async fn sync_materialisation_progress(
) -> Result<super::progress::MaterialisationProgress, SyncConfigError> {
    Ok(super::progress::read())
}

/// Re-exported: the cycle and its outcome type moved to `cycle` with task 84,
/// so the browser runs the same code. `loop_control` and `sync_now` keep
/// resolving `commands::{CycleOutcome, run_active_cycle}`.
pub use super::cycle::CycleOutcome;

/// Gather the active vault's sync inputs and run one cycle.
///
/// A thin wrapper now. The `AppHandle` supplies the host seam and the runtime
/// state; everything else — the gather, the process-wide serializer, the
/// blocking-pool scheduling, the four event emits — is `cycle`'s, shared with
/// the browser.
pub async fn run_active_cycle<R: Runtime>(app: &AppHandle<R>, allow_push: bool) -> CycleOutcome {
    let Some(state) = app.try_state::<VaultRuntimeState>() else {
        return CycleOutcome::NotReady;
    };
    super::cycle::run_active_cycle_from_host(
        &crate::host::tauri_host::TauriHost::new(app.clone()),
        &crate::vault_io::StdVaultIo,
        state.inner(),
        allow_push,
    )
    .await
}

/// Best-effort: push the current on-disk `vault.meta` to the server right now, so
/// a local credential change (password change / recovery reset) is reflected
/// server-side immediately instead of going stale until the next device enrols
/// (F1). A stale server `vault.meta` makes a joining device derive `root_key`
/// against the OLD password-side wrap and fail to unlock with the new password.
///
/// Deliberately **best-effort and non-blocking**: it never fails the caller. Any
/// not-ready state (sync disabled, not enrolled, vault locked / no stored token)
/// is a silent no-op, and a transport failure only writes the `vault.meta-dirty`
/// marker so the sync loop's meta phase (F1 Faz B) pushes it later. Returns
/// `true` only when the server accepted the PUT. A still-pending device (no
/// stored token yet) no-ops without marking dirty — enrolment re-seeds meta.
/// Tauri arm. Looks the runtime state up through `Manager` exactly as before, so
/// its behaviour — including the silent `false` when no state is managed — is
/// unchanged for any caller that still has only an `AppHandle`.
#[cfg(all(feature = "tauri-ipc", not(target_arch = "wasm32")))]
pub async fn push_vault_meta_now<R: Runtime>(app: &AppHandle<R>) -> bool {
    let Some(state) = app.try_state::<VaultRuntimeState>() else {
        return false;
    };
    push_vault_meta_now_from_host(
        &crate::host::tauri_host::TauriHost::new(app.clone()),
        state.inner(),
    )
    .await
}

/// Host arm. Takes the runtime state **explicitly** rather than looking it up.
///
/// That is deliberate and is the one place this port improves on what it
/// replaced. `Manager::try_state` returning `None` is a *silent* `false` here —
/// a sync push that never happened and never said so. Every caller of this
/// function is a command that already holds `State<'_, VaultRuntimeState>`
/// (Tauri could not have invoked it otherwise), so the `None` branch was
/// unreachable from them; making the parameter explicit removes the branch
/// rather than preserving a failure mode nobody could hit.
pub async fn push_vault_meta_now_from_host(host: &dyn HostCtx, state: &VaultRuntimeState) -> bool {
    // A thin wrapper now (phase3-web-client task 41). The body moved to
    // `cycle::push_vault_meta_now_via_io` so the BROWSER can run it: a web
    // password change that never reaches the server is the failure task 88
    // exists to prevent, and it cannot be prevented from a module the wasm build
    // does not compile.
    super::cycle::push_vault_meta_now_via_io(host, &crate::vault_io::StdVaultIo, state).await
}

/// Request an immediate sync ("sync now" affordance, task 10). Runs one real
/// full cycle (pull head-verify + rollback-reject → download → write to disk →
/// push local changes under a fresh head → persist). Returns the resulting
/// status — `Disabled`/`Idle` for the honest not-ready states, `Error` only on a
/// genuine transport/protocol failure.
#[tauri::command]
pub async fn sync_now<R: Runtime>(app: AppHandle<R>) -> Result<SyncRuntimeStatus, SyncConfigError> {
    let Some(state) = app.try_state::<VaultRuntimeState>() else {
        return Ok(SyncRuntimeStatus::NotEnrolled);
    };
    Ok(super::cycle::sync_now_from_host(
        &crate::host::tauri_host::TauriHost::new(app.clone()),
        &crate::vault_io::StdVaultIo,
        state.inner(),
    )
    .await)
}

/// Mobile lifecycle ingress (SYNC-37/38): the WebView's `visibilitychange`
/// handler reports "app backgrounded" so the sync loop hard-idles instead of
/// ticking against a frozen clock. Flips an in-RAM scheduler flag only — no
/// vault access, no IO, no server call; a no-op on hosts that do not manage the
/// [`super::loop_control::SyncLifecycleSignal`] (desktop).
#[tauri::command]
pub async fn sync_lifecycle_suspend<R: Runtime>(app: AppHandle<R>) {
    if let Some(sig) = app.try_state::<super::loop_control::SyncLifecycleSignal>() {
        sig.suspend();
    }
}

/// Foreground counterpart of [`sync_lifecycle_suspend`]: clears the suspend
/// flag and arms the one-shot resume-immediate poll, so returning to the app
/// pulls fresh state without waiting out the poll interval. Same no-op
/// contract on hosts without the managed signal.
#[tauri::command]
pub async fn sync_lifecycle_resume<R: Runtime>(app: AppHandle<R>) {
    if let Some(sig) = app.try_state::<super::loop_control::SyncLifecycleSignal>() {
        sig.resume();
    }
}

// --- Device management commands (MYND-425 tasks 7/8) ---
//
// Authed device roster + approve/remove over the server auth surface. The token
// comes from the device-local token store (task 4 fallback); the transport from
// the configured endpoint via the build_transport factory (loopback-http for
// dev/harness, pinned rustls for https). No root_key needed (device-mgmt is
// token-authed); enrollment (which needs root_key) is a separate command.

use super::devices::{self, DeviceEntry};
use crate::plugins::vault_unlock::state::VaultRuntimeState;
use tauri::State;

/// Re-exported: the device/account command CORES moved to `devices` with task
/// 84, so the browser dispatches the same code. `generate_handler!`, the mobile
/// crate and the TS mirrors keep resolving these paths.
pub use super::devices::{AccountStatusView, SyncDeviceError};

/// List the account's devices (the device-list UI + pending-discovery render).
#[tauri::command]
pub async fn sync_list_devices<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, VaultRuntimeState>,
) -> Result<Vec<DeviceEntry>, SyncDeviceError> {
    devices::list_devices_from_host(
        &crate::host::tauri_host::TauriHost::new(app.clone()),
        &crate::vault_io::StdVaultIo,
        state.inner(),
    )
    .await
}

/// Approve a pending device (the existing unlocked device authorizes it).
#[tauri::command]
pub async fn sync_approve_device<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, VaultRuntimeState>,
    device_id_hex: String,
) -> Result<(), SyncDeviceError> {
    devices::approve_device_from_host(
        &crate::host::tauri_host::TauriHost::new(app.clone()),
        &crate::vault_io::StdVaultIo,
        state.inner(),
        &device_id_hex,
    )
    .await
}

/// Remove a device — revoke its token (availability; not a crypto lockout, SYNC-2).
#[tauri::command]
pub async fn sync_remove_device<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, VaultRuntimeState>,
    device_id_hex: String,
) -> Result<(), SyncDeviceError> {
    devices::remove_device_from_host(
        &crate::host::tauri_host::TauriHost::new(app.clone()),
        &crate::vault_io::StdVaultIo,
        state.inner(),
        &device_id_hex,
    )
    .await
}

/// Read this account's own usage + effective ceilings for Settings → Sync.
#[tauri::command]
pub async fn sync_account_status<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, VaultRuntimeState>,
) -> Result<Option<AccountStatusView>, SyncConfigError> {
    devices::account_status_from_host(
        &crate::host::tauri_host::TauriHost::new(app.clone()),
        &crate::vault_io::StdVaultIo,
        state.inner(),
    )
    .await
}

// --- Keep-both conflict materialization (MYND-427) ---
//
// When two devices edit the same note concurrently, `run_sync_cycle` stages the
// remote revision under `<vault>/conflicts/<id>.myn` and surfaces it; the local
// edit stays untouched. The notes layer drives the three commands below to
// finish the keep-both: list the pending conflicts, decrypt each remote revision
// to its plaintext (to materialize a `conflict_of:` copy via `note_create`), then
// resolve — adopting the remote as the synced baseline so the local edit pushes
// as a clean linear advance. No edit is ever lost or silently overwritten.

/// Reset this device's sync enrollment locally: clear the device-local token + the
/// sync baseline (`sync-state.json` + `vault.head-state`) for the active vault,
/// returning it to a clean "not enrolled, unsynced" state. This is the in-app recovery
/// when the token is stale/rejected — the device was removed from another device, or
/// the server's auth state was reset — so the panel no longer loops on Unauthenticated
/// / NotEnrolled with no way forward. After reset, re-add the device via the enroll
/// form. It NEVER touches `notes/`, attachments, or `vault.meta`, and never calls the
/// server (a rejected token cannot authenticate a server-side remove); the server-side
/// device row, if any, is reaped by the existing approval/retire path. The client reads
/// token + state from disk per operation, so the effect is immediate (no app restart).
#[tauri::command]
pub async fn sync_reset_local<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, VaultRuntimeState>,
) -> Result<(), SyncDeviceError> {
    devices::reset_local_from_host(
        &crate::host::tauri_host::TauriHost::new(app.clone()),
        &crate::vault_io::StdVaultIo,
        state.inner(),
    )
    .await
}

/// List the note ids (hex) with a staged conflicting remote revision awaiting
/// keep-both materialization.
#[tauri::command]
pub async fn sync_pending_conflicts<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, VaultRuntimeState>,
) -> Result<Vec<String>, SyncDeviceError> {
    let dir = crate::paths::active_vault_root_io(&app, state.active_vault_id().await)
        .map_err(|_| SyncDeviceError::Internal)?;
    Ok(super::conflict::pending_conflicts(&crate::vault_io::StdVaultIo, &dir).await)
}

/// Decrypt a staged conflicting remote revision to its plaintext body, so the
/// notes layer can materialize it as a keep-both copy. The body is the user's
/// note plaintext (same secret class as `note_read`) — never logged. See the
/// repo `src-tauri/CLAUDE.md` "Secret-handling logging discipline".
#[tauri::command]
pub async fn sync_take_conflict<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, VaultRuntimeState>,
    original_id_hex: String,
) -> Result<String, SyncDeviceError> {
    let dir = crate::paths::active_vault_root_io(&app, state.active_vault_id().await)
        .map_err(|_| SyncDeviceError::Internal)?;
    super::conflict::take_conflict(
        &crate::vault_io::StdVaultIo,
        &dir,
        state.inner(),
        &original_id_hex,
    )
    .await
}

/// Finish a keep-both resolution: adopt the staged remote revision as the synced
/// baseline (the untouched local edit then pushes as a linear advance) + clear
/// the staging. Idempotent.
#[tauri::command]
pub async fn sync_resolve_conflict<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, VaultRuntimeState>,
    original_id_hex: String,
) -> Result<(), SyncDeviceError> {
    let dir = crate::paths::active_vault_root_io(&app, state.active_vault_id().await)
        .map_err(|_| SyncDeviceError::Internal)?;
    super::conflict::resolve_conflict(&crate::vault_io::StdVaultIo, &dir, &original_id_hex).await
}

/// Queue a deletion (note id, 32-hex) so the next push sets its server-side
/// tombstone flag (horizon-GC). The dialect-aware notes layer calls this from the
/// tombstone path — it knows the version is genuinely a deletion, so a LIVE note
/// is never flagged (no false-positive → the server never GCs live data). No
/// vault-blob access; only the device-local pending-tombstone queue is touched.
#[tauri::command]
pub async fn sync_mark_tombstone<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, VaultRuntimeState>,
    note_id_hex: String,
) -> Result<(), SyncDeviceError> {
    let dir = crate::paths::active_vault_root_io(&app, state.active_vault_id().await)
        .map_err(|_| SyncDeviceError::Internal)?;
    super::conflict::mark_tombstone(&crate::vault_io::StdVaultIo, &dir, &note_id_hex).await
}

// --- Recovered notes: quarantine visibility (MYND-427 follow-up) ---
//
// The reconcile drop-leg moves a previously-synced note whose server record
// was deleted + horizon-GC-reclaimed into `<vault>/quarantine/` instead of
// destroying it (§11.3 drop disposition — never destroyed, never re-uploaded).
// The four commands below give the user a window into that dir: list the
// quarantined blobs, decrypt one for preview, restore one as a NEW note (a
// fresh UUIDv7 — re-pushing the reclaimed id would resurrect deleted content
// server-side), or delete one permanently. `sync_delete_quarantine` is the
// ONLY destroyer of `quarantine/` content (`clear_device_local_sync`
// deliberately skips the dir, sync/state.rs — it holds user data), so the UI
// gates it behind an explicit confirm.

/// Re-exported: the quarantine cores + their row type moved to `conflict` with
/// task 87, so the browser dispatches the same code.
pub use super::conflict::QuarantineEntry;
use super::conflict::{
    delete_quarantine_in, list_quarantine_entries, read_quarantine_with_dir,
    restore_quarantine_with_dirs,
};

/// List the quarantined note blobs for the "Recovered notes" surface.
#[tauri::command]
pub async fn sync_list_quarantine<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, VaultRuntimeState>,
) -> Result<Vec<QuarantineEntry>, SyncDeviceError> {
    let dir = crate::paths::active_vault_root_io(&app, state.active_vault_id().await)
        .map_err(|_| SyncDeviceError::Internal)?;
    Ok(list_quarantine_entries(&crate::vault_io::StdVaultIo, &dir).await)
}

/// Decrypt one quarantined blob to its plaintext body for the preview modal.
/// The body is note plaintext (the `note_read` secret class) — never logged.
#[tauri::command]
pub async fn sync_read_quarantine<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, VaultRuntimeState>,
    file_name: String,
) -> Result<String, SyncDeviceError> {
    let dir = crate::paths::active_vault_root_io(&app, state.active_vault_id().await)
        .map_err(|_| SyncDeviceError::Internal)?;
    read_quarantine_with_dir(
        &crate::vault_io::StdVaultIo,
        &dir,
        state.inner(),
        &file_name,
    )
    .await
}

/// Restore a quarantined blob as a NEW note and remove the quarantine source
/// on success. Returns the new note's 36-char id.
#[tauri::command]
pub async fn sync_restore_quarantine<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, VaultRuntimeState>,
    hooks: State<'_, crate::hooks::Hooks>,
    file_name: String,
) -> Result<String, SyncDeviceError> {
    let dir = crate::paths::active_vault_root_io(&app, state.active_vault_id().await)
        .map_err(|_| SyncDeviceError::Internal)?;
    let notes_dir = crate::paths::notes_dir_under(&dir).map_err(|_| SyncDeviceError::Internal)?;
    let (new_id, body) = restore_quarantine_with_dirs(
        &crate::vault_io::StdVaultIo,
        &dir,
        notes_dir,
        state.inner(),
        &file_name,
        &crate::host::tauri_host::TauriHost::new(app.clone()),
    )
    .await?;
    // Mirror `note_create`'s post-write side-effects (the Tauri wrapper there
    // owns them, so calling the `_with_dir` core directly means wiring them
    // here): search/AI indexing so the restored note is findable in-session,
    // and the sync dirty-bump so the restore pushes on the next cycle.
    let title = crate::plugins::notes::title_extract::resolve_note_title(body.as_bytes())
        .unwrap_or_default();
    if crate::plugins::notes::drawing_text::is_drawing(body.as_bytes()) {
        let projected = crate::plugins::notes::drawing_text::project_drawing_text(body.as_bytes())
            .unwrap_or_default();
        hooks.search_upsert(&new_id, &title, &projected);
    } else {
        hooks.search_upsert(&new_id, &title, &body);
        hooks
            .index_note_attachments(state.inner(), &new_id, &title, &body)
            .await;
    }
    hooks.ai_note_changed(&new_id, &body);
    hooks.bump_local_change();
    Ok(new_id)
}

/// Delete a quarantined blob permanently (UI confirms first — this is the
/// only path that destroys quarantine evidence).
#[tauri::command]
pub async fn sync_delete_quarantine<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, VaultRuntimeState>,
    file_name: String,
) -> Result<(), SyncDeviceError> {
    let dir = crate::paths::active_vault_root_io(&app, state.active_vault_id().await)
        .map_err(|_| SyncDeviceError::Internal)?;
    delete_quarantine_in(&crate::vault_io::StdVaultIo, &dir, &file_name).await
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

// `head_fingerprint_of_hex` moved to `devices` with MYND-635 — `commands` is
// `tauri-ipc`-gated, so anything living here is invisible to the wasm build, and
// the web client needs this encoding for the same eye-compare the desktop does.

/// The 8-char Crockford `XXXX-XXXX` SAS fingerprint of this device's currently
/// adopted vault head — the substrate for the enroll-time out-of-band eye-compare
/// (SYNC-17 / bootstrap-fingerprint, `sync-protocol.md` §6.3). Reads the
/// device-local sync-state's latest head observation (the engine records it after
/// each pull/reconcile via `record_observation`); returns `None` when the device
/// has adopted no head yet (never synced). This is the SINGLE encoding feeding
/// both SAS UI ends (mobile SY-05 + desktop DeviceManagementPanel) — no word-list,
/// no second derivation.
///
/// SHIP-GATE (SYNC-17): the primitive-level review of `protocol::head_fingerprint`
/// is still flagged and MUST close before the enroll-compare ships. This command
/// only exposes the frozen substrate; it does NOT discharge that review debt.
#[tauri::command]
pub async fn sync_head_fingerprint<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, VaultRuntimeState>,
) -> Result<Option<String>, SyncDeviceError> {
    devices::head_fingerprint_from_host(
        &crate::host::tauri_host::TauriHost::new(app.clone()),
        &crate::vault_io::StdVaultIo,
        state.inner(),
    )
    .await
}

/// Re-exported: the enrolment types moved to `enroll` with the flow (task 84),
/// so `generate_handler!`, the mobile crate and the TS mirrors keep resolving
/// `commands::{EnrollCredential, EnrollResult}`.
pub use super::enroll::{EnrollCredential, EnrollResult};

/// Enroll this device against the configured server using {account# + credential}.
///
/// A thin wrapper now: the flow moved to `enroll::enroll_device_from_host` with
/// task 84. What stays here is the one host-shaped side effect — the
/// bootstrap-push signal, a `Manager::try_state` counter with no browser twin.
#[tauri::command]
pub async fn sync_enroll<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, VaultRuntimeState>,
    account_number: String,
    credential: String,
    credential_kind: EnrollCredential,
) -> Result<EnrollResult, SyncDeviceError> {
    let out = super::enroll::enroll_device_from_host(
        &crate::host::tauri_host::TauriHost::new(app.clone()),
        &crate::vault_io::StdVaultIo,
        state.inner(),
        account_number,
        credential,
        credential_kind,
    )
    .await?;

    // Bootstrap upload (MYND-424): an approved device that just enrolled with an
    // existing, populated vault must push it WITHOUT waiting for a note edit.
    // `sync_enroll` itself does not author a head; the background loop only
    // pushes once a local change is signalled. Reuse that same coalesced-push
    // trigger so the loop's next tick opens the coalescing window and runs an
    // allow_push cycle. Safe re: the resolution-blur side-channel — a one-shot
    // bootstrap, not edit timing. A pending device is skipped: it cannot push
    // and, as a joining device, has no local vault to upload.
    if out.approved {
        if let Some(sig) = app.try_state::<super::loop_control::SyncLocalChange>() {
            sig.bump();
        }
    }
    Ok(out)
}

/// Re-exported: the join flow and its result moved to `enroll` with task 85, so
/// the browser bootstraps through the same code.
pub use super::enroll::JoinResult;

/// **Add this device to an existing account.**
///
/// A thin wrapper: it supplies the two things that differ per client — a
/// freshly-MINTED vault id (desktop holds many vaults, so collision-freedom
/// costs a disk scan) and `can_pin: true` (only a host can complete a TLS
/// handshake and read the leaf certificate).
#[tauri::command]
pub async fn sync_join_account<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, VaultRuntimeState>,
    server_url: String,
    account_number: String,
    password: String,
) -> Result<JoinResult, SyncDeviceError> {
    let base = app
        .path()
        .app_data_dir()
        .map_err(|_| SyncDeviceError::Internal)?;
    let vault_id = crate::vault_registry::mint_unique_vault_id(&base);
    super::enroll::join_account_from_host(
        &crate::host::tauri_host::TauriHost::new(app.clone()),
        &crate::vault_io::StdVaultIo,
        state.inner(),
        super::enroll::JoinClient {
            vault_id,
            can_pin: true,
        },
        server_url,
        account_number,
        password,
    )
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    // Only the test below still reaches for it — `sync_reset_local`'s body moved
    // to `devices` with MYND-635.
    use super::super::cycle::sync_cycle_mutex;
    // Used only by the quarantine fixtures below; imported here rather than at
    // module scope so the lib build does not carry an unused import.
    use super::super::conflict::parse_quarantine_file_name;
    use super::super::devices::hex16;
    use std::path::Path;

    fn qr_account() -> String {
        String::from_utf8(
            protocol::generate_account_number()
                .unwrap()
                .canonical
                .to_vec(),
        )
        .unwrap()
    }

    #[test]
    fn decode_join_qr_view_maps_a_fresh_self_host_payload() {
        use super::super::qr_join::QrJoinPayload;
        let acct = qr_account();
        let pin = "ab".repeat(32);
        let encoded =
            QrJoinPayload::new("https://sync.example.org", &acct, Some(pin.clone()), 1_000)
                .unwrap()
                .encode()
                .unwrap();
        let view = decode_join_qr_view(&encoded, 1_050).expect("decode");
        assert_eq!(view.endpoint_url, "https://sync.example.org");
        assert_eq!(view.account_number, acct);
        assert_eq!(view.cert_pin_hex, Some(pin));
        assert_eq!(view.pin_source, JoinQrPinSource::SelfHostTofu);
        assert!(view.fresh);
    }

    #[test]
    fn decode_join_qr_view_flags_a_stale_payload() {
        use super::super::qr_join::{QrJoinPayload, QR_JOIN_TTL_SECS};
        let acct = qr_account();
        let encoded = QrJoinPayload::new("https://s.example", &acct, None, 1_000)
            .unwrap()
            .encode()
            .unwrap();
        let view = decode_join_qr_view(&encoded, 1_000 + QR_JOIN_TTL_SECS + 999).expect("decode");
        assert!(!view.fresh);
        assert_eq!(view.pin_source, JoinQrPinSource::SelfHostNoPin);
    }

    #[test]
    fn decode_join_qr_view_rejects_non_myne_input() {
        assert!(decode_join_qr_view("https://evil.example", 1).is_err());
    }

    // `head_fingerprint_of_hex_matches_golden_vector` moved to `devices` with
    // the function itself (MYND-635). It gains coverage rather than losing it:
    // this module is `tauri-ipc`-gated, so the golden vector was never checked
    // on the wasm build that now uses the same encoding.

    #[test]
    fn sync_cycle_mutex_serializes_concurrent_holders() {
        use std::sync::atomic::{AtomicUsize, Ordering};
        // Two truly-parallel tasks. If the guard did not serialize (or the callers
        // used different mutex instances), both would occupy the critical section
        // at once and MAX_SEEN would reach 2; the shared lock keeps it at 1.
        static ACTIVE: AtomicUsize = AtomicUsize::new(0);
        static MAX_SEEN: AtomicUsize = AtomicUsize::new(0);
        async fn hold() {
            let _g = sync_cycle_mutex().lock().await;
            let n = ACTIVE.fetch_add(1, Ordering::SeqCst) + 1;
            MAX_SEEN.fetch_max(n, Ordering::SeqCst);
            // Widen the overlap window so a broken lock is caught deterministically.
            tokio::task::yield_now().await;
            std::thread::sleep(std::time::Duration::from_millis(20));
            ACTIVE.fetch_sub(1, Ordering::SeqCst);
        }
        let rt = tokio::runtime::Builder::new_multi_thread()
            .worker_threads(2)
            .enable_all()
            .build()
            .expect("multi-thread runtime");
        rt.block_on(async {
            let a = tokio::spawn(hold());
            let b = tokio::spawn(hold());
            a.await.unwrap();
            b.await.unwrap();
        });
        assert_eq!(
            MAX_SEEN.load(Ordering::SeqCst),
            1,
            "two sync-cycle-guard holders must never overlap"
        );
    }

    #[test]
    fn status_from_maps_endpoint_token_identity_to_status() {
        // No endpoint → Disabled regardless of token/identity. (The regression the
        // status fix removed: the old stub returned Idle/"Synced" whenever an endpoint
        // existed, ignoring enrollment entirely.)
        assert_eq!(
            status_from(false, false, false),
            SyncRuntimeStatus::Disabled
        );
        assert_eq!(status_from(false, true, true), SyncRuntimeStatus::Disabled);
        // Endpoint + token → Idle (token presence dominates identity).
        assert_eq!(status_from(true, true, false), SyncRuntimeStatus::Idle);
        assert_eq!(status_from(true, true, true), SyncRuntimeStatus::Idle);
        // Endpoint + no token + persisted identity → Pending (added, awaiting approval).
        assert_eq!(status_from(true, false, true), SyncRuntimeStatus::Pending);
        // Endpoint + no token + no identity → NotEnrolled (never added).
        assert_eq!(
            status_from(true, false, false),
            SyncRuntimeStatus::NotEnrolled
        );
    }

    #[test]
    fn overlay_status_config_state_dominates_live_and_conflicts() {
        // A device that cannot sync shows WHY, never a stale live/conflict overlay.
        for base in [
            SyncRuntimeStatus::Disabled,
            SyncRuntimeStatus::NotEnrolled,
            SyncRuntimeStatus::Pending,
        ] {
            assert_eq!(
                overlay_status(base.clone(), Some(LiveStatus::Syncing), 5),
                base
            );
        }
    }

    #[test]
    fn overlay_status_live_wins_over_conflicts_over_idle() {
        use SyncRuntimeStatus as S;
        // In-flight Syncing wins even with conflicts present.
        assert_eq!(
            overlay_status(S::Idle, Some(LiveStatus::Syncing), 3),
            S::Syncing
        );
        // A failed cycle surfaces Error (with its detail) over conflicts.
        assert_eq!(
            overlay_status(S::Idle, Some(LiveStatus::Error("sync_failed".into())), 3),
            S::Error {
                detail: "sync_failed".into()
            }
        );
        // No live overlay + unresolved conflicts → Conflicts{count}.
        assert_eq!(overlay_status(S::Idle, None, 2), S::Conflicts { count: 2 });
        // Enrolled, nothing in flight, no conflicts → a bare Idle.
        assert_eq!(overlay_status(S::Idle, None, 0), S::Idle);
    }

    #[test]
    fn runtime_status_cell_transitions() {
        let cell = SyncRuntimeStatusCell::default();
        assert_eq!(cell.get(), None); // no overlay initially
        cell.set_syncing();
        assert_eq!(cell.get(), Some(LiveStatus::Syncing));
        cell.set_error("sync_failed");
        assert_eq!(cell.get(), Some(LiveStatus::Error("sync_failed".into())));
        cell.clear();
        assert_eq!(cell.get(), None); // a clean cycle clears the overlay
    }

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

    // ---- Recovered-notes quarantine commands ------------------------------

    use crate::plugins::vault_unlock::state::{fixture_unlocked_with_keys, test_vault_id};
    use crate::test_support::ScopedTempDir;

    const SEED_ROOT: u8 = 0x42;
    const SEED_ITEMS: u8 = 0x99;
    const SEED_ITEMS_ID: u8 = 1;
    const QUAR_BODY: &[u8] = b"# Recovered\n\nquarantined body";

    fn rt() -> tokio::runtime::Runtime {
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("current-thread runtime")
    }

    async fn unlocked_state() -> VaultRuntimeState {
        let state = VaultRuntimeState::default();
        state
            .set_unlocked(
                test_vault_id(),
                fixture_unlocked_with_keys(SEED_ROOT, SEED_ITEMS, SEED_ITEMS_ID),
            )
            .await;
        state
    }

    /// Seal `QUAR_BODY` under the fixture items key with `uuid` as the AAD
    /// and drop it into `<vault>/quarantine/<file_name>`.
    fn seed_quarantined_blob(vault_root: &Path, uuid: &uuid::Uuid, file_name: &str) {
        let blob = protocol::encode_new_note(
            &[SEED_ITEMS; 32],
            &[SEED_ITEMS_ID; 16],
            uuid.as_bytes(),
            QUAR_BODY,
        )
        .expect("encode quarantined note blob");
        let dir = super::super::orchestrator::quarantine_dir(vault_root);
        std::fs::create_dir_all(&dir).expect("create quarantine dir");
        std::fs::write(dir.join(file_name), blob).expect("write quarantined blob");
    }

    const QUAR_UUID_A: &str = "01970e83-4f2f-7000-8000-00000000000a";
    const QUAR_UUID_B: &str = "01970e83-4f2f-7000-8000-00000000000b";

    #[test]
    fn parse_quarantine_file_name_accepts_base_and_duplicate_suffix() {
        let expected = *uuid::Uuid::parse_str(QUAR_UUID_A).unwrap().as_bytes();
        assert_eq!(
            parse_quarantine_file_name(&format!("{QUAR_UUID_A}.myn")),
            Some(expected)
        );
        // A `-<n>` duplicate parses to the SAME base uuid — the decode AAD is
        // the suffix-stripped id (blob filename rule, protocol.md §9.1).
        assert_eq!(
            parse_quarantine_file_name(&format!("{QUAR_UUID_A}-1.myn")),
            Some(expected)
        );
        assert_eq!(
            parse_quarantine_file_name(&format!("{QUAR_UUID_A}-12.myn")),
            Some(expected)
        );
    }

    #[test]
    fn parse_quarantine_file_name_rejects_traversal_and_wrong_shape() {
        // Path traversal / absolute paths.
        assert!(parse_quarantine_file_name("../vault.meta").is_none());
        assert!(parse_quarantine_file_name(&format!("../{QUAR_UUID_A}.myn")).is_none());
        assert!(parse_quarantine_file_name(&format!("/tmp/{QUAR_UUID_A}.myn")).is_none());
        // Wrong / missing extension.
        assert!(parse_quarantine_file_name(QUAR_UUID_A).is_none());
        assert!(parse_quarantine_file_name(&format!("{QUAR_UUID_A}.txt")).is_none());
        // Malformed duplicate suffix.
        assert!(parse_quarantine_file_name(&format!("{QUAR_UUID_A}-.myn")).is_none());
        assert!(parse_quarantine_file_name(&format!("{QUAR_UUID_A}-1x.myn")).is_none());
        // Uppercase / non-uuid stems.
        assert!(parse_quarantine_file_name("01970E83-4F2F-7000-8000-00000000000A.myn").is_none());
        assert!(parse_quarantine_file_name("not-a-uuid.myn").is_none());
        assert!(parse_quarantine_file_name(".myn").is_none());
        assert!(parse_quarantine_file_name("").is_none());
    }

    #[test]
    fn quarantine_list_empty_then_sorted_with_duplicate_suffix() {
        let tmp = ScopedTempDir::new("quar-list").expect("scoped tempdir");
        use crate::vault_io::VaultIo as _;
        let io = &crate::vault_io::StdVaultIo;
        let entries = crate::test_support::block_on(async {
            // No quarantine/ dir at all → empty, no error.
            assert!(list_quarantine_entries(io, tmp.path()).await.is_empty());

            let qdir = super::super::orchestrator::quarantine_dir(tmp.path());
            // `VaultIo::write` does NOT create parent directories — it writes
            // where it is told. The old `std::fs` fixture did its own
            // `create_dir_all`, so this is the same step, not a new one.
            io.create_dir_all(&qdir)
                .await
                .expect("create quarantine dir");
            // Staged through the SEAM, like every other ported fixture: a test
            // that writes with `std::fs` while production reads through
            // `VaultIo` proves a path production does not take.
            let put = |name: String, bytes: &'static [u8]| {
                let p = qdir.join(name);
                async move {
                    io.write(&p, bytes, crate::vault_io::WriteOpts::default())
                        .await
                        .expect("stage fixture");
                }
            };
            put(format!("{QUAR_UUID_B}.myn"), b"bbbb").await;
            put(format!("{QUAR_UUID_A}-1.myn"), b"aaaaa").await;
            put(format!("{QUAR_UUID_A}.myn"), b"aaa").await;
            // Stray entries are skipped, not surfaced.
            put(".DS_Store".to_string(), b"x").await;
            put("not-a-uuid.myn".to_string(), b"x").await;

            list_quarantine_entries(io, tmp.path()).await
        });
        assert_eq!(
            entries
                .iter()
                .map(|e| e.file_name.as_str())
                .collect::<Vec<_>>(),
            vec![
                // Deterministic file-name sort: `-` (0x2d) < `.` (0x2e).
                format!("{QUAR_UUID_A}-1.myn"),
                format!("{QUAR_UUID_A}.myn"),
                format!("{QUAR_UUID_B}.myn"),
            ]
        );
        // The duplicate row strips its `-1` suffix down to the base uuid.
        assert_eq!(entries[0].note_id_hex, QUAR_UUID_A);
        assert_eq!(entries[1].note_id_hex, QUAR_UUID_A);
        assert_eq!(entries[2].note_id_hex, QUAR_UUID_B);
        assert_eq!(entries[0].size, 5);
        assert_eq!(entries[1].size, 3);
        assert!(entries[0].modified_epoch_ms.is_some());
    }

    #[test]
    fn quarantine_read_opens_duplicate_with_base_uuid_aad() {
        rt().block_on(async {
            let tmp = ScopedTempDir::new("quar-read").expect("scoped tempdir");
            let state = unlocked_state().await;
            let uuid = uuid::Uuid::parse_str(QUAR_UUID_A).unwrap();
            // Sealed under the BASE uuid, stored under the `-1` duplicate name
            // — exactly what `quarantine_note` produces on a repeated drop.
            seed_quarantined_blob(tmp.path(), &uuid, &format!("{QUAR_UUID_A}-1.myn"));

            let body = read_quarantine_with_dir(
                &crate::vault_io::StdVaultIo,
                tmp.path(),
                &state,
                &format!("{QUAR_UUID_A}-1.myn"),
            )
            .await
            .expect("duplicate decodes under its base-uuid AAD");
            assert_eq!(body.as_bytes(), QUAR_BODY);
        });
    }

    #[test]
    fn quarantine_read_locked_vault_errors() {
        rt().block_on(async {
            let tmp = ScopedTempDir::new("quar-locked").expect("scoped tempdir");
            let state = VaultRuntimeState::default(); // no unlocked slot
            let uuid = uuid::Uuid::parse_str(QUAR_UUID_A).unwrap();
            seed_quarantined_blob(tmp.path(), &uuid, &format!("{QUAR_UUID_A}.myn"));

            let err = read_quarantine_with_dir(
                &crate::vault_io::StdVaultIo,
                tmp.path(),
                &state,
                &format!("{QUAR_UUID_A}.myn"),
            )
            .await
            .expect_err("locked vault must not decrypt quarantine content");
            assert_eq!(err, SyncDeviceError::Internal);
        });
    }

    #[test]
    fn quarantine_restore_mints_new_id_removes_source_and_preserves_content() {
        rt().block_on(async {
            let tmp = ScopedTempDir::new("quar-restore").expect("scoped tempdir");
            let state = unlocked_state().await;
            let uuid = uuid::Uuid::parse_str(QUAR_UUID_A).unwrap();
            let file_name = format!("{QUAR_UUID_A}.myn");
            seed_quarantined_blob(tmp.path(), &uuid, &file_name);
            let notes_dir = crate::paths::notes_dir_under(tmp.path()).expect("notes dir");

            let (new_id, body) = restore_quarantine_with_dirs(
                &crate::vault_io::StdVaultIo,
                tmp.path(),
                notes_dir.clone(),
                &state,
                &file_name,
                &crate::host::NoopHost,
            )
            .await
            .expect("restore succeeds");

            // A NEW id — the reclaimed original is never re-pushed.
            assert_ne!(new_id, QUAR_UUID_A);
            assert_eq!(body.as_bytes(), QUAR_BODY);
            // The quarantine source is gone…
            assert!(!super::super::orchestrator::quarantine_dir(tmp.path())
                .join(&file_name)
                .exists());
            // …and the new `.myn` decodes byte-identically under the new id.
            let new_blob =
                std::fs::read(notes_dir.join(format!("{new_id}.myn"))).expect("new note blob");
            let new_uuid = *uuid::Uuid::parse_str(&new_id).unwrap().as_bytes();
            let decrypted = protocol::decode_note(
                &new_blob,
                &new_uuid,
                &[SEED_ITEMS; 32],
                &[SEED_ITEMS_ID; 16],
            )
            .expect("restored note decodes");
            assert_eq!(decrypted.plaintext(), QUAR_BODY);
        });
    }

    #[test]
    fn quarantine_restore_failed_create_keeps_source() {
        rt().block_on(async {
            // Locked vault → note_create_with_dir rejects → the quarantine
            // source must remain untouched (evidence never destroyed on a
            // failed restore).
            let tmp = ScopedTempDir::new("quar-restore-fail").expect("scoped tempdir");
            let state = VaultRuntimeState::default();
            let uuid = uuid::Uuid::parse_str(QUAR_UUID_A).unwrap();
            let file_name = format!("{QUAR_UUID_A}.myn");
            seed_quarantined_blob(tmp.path(), &uuid, &file_name);
            let notes_dir = crate::paths::notes_dir_under(tmp.path()).expect("notes dir");

            let err = restore_quarantine_with_dirs(
                &crate::vault_io::StdVaultIo,
                tmp.path(),
                notes_dir,
                &state,
                &file_name,
                &crate::host::NoopHost,
            )
            .await
            .expect_err("locked vault must not restore");
            assert_eq!(err, SyncDeviceError::Internal);
            assert!(super::super::orchestrator::quarantine_dir(tmp.path())
                .join(&file_name)
                .exists());
        });
    }

    #[test]
    fn quarantine_delete_rejects_pattern_violations_and_removes_valid() {
        use crate::vault_io::VaultIo as _;
        let tmp = ScopedTempDir::new("quar-delete").expect("scoped tempdir");
        let qdir = super::super::orchestrator::quarantine_dir(tmp.path());
        let file_name = format!("{QUAR_UUID_A}.myn");
        let io = &crate::vault_io::StdVaultIo;
        crate::test_support::block_on(async {
            // See the sibling test: the seam's `write` does not mkdir -p.
            io.create_dir_all(&qdir)
                .await
                .expect("create quarantine dir");
            io.write(
                &qdir.join(&file_name),
                b"ciphertext",
                crate::vault_io::WriteOpts::default(),
            )
            .await
            .expect("stage fixture");

            // Pattern violations are BadRequest — nothing outside quarantine/ is
            // reachable through this command.
            for bad in [
                "../vault.meta".to_string(),
                format!("../{QUAR_UUID_A}.myn"),
                format!("/tmp/{QUAR_UUID_A}.myn"),
                QUAR_UUID_A.to_string(), // no .myn
                format!("{QUAR_UUID_A}.txt"),
            ] {
                assert_eq!(
                    delete_quarantine_in(io, tmp.path(), &bad).await,
                    Err(SyncDeviceError::BadRequest),
                    "must reject {bad:?}"
                );
            }
            assert!(
                io.exists(&qdir.join(&file_name)).await.unwrap(),
                "rejections must not delete"
            );

            // The valid name removes exactly that file.
            delete_quarantine_in(io, tmp.path(), &file_name)
                .await
                .expect("valid delete");
            assert!(!io.exists(&qdir.join(&file_name)).await.unwrap());
            // A second delete of the now-missing file surfaces Internal.
            assert_eq!(
                delete_quarantine_in(io, tmp.path(), &file_name).await,
                Err(SyncDeviceError::Internal)
            );
        });
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
