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
use crate::vault_io::VaultIo as _;
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
///
/// `confirmed_fingerprint` is the fingerprint the user obtained **out-of-band**
/// from their server. It is optional on the clearnet (the shipped TOFU bargain
/// is unchanged) and **mandatory in Tor mode**, where the first handshake goes
/// through an exit node that is in a position to serve its own certificate —
/// see `super::pin_confirm`. A mismatch aborts with nothing written: no
/// endpoint, no pin.
#[tauri::command]
pub async fn sync_set_endpoint<R: Runtime>(
    app: AppHandle<R>,
    endpoint_url: Option<String>,
    confirmed_fingerprint: Option<String>,
) -> Result<EndpointPinInfo, SyncConfigError> {
    let cert_pin_hex = match endpoint_url.as_deref() {
        Some(url) => {
            // Validate BEFORE reaching out: an invalid URL must fail as an
            // invalid URL, not as an unreachable server.
            validate_endpoint_url(url)?;
            let (scheme, host, port) =
                super::http_transport::parse_endpoint(url).ok_or(SyncConfigError::InvalidUrl)?;
            if scheme == "https" {
                // Reach the server once, accept-and-record its cert, pin it —
                // subject to the out-of-band compare in Tor mode.
                let captured =
                    super::pin_confirm::capture_pin(host, port, confirmed_fingerprint.as_deref())
                        .await
                        .map_err(SyncConfigError::from)?;
                // A re-connect to an endpoint this device ALREADY trusts must
                // not silently adopt a different certificate (myne#581). This
                // command used to overwrite the stored pin with whatever the
                // handshake produced, never reading the old one, so "re-enter
                // the server URL" — the remedy the device panel recommends for
                // a transport failure — was also the way to hand a pin to
                // whoever answered. The user confirming a fingerprint out of
                // band is the one path that may replace it, and `capture_pin`
                // above has already enforced that compare when they did.
                if confirmed_fingerprint.is_none() {
                    let host_ctx = crate::host::tauri_host::TauriHost::new(app.clone());
                    if let Ok(path) = super::config::config_path_for_read(&host_ctx) {
                        let cfg = super::config::read_config(&crate::vault_io::StdVaultIo, &path)
                            .await
                            .unwrap_or_default();
                        let replaces_a_trusted_pin = cfg.endpoint_url.as_deref() == Some(url)
                            && cfg
                                .cert_pin_hex
                                .as_deref()
                                .is_some_and(|prev| prev != captured);
                        if replaces_a_trusted_pin {
                            return Err(SyncConfigError::CertificateChanged);
                        }
                    }
                }
                Some(captured)
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
    // A pulled note has to reach the search / attachment / AI indexes exactly
    // as a locally-saved one does (myne#305), and the hooks are how any of the
    // three is reachable from here.
    let Some(hooks) = app.try_state::<crate::hooks::Hooks>() else {
        return CycleOutcome::NotReady;
    };
    super::cycle::run_active_cycle_from_host(
        &crate::host::tauri_host::TauriHost::new(app.clone()),
        &crate::vault_io::StdVaultIo,
        state.inner(),
        hooks.inner(),
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
    let Some(hooks) = app.try_state::<crate::hooks::Hooks>() else {
        return Ok(SyncRuntimeStatus::NotEnrolled);
    };
    Ok(super::cycle::sync_now_from_host(
        &crate::host::tauri_host::TauriHost::new(app.clone()),
        &crate::vault_io::StdVaultIo,
        state.inner(),
        hooks.inner(),
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

/// A device-verification eye-compare (SYNC-40) is open on this device — hold
/// content pushes so the vault head cannot advance under it (myne#462).
///
/// **Idempotent, and it doubles as the lease ping.** The open screen calls this
/// about once a second; silence for
/// [`VERIFY_HOLD_LEASE_MS`](super::verify_hold::VERIFY_HOLD_LEASE_MS) releases
/// the hold, so a crashed WebView cannot leave this device silently unsynced.
/// Renewal cannot push past
/// [`VERIFY_HOLD_MAX_MS`](super::verify_hold::VERIFY_HOLD_MAX_MS).
///
/// Like the lifecycle pair above: an in-RAM flag only — no vault access, no IO,
/// no server call. Pulls are untouched, which is required rather than
/// incidental (both sides reach the head they are comparing by pulling).
#[tauri::command]
pub async fn sync_verify_hold_begin<R: Runtime>(app: AppHandle<R>) {
    use crate::host::HostCtx as _;
    let now = crate::host::tauri_host::TauriHost::new(app).now_unix_millis();
    super::verify_hold::verify_hold().begin(now);
}

/// Release the hold engaged by [`sync_verify_hold_begin`] — the compare closed,
/// by match, by mismatch or by unmount. Idempotent: the UI releases on every
/// unmount path and cannot always know which one ran first.
#[tauri::command]
pub async fn sync_verify_hold_end<R: Runtime>(_app: AppHandle<R>) {
    super::verify_hold::verify_hold().end();
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

/// **Unlock the backend-held person identity** (B2B identity substrate,
/// myne-md/myne#698). One call per process: derive (or first-enroll) the
/// person keypair from the person's own recovery phrase and hold it in
/// [`VaultRuntimeState`], never in the WebView. Every later invite reads
/// it from there, so no private seed ever crosses IPC.
///
/// The phrase crosses the bridge exactly once, at this unlock-equivalent
/// moment, mirroring the master-password-at-unlock precedent.
#[tauri::command]
pub async fn sync_person_unlock<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, VaultRuntimeState>,
    phrase: String,
) -> Result<PersonIdentityView, SyncDeviceError> {
    let phrase = zeroize::Zeroizing::new(phrase);
    // `normalize_user_phrase` is infallible by signature: it canonicalizes
    // whatever it is handed, and a phrase that does not decode as BIP-39
    // simply derives a different (unusable) identity rather than erroring.
    let normalized = protocol::normalize_user_phrase(&phrase);
    let pair = crate::account::person_identity::unlock_person_identity(
        &crate::host::tauri_host::TauriHost::new(app.clone()),
        &crate::vault_io::StdVaultIo,
        normalized.as_str(),
    )
    .await
    .map_err(|e| {
        // Map by cause: a transient IO or CSPRNG failure is not a "bad phrase",
        // and telling the user to retype a correct phrase sends them in a loop.
        use crate::account::person_identity::PersonIdentityError as E;
        match e {
            E::BadPhrase | E::CannotDecrypt => SyncDeviceError::BadRequest,
            E::Io | E::Csprng => SyncDeviceError::Transport,
        }
    })?;
    let view = PersonIdentityView {
        fingerprint_hex: crate::account::person_identity::hex_lower(pair.fingerprint()),
    };
    state.inner().set_person_identity(pair).await;
    Ok(view)
}

/// **Drop the backend-held person identity** (lock-equivalent). The pair
/// zeroizes as it drops.
///
/// `forget: true` additionally ERASES the device-local sealed file, which is
/// person off-boarding from this device rather than a session lock: the next
/// unlock with the same phrase re-enrols a fresh keypair and a new fingerprint.
/// The flag exists so the erase path has a production caller instead of being a
/// dead function, and so a plain lock never destroys an enrollment the user did
/// not mean to drop.
#[tauri::command]
pub async fn sync_person_lock<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, VaultRuntimeState>,
    forget: Option<bool>,
) -> Result<(), SyncDeviceError> {
    let _ = state.inner().take_person_identity().await;
    if forget.unwrap_or(false) {
        let host = crate::host::tauri_host::TauriHost::new(app.clone());
        crate::account::person_identity::delete_sealed_file(&host, &crate::vault_io::StdVaultIo)
            .await
            .map_err(|_| SyncDeviceError::BadRequest)?;
    }
    Ok(())
}

/// The person identity's public view (fingerprint only, no key material).
#[derive(Debug, serde::Serialize)]
pub struct PersonIdentityView {
    /// Canonical fingerprint (the SAS value), lowercase hex.
    pub fingerprint_hex: String,
}

/// **Invite a member to the unlocked vault** (B2B identity substrate,
/// myne-md/myne#698 task 5-6 command core).
///
/// Wraps the vault's `itemsKey` to the member's full person public half
/// (ML-KEM ek + Ed25519 pk + ML-DSA vk, all lowercase hex, fetched from
/// the member's SCRAM account), seals the payload to the member under a
/// fresh PQ-hybrid frame, and signs it with the HELD owner identity.
/// Randomness comes from the OS CSPRNG; the held identity comes from
/// `sync_person_unlock`; the vault hash binds the wrap to this vault.
///
/// The wire ROUTE is Grill 4's (B10): this core returns the invite frame;
/// the caller relays it once the route exists.
#[tauri::command]
pub async fn sync_invite_member<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, VaultRuntimeState>,
    member_kem_ek_hex: String,
    member_ed_pk_hex: String,
    member_mldsa_vk_hex: String,
    vault_label: String,
    created_at_secs: u64,
) -> Result<InviteCommandView, SyncDeviceError> {
    let host = crate::host::tauri_host::TauriHost::new(app.clone());
    let io = crate::vault_io::StdVaultIo;
    // Peek the slot, then DROP the guard before any await: holding a
    // `slots.read()` across `active_vault_id()`'s own `slots.read()` is the
    // tokio RwLock deadlock shape (a queued writer blocks the second acquire
    // while the first stays held).
    let (root_key, items_key) = {
        let slot = state.inner().slot_read_active().await;
        match &*slot {
            crate::plugins::vault_unlock::state::Slot::Unlocked(uv) => (
                zeroize::Zeroizing::new(*uv.root_key),
                zeroize::Zeroizing::new(*uv.items_key),
            ),
            _ => return Err(SyncDeviceError::NotEnrolled),
        }
    };
    let owner = state
        .inner()
        .clone_person_identity()
        .await
        .ok_or(SyncDeviceError::NotEnrolled)?;

    let member_public = protocol::person_key::PersonPublicHalf::from_parts_hex(
        &member_kem_ek_hex,
        &member_ed_pk_hex,
        &member_mldsa_vk_hex,
    )
    .map_err(|_| SyncDeviceError::BadRequest)?;

    // Serialize the whole-blob `vault.meta` read-modify-write against every
    // other lifecycle mutation BEFORE reading: the permit must be held across
    // the read below and the write in `write_roster_row`, or a concurrent
    // `change_password` landing between them is silently reverted by the
    // invite write (both blobs stay AEAD-valid, so nothing detects it).
    // `member_removal` takes the permit first for the same reason.
    let _permit = state
        .inner()
        .auth_permits()
        .try_acquire()
        .map_err(|_| SyncDeviceError::Transport)?;

    // Read `vault.meta` ONCE: its account hash binds the wrap and its roster is
    // the store the invited member's row is written into.
    let root = crate::paths::active_vault_root_from_base(
        &host
            .app_data_dir()
            .map_err(|_| SyncDeviceError::Transport)?,
        state.inner().active_vault_id().await,
    );
    let meta_path = root.join("vault.meta");
    let meta_bytes = io
        .read(&meta_path)
        .await
        .map_err(|_| SyncDeviceError::Transport)?;
    let version = protocol::meta_version_of(&meta_bytes).unwrap_or(protocol::MetaVersion::V0_1);
    let mut meta =
        protocol::parse_vault_meta_any(&meta_bytes).map_err(|_| SyncDeviceError::BadRequest)?;
    let account_number_hash = meta.account_number_hash;

    // Panics on an OS CSPRNG failure (the `CryptoRng` bound the person
    // surfaces take needs an infallible source; `rng.rs` documents that
    // posture). Not a recoverable state on a supported platform.
    let mut rng = rand_core::UnwrapErr(crate::rng::OsRng);
    let invite = super::invite::invite_create(
        &owner,
        &member_public,
        &items_key,
        &account_number_hash,
        &vault_label,
        created_at_secs,
        &mut rng,
    )
    .map_err(|_| SyncDeviceError::BadRequest)?;

    // Write the invited member's roster row. This is what CREATES the roster
    // extension: without it no roster is ever written, `sync_list_roster` stays
    // empty, and `sync_remove_member` is unreachable.
    let wrapped = protocol::person_rekey::wrap_items_key_to_member(
        &items_key,
        &member_public,
        &account_number_hash,
        &mut rng,
    )
    .map_err(|_| SyncDeviceError::BadRequest)?;
    let row = super::invite::invited_member_row(
        &member_public,
        super::invite::wrapped_hex(&wrapped),
        &vault_label,
        created_at_secs,
    );
    if let Err(e) = write_roster_row(
        state.inner(),
        &_permit,
        &io,
        &root,
        &meta_path,
        version,
        &mut meta,
        &root_key,
        &account_number_hash,
        row,
    )
    .await
    {
        tracing::debug!(stage = "invite", error = ?e, "roster row write failed");
        return Err(e);
    }

    let invite_wire = protocol::person_invite::vault_invite_to_wire(&invite);
    Ok(InviteCommandView {
        owner_fingerprint_hex: invite.owner_fingerprint_hex,
        member_fingerprint_hex: invite.member_fingerprint_hex,
        owner_ed25519_pk_hex: invite.owner_ed25519_pk_hex.clone(),
        owner_mldsa_vk_hex: invite.owner_mldsa_vk_hex.clone(),
        // The relayable frame. The wire ROUTE is Grill 4's, but the frame itself
        // is what the member needs to accept, so the command hands it back
        // instead of dropping it: without this the invite cannot leave the
        // device and the feature is inert in one direction.
        invite_wire,
    })
}

/// Unseal the roster (or start empty), upsert one member row, re-seal it into
/// `vault.meta`, and write the meta back. Runs under the caller's auth permit
/// (held across the `vault.meta` read in `sync_invite_member` and this write),
/// so the write cannot interleave a concurrent `change_password`; marks the
/// meta dirty so the row reaches peers, and refreshes the slot anchor so the
/// next change-password does not read the write as external tampering.
#[allow(clippy::too_many_arguments)]
async fn write_roster_row(
    state: &VaultRuntimeState,
    _permit: &tokio::sync::SemaphorePermit<'_>,
    io: &dyn crate::vault_io::VaultIo,
    root: &std::path::Path,
    meta_path: &std::path::Path,
    version: protocol::MetaVersion,
    meta: &mut protocol::VaultMeta,
    root_key: &[u8; 32],
    account_number_hash: &[u8; 16],
    row: super::roster::RosterMemberEntry,
) -> Result<(), SyncDeviceError> {
    // The auth permit arrives held from `sync_invite_member` (acquired before
    // its `vault.meta` read); it is only borrowed here to keep the
    // read-modify-write under one hold. Taking it here instead would leave the
    // outer read outside the serialization.
    let current = match meta.membership.as_ref().and_then(|m| m.roster.as_ref()) {
        Some(env) => {
            let plaintext = protocol::unseal_membership_roster(root_key, env, account_number_hash)
                .map_err(|_| SyncDeviceError::BadRequest)?;
            super::roster::parse_roster(&plaintext).ok_or(SyncDeviceError::BadRequest)?
        }
        None => super::roster::RosterMap::new(),
    };
    // Refuse to re-invite a tombstoned member rather than writing the unchanged
    // roster and handing back a live invite frame: `upsert_member` leaves a
    // tombstone alone (remove-wins), so the member would accept an invite that
    // the roster never records and no later rotation re-wraps.
    if current
        .get(&row.fingerprint_hex)
        .is_some_and(|existing| existing.deleted)
    {
        return Err(SyncDeviceError::BadRequest);
    }
    let updated = super::roster::upsert_member(&current, row);
    let plaintext = super::roster::encode_roster(&updated);
    let mut nonce = [0u8; protocol::MEMBERSHIP_ROSTER_NONCE_LEN];
    getrandom::getrandom(&mut nonce).map_err(|_| SyncDeviceError::Transport)?;
    let env =
        protocol::seal_membership_roster_raw(root_key, &plaintext, account_number_hash, &nonce)
            .map_err(|_| SyncDeviceError::BadRequest)?;
    match meta.membership.as_mut() {
        Some(m) => m.roster = Some(env),
        None => return Err(SyncDeviceError::BadRequest),
    }
    let old_hash = state
        .peek_unlocked_root_key_and_hash_clone()
        .await
        .map(|(_, h)| h);
    let new_bytes = protocol::serialize_vault_meta_versioned(version, meta);
    io.write(meta_path, &new_bytes, crate::vault_io::WriteOpts::default())
        .await
        .map_err(|_| SyncDeviceError::Transport)?;
    if let Err(e) = crate::plugins::sync::state::mark_vault_meta_dirty(io, root).await {
        tracing::debug!(stage = "invite", error = ?e, "meta-dirty marker write failed");
    }
    // Refresh the CAS anchor to the bytes written, or the next change-password
    // compares against the pre-invite hash and force-relocks with
    // `VaultMetaChangedExternally`.
    if let (Some(old), Some(id)) = (old_hash, state.active_vault_id().await) {
        use sha2::Digest as _;
        let new_hash: [u8; 32] = sha2::Sha256::digest(&new_bytes).into();
        state.refresh_meta_hash_if(id, old, new_hash).await;
    }
    Ok(())
}

/// The invite command's serializable result.
#[derive(Debug, serde::Serialize)]
pub struct InviteCommandView {
    pub owner_fingerprint_hex: String,
    pub member_fingerprint_hex: String,
    pub owner_ed25519_pk_hex: String,
    pub owner_mldsa_vk_hex: String,
    /// The whole sealed invite frame, hex-JSON encoded
    /// (`protocol::person_invite::vault_invite_to_wire`), for the caller to
    /// relay to the member. Accept is a later task; this is the frame it needs.
    pub invite_wire: String,
}

/// **List the unlocked vault's B2B roster** (myne-md/myne#698 task 9).
///
/// Unseals the membership field's roster extension (when present) with the
/// slot's `root_key`, parses the canonical member rows, and returns the
/// non-tombstoned ones. A vault without the extension answers an empty
/// list (the 0580 single-account shape, no roster to show).
#[tauri::command]
pub async fn sync_list_roster<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, VaultRuntimeState>,
) -> Result<Vec<RosterMemberView>, SyncDeviceError> {
    let host = crate::host::tauri_host::TauriHost::new(app.clone());
    let io = crate::vault_io::StdVaultIo;
    let slot = state.inner().slot_read_active().await;
    let root_key = match &*slot {
        crate::plugins::vault_unlock::state::Slot::Unlocked(uv) => uv.root_key.clone(),
        _ => return Err(SyncDeviceError::NotEnrolled),
    };
    drop(slot);

    let root = crate::paths::active_vault_root_from_base(
        &host
            .app_data_dir()
            .map_err(|_| SyncDeviceError::Transport)?,
        state.inner().active_vault_id().await,
    );
    // Read + parse `vault.meta` ONCE: the account hash and the roster both come
    // from it, and a second read could observe a file that changed between them.
    let bytes = io
        .read(&root.join("vault.meta"))
        .await
        .map_err(|_| SyncDeviceError::Transport)?;
    let meta = protocol::parse_vault_meta_any(&bytes).map_err(|_| SyncDeviceError::BadRequest)?;
    let hash = meta.account_number_hash;
    let roster = match meta.membership.as_ref().and_then(|m| m.roster.as_ref()) {
        Some(roster) => {
            let plaintext = protocol::unseal_membership_roster(&root_key, roster, &hash)
                .map_err(|_| SyncDeviceError::BadRequest)?;
            // The roster is AEAD-verified by now, so a parse failure means the
            // writer is broken. Error rather than substitute an empty map:
            // answering "no members" for a corrupt roster would let the caller
            // (and the next write) persist that emptiness over real rows.
            super::roster::parse_roster(&plaintext).ok_or(SyncDeviceError::BadRequest)?
        }
        None => super::roster::RosterMap::new(),
    };

    Ok(roster
        .into_values()
        .filter(|m| !m.deleted)
        .map(RosterMemberView::from_entry)
        .collect())
}

/// One roster row as the UI consumes it.
#[derive(Debug, serde::Serialize)]
pub struct RosterMemberView {
    pub fingerprint_hex: String,
    pub display_name: String,
    pub version: u64,
    pub previous_fingerprint_hex: Option<String>,
    pub joined_at: u64,
    /// The member's Ed25519 public key (lowercase hex).
    pub member_ed_pk_hex: String,
    /// The member's ML-KEM encapsulation key (lowercase hex).
    pub member_kem_ek_hex: String,
    /// The member's ML-DSA verifying key (lowercase hex).
    pub member_mldsa_vk_hex: String,
}

impl RosterMemberView {
    fn from_entry(e: super::roster::RosterMemberEntry) -> Self {
        Self {
            fingerprint_hex: e.fingerprint_hex,
            display_name: e.display_name,
            version: e.version,
            previous_fingerprint_hex: e.previous_fingerprint_hex,
            joined_at: e.joined_at,
            member_ed_pk_hex: e.member_ed_pk_hex,
            member_kem_ek_hex: e.member_kem_ek_hex,
            member_mldsa_vk_hex: e.member_mldsa_vk_hex,
        }
    }
}

/// **Remove a member from the unlocked vault** (B2B, myne-md/myne#698
/// tasks 4 and 7). Rotates the vault `itemsKey`, re-wraps every note and
/// attachment blob's per-entry key under it (content ciphertext
/// byte-identical), tombstones the removed member's roster row, re-wraps
/// the new `itemsKey` to every remaining member's carried public half,
/// re-seals the roster into `vault.meta`, and re-derives the slot's
/// `itemsKey` so the running session keeps working.
#[tauri::command]
pub async fn sync_remove_member<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, VaultRuntimeState>,
    member_fingerprint_hex: String,
) -> Result<(), SyncDeviceError> {
    super::member_removal::remove_member_from_host(
        &crate::host::tauri_host::TauriHost::new(app.clone()),
        &crate::vault_io::StdVaultIo,
        state.inner(),
        &member_fingerprint_hex,
    )
    .await
    .map_err(|e| {
        // Map the closed enum by cause rather than collapsing every failure to
        // `Transport`: a removed member that does not exist and a corrupt
        // `vault.meta` are not transient network faults, and reporting them as
        // one makes a failed call indistinguishable from a retryable one.
        use super::member_removal::MemberRemovalError as E;
        match e {
            E::VaultLocked | E::NoRoster => SyncDeviceError::NotEnrolled,
            E::MemberNotFound => SyncDeviceError::DeviceNotFound,
            // A contended auth permit is transient: the frontend retries rather
            // than re-enrolling, so it maps to `Transport`, not `NotEnrolled`.
            E::Busy => SyncDeviceError::Transport,
            E::CannotDecrypt | E::InvalidVaultMeta | E::Io => SyncDeviceError::BadRequest,
        }
    })
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
    delete_quarantine_in(
        &crate::vault_io::StdVaultIo,
        &dir,
        state.inner(),
        &file_name,
    )
    .await
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
///
/// `confirmed_fingerprint` is the out-of-band value the user obtained from
/// their server — optional on the clearnet, mandatory in Tor mode
/// (`super::pin_confirm`, MYND-650 task 5). A join that omits it in Tor mode,
/// or supplies one the server does not match, aborts having written nothing:
/// no endpoint, no pin, no vault container.
#[tauri::command]
pub async fn sync_join_account<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, VaultRuntimeState>,
    server_url: String,
    account_number: String,
    password: String,
    confirmed_fingerprint: Option<String>,
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
        super::enroll::JoinRequest {
            server_url,
            account_number,
            password,
            confirmed_fingerprint,
        },
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
        // Endpoint + token + identity → Idle.
        assert_eq!(status_from(true, true, true), SyncRuntimeStatus::Idle);
        // #267: token presence no longer dominates identity. A token with no
        // identity is a device that cannot sync — it reported `Idle`, the UI
        // read that as "already enrolled", and the retry surface stayed hidden
        // while the cycle refused to run.
        assert_eq!(
            status_from(true, true, false),
            SyncRuntimeStatus::NotEnrolled
        );
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
                overlay_status(base.clone(), Some(LiveStatus::Syncing), 5, None),
                base
            );
        }
    }

    #[test]
    fn overlay_status_live_wins_over_conflicts_over_idle() {
        use SyncRuntimeStatus as S;
        // In-flight Syncing wins even with conflicts present.
        assert_eq!(
            overlay_status(S::Idle, Some(LiveStatus::Syncing), 3, None),
            S::Syncing
        );
        // A failed cycle surfaces Error (with its detail) over conflicts.
        assert_eq!(
            overlay_status(
                S::Idle,
                Some(LiveStatus::Error("sync_failed".into())),
                3,
                None
            ),
            S::Error {
                detail: "sync_failed".into(),
                last_success_at: None
            }
        );
        // No live overlay + unresolved conflicts → Conflicts{count}.
        assert_eq!(
            overlay_status(S::Idle, None, 2, None),
            S::Conflicts { count: 2 }
        );
        // Enrolled, nothing in flight, no conflicts → a bare Idle.
        assert_eq!(overlay_status(S::Idle, None, 0, None), S::Idle);
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

    /// The only destroyer of `quarantine/` content refuses when nothing is
    /// unlocked — and the blob is still on disk afterwards (myne#382).
    ///
    /// Asserted at rest, not only through the return value: §11.3 calls the
    /// quarantined ciphertext the *recoverable* ceiling on a lying server, and
    /// "recoverable" is a claim about the bytes, not about an error code. Its
    /// siblings refuse when locked only as a side effect of needing `items_key`;
    /// a delete needs no key, so it used to answer.
    #[test]
    fn quarantine_delete_refuses_while_locked() {
        rt().block_on(async {
            let tmp = ScopedTempDir::new("quar-delete-locked").expect("scoped tempdir");
            let state = VaultRuntimeState::default(); // no unlocked slot
            let uuid = uuid::Uuid::parse_str(QUAR_UUID_A).unwrap();
            let file_name = format!("{QUAR_UUID_A}.myn");
            seed_quarantined_blob(tmp.path(), &uuid, &file_name);

            let err =
                delete_quarantine_in(&crate::vault_io::StdVaultIo, tmp.path(), &state, &file_name)
                    .await
                    .expect_err("locked vault must not destroy quarantine evidence");
            assert_eq!(err, SyncDeviceError::Internal);
            assert!(
                tmp.path().join("quarantine").join(&file_name).exists(),
                "the evidence must survive the refusal"
            );
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

            // UNLOCKED, deliberately: threading a `VaultRuntimeState::default()`
            // here to make it compile would silently turn every assertion below
            // into an assertion about the LOCKED path, and the traversal guard
            // would stop being tested at all (myne#382).
            let state = unlocked_state().await;

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
                    delete_quarantine_in(io, tmp.path(), &state, &bad).await,
                    Err(SyncDeviceError::BadRequest),
                    "must reject {bad:?}"
                );
            }
            assert!(
                io.exists(&qdir.join(&file_name)).await.unwrap(),
                "rejections must not delete"
            );

            // The valid name removes exactly that file.
            delete_quarantine_in(io, tmp.path(), &state, &file_name)
                .await
                .expect("valid delete");
            assert!(!io.exists(&qdir.join(&file_name)).await.unwrap());
            // A second delete of the now-missing file surfaces Internal.
            assert_eq!(
                delete_quarantine_in(io, tmp.path(), &state, &file_name).await,
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
