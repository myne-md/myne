// SPDX-License-Identifier: AGPL-3.0
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

use super::config::SyncConfigError;
use crate::host::HostCtx;
use crate::vault_io::VaultIo as _;
use std::path::PathBuf;
// The rest of this module is still Tauri-shaped (task 79 step 9); only the two
// entry points the auth cluster calls have host arms so far.
use tauri::{AppHandle, Emitter, Manager, Runtime};

/// Re-exported so `generate_handler!`, the mobile crate and the TS mirror keep
/// resolving `commands::SyncRuntimeStatus`; the type moved to `status` with the
/// derivation (task 84).
pub use super::status::{overlay_status, status_from, LiveStatus, SyncClocks, SyncRuntimeStatus};

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
    )
    .await
}

/// The decoded, validated view of a scanned device-join QR — everything the mobile
/// confirm screen needs before the user enters their credential (MYND-466, Option 1).
///
/// Internally tagged by `kind`, because the two targets lead to different
/// credentials and different next steps: an `account` code is the owner's
/// `{account# + password}` join, a `member_vault` one is the member's own
/// second-device join with the 24-word phrase (myne-md/myne). One flat struct
/// with an optional field per kind would put that choice in the caller's hands.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum JoinQrView {
    /// The vault ACCOUNT: the owner's device-join flow.
    Account {
        /// Endpoint URL the QR carried (prefills the join form / endpoint set).
        endpoint_url: String,
        /// Canonical account number the QR carried (the UI formats it for display).
        account_number: String,
        /// Whether the QR is still fresh (within the ephemeral TTL). A stale QR is
        /// rejected with a "re-scan a fresh one" message (grill Q8 liveness).
        fresh: bool,
    },
    /// The PERSON (myne-md/myne#911 task 9): an owner's device-join on the
    /// identity model. The scanner proves the 24-word phrase and registers as a
    /// device of that person's account, which admits it to every vault the
    /// person owns after one approval.
    Person {
        /// Endpoint URL the QR carried (prefills the settle step / endpoint set).
        endpoint_url: String,
        /// The person id, 32 lowercase hex. Public material: it is the hash the
        /// identity code already carries, and it is what the joining device
        /// checks the account it reached against.
        person_id_hex: String,
        /// See [`JoinQrView::Account::fresh`].
        fresh: bool,
    },
    /// A shared vault, joined by a MEMBER's own second device.
    MemberVault {
        /// Endpoint URL the QR carried.
        endpoint_url: String,
        /// The vault's `account_number_hash`, 32 lowercase hex. The scanner uses it
        /// to find the invite row this vault appears as; it is not a secret (it is
        /// the vault's public id and the namespace its blobs live under).
        account_hash_hex: String,
        /// See [`JoinQrView::Account::fresh`].
        fresh: bool,
    },
}

/// Pure decode → view mapping (host-testable; the command supplies `now_unix`).
fn decode_join_qr_view(
    scanned: &str,
    now_unix: u64,
) -> Result<JoinQrView, super::qr_join::QrJoinDecodeError> {
    use super::qr_join::{QrJoinPayload, QrJoinTarget, QR_JOIN_TTL_SECS};
    let payload = QrJoinPayload::decode(scanned.trim())?;
    let fresh = payload.is_fresh(now_unix, QR_JOIN_TTL_SECS);
    let endpoint_url = payload.endpoint_url;
    Ok(match payload.target {
        QrJoinTarget::Account { account_number } => JoinQrView::Account {
            endpoint_url,
            account_number,
            fresh,
        },
        QrJoinTarget::MemberVault { account_hash_hex } => JoinQrView::MemberVault {
            endpoint_url,
            account_hash_hex,
            fresh,
        },
        QrJoinTarget::Person { person_id_hex } => JoinQrView::Person {
            endpoint_url,
            person_id_hex,
            fresh,
        },
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

/// Re-export the endpoint result so existing IPC registration stays stable.
pub use super::config::EndpointPinInfo;

/// Set (or clear, with `None`) the sync endpoint.
///
/// Native HTTPS performs a validated handshake using the SAME transport and
/// Tor route as later sync requests before storing the URL. The retired
/// `confirmed_fingerprint` IPC argument is ignored for old-client compatibility.
///
/// The probe is [`super::enroll::verify_join_tls`], shared with the device-join
/// flow rather than written out again. The two commands have separate error
/// enums, so the mapping to `SyncConfigError` stays here; the POLICY, the
/// transport and the order (verify, then write) do not, and when they were two
/// copies a server that refused its certificate produced `TlsFailure` on the
/// join path and `Unreachable` here, so the same fault read as two different
/// things depending on which door the user came through.
#[tauri::command]
pub async fn sync_set_endpoint<R: Runtime>(
    app: AppHandle<R>,
    endpoint_url: Option<String>,
    _confirmed_fingerprint: Option<String>,
    invite_code: Option<String>,
) -> Result<EndpointPinInfo, SyncConfigError> {
    if let Some(url) = endpoint_url.as_deref() {
        super::enroll::verify_join_tls(url)
            .await
            .map_err(|e| match e {
                super::transport::TransportError::Tls => SyncConfigError::TlsFailure,
                _ => SyncConfigError::Unreachable,
            })?;
    }
    super::config::set_endpoint(
        &crate::host::tauri_host::TauriHost::new(app.clone()),
        &crate::vault_io::StdVaultIo,
        endpoint_url,
        None,
        invite_code,
    )
    .await
}

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
    /// Publish "the last cycle ran and could not upload", with a bounded cause token
    /// (myne-md/myne#1027).
    ///
    /// The third state this cell was missing. Before it, a cycle that succeeded without
    /// uploading had to choose between `set_error` (a lie about a pull that worked) and
    /// `clear` (the status falls back to `Idle`, which the indicator renders as "Synced", the
    /// other lie, and the one that hid this state for a day).
    pub fn set_blocked(&self, detail: impl Into<String>) {
        *self.0.lock().unwrap() = Some(LiveStatus::Blocked(detail.into()));
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
    let status = super::status::read_status(
        &crate::host::tauri_host::TauriHost::new(app.clone()),
        &crate::vault_io::StdVaultIo,
        state.inner(),
        live,
    )
    .await;
    note_reported_status(status.as_ref().ok());
    status
}

/// One line per CHANGE of the status this app hands its own UI (myne-md/myne#1033).
///
/// The defect this answers: a failure the core repairs, and a screen that keeps showing the
/// old sentence, were indistinguishable from the outside. If the reported status stops moving
/// while the cycles recover, the staleness is in the read; if it keeps reporting the stuck
/// value, the core still believes it.
fn note_reported_status(status: Option<&SyncRuntimeStatus>) {
    // A bounded token per state, and the detail token beside it. NOT `?status`: the Debug shape
    // of this enum carries a `String` and the two AS15 per-device clocks, and §7 sanctions `?`
    // only over a CLOSED enum, so a `String`-carrying payload is exactly the unbounded field the
    // rule cannot inspect (review of myne-md/myne#1033).
    let (state, detail) = match status {
        None => ("none".to_string(), ""),
        Some(status) => (status.state_token(), status.detail_token()),
    };
    if !super::change_gate::first_sighting(
        "reported_status",
        super::change_gate::fold(&state, detail),
    ) {
        return;
    }
    tracing::info!(
        stage = "sync_status",
        event = "sync_status_changed",
        state,
        detail,
        "the status this app reports to its own UI changed"
    );
}

/// Report the five facts that decide whether this device can sync, as one verdict
/// (myne-md/myne#1003).
///
/// A sibling of [`sync_status`] and READ-ONLY in the same way, but it answers the
/// question `sync_status` cannot: that one reports a device-level state, and this one
/// names which of generation / authority / binding / key at rest / session is the
/// missing half. Nothing polls it: the cycle's roster verification is an ML-DSA verify
/// and belongs on a user action, not on a five-second beat.
///
/// `None` means there is no active vault to diagnose, which every caller renders as
/// nothing at all. The error type is `()`, the house spelling for a command with no
/// failure of its own (`vault_migrate_progress` states it the same way): Tauri requires a
/// `Result` from an async command that borrows state, and the unreadable cases are FACTS
/// the report carries rather than errors a caller would act on.
#[tauri::command]
pub async fn sync_vault_doctor<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, VaultRuntimeState>,
) -> Result<Option<super::doctor::VaultDoctor>, ()> {
    Ok(super::doctor::read(
        &crate::host::tauri_host::TauriHost::new(app),
        &crate::vault_io::StdVaultIo,
        state.inner(),
    )
    .await)
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
    let Some(live_registry) = app.try_state::<crate::plugins::live::LiveSessionRegistry>() else {
        return CycleOutcome::NotReady;
    };
    super::cycle::run_active_cycle_from_host(
        &crate::host::tauri_host::TauriHost::new(app.clone()),
        &crate::vault_io::StdVaultIo,
        state.inner(),
        hooks.inner(),
        live_registry.inner(),
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
/// status: `Disabled` for the honest not-ready states, `Idle` only for a cycle
/// that could upload, `UploadsBlocked` when it ran and could not, and `Error` on
/// a genuine transport/protocol failure.
#[tauri::command]
pub async fn sync_now<R: Runtime>(app: AppHandle<R>) -> Result<SyncRuntimeStatus, SyncConfigError> {
    let Some(state) = app.try_state::<VaultRuntimeState>() else {
        return Ok(SyncRuntimeStatus::NotEnrolled);
    };
    let Some(hooks) = app.try_state::<crate::hooks::Hooks>() else {
        return Ok(SyncRuntimeStatus::NotEnrolled);
    };
    let Some(live_registry) = app.try_state::<crate::plugins::live::LiveSessionRegistry>() else {
        return Ok(SyncRuntimeStatus::NotEnrolled);
    };
    let status = super::cycle::sync_now_from_host(
        &crate::host::tauri_host::TauriHost::new(app.clone()),
        &crate::vault_io::StdVaultIo,
        state.inner(),
        hooks.inner(),
        live_registry.inner(),
    )
    .await;
    // The manual answer must also move the overlay the POLLED status reads. The background
    // loop is the only other writer, so without this a "Sync now" that could not upload shows
    // "Uploads paused" for one render and then flips back to "Synced" on the next poll, which
    // is the same lie reached through the other path (myne-md/myne#1027).
    if let Some(cell) = app.try_state::<SyncRuntimeStatusCell>() {
        match &status {
            SyncRuntimeStatus::UploadsBlocked { detail, .. } => cell.set_blocked(detail.clone()),
            SyncRuntimeStatus::Error { detail, .. } => cell.set_error(detail.clone()),
            SyncRuntimeStatus::Idle => cell.clear(),
            // Disabled / NotEnrolled / Pending are base states, not overlays: they come
            // from the config+token derivation and are wrong to pin in the cell.
            _ => {}
        }
    }
    // Every other writer of this cell emits, and a subscriber that is not the pressing surface
    // (the unsynced-edits banner, the phone's hook) renders the superseded value for a poll
    // interval without it (myne-md/myne#1027 review).
    let _ = app.emit("sync://status-changed", ());
    Ok(status)
}

/// Report where this vault stands with respect to the server (myne-md/myne#911
/// task 8): published or device only, the namespace publish recorded, and
/// whether the vault was born under an identity.
///
/// A sibling of [`sync_status`] rather than a field on it, and read-only in the
/// same way: it reads device-local state and four bytes of `vault.meta`, touches
/// no key material and no network, so it is safe to ask on mount. The reason it
/// exists separately from the vault row's `published` flag is the active vault's
/// own panel, which needs the durable answer WITHOUT re-listing every vault.
#[tauri::command]
pub async fn sync_published_state<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, crate::plugins::vault_unlock::state::VaultRuntimeState>,
) -> Result<super::publish::PublishState, SyncDeviceError> {
    let host = crate::host::tauri_host::TauriHost::new(app);
    // The ACTIVE vault, never `sole_vault_id()`: that is `None` on every desktop
    // install, and the disk fallback it triggers answers the pre-multi-vault
    // `vault/` directory as soon as two vaults exist, so the sole-vault spelling
    // reported "device only" for a vault that is published (myne-md/myne#911).
    let active = state.active_vault_id().await;
    let Ok(root) = crate::paths::active_vault_root_from_host(&host, active) else {
        // No vault on this device yet: nothing to publish, and "device only" is
        // the truthful reading rather than an error a caller would have to map.
        return Ok(super::publish::PublishState::default());
    };
    Ok(super::publish::published_state(&crate::vault_io::StdVaultIo, &root).await)
}

/// List every vault the person account is bound to, materialising the frames
/// this device does not hold yet (myne-md/myne#911 task 9).
///
/// Each returned row is one vault: its namespace, the binding's role, and the
/// local `vault_id` once a container exists here. Listing writes only frames, so
/// it needs no vault password and installs no key; opening one still asks for
/// THAT vault's password.
#[tauri::command]
pub async fn sync_person_list_vaults<R: Runtime>(
    app: AppHandle<R>,
) -> Result<Vec<super::person_discovery::PersonVaultRow>, SyncDeviceError> {
    super::person_discovery::list_person_vaults(
        &crate::host::tauri_host::TauriHost::new(app),
        &crate::vault_io::StdVaultIo,
    )
    .await
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
///
/// It also asks every open live session to re-announce itself (`SYNC-29`,
/// myne-md/myne#849): each one sends a `FrameType::Join` on the awareness
/// supervisor's next drain, and peers answer a join by re-announcing their own
/// presence. The mobile WebView drops its presence store when the app is hidden
/// (threat-model AS24), while the supervisor tears the awareness stream down
/// only on its next tick after suspension, so a hide shorter than one tick
/// leaves the stream up and the reconnect path that re-joins never runs; without this an
/// idle peer stays missing from the participant list until they move their
/// caret. Desktop never invokes this command, so the rejoin is mobile-effective
/// only. Best-effort like the rest: an unmanaged registry is a no-op.
#[tauri::command]
pub async fn sync_lifecycle_resume<R: Runtime>(app: AppHandle<R>) {
    let signal = app.try_state::<super::loop_control::SyncLifecycleSignal>();
    let live = app.try_state::<crate::plugins::live::LiveSessionRegistry>();
    sync_lifecycle_resume_from_host(signal.as_deref(), live.as_deref());
}

/// The body of [`sync_lifecycle_resume`], taking the two managed states it
/// touches so a test can drive it without an `AppHandle`. Either may be absent
/// (a host that manages neither), and each absent one is skipped.
pub fn sync_lifecycle_resume_from_host(
    signal: Option<&super::loop_control::SyncLifecycleSignal>,
    live: Option<&crate::plugins::live::LiveSessionRegistry>,
) {
    if let Some(sig) = signal {
        sig.resume();
    }
    if let Some(reg) = live {
        reg.mark_all_join_pending();
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

use super::device_admission;
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
    let normalized = zeroize::Zeroizing::new(protocol::normalize_user_phrase(&phrase));
    let generation = state.inner().person_session_generation().await;
    let host = crate::host::tauri_host::TauriHost::new(app.clone());
    let (pair, mut transition) = crate::account::person_identity::unlock_person_identity(
        &host,
        &crate::vault_io::StdVaultIo,
        normalized.as_str(),
    )
    .await
    .map_err(|e| {
        use crate::account::person_identity::PersonIdentityError as E;
        match e {
            E::BadPhrase | E::CannotDecrypt => SyncDeviceError::BadRequest,
            E::Io | E::Csprng => SyncDeviceError::Transport,
        }
    })?;
    if transition.is_none() {
        transition = crate::account::person_identity::read_pending_person_key_transition(
            &host,
            &crate::vault_io::StdVaultIo,
        )
        .await
        .map_err(|_| SyncDeviceError::Transport)?;
    }
    let person_id = protocol::person_id_hash(normalized.as_str());
    let public = pair.public_half();
    let view = PersonIdentityView {
        fingerprint_hex: crate::account::person_identity::hex_lower(pair.fingerprint()),
        person_id_hex: crate::account::person_identity::hex_lower(&person_id),
        identity_code: super::invite::encode_person_identity_code(&person_id, &public),
    };
    let profile = derive_person_profile_key(&host, state.inner(), normalized.as_str()).await;
    // Vault-bound carrier (myne-md/myne#792): seal the keypair under the active
    // owner vault's root_key so its next unlock installs this session with no
    // phrase. Best-effort; only fires for an unlocked NTV6 owner vault.
    super::person_vault_carrier::refresh_carrier_best_effort(
        &host,
        &crate::vault_io::StdVaultIo,
        state.inner(),
        &person_id,
        &pair,
    )
    .await;
    let install = crate::plugins::vault_unlock::state::PersonSessionInstall {
        pair,
        person_id,
        profile,
        transition,
    };
    let installed_generation = generation.wrapping_add(1);
    if !state
        .inner()
        .install_person_session_if_generation(generation, install)
        .await
    {
        return Err(SyncDeviceError::Transport);
    }
    // Record the code this device just derived, so the roster panel and the sync cycle
    // can verify an owner-signed roster on a later cold start without the phrase. The
    // device key took over SIGNING at `0731` stage 1; this is what stops the same change
    // from still demanding the phrase to READ.
    {
        let base = host.app_data_dir().ok();
        if let Some(base) = base {
            let root = crate::paths::active_vault_root_from_base(
                &base,
                state.inner().active_vault_id().await,
            );
            let _ = super::state::remember_own_identity_code(
                &crate::vault_io::StdVaultIo,
                &root,
                &view.identity_code,
            )
            .await;
            // Adopt the person plane's device id into this vault's sync state
            // BEFORE the claim: the claim's own id reader is that field, and on a
            // person-born vault nothing had ever written it.
            super::person_account::adopt_person_device_identity_best_effort(
                &host,
                &crate::vault_io::StdVaultIo,
                &root,
            )
            .await;
            // Claim this device in the ACTIVE vault, now that the person key is in hand.
            //
            // The unlock pipeline claims too, but it needs the person session to be held
            // at the moment the VAULT unlocks, and on a person-born (`NTV7`) vault the
            // carrier that would install one is deliberately excluded. So the ordinary
            // order, unlock the vault and then unlock the identity, left the device
            // UNCLAIMED, and an unclaimed device cannot author a `0x03` head, so every
            // later sync still needed the phrase. That is the loop this closes: unlock the
            // identity once and the claim happens, and from then on the device signs for
            // itself.
            crate::plugins::device_binding::commands::claim_own_binding_best_effort(
                &host,
                &crate::vault_io::StdVaultIo,
                state.inner(),
                &root,
            )
            .await;
        }
    }
    if super::person_account::refresh_person_auth_public_material(
        &host,
        &crate::vault_io::StdVaultIo,
        person_id,
        &public,
    )
    .await
    .is_err()
    {
        let _ = state
            .inner()
            .clear_person_session_if_generation(installed_generation)
            .await;
        return Err(SyncDeviceError::Transport);
    }
    Ok(view)
}

/// Derive the deterministic `(profile_id, profile_key)` for the ACTIVE vault
/// from the person's normalized phrase. `None` when no vault is unlocked or its
/// `vault.meta` cannot be read; the caller treats that as "no profile yet".
async fn derive_person_profile_key(
    host: &dyn crate::host::HostCtx,
    state: &VaultRuntimeState,
    phrase_normalized: &str,
) -> Option<([u8; 16], zeroize::Zeroizing<[u8; protocol::AEAD_KEY_LEN]>)> {
    use crate::vault_io::VaultIo as _;
    let base = host.app_data_dir().ok()?;
    let root = crate::paths::active_vault_root_from_base(&base, state.active_vault_id().await);
    let bytes = crate::vault_io::StdVaultIo
        .read(&root.join("vault.meta"))
        .await
        .ok()?;
    let meta = protocol::parse_vault_meta_any(&bytes).ok()?;
    let person_id = protocol::person_id_hash(phrase_normalized);
    let profile_id = protocol::person_profile_id(&person_id, &meta.account_number_hash);
    let key =
        protocol::derive_person_vault_profile_key(phrase_normalized, &profile_id, &meta.kdf_params)
            .ok()?;
    Some((profile_id, key))
}

/// **Drop the backend-held person identity** (lock-equivalent). The pair
/// zeroizes as it drops.
///
/// `forget: true` additionally ERASES the device-local sealed file **and the
/// device-scoped person token** (`person-auth.json`), which is person
/// off-boarding from this device rather than a session lock: the next unlock
/// with the same phrase re-enrols a fresh keypair and a new fingerprint, and
/// there is no stale token left claiming an enrollment that no longer exists
/// (myne-md/myne#780).
/// The flag exists so the erase path has a production caller instead of being a
/// dead function, and so a plain lock never destroys an enrollment the user did
/// not mean to drop.
#[tauri::command]
pub async fn sync_person_lock<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, VaultRuntimeState>,
    forget: Option<bool>,
) -> Result<(), SyncDeviceError> {
    let _ = state.inner().clear_person_session().await;
    if forget.unwrap_or(false) {
        let host = crate::host::tauri_host::TauriHost::new(app.clone());
        // Erase every vault-bound carrier first: leaving one behind would
        // silently re-install the identity at the next owner-vault unlock. A
        // failed erase fails the forget rather than reporting success.
        super::person_vault_carrier::delete_all_person_vault_carriers(
            &host,
            &crate::vault_io::StdVaultIo,
        )
        .await
        .map_err(|_| SyncDeviceError::Internal)?;
        super::person_account::forget_person_from_host(&host, &crate::vault_io::StdVaultIo).await?;
    } else {
        // An explicit lock must not be silently reversed by the next owner-vault
        // unlock (myne-md/myne#792 review): record it so the carrier install
        // stands down until a real (phrase) unlock.
        state.inner().set_person_explicit_lock().await;
    }
    Ok(())
}

/// The person identity's public view (fingerprint only, no key material).
#[derive(Debug, serde::Serialize)]
pub struct PersonIdentityView {
    /// Canonical fingerprint (the SAS value), lowercase hex.
    pub fingerprint_hex: String,
    /// The addressable person id (lowercase hex).
    pub person_id_hex: String,
    /// The out-of-band identity code a member pastes to verify this owner's
    /// group package (task 12). Public material only.
    pub identity_code: String,
}

/// Refuse an admin-only command invoked under a member authority (B2B,
/// myne-md/myne#714). The roster UI hides owner-only affordances from
/// members, so this is the backend contract for the future member client
/// rather than a button a member sees. It mirrors the cryptographic
/// enforcement (only a `root_key` holder can seal a roster peers accept)
/// with a clear refusal instead of a generic `BadRequest` or `NotEnrolled`.
fn require_owner(
    authority: crate::plugins::vault_unlock::state::VaultAuthority,
) -> Result<(), SyncDeviceError> {
    match authority {
        crate::plugins::vault_unlock::state::VaultAuthority::Owner => Ok(()),
        crate::plugins::vault_unlock::state::VaultAuthority::Member => {
            Err(SyncDeviceError::NotOwner)
        }
    }
}

/// The outcome of an explicit owner-approved B2B migration, as the frontend
/// sees it. Carries no key material: the `group_key` stays backend-side.
#[derive(Debug, Clone, serde::Serialize)]
pub struct B2bMigrationView {
    /// The group-key epoch the committed `NTV6` metadata carries.
    pub group_key_epoch: u64,
    /// How many shared singletons were resealed under the group tier.
    pub singletons_migrated: usize,
}

/// **Start the explicit owner-approved NTV5 to NTV6 migration** (B2B,
/// myne-md/myne#712 task 5).
///
/// This is the one production caller of
/// [`crate::plugins::vault_migrate::b2b::migrate_owner_vault_to_ntv6`], and the
/// only place an ordinary owner vault changes on-disk format. An ordinary unlock
/// never migrates; this runs only when the user has explicitly begun the first
/// B2B sharing action AND the owner person identity is unlocked
/// (`sync_person_unlock`), so `root_key`, the vault, and the person all have to
/// be present at once.
///
/// Owner-only: a member session has no `root_key` to wrap the group key under.
/// The caller holds the auth permit across the whole journaled migration, so a
/// concurrent `change_password` cannot interleave the `vault.meta` rewrite.
///
/// Idempotent: a vault already carrying `NTV6` reports its existing epoch
/// without rewriting anything.
#[tauri::command]
pub async fn sync_start_b2b_migration<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, VaultRuntimeState>,
    owner_display_name: String,
) -> Result<B2bMigrationView, SyncDeviceError> {
    start_b2b_migration_from_host(
        &crate::host::tauri_host::TauriHost::new(app.clone()),
        state.inner(),
        &crate::vault_io::StdVaultIo,
        &owner_display_name,
    )
    .await
}

/// Host-taking core for [`sync_start_b2b_migration`], so tests drive the whole
/// journaled migration under a temp vault with no Tauri runtime.
pub async fn start_b2b_migration_from_host(
    host: &dyn HostCtx,
    state: &VaultRuntimeState,
    io: &dyn crate::vault_io::VaultIo,
    owner_display_name: &str,
) -> Result<B2bMigrationView, SyncDeviceError> {
    use crate::plugins::vault_migrate::b2b::{self, B2bMigrationError};

    // Peek the slot, then DROP the guard before any await (the tokio RwLock
    // deadlock shape documented on `sync_invite_member`).
    let (root_key, items_key, authority) = {
        let slot = state.slot_read_active().await;
        match &*slot {
            crate::plugins::vault_unlock::state::Slot::Unlocked(uv) => {
                let authority = uv.authority();
                let root_key = uv
                    .owner_root_key()
                    .map(|k| zeroize::Zeroizing::new(**k))
                    .ok_or(SyncDeviceError::NotOwner)?;
                (root_key, zeroize::Zeroizing::new(*uv.items_key), authority)
            }
            _ => return Err(SyncDeviceError::NotEnrolled),
        }
    };
    require_owner(authority)?;
    let owner = state
        .clone_person_identity()
        .await
        .ok_or(SyncDeviceError::NotEnrolled)?;
    // The owner's own `person_id_hash`, recorded on the owner's roster row so the
    // member list can resolve the owner's chosen name on every device.
    let owner_person_id = state
        .clone_person_id()
        .await
        .ok_or(SyncDeviceError::NotEnrolled)?;

    // The whole-blob `vault.meta` rewrite is a lifecycle mutation: hold the
    // permit across the migration so a concurrent `change_password` cannot land
    // between the read and the commit (both blobs would stay AEAD-valid and the
    // revert would be silent).
    let _permit = state
        .auth_permits()
        .try_acquire()
        .map_err(|_| SyncDeviceError::Transport)?;

    let vault_id = state.active_vault_id().await;
    let root = crate::paths::active_vault_root_from_base(
        &host
            .app_data_dir()
            .map_err(|_| SyncDeviceError::Transport)?,
        vault_id,
    );
    let meta_path = root.join("vault.meta");
    let meta_bytes = io
        .read(&meta_path)
        .await
        .map_err(|_| SyncDeviceError::Transport)?;
    let old_hash = crate::vault_meta_hash::vault_meta_sha256(&meta_bytes);

    match b2b::migrate_owner_vault_to_ntv6(
        io,
        &root,
        &root_key,
        &items_key,
        &owner,
        &owner_person_id,
        owner_display_name,
    )
    .await
    {
        Ok(out) => {
            if let Some(id) = vault_id {
                state
                    .refresh_meta_hash_if(id, old_hash, out.new_meta_hash)
                    .await;
                // The on-disk singletons are now group-sealed, so the running
                // session must read them through the group tier too. Without
                // this the next prefs/search/workspace read would derive the
                // old root-tier KEK and fail to open a blob this same call just
                // resealed.
                state.set_group_key(id, out.group_key).await;
            }
            // The head format changes with the generation (0x01 HMAC to 0x02
            // signed), so the next cycle must re-base rather than reject the
            // server's still-HMAC head as a forgery (decisions/protocol/0603,
            // Q2 revised: the head format is keyed off the vault generation).
            // Only when the flag is not already set, and only through the one writer:
            // a cycle may be running on another task while this migration completes,
            // and its cursor must survive the flag being raised (#964).
            let _ = super::state::update_sync_state(io, &root, |sync_state| {
                if sync_state.rekey_rebase_pending {
                    return (false, super::state::Persist::No);
                }
                sync_state.rekey_rebase_pending = true;
                (true, super::state::Persist::Yes)
            })
            .await;
            // The vault is `NTV6` now: seal the person-identity carrier under the
            // held root_key so a later unlock installs the session with no phrase
            // (myne-md/myne#792). Best-effort.
            if let Some(person_id) = state.clone_person_id().await {
                super::person_vault_carrier::refresh_carrier_best_effort(
                    host, io, state, &person_id, &owner,
                )
                .await;
            }
            Ok(B2bMigrationView {
                group_key_epoch: 1,
                singletons_migrated: out.singletons_migrated,
            })
        }
        Err(B2bMigrationError::AlreadyMigrated) => {
            // Already NTV6: report the committed epoch and rewrite nothing.
            let epoch = protocol::parse_vault_meta_ntv6(&meta_bytes)
                .map(|meta| meta.group_key_epoch)
                .map_err(|_| SyncDeviceError::BadRequest)?;
            Ok(B2bMigrationView {
                group_key_epoch: epoch,
                singletons_migrated: 0,
            })
        }
        // A v0.1 (`MYV1`) vault has to reach v0.2 before it can carry B2B
        // metadata; every other failure is IO, CSPRNG, or a malformed base.
        Err(_) => Err(SyncDeviceError::BadRequest),
    }
}

/// Host-taking core for [`sync_person_create_invite`]: seal an invite to
/// `member_public`, write the invited member's roster row, and return the
/// relayable frame. Split from the IPC wrapper so the identity-code path owns
/// one implementation of the roster write and the crypto (myne-md/myne#711
/// task 11). This replaced the pre-wire `sync_invite_member` command, which
/// returned the frame and relied on no caller to relay it.
pub async fn invite_member_from_host(
    host: &dyn crate::host::HostCtx,
    state: &VaultRuntimeState,
    io: &dyn crate::vault_io::VaultIo,
    member_public: &protocol::person_key::PersonPublicHalf,
    member_person_id_hex: Option<&str>,
    vault_label: &str,
    created_at_secs: u64,
) -> Result<InviteCommandView, SyncDeviceError> {
    // Peek the slot, then DROP the guard before any await: holding a
    // `slots.read()` across `active_vault_id()`'s own `slots.read()` is the
    // tokio RwLock deadlock shape (a queued writer blocks the second acquire
    // while the first stays held).
    let (root_key, items_key, authority, group_key) = {
        let slot = state.slot_read_active().await;
        match &*slot {
            crate::plugins::vault_unlock::state::Slot::Unlocked(uv) => {
                let authority = uv.authority();
                let root_key = uv
                    .owner_root_key()
                    .map(|k| zeroize::Zeroizing::new(**k))
                    .ok_or(SyncDeviceError::NotOwner)?;
                (
                    root_key,
                    zeroize::Zeroizing::new(*uv.items_key),
                    authority,
                    uv.group_key.clone(),
                )
            }
            _ => return Err(SyncDeviceError::NotEnrolled),
        }
    };
    // Owner-only: a member gets the typed `NotOwner` refusal rather than a
    // generic failure further down. The cryptographic enforcement (only a
    // `root_key` holder can seal a roster peers accept) still holds behind it.
    require_owner(authority)?;
    let owner = state
        .clone_person_identity()
        .await
        .ok_or(SyncDeviceError::NotEnrolled)?;

    // Refuse a self-invite (the helper names the consequence: the member
    // upsert would overwrite the owner row and silently demote the owner).
    if super::invite::is_self_invite(&owner, member_public) {
        return Err(SyncDeviceError::BadRequest);
    }

    // Serialize the whole-blob `vault.meta` read-modify-write against every
    // other lifecycle mutation BEFORE reading: the permit must be held across
    // the read below and the write in `write_roster_row`, or a concurrent
    // `change_password` landing between them is silently reverted by the
    // invite write (both blobs stay AEAD-valid, so nothing detects it).
    // `member_removal` takes the permit first for the same reason.
    let _permit = state
        .auth_permits()
        .try_acquire()
        .map_err(|_| SyncDeviceError::Transport)?;

    // Read `vault.meta` ONCE: its account hash binds the wrap and its roster is
    // the store the invited member's row is written into.
    let root = crate::paths::active_vault_root_from_base(
        &host
            .app_data_dir()
            .map_err(|_| SyncDeviceError::Transport)?,
        state.active_vault_id().await,
    );
    let meta_path = root.join("vault.meta");
    let meta_bytes = io
        .read(&meta_path)
        .await
        .map_err(|_| SyncDeviceError::Transport)?;
    if meta_bytes.get(..4) == Some(protocol::VAULT_META_V0_2_MAGIC.as_slice()) {
        return Err(SyncDeviceError::MigrationRequired);
    }
    // **One dispatch for every tail generation, carried rather than re-inferred**
    // (myne-md/myne#938 review). The arms below used to be a `NTV6` magic test and an
    // `NTV7`-only generation test, so an `NTV8` vault — every vault created since the
    // upgrade — fell through to the legacy `write_roster_row`, which is `NTV5`-shaped:
    // no group-key wrap, no epoch, no signed roster. There the invite is merely
    // refused (`BadRequest`, because a person-born base carries no `membership`), but
    // the fall-through is only one `None` away from writing an `NTV5` frame over a
    // group-sealed `itemsKey`, which no unlock path could open again.
    //
    // A tail generation invites through the SAME writer, because the tail is `NTV6`'s
    // byte for byte: the roster, the group-key package and the epoch are the same
    // objects. What differs is the frame it is sealed back into, so the writer takes
    // the frame it arrived in (and the person wrap, when that frame has one) and
    // re-emits it verbatim around the new tail.
    //
    // Sharing a person-born vault used to be out of scope (`decisions/ui/0729`) and
    // answered a flat `BadRequest`; it is in scope now, because a generation that is
    // born with the group tier and can never be shared is a vault type the product no
    // longer has.
    if let Some(frame) = super::meta_kind::TailFrame::of(&meta_bytes) {
        let person_wrap = match frame {
            super::meta_kind::TailFrame::Ntv7 => Some(
                protocol::parse_vault_meta_ntv7(&meta_bytes)
                    .map_err(|_| SyncDeviceError::BadRequest)?
                    .person_wrap,
            ),
            super::meta_kind::TailFrame::Ntv6 | super::meta_kind::TailFrame::Ntv8 => None,
        };
        return write_ntv6_invite(
            host,
            state,
            io,
            &root,
            &meta_path,
            &meta_bytes,
            &owner,
            member_public,
            member_person_id_hex,
            group_key.as_deref(),
            frame,
            person_wrap,
            &_permit,
        )
        .await;
    }
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
        member_public,
        &items_key,
        &account_number_hash,
        vault_label,
        created_at_secs,
        &mut rng,
    )
    .map_err(|_| SyncDeviceError::BadRequest)?;

    // Write the invited member's roster row. This is what CREATES the roster
    // extension: without it no roster is ever written, `sync_list_roster` stays
    // empty, and `sync_remove_member` is unreachable.
    let wrapped = protocol::person_rekey::wrap_items_key_to_member(
        &items_key,
        member_public,
        &account_number_hash,
        &mut rng,
    )
    .map_err(|_| SyncDeviceError::BadRequest)?;
    let row = super::invite::invited_member_row(
        member_public,
        super::invite::wrapped_hex(&wrapped),
        vault_label,
        created_at_secs,
        super::roster::RosterRole::Member,
    );
    // The owner's own row is written at the first invite, alongside the
    // member's row. It carries the owner's public halves and an `itemsKey`
    // wrap to the owner, marked `owner`, so the roster lists who administers
    // the vault. A later invite leaves it untouched (`upsert_owner_once`).
    let owner_public = owner.public_half();
    let owner_wrapped = protocol::person_rekey::wrap_items_key_to_member(
        &items_key,
        &owner_public,
        &account_number_hash,
        &mut rng,
    )
    .map_err(|_| SyncDeviceError::BadRequest)?;
    let owner_row = super::invite::invited_member_row(
        &owner_public,
        super::invite::wrapped_hex(&owner_wrapped),
        vault_label,
        created_at_secs,
        super::roster::RosterRole::Owner,
    );
    if let Err(e) = write_roster_row(
        state,
        &_permit,
        io,
        &root,
        &meta_path,
        version,
        &mut meta,
        &root_key,
        &account_number_hash,
        owner_row,
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

/// **Create and relay an invite from a pasted person identity code** (B2B,
/// myne-md/myne#711 task 11). This is the owner-side wire: decode the invitee's
/// public halves from the out-of-band code, seal the invite locally (the same
/// core [`sync_invite_member`] uses), then bind the owner person to the vault
/// once and POST the sealed frame to the relay.
///
/// The owner learns the invitee's audience from `recipient_code` and nothing
/// else: the outer relay frame carries only the recipient person id and the
/// vault id (`server-protocol.md` §3.1a), so the server reads no fingerprint and
/// no public half.
#[tauri::command]
pub async fn sync_person_create_invite<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, VaultRuntimeState>,
    recipient_code: String,
    vault_label: String,
    created_at_secs: u64,
) -> Result<InviteCommandView, SyncDeviceError> {
    let host = crate::host::tauri_host::TauriHost::new(app.clone());
    let io = crate::vault_io::StdVaultIo;
    create_invite_from_host(
        &host,
        state.inner(),
        &io,
        &recipient_code,
        &vault_label,
        created_at_secs,
    )
    .await
}

/// Host-taking core for [`sync_person_create_invite`], so a test drives the
/// decode, the local invite build and the two relay calls against a
/// [`super::transport::FakeTransport`].
pub async fn create_invite_from_host(
    host: &dyn crate::host::HostCtx,
    state: &VaultRuntimeState,
    io: &dyn crate::vault_io::VaultIo,
    recipient_code: &str,
    vault_label: &str,
    created_at_secs: u64,
) -> Result<InviteCommandView, SyncDeviceError> {
    let code = super::invite::decode_person_identity_code(recipient_code)
        .map_err(|_| SyncDeviceError::BadRequest)?;
    let owner_person_id = state
        .clone_person_id()
        .await
        .ok_or(SyncDeviceError::NotEnrolled)?;
    let recipient_person_id_hex = crate::account::person_identity::hex_lower(&code.person_id);

    // Bind the owner person to the vault once (server-side availability), then
    // seal the invite locally, then relay it. The bind is idempotent and its
    // token is stored device-locally, so a second invite skips the round-trip.
    let owner_token = super::person_account::ensure_owner_member_token(
        host,
        io,
        state,
        &crate::account::person_identity::hex_lower(&owner_person_id),
    )
    .await?;

    let view = invite_member_from_host(
        host,
        state,
        io,
        &code.public,
        Some(&recipient_person_id_hex),
        vault_label,
        created_at_secs,
    )
    .await?;

    // Publish the (migrated) `vault.meta` BEFORE the invite can be claimed
    // (myne-md/myne#795): a member's accept fetches the server copy and requires
    // `NTV6`, but the NTV5->NTV6 migration does not push one. Best-effort — the
    // sync loop's meta phase now pushes a one-sided local `NTV6` on its next cycle
    // — so this only closes the race between the invite being posted and that
    // cycle, which is the window a member can claim in.
    let _ = push_vault_meta_now_from_host(host, state).await;

    let frame = super::person_account::hex_to_bytes(&view.invite_wire)
        .ok_or(SyncDeviceError::BadRequest)?;
    super::person_account::post_sealed_invite(
        host,
        io,
        &owner_token,
        &crate::account::person_identity::hex_lower(&code.person_id),
        &frame,
    )
    .await?;
    Ok(view)
}

/// **Invite a member to an `NTV6` or `NTV7` vault** (B2B, myne-md/myne#712).
///
/// The grant is a GROUP-key package, not an `itemsKey` wrap: the member receives the
/// current epoch's `group_key`, which is what opens the vault's shared content. This
/// opens the sealed owner-signed roster, appends the new live member row (with the
/// package's wrap), re-signs and re-seals it at the SAME epoch, and writes
/// `vault.meta`. The epoch only advances on a removal.
///
/// `frame` is the generation this frame arrived in, and `person_wrap` is carried with
/// it rather than derived from it: `NTV6` and `NTV8` both have no person wrap, so
/// `person_wrap.is_some()` cannot tell them apart and an `NTV8` vault would be
/// re-emitted as `NTV6` — two generations back, retiring the tail the spec says is
/// never written again (myne-md/myne#938 review). `NTV7` and `NTV8` keep the `NTV6`
/// tail byte for byte, so only the envelope around the new roster differs.
///
/// The member-accept path and the wire that carries the package are Grill 4; the
/// frame is returned in `invite_wire` so the caller can relay it.
#[allow(clippy::too_many_arguments)]
async fn write_ntv6_invite(
    host: &dyn HostCtx,
    state: &VaultRuntimeState,
    io: &dyn crate::vault_io::VaultIo,
    root: &std::path::Path,
    meta_path: &std::path::Path,
    meta_bytes: &[u8],
    owner: &protocol::person_key::PersonKeyPair,
    member_public: &protocol::person_key::PersonPublicHalf,
    member_person_id_hex: Option<&str>,
    group_key: Option<&[u8; 32]>,
    frame: super::meta_kind::TailFrame,
    person_wrap: Option<protocol::PersonWrap>,
    _permit: &tokio::sync::SemaphorePermit<'_>,
) -> Result<InviteCommandView, SyncDeviceError> {
    use protocol::person_invite as pi;
    let b2b = protocol::parse_b2b_tail_any(meta_bytes).map_err(|_| SyncDeviceError::BadRequest)?;
    let account_number_hash = b2b.base.account_number_hash;
    // An `NTV6` invite wraps the shared `group_key`, so an owner session that
    // does not carry the group tier cannot seal one. This is the typed refusal
    // the variant exists for: the vault is valid and migrated, and the caller
    // needs the group-key session tier rather than "bad request" (task 20's
    // carry-over, given its producer here).
    let group_key = group_key.ok_or(SyncDeviceError::GroupRosterInviteUnavailable)?;
    let epoch = b2b.group_key_epoch;
    let current = pi::open_group_roster(
        group_key,
        &account_number_hash,
        epoch,
        &b2b.signed_roster_envelope,
    )
    .ok_or(SyncDeviceError::BadRequest)?;
    // A vault whose owner signs with a device key has a roster this call must be able
    // to read back before it re-signs it (`decisions/protocol/0731` stage 2). The
    // candidates are this owner's own device half plus every verified row of the store
    // that names the owner.
    let owner_public = owner.public_half();
    let bindings_key = crate::plugins::device_binding::bindings_key_for_group(
        group_key,
        account_number_hash,
        epoch,
    );
    let owner_devices = super::roster_trust::device_halves_for_owner(
        io,
        root,
        Some(&bindings_key.borrow()),
        None,
        &owner_public,
    )
    .await;
    let roster = pi::verify_group_roster(
        super::roster_trust::trust(&owner_public, &owner_devices),
        &current,
        &account_number_hash,
    )
    .map_err(|_| SyncDeviceError::BadRequest)?;
    let member_fp = crate::account::person_identity::hex_lower(member_public.fingerprint());
    if roster
        .members
        .iter()
        .any(|m| m.fingerprint_hex == member_fp && m.state == pi::GroupMemberState::Live)
    {
        // Already a live member: re-inviting would duplicate the row.
        return Err(SyncDeviceError::BadRequest);
    }

    let mut rng = rand_core::UnwrapErr(crate::rng::OsRng);
    // The owner's DEVICE attestation, if it has one (`0731` stage 2): the package carries
    // it so the recipient can resolve a roster this device is about to sign. Absent on a
    // platform with no device-key rung, which keeps the person-key path exactly as it
    // was.
    let own_device_attestation = super::roster_trust::own_device_signing_pair(
        host,
        io,
        root,
        group_key,
        account_number_hash,
        epoch,
        &owner.public_half(),
    )
    .await
    .map(|(_, attestation)| attestation);
    let package = pi::create_group_package_with_attestation(
        owner,
        member_public,
        group_key,
        &account_number_hash,
        epoch,
        own_device_attestation.as_ref(),
        &mut rng,
    )
    .map_err(|_| SyncDeviceError::BadRequest)?;
    let package_payload = pi::verify_group_package(&owner.public_half(), &package)
        .map_err(|_| SyncDeviceError::BadRequest)?;

    let mut members = roster.members;
    members.push(pi::GroupRosterMember {
        fingerprint_hex: member_fp.clone(),
        person_id_hex: member_person_id_hex.map(str::to_string),
        // The member's chosen name is not known at invite time; the UI shows the
        // fingerprint, so an empty name is honest rather than a placeholder.
        display_name: String::new(),
        role: pi::GroupRosterRole::Member,
        state: pi::GroupMemberState::Live,
        wrapped_group_key_hex: Some(package_payload.wrapped_group_key_hex),
        member_kem_ek_hex: crate::account::person_identity::hex_lower(member_public.kem_ek()),
        member_ed_pk_hex: crate::account::person_identity::hex_lower(member_public.ed_pk()),
        member_mldsa_vk_hex: crate::account::person_identity::hex_lower(member_public.mldsa_vk()),
        previous_fingerprint_hex: None,
        continuity: pi::GroupKeyContinuity::Current,
        transition_hex: None,
    });
    let owner_fingerprint_hex = roster.owner_fingerprint_hex;
    let mut new_roster = pi::GroupRosterPayload {
        account_number_hash_hex: crate::account::person_identity::hex_lower(&account_number_hash),
        group_key_epoch: epoch,
        owner_fingerprint_hex: owner_fingerprint_hex.clone(),
        members,
    };
    // Heal an old vault's owner row on this write: a vault migrated
    // before the owner row carried a person id has no way to resolve the owner's
    // chosen name, and an invite is the next owner-signed roster write.
    if let Some(person_id) = state.clone_person_id().await {
        super::roster::backfill_owner_person_id(
            &mut new_roster,
            &owner_fingerprint_hex,
            &person_id,
        );
    }
    // Signed by the DEVICE key when this owner holds one and the package above carries
    // its attestation, so inviting stops needing the recovery phrase. Otherwise the
    // person key signs, which is the pre-stage-2 behaviour and still the only option on a
    // platform with no device-key rung.
    let signed = match (
        own_device_attestation.is_some(),
        super::device_identity::load(),
    ) {
        (true, Ok(Some(device_key))) => {
            pi::sign_group_roster_with_device(&device_key, &new_roster, &mut rng)
        }
        _ => pi::sign_group_roster(owner, &new_roster, &mut rng),
    }
    .map_err(|_| SyncDeviceError::BadRequest)?;
    let mut roster_nonce = [0u8; protocol::AEAD_NONCE_LEN];
    getrandom::getrandom(&mut roster_nonce).map_err(|_| SyncDeviceError::Transport)?;
    let sealed = pi::seal_group_roster(
        group_key,
        &account_number_hash,
        epoch,
        &roster_nonce,
        &signed,
    )
    .ok_or(SyncDeviceError::BadRequest)?;
    let new_meta = super::meta_kind::serialize_tail_frame(
        frame,
        protocol::B2bVaultMeta {
            base: b2b.base,
            group_key_nonce: b2b.group_key_nonce,
            enc_group_key: b2b.enc_group_key,
            group_key_epoch: epoch,
            signed_roster_envelope: sealed,
        },
        person_wrap,
    )
    .map_err(|_| SyncDeviceError::BadRequest)?;

    let old_hash = crate::vault_meta_hash::vault_meta_sha256(meta_bytes);
    io.write(meta_path, &new_meta, crate::vault_io::WriteOpts::default())
        .await
        .map_err(|_| SyncDeviceError::Transport)?;
    if let Some(id) = state.active_vault_id().await {
        state
            .refresh_meta_hash_if(
                id,
                old_hash,
                crate::vault_meta_hash::vault_meta_sha256(&new_meta),
            )
            .await;
    }
    let _ = crate::plugins::sync::state::mark_vault_meta_dirty(io, root).await;

    let invite_wire = pi::encode_signed_group_package(&package)
        .map(|frame| crate::account::person_identity::hex_lower(&frame))
        .ok_or(SyncDeviceError::BadRequest)?;
    Ok(InviteCommandView {
        owner_fingerprint_hex: crate::account::person_identity::hex_lower(owner.fingerprint()),
        member_fingerprint_hex: member_fp,
        owner_ed25519_pk_hex: crate::account::person_identity::hex_lower(
            owner.public_half().ed_pk(),
        ),
        owner_mldsa_vk_hex: crate::account::person_identity::hex_lower(
            owner.public_half().mldsa_vk(),
        ),
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
    owner_row: super::roster::RosterMemberEntry,
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
    // The owner's own row is written at the first invite and never advanced
    // afterwards. `upsert_owner_once` inserts it only when the fingerprint is
    // absent, so a later invite leaves the owner's version and wrap untouched.
    // A self-invite cannot reach this point: `sync_invite_member` refuses a
    // member fingerprint equal to the owner's, so the member upsert below
    // never shares the owner's key.
    let with_owner = super::roster::upsert_owner_once(&current, owner_row);
    // Refuse to re-invite a tombstoned member rather than writing the unchanged
    // roster and handing back a live invite frame: `upsert_member` leaves a
    // tombstone alone (remove-wins), so the member would accept an invite that
    // the roster never records and no later rotation re-wraps.
    if with_owner
        .get(&row.fingerprint_hex)
        .is_some_and(|existing| existing.deleted)
    {
        return Err(SyncDeviceError::BadRequest);
    }
    let updated = super::roster::upsert_member(&with_owner, row);
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
    // The dirty marker opens the meta phase's push window for this device's
    // roster write. Best-effort with one immediate retry: a transient IO
    // failure is the common case and the marker write is idempotent, so a
    // second attempt is cheap and needs no signature change. A persistent
    // failure still converges rather than stranding the invite: the meta
    // phase pushes on baseline divergence too (`meta_baseline_hex` still
    // holds the pre-invite hash while `vault.meta` already carries the new
    // roster), so the marker only accelerates the baseline-lost corner
    // instead of gating the push.
    if let Err(first) = crate::plugins::sync::state::mark_vault_meta_dirty(io, root).await {
        // One immediate retry before giving up (see the guarantee above).
        if let Err(e) = crate::plugins::sync::state::mark_vault_meta_dirty(io, root).await {
            tracing::warn!(stage = "invite", first_error = ?first, error = ?e, "meta-dirty marker write failed twice");
        }
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
) -> Result<RosterListView, SyncDeviceError> {
    let host = crate::host::tauri_host::TauriHost::new(app.clone());
    let io = crate::vault_io::StdVaultIo;
    let slot = state.inner().slot_read_active().await;
    // `root_key` is `None` on a member session (it holds no owner tier); the
    // legacy `MYV1`/`NTV5` arm below is owner-only, while the `NTV6` arm reads
    // the roster off the group tier so a member can list it too.
    let (root_key, authority, group_key) = match &*slot {
        crate::plugins::vault_unlock::state::Slot::Unlocked(uv) => {
            (uv.root_key.clone(), uv.authority(), uv.group_key.clone())
        }
        _ => return Err(SyncDeviceError::NotEnrolled),
    };
    drop(slot);

    // Which row is the caller? The UI marks it "You", and it must be decided by
    // IDENTITY (the local person's fingerprint), not by the roster role: every
    // device sees the owner's row as `role: owner`, so keying "You" on the role
    // made an invited member read the owner's row as themselves
    // (myne-md/myne#859). `None` when no person identity is installed, in which
    // case no row is marked; roles and fingerprints still render.
    //
    // The person ID is the second thing the roster needs from the local identity:
    // a vault migrated before the owner row carried one still resolves the
    // CALLER'S OWN name, whose store row is keyed by person id while the roster
    // row has none.
    let local_identity = state.inner().clone_person_identity().await;
    let local_fingerprint_hex = local_identity
        .as_ref()
        .map(|identity| crate::account::person_identity::hex_lower(identity.fingerprint()));
    let local_person_id_hex = state
        .inner()
        .clone_person_id()
        .await
        .map(|id| crate::account::person_identity::hex_lower(&id));

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
    // The `NTV6` generation carries the owner-signed roster, not the legacy
    // membership envelope. Verify it under the owner's public half and surface
    // the group-key epoch + per-row continuity so the UI can show the
    // key-generation state. An OWNER session holds that identity directly; a
    // MEMBER session holds only the owner's public half, pinned out-of-band at
    // accept (`owner_identity_code`), exactly as `signed_head_ctx` resolves it.
    // Both B2B generations carry the owner-signed roster. Reading only `NTV6`
    // here made a person-born vault's roster render empty, which hid its own
    // owner row from the panel (myne-md/myne#911 review).
    if protocol::has_b2b_tail(&bytes) {
        let b2b = protocol::parse_b2b_tail_any(&bytes).map_err(|_| SyncDeviceError::BadRequest)?;
        // The roster is sealed under the group tier; open it first, then verify
        // the owner signature.
        let group_key = group_key.ok_or(SyncDeviceError::NotOwner)?;
        let envelope = protocol::person_invite::open_group_roster(
            &group_key,
            &b2b.base.account_number_hash,
            b2b.group_key_epoch,
            &b2b.signed_roster_envelope,
        )
        .ok_or(SyncDeviceError::BadRequest)?;
        let is_owner = authority == crate::plugins::vault_unlock::state::VaultAuthority::Owner;
        // One state read serves both the pinned owner code and the pinned owner-DEVICE
        // attestation, which arrive together at accept.
        let sync_state = super::state::read_sync_state(&io, &root)
            .await
            .map_err(|_| SyncDeviceError::Transport)?;
        let owner_public = if is_owner {
            // An owner session holds the identity directly, so it is the first source. A
            // COLD start holds nothing, and refusing here is why the panel used to show
            // "Unlock member identity" after the device key had already taken over
            // signing: the roster carries the owner's FINGERPRINT, not their public half,
            // so verifying it needs the half from somewhere. This device derived its own
            // half the last time the phrase was entered and cached it, which is public
            // material only.
            let held = state.inner().clone_person_identity().await;
            match held {
                Some(identity) => identity.public_half(),
                None => {
                    let code = sync_state
                        .own_identity_code
                        .as_deref()
                        .ok_or(SyncDeviceError::NotOwner)?;
                    super::invite::decode_person_identity_code(code)
                        .map_err(|_| SyncDeviceError::BadRequest)?
                        .public
                }
            }
        } else {
            // A member holds the owner's public half only as the pinned out-of-band
            // code recorded at invite accept.
            let code = sync_state
                .owner_identity_code
                .ok_or(SyncDeviceError::BadRequest)?;
            super::invite::decode_person_identity_code(&code)
                .map_err(|_| SyncDeviceError::BadRequest)?
                .public
        };
        let bindings_key = crate::plugins::device_binding::bindings_key_for_group(
            &group_key,
            b2b.base.account_number_hash,
            b2b.group_key_epoch,
        );
        let owner_devices = super::roster_trust::device_halves_for_owner(
            &io,
            &root,
            Some(&bindings_key.borrow()),
            sync_state.owner_device.as_ref(),
            &owner_public,
        )
        .await;
        let roster = protocol::person_invite::verify_group_roster(
            super::roster_trust::trust(&owner_public, &owner_devices),
            &envelope,
            &b2b.base.account_number_hash,
        )
        .map_err(|_| SyncDeviceError::BadRequest)?;

        // Signed display names (myne-md/myne#851 task 4), from the same group tier
        // the roster itself came from. The epoch and the account hash are the ones
        // ALREADY parsed above rather than a second read of `vault.meta`, because a
        // second read could observe different bytes than the roster did.
        let names_key = crate::plugins::member_names::names_key_for_group(
            &group_key,
            b2b.base.account_number_hash,
            b2b.group_key_epoch,
        );
        let stored_names =
            crate::plugins::member_names::read_member_names_in_dir(&io, &root, &names_key.borrow())
                .await;
        // A store that cannot be read answers "no names", never an error: this is a
        // read for display and nothing is written back, so it cannot persist that
        // emptiness over real rows (the hazard the store's own read guards against),
        // and a damaged name store must not make the whole member list unlistable.
        // Every row then reports `absent`, which is honest about what this device
        // could prove.
        let (verified_names, unverified_names) = match stored_names {
            Ok(map) => {
                // Each row's OWN public half, keyed by its person id. The owner's is
                // passed separately so an owner-signed tombstone verifies too.
                let publics: std::collections::HashMap<
                    String,
                    protocol::person_key::PersonPublicHalf,
                > = roster
                    .members
                    .iter()
                    .filter_map(|m| {
                        let id = m.person_id_hex.as_deref()?;
                        let public = protocol::person_key::PersonPublicHalf::from_parts_hex(
                            &m.member_kem_ek_hex,
                            &m.member_ed_pk_hex,
                            &m.member_mldsa_vk_hex,
                        )
                        .ok()?;
                        Some((id.to_ascii_lowercase(), public))
                    })
                    .collect();
                let mut publics = publics;
                // The caller's OWN public half, keyed by their person id. A vault
                // migrated before the owner row carried a person id has no entry
                // for the owner here, so the owner's name record — keyed by the
                // session person id — would verify against nothing and read as
                // "absent" on the very device that wrote it.
                if let (Some(id), Some(identity)) =
                    (local_person_id_hex.as_deref(), local_identity.as_ref())
                {
                    publics
                        .entry(id.to_string())
                        .or_insert_with(|| identity.public_half());
                }
                protocol::partition_verified(
                    &map,
                    |id| publics.get(&id.to_ascii_lowercase()).cloned(),
                    Some(&owner_public),
                )
            }
            Err(err) => {
                tracing::warn!(
                    stage = "roster",
                    event = "member_names_unreadable",
                    error = ?err,
                    "the member-names store could not be read; listing members without names"
                );
                (protocol::MemberNamesMap::new(), Vec::new())
            }
        };

        let epoch = roster.group_key_epoch;
        let mut views: Vec<RosterMemberView> = roster
            .members
            .into_iter()
            .filter(|m| m.state == protocol::person_invite::GroupMemberState::Live)
            .map(|m| {
                // A Live row whose person id the signed roster does not carry (a
                // vault migrated before it did) still resolves on the device that
                // owns the identity: the caller's OWN row can be matched by
                // fingerprint, and the local person id is the one its name record
                // is keyed by. Any OTHER row stays `absent`, which is honest —
                // this device cannot prove a stranger's person id.
                let effective_id = effective_person_id_hex(
                    m.person_id_hex.as_deref(),
                    &m.fingerprint_hex,
                    local_fingerprint_hex.as_deref(),
                    local_person_id_hex.as_deref(),
                );
                let (display_name, name_state) = resolve_member_name(
                    effective_id.as_deref(),
                    &verified_names,
                    &unverified_names,
                );
                RosterMemberView::from_group_member(
                    m,
                    local_fingerprint_hex.as_deref(),
                    display_name,
                    name_state,
                )
            })
            .collect();
        sort_owner_first(&mut views);
        return Ok(RosterListView {
            members: views,
            authority,
            group_key_epoch: Some(epoch),
        });
    }

    // The legacy `MYV1`/`NTV5` roster is sealed under the owner root tier, so a
    // member session (which has none) has nothing to list here.
    let root_key = root_key.ok_or(SyncDeviceError::NotOwner)?;
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

    let mut views: Vec<RosterMemberView> = roster
        .into_values()
        .filter(|m| !m.deleted)
        .map(|m| RosterMemberView::from_entry(m, local_fingerprint_hex.as_deref()))
        .collect();
    // The legacy roster is a map, so its iteration order is arbitrary. Sort it
    // deterministically AND owner-first, matching the `NTV6` arm's display order.
    views.sort_by(|a, b| {
        (
            a.role != super::roster::RosterRole::Owner,
            &a.fingerprint_hex,
        )
            .cmp(&(
                b.role != super::roster::RosterRole::Owner,
                &b.fingerprint_hex,
            ))
    });

    Ok(RosterListView {
        members: views,
        authority,
        group_key_epoch: None,
    })
}

/// Put the OWNER's row first and leave everyone else in the order the caller
/// collected them (a stable sort), which for a `NTV6` roster is the signed
/// roster's own canonical, fingerprint-sorted order.
///
/// Display order only: the SIGNED roster must stay fingerprint-sorted, because
/// that is what makes one semantic roster have one signed byte representation
/// (`validate_group_roster`), so the reordering belongs here rather than in the
/// payload.
fn sort_owner_first(views: &mut [RosterMemberView]) {
    views.sort_by_key(|v| v.role != super::roster::RosterRole::Owner);
}

/// The roster listing plus the caller's vault authority, so the UI gates
/// admin affordances on one typed source rather than inferring ownership.
#[derive(Debug, serde::Serialize)]
pub struct RosterListView {
    pub members: Vec<RosterMemberView>,
    pub authority: crate::plugins::vault_unlock::state::VaultAuthority,
    /// The current group-key epoch on an `NTV6` vault; `None` for a legacy
    /// `NTV5`/`MYV1` roster that has no group tier.
    pub group_key_epoch: Option<u64>,
}

/// One roster row as the UI consumes it.
#[derive(Debug, serde::Serialize)]
pub struct RosterMemberView {
    pub fingerprint_hex: String,
    /// Whether this row is the CALLER: the local person's own fingerprint. The
    /// UI renders its "You" badge from this, never from `role`, because every
    /// device sees the owner's row as `owner` (myne-md/myne#859).
    pub is_self: bool,
    /// The member's display name, resolved from the signed `vault.member-names`
    /// store (myne-md/myne#851 task 4). Non-empty ONLY when `name_state` is
    /// `verified`, so a record that failed its signature never puts a name in front
    /// of the user.
    ///
    /// It deliberately does NOT carry the owner-signed roster's own `display_name`.
    /// That field is the vault label captured at migration rather than a person, it
    /// read as "Owner"/"Member" on every device, and the member list must render a
    /// name only where a member actually chose one; the fingerprint and the role
    /// badge are what identify a row without a name.
    pub display_name: String,
    /// Whether the store holds a name record for this row, and whether it verified:
    /// `verified`, `unverified` or `absent`. Three answers rather than a flag,
    /// because "this member has not chosen a name" and "somebody wrote a row for
    /// this member that nobody signed" are different things to say and the member
    /// list renders them differently. `display_name` is non-empty only for
    /// `verified`.
    pub name_state: String,
    /// The member's vault role (`owner` or `member`), serialized lowercase.
    pub role: super::roster::RosterRole,
    pub version: u64,
    pub previous_fingerprint_hex: Option<String>,
    pub joined_at: u64,
    /// The member's Ed25519 public key (lowercase hex).
    pub member_ed_pk_hex: String,
    /// The member's ML-KEM encapsulation key (lowercase hex).
    pub member_kem_ek_hex: String,
    /// The member's ML-DSA verifying key (lowercase hex).
    pub member_mldsa_vk_hex: String,
    /// The row's identity-continuity state on an `NTV6` vault (`current`,
    /// `changed` or `owner-confirmed`); `None` for a legacy roster. The UI uses
    /// it to distinguish a cryptographic key change from an owner-confirmed
    /// relink.
    pub continuity: Option<String>,
    /// Hex of the member's signed `myne.person-key-transition v1|` record when
    /// the fingerprint change was cryptographic. Absent for a never-changed
    /// member and for an owner-confirmed relink, which is exactly the
    /// distinction the UI renders.
    pub transition_hex: Option<String>,
}

impl RosterMemberView {
    /// Map one `NTV6` signed-roster row to the UI shape, with the name already
    /// resolved from the store by [`resolve_member_name`]. `version`/`joined_at`
    /// are the legacy NTV5 roster's fields and carry no `NTV6` meaning, so they
    /// are zero; the `NTV6` row's own state is `continuity`.
    fn from_group_member(
        m: protocol::person_invite::GroupRosterMember,
        local_fingerprint_hex: Option<&str>,
        display_name: String,
        name_state: &str,
    ) -> Self {
        let is_self = matches!(local_fingerprint_hex, Some(f) if f == m.fingerprint_hex.as_str());
        let continuity = match m.continuity {
            protocol::person_invite::GroupKeyContinuity::Current => "current",
            protocol::person_invite::GroupKeyContinuity::Changed => "changed",
            protocol::person_invite::GroupKeyContinuity::OwnerConfirmed => "owner-confirmed",
        }
        .to_string();
        Self {
            fingerprint_hex: m.fingerprint_hex,
            is_self,
            display_name,
            name_state: name_state.to_string(),
            role: match m.role {
                protocol::person_invite::GroupRosterRole::Owner => super::roster::RosterRole::Owner,
                protocol::person_invite::GroupRosterRole::Member => {
                    super::roster::RosterRole::Member
                }
            },
            version: 0,
            previous_fingerprint_hex: m.previous_fingerprint_hex,
            joined_at: 0,
            member_ed_pk_hex: m.member_ed_pk_hex,
            member_kem_ek_hex: m.member_kem_ek_hex,
            member_mldsa_vk_hex: m.member_mldsa_vk_hex,
            continuity: Some(continuity),
            transition_hex: m.transition_hex,
        }
    }

    fn from_entry(
        e: super::roster::RosterMemberEntry,
        local_fingerprint_hex: Option<&str>,
    ) -> Self {
        let is_self = matches!(local_fingerprint_hex, Some(f) if f == e.fingerprint_hex.as_str());
        Self {
            fingerprint_hex: e.fingerprint_hex,
            is_self,
            // The legacy `MYV1`/`NTV5` roster has no member-names store (the family
            // is `NTV6`-only), and its own `display_name` is the field this change
            // stops surfacing. So a legacy row reports no name, and the member list
            // falls back to the fingerprint for it.
            display_name: String::new(),
            name_state: "absent".to_string(),
            role: e.role,
            version: e.version,
            previous_fingerprint_hex: e.previous_fingerprint_hex,
            joined_at: e.joined_at,
            member_ed_pk_hex: e.member_ed_pk_hex,
            member_kem_ek_hex: e.member_kem_ek_hex,
            member_mldsa_vk_hex: e.member_mldsa_vk_hex,
            continuity: None,
            transition_hex: e.transition_hex,
        }
    }
}

/// The person id a roster row resolves its name against.
///
/// The row's own when the signed roster carries one. Otherwise, for the
/// CALLER'S OWN row only, the session's person id: a vault migrated before the
/// owner row carried a person id still has the owner's name record keyed by that
/// id on the very device that wrote it. Any other row answers `None`,
/// which is honest — this device cannot prove a stranger's person id, and
/// guessing one would risk rendering a name the row's own signature does not back.
fn effective_person_id_hex(
    row_person_id_hex: Option<&str>,
    row_fingerprint_hex: &str,
    local_fingerprint_hex: Option<&str>,
    local_person_id_hex: Option<&str>,
) -> Option<String> {
    if let Some(id) = row_person_id_hex {
        return Some(id.to_string());
    }
    let is_self = matches!(local_fingerprint_hex, Some(f) if f == row_fingerprint_hex);
    if is_self {
        local_person_id_hex.map(str::to_string)
    } else {
        None
    }
}

/// The name a roster row reports, and whether the store's record for it verified.
///
/// `verified` and `unverified` come from [`protocol::partition_verified`], which is
/// what makes this trustworthy: a record is verified against the public half of the
/// person the ROW names, so a member cannot claim another member's name, and an owner
/// signature is accepted on a tombstone only. The unverified ids are kept as a list
/// precisely so this can tell a failed record from an absent one.
fn resolve_member_name(
    person_id_hex: Option<&str>,
    verified: &protocol::MemberNamesMap,
    unverified: &[String],
) -> (String, &'static str) {
    let Some(id) = person_id_hex else {
        // A row migrated from a pre-B2B roster has no person account, so nothing
        // could have named it.
        return (String::new(), "absent");
    };
    // The store's keys are the family's lowercase hex and the roster's
    // `person_id_hex` is owner-supplied, so compare case-insensitively rather than
    // trusting one spelling: a row that differs only in case is still that person.
    let same = |k: &str| k.eq_ignore_ascii_case(id);
    if let Some((_, entry)) = verified.iter().find(|(k, _)| same(k)) {
        // A verified TOMBSTONE is a cleared name (or an owner removal), which reads
        // as no name: the live view drops tombstones for the same reason.
        if entry.tombstone {
            return (String::new(), "absent");
        }
        return (entry.name.clone(), "verified");
    }
    if unverified.iter().any(|u| u.eq_ignore_ascii_case(id)) {
        return (String::new(), "unverified");
    }
    (String::new(), "absent")
}

/// **Remove a member from the unlocked vault** (B2B, myne-md/myne#698
/// tasks 4 and 7).
///
/// LIVE and reachable: `src/lib/invite.ts::removeMember` wraps it, `useRoster`
/// exposes it as `remove`, and `MemberRosterPanel`'s remove button plus its
/// confirm dialog call it. It is owner-only (`require_owner`), so a member gets
/// the typed [`SyncDeviceError::NotOwner`].
///
/// It runs the canonical B2B rotation rather than the parked legacy NTV5 path:
/// `member_removal::rotate_group_from_host` rotates the vault `itemsKey` and the
/// `group_key` to epoch + 1, re-wraps every note and attachment blob's per-entry
/// key under the new `itemsKey` (content ciphertext byte-identical), tombstones
/// the removed member's roster row, re-seals every shared singleton
/// (`vault.member-names` included) to the new group tier, re-wraps the new
/// `itemsKey` to every remaining member's carried public half, and re-derives the
/// slot's tiers so the running session keeps working. This command then posts the
/// per-member packages and the retirement records
/// (`person_account::push_and_revoke_removed_member_from_host`) and marks the
/// scheduler dirty so the re-keyed content pushes on the next cycle.
///
/// [`SyncDeviceError::RemovalUnavailable`] is therefore NOT reachable from here:
/// that variant belongs to the legacy NTV5 `member_removal::remove_member_from_host`,
/// which stays parked and which nothing in this path calls. What is genuinely not
/// shipped is the WIRE half: a removed member's device is never told, so it keeps
/// the retired group key until it learns of the greater epoch from `vault.meta`.
/// That is a liveness gap on the removed side, not a refusal on ours.
#[tauri::command]
pub async fn sync_remove_member<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, VaultRuntimeState>,
    hooks: State<'_, crate::hooks::Hooks>,
    member_fingerprint_hex: String,
) -> Result<(), SyncDeviceError> {
    // Authority BEFORE any vault work, so a non-owner gets the typed `NotOwner`
    // rather than a failure from a rotation that should never have started.
    let authority = {
        let slot = state.inner().slot_read_active().await;
        match &*slot {
            crate::plugins::vault_unlock::state::Slot::Unlocked(uv) => uv.authority(),
            _ => return Err(SyncDeviceError::NotEnrolled),
        }
    };
    require_owner(authority)?;
    let host = crate::host::tauri_host::TauriHost::new(app.clone());
    let io = crate::vault_io::StdVaultIo;
    let owner = state
        .inner()
        .clone_person_identity()
        .await
        .ok_or(SyncDeviceError::NotEnrolled)?;
    let person_id = super::member_removal::member_person_id_from_host(
        &host,
        &io,
        state.inner(),
        &owner,
        &member_fingerprint_hex,
    )
    .await
    .map_err(map_remove_error)?;
    let rotation = super::member_removal::rotate_group_from_host(
        &host,
        &io,
        state.inner(),
        &owner,
        &member_fingerprint_hex,
    )
    .await
    .map_err(map_remove_error)?;
    super::person_account::push_and_revoke_removed_member_from_host(
        &host,
        &io,
        state.inner(),
        person_id.as_deref(),
        rotation.new_epoch.saturating_sub(1),
        rotation.new_epoch,
        &rotation.reclaim_sync_ids_hex,
        &rotation.packages,
    )
    .await?;
    // The rotation re-keyed every content blob locally, but a member removal is
    // not a note edit, so nothing else bumps the sync scheduler: without this the
    // re-keyed content waits for an unrelated edit to open a push window, and the
    // server keeps serving the OLD `itemsKey`'s ciphertext. A member who joins
    // after the removal would then pull notes their (new) `itemsKey` cannot open.
    // Mark the scheduler dirty so the re-keyed content pushes on the next cycle.
    hooks.bump_local_change();
    Ok(())
}

/// Map the closed member-removal enum by cause rather than collapsing every
/// failure to `Transport`: a removed member that does not exist and a corrupt
/// `vault.meta` are not transient network faults, and reporting them as one
/// makes a failed call indistinguishable from a retryable one.
fn map_remove_error(e: super::member_removal::MemberRemovalError) -> SyncDeviceError {
    use super::member_removal::MemberRemovalError as E;
    match e {
        E::RemovalUnavailable => SyncDeviceError::RemovalUnavailable,
        E::VaultLocked | E::NoRoster => SyncDeviceError::NotEnrolled,
        E::MemberNotFound => SyncDeviceError::DeviceNotFound,
        // A contended auth permit is transient: the frontend retries rather
        // than re-enrolling, so it maps to `Transport`, not `NotEnrolled`.
        E::Busy => SyncDeviceError::Transport,
        E::CannotDecrypt | E::InvalidVaultMeta | E::Io => SyncDeviceError::BadRequest,
    }
}

// --- The two-sided device admission ceremony (myne-md/myne#938 task 11; 0735) ---
//
// Five commands, because the ceremony has five states a screen can be in and each one
// gates a DIFFERENT write: the joining device mints nothing to disk, its confirm persists
// its own secret, the admitting device previews nothing, its accept installs the credential
// and writes the row, and a cancel forgets the RAM copy. Collapsing any two would put two
// different guarantees behind one call.

/// JOINING device, step 1: mint an admission and show its code and SAS. Writes nothing.
#[tauri::command]
pub async fn sync_device_admission_start(
    state: State<'_, VaultRuntimeState>,
    person_id_hex: String,
) -> Result<device_admission::AdmissionMintedView, SyncDeviceError> {
    device_admission::mint_from_host(state.inner(), &person_id_hex).await
}

/// JOINING device, step 2: persist this device's own secret, after its own tap.
///
/// `Ok(true)` means the admitting device had already accepted, so this device holds a
/// session; `Ok(false)` is the ordinary pending answer and the screen says "waiting".
#[tauri::command]
pub async fn sync_device_admission_confirm<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, VaultRuntimeState>,
    confirmed_sas: String,
) -> Result<bool, SyncDeviceError> {
    device_admission::confirm_minted_from_host(
        &crate::host::tauri_host::TauriHost::new(app.clone()),
        &crate::vault_io::StdVaultIo,
        state.inner(),
        &confirmed_sas,
    )
    .await
}

/// ADMITTING device, step 1: derive the SAS from a code the user pasted or scanned.
/// Writes nothing and sends nothing. This is the call whose contract is that it is a read.
#[tauri::command]
pub async fn sync_device_admission_preview(
    state: State<'_, VaultRuntimeState>,
    code: String,
) -> Result<device_admission::AdmissionPreviewView, SyncDeviceError> {
    device_admission::preview_from_host(state.inner(), &code).await
}

/// ADMITTING device, step 2: install the credential and write the binding row, after its
/// own tap and only for the SAS the human confirmed.
#[tauri::command]
pub async fn sync_device_admission_accept<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, VaultRuntimeState>,
    code: String,
    confirmed_sas: String,
) -> Result<device_admission::AdmissionConfirmedView, SyncDeviceError> {
    device_admission::confirm_preview_from_host(
        &crate::host::tauri_host::TauriHost::new(app.clone()),
        &crate::vault_io::StdVaultIo,
        state.inner(),
        &code,
        &confirmed_sas,
    )
    .await
}

/// Either side: discard the exchange. Nothing was written, so there is nothing to undo
/// beyond the RAM copy of the minted secret.
#[tauri::command]
pub async fn sync_device_admission_cancel(
    state: State<'_, VaultRuntimeState>,
) -> Result<(), SyncDeviceError> {
    device_admission::cancel_from_host(state.inner()).await;
    Ok(())
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
/// repo `src-tauri/AGENTS.md` "Secret-handling logging discipline".
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
/// costs a disk scan) and `native_tls: true` (only a host has a rustls arm to
/// complete the certificate-verifying handshake with).
///
/// `confirmed_fingerprint` is the retired out-of-band value, still on the wire
/// and ignored: certificate pinning is gone (decisions/sync/0620), so a join
/// with a wrong one no longer aborts, and a join without one is no longer
/// refused in Tor mode.
#[tauri::command]
pub async fn sync_join_account<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, VaultRuntimeState>,
    server_url: String,
    account_number: String,
    password: String,
    confirmed_fingerprint: Option<String>,
    // Optional so every existing caller keeps meaning "password" (myne-md/myne#468).
    credential_kind: Option<super::enroll::EnrollCredential>,
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
            native_tls: true,
        },
        super::enroll::JoinRequest {
            server_url,
            account_number,
            password,
            confirmed_fingerprint,
            credential_kind: credential_kind.unwrap_or(super::enroll::EnrollCredential::Password),
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
        // A payload that STILL carries a legacy pin, on purpose: the phone must
        // decode a QR an older desktop produced, and the decoded view must carry
        // no trust material at all. Asserting the absence is the property; a
        // payload built with `None` would satisfy any assertion about the
        // endpoint and say nothing about this.
        let pin = "ab".repeat(32);
        let encoded = QrJoinPayload::new("https://sync.example.org", &acct, Some(pin), 1_000)
            .unwrap()
            .encode()
            .unwrap();
        let view = decode_join_qr_view(&encoded, 1_050).expect("decode");
        match view {
            JoinQrView::Account {
                endpoint_url,
                account_number,
                fresh,
            } => {
                assert_eq!(endpoint_url, "https://sync.example.org");
                assert_eq!(account_number, acct);
                assert!(fresh);
            }
            other => panic!("an account payload must decode as the account kind: {other:?}"),
        }
    }

    /// The member target, end to end through the view the WebView receives: the
    /// vault is named by its account hash and the endpoint travels with it, which
    /// is the whole contribution of the member QR (the phrase is still typed).
    #[test]
    fn decode_join_qr_view_carries_a_member_target() {
        use super::super::qr_join::QrJoinPayload;
        let hash = "ab".repeat(16);
        let encoded = QrJoinPayload::member_vault("https://sync.example.org", &hash, 1_000)
            .unwrap()
            .encode()
            .unwrap();
        match decode_join_qr_view(&encoded, 1_050).expect("decode") {
            JoinQrView::MemberVault {
                endpoint_url,
                account_hash_hex,
                fresh,
            } => {
                assert_eq!(endpoint_url, "https://sync.example.org");
                assert_eq!(account_hash_hex, hash);
                assert!(fresh);
            }
            other => panic!("a member payload must decode as the member kind: {other:?}"),
        }
    }

    /// A v1 (older desktop) QR reaches the scanner as the ACCOUNT kind, not as a
    /// member one — the legacy layout has no kind byte, and reading it as anything
    /// else would send the user to the phrase wizard for an owner join.
    #[test]
    fn decode_join_qr_view_reads_a_legacy_payload_as_an_account_target() {
        let acct = qr_account();
        let v1 = format!("MYQR1|https://s.example|{acct}|-|1000");
        match decode_join_qr_view(&v1, 1_050).expect("decode") {
            JoinQrView::Account { account_number, .. } => assert_eq!(account_number, acct),
            other => panic!("a v1 payload must decode as the account kind: {other:?}"),
        }
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
        assert!(matches!(view, JoinQrView::Account { fresh: false, .. }));
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
                overlay_status(
                    base.clone(),
                    Some(LiveStatus::Syncing),
                    5,
                    SyncClocks::default()
                ),
                base
            );
        }
    }

    #[test]
    fn overlay_status_live_wins_over_conflicts_over_idle() {
        use SyncRuntimeStatus as S;
        // In-flight Syncing wins even with conflicts present.
        assert_eq!(
            overlay_status(S::Idle, Some(LiveStatus::Syncing), 3, SyncClocks::default()),
            S::Syncing
        );
        // A failed cycle surfaces Error (with its detail) over conflicts.
        assert_eq!(
            overlay_status(
                S::Idle,
                Some(LiveStatus::Error("sync_failed".into())),
                3,
                SyncClocks::default()
            ),
            S::Error {
                detail: "sync_failed".into(),
                last_success_at: None
            }
        );
        // No live overlay + unresolved conflicts → Conflicts{count}.
        assert_eq!(
            overlay_status(S::Idle, None, 2, SyncClocks::default()),
            S::Conflicts { count: 2 }
        );
        // Enrolled, nothing in flight, no conflicts → a bare Idle.
        assert_eq!(
            overlay_status(S::Idle, None, 0, SyncClocks::default()),
            S::Idle
        );
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

    #[test]
    fn require_owner_passes_owner_and_refuses_member() {
        use crate::plugins::vault_unlock::state::VaultAuthority;
        assert_eq!(super::require_owner(VaultAuthority::Owner), Ok(()));
        assert_eq!(
            super::require_owner(VaultAuthority::Member),
            Err(SyncDeviceError::NotOwner)
        );
    }

    #[test]
    fn roster_member_view_carries_the_role() {
        use crate::plugins::sync::roster::{RosterMemberEntry, RosterRole};
        let entry = RosterMemberEntry {
            fingerprint_hex: "aa".repeat(32),
            display_name: "Owner".into(),
            wrapped_items_key_hex: "bb".repeat(32),
            member_kem_ek_hex: "cd".repeat(1184),
            member_ed_pk_hex: "ef".repeat(32),
            member_mldsa_vk_hex: "01".repeat(1952),
            version: 1,
            role: RosterRole::Owner,
            deleted: false,
            previous_fingerprint_hex: None,
            transition_hex: None,
            joined_at: 0,
        };
        let view = super::RosterMemberView::from_entry(entry, None);
        assert_eq!(view.role, RosterRole::Owner);
        // No local identity → no row is marked as the caller (myne-md/myne#859).
        assert!(!view.is_self);
    }

    // `is_self` is decided by FINGERPRINT, never by role: every device sees the
    // owner's row as `Owner`, so a role-keyed marker made an invited member read
    // the owner as themselves (myne-md/myne#859).
    #[test]
    fn roster_member_view_marks_the_caller_by_fingerprint_not_role() {
        use crate::plugins::sync::roster::{RosterMemberEntry, RosterRole};
        let mine = "aa".repeat(32);
        let row = |fingerprint_hex: String, role: RosterRole| RosterMemberEntry {
            fingerprint_hex,
            display_name: "Untitled vault".into(),
            wrapped_items_key_hex: "bb".repeat(32),
            member_kem_ek_hex: "cd".repeat(1184),
            member_ed_pk_hex: "ef".repeat(32),
            member_mldsa_vk_hex: "01".repeat(1952),
            version: 1,
            role,
            deleted: false,
            previous_fingerprint_hex: None,
            transition_hex: None,
            joined_at: 0,
        };
        assert!(
            super::RosterMemberView::from_entry(row(mine.clone(), RosterRole::Member), Some(&mine))
                .is_self
        );
        // A member's own row can be the OWNER role on the owner's device, and the
        // owner's row is NOT self on the member's device.
        assert!(
            !super::RosterMemberView::from_entry(
                row("ff".repeat(32), RosterRole::Owner),
                Some(&mine)
            )
            .is_self
        );
    }

    // ── the signed display name in the roster view (myne-md/myne#851 task 4) ──
    //
    // A row reports a NAME only where the store's record verified against the
    // person the ROW names. The three answers are load-bearing: `verified` carries
    // the name, `unverified` is a record that exists and failed its signature (or
    // names someone else), and `absent` is a member who has not chosen one. The
    // UI may render a name for the first and must not for the other two, but the
    // last two stay distinguishable because they say different things.

    fn name_pair(seed: u8) -> PersonKeyPair {
        PersonKeyPair::generate_raw(
            &[seed; protocol::person_key::PERSON_DK_SEED_LEN],
            &[seed.wrapping_add(1); protocol::person_key::PERSON_ED25519_SEED_LEN],
            &[seed.wrapping_add(2); protocol::person_key::PERSON_MLDSA_SEED_LEN],
        )
    }

    /// A live group-roster row for `pair`, carrying whatever owner-signed
    /// `display_name` we hand it. That field is exactly what the view must STOP
    /// surfacing, so each fixture below sets it to something the assertions would
    /// catch if it leaked.
    fn group_row(
        pair: &PersonKeyPair,
        person_id_hex: Option<String>,
        owner_signed_name: &str,
    ) -> protocol::person_invite::GroupRosterMember {
        use crate::account::person_identity::hex_lower;
        use protocol::person_invite::{
            GroupKeyContinuity, GroupMemberState, GroupRosterMember, GroupRosterRole,
        };
        let public = pair.public_half();
        GroupRosterMember {
            fingerprint_hex: hex_lower(pair.fingerprint()),
            person_id_hex,
            display_name: owner_signed_name.into(),
            role: GroupRosterRole::Member,
            state: GroupMemberState::Live,
            wrapped_group_key_hex: None,
            member_kem_ek_hex: hex_lower(public.kem_ek()),
            member_ed_pk_hex: hex_lower(public.ed_pk()),
            member_mldsa_vk_hex: hex_lower(public.mldsa_vk()),
            previous_fingerprint_hex: None,
            continuity: GroupKeyContinuity::Current,
            transition_hex: None,
        }
    }

    fn publics_for(
        rows: &[protocol::person_invite::GroupRosterMember],
    ) -> std::collections::HashMap<String, protocol::person_key::PersonPublicHalf> {
        rows.iter()
            .filter_map(|m| {
                let id = m.person_id_hex.as_deref()?;
                let public = protocol::person_key::PersonPublicHalf::from_parts_hex(
                    &m.member_kem_ek_hex,
                    &m.member_ed_pk_hex,
                    &m.member_mldsa_vk_hex,
                )
                .ok()?;
                Some((id.to_ascii_lowercase(), public))
            })
            .collect()
    }

    #[test]
    fn a_group_row_reports_its_verified_name_and_flags_the_others() {
        use crate::plugins::sync::roster::RosterRole;
        use protocol::MemberNamesMap;

        let ada = name_pair(0x21);
        let bob = name_pair(0x31);
        let mallory = name_pair(0x41);
        let (ada_id, bob_id, mal_id) = ("ab".repeat(16), "cd".repeat(16), "ef".repeat(16));
        // Every row's owner-signed name is a value the view must NOT surface.
        let rows = vec![
            group_row(&ada, Some(ada_id.clone()), "Owner"),
            group_row(&bob, Some(bob_id.clone()), "Member"),
            group_row(&mallory, Some(mal_id.clone()), "Member"),
        ];

        let mut rng = rand_core::UnwrapErr(crate::rng::OsRng);
        let mut store = MemberNamesMap::new();
        // Ada signs her OWN row: verifies.
        store.insert(
            ada_id.clone(),
            protocol::sign_member_name(&ada, &[0xab; 16], 1, false, "Ada", &mut rng).unwrap(),
        );
        // Mallory's row carries a name Ada signed, so it verifies against nobody
        // the row names: unverified, and its name must not cross the boundary.
        store.insert(
            mal_id.clone(),
            protocol::sign_member_name(&ada, &[0xef; 16], 1, false, "Grace", &mut rng).unwrap(),
        );

        let publics = publics_for(&rows);
        let (verified, unverified) = protocol::partition_verified(
            &store,
            |id| publics.get(&id.to_ascii_lowercase()).cloned(),
            None,
        );
        assert_eq!(verified.len(), 1, "only Ada's own signature verifies");
        assert_eq!(unverified, vec![mal_id.clone()]);

        let views: Vec<_> = rows
            .into_iter()
            .map(|m| {
                let (display_name, name_state) =
                    super::resolve_member_name(m.person_id_hex.as_deref(), &verified, &unverified);
                super::RosterMemberView::from_group_member(m, None, display_name, name_state)
            })
            .collect();

        assert_eq!(views[0].display_name, "Ada");
        assert_eq!(views[0].name_state, "verified");
        assert_eq!(views[1].display_name, "", "no record means no name");
        assert_eq!(views[1].name_state, "absent");
        assert_eq!(
            views[2].display_name, "",
            "a name nobody signed never reaches the UI"
        );
        assert_eq!(views[2].name_state, "unverified");
        assert_ne!(
            views[1].name_state, views[2].name_state,
            "an absent record and a failed one are different things to say"
        );
        // The owner-signed roster field is gone from every row, including the one
        // whose store record verified: the name above comes from the store.
        assert!(views
            .iter()
            .all(|v| v.display_name != "Owner" && v.display_name != "Member"));
        // The identity affordances are untouched by this change.
        assert_eq!(views[0].role, RosterRole::Member);
        assert!(views.iter().all(|v| !v.is_self));
    }

    #[test]
    fn resolve_member_name_reads_a_tombstone_and_a_missing_person_id_as_absent() {
        use protocol::MemberNamesMap;

        let ada = name_pair(0x21);
        let id_hex = "ab".repeat(16);
        let mut rng = rand_core::UnwrapErr(crate::rng::OsRng);

        // A VERIFIED TOMBSTONE is a cleared name, which reads as no name: the live
        // view drops tombstones for the same reason.
        let mut cleared = MemberNamesMap::new();
        cleared.insert(
            id_hex.clone(),
            protocol::sign_member_name(&ada, &[0xab; 16], 2, true, "", &mut rng).unwrap(),
        );
        assert_eq!(
            super::resolve_member_name(Some(&id_hex), &cleared, &[]),
            (String::new(), "absent")
        );
        // A row migrated from a pre-B2B roster has no person account, so nothing
        // could have named it.
        assert_eq!(
            super::resolve_member_name(None, &cleared, &[]),
            (String::new(), "absent")
        );

        // The store's keys are the family's lowercase hex and the roster's id is
        // owner-supplied, so a row differing only in case is still that person.
        let mut live = MemberNamesMap::new();
        live.insert(
            id_hex.clone(),
            protocol::sign_member_name(&ada, &[0xab; 16], 1, false, "Ada", &mut rng).unwrap(),
        );
        assert_eq!(
            super::resolve_member_name(Some(&id_hex.to_ascii_uppercase()), &live, &[]),
            ("Ada".to_string(), "verified")
        );
        // And an id the store knows nothing about is absent, not unverified.
        assert_eq!(
            super::resolve_member_name(Some(&"cd".repeat(16)), &live, &[]),
            (String::new(), "absent")
        );
        assert_eq!(
            super::resolve_member_name(
                Some(&"cd".repeat(16)),
                &MemberNamesMap::new(),
                &["cd".repeat(16)]
            ),
            (String::new(), "unverified")
        );
    }

    /// The name a row resolves against is its OWN person id, except on the
    /// caller's own row of a vault whose roster carries none: there the session
    /// person id stands in, which is what lets the owner see the name they just
    /// wrote.
    #[test]
    fn a_self_row_without_a_person_id_falls_back_to_the_session_id() {
        let self_fp = "aa".repeat(32);
        let other_fp = "bb".repeat(32);
        let local_id = "ab".repeat(16);
        // A row carrying its own id is used verbatim, case preserved.
        assert_eq!(
            super::effective_person_id_hex(
                Some("CD".repeat(16).as_str()),
                &other_fp,
                Some(&self_fp),
                Some(&local_id),
            ),
            Some("CD".repeat(16))
        );
        // The caller's own row falls back to the session id.
        assert_eq!(
            super::effective_person_id_hex(None, &self_fp, Some(&self_fp), Some(&local_id)),
            Some(local_id.clone())
        );
        // Nobody else's does: this device cannot prove a stranger's person id, and
        // guessing one would risk a name that row's own signature does not back.
        assert_eq!(
            super::effective_person_id_hex(None, &other_fp, Some(&self_fp), Some(&local_id)),
            None
        );
        // No local identity installed: nothing to fall back to.
        assert_eq!(
            super::effective_person_id_hex(None, &self_fp, None, None),
            None
        );
    }

    /// The member list leads with the OWNER wherever the fingerprint sort put
    /// them, and leaves everyone else in the caller's order.
    #[test]
    fn the_roster_view_leads_with_the_owner_and_keeps_the_rest_in_order() {
        use crate::plugins::sync::roster::RosterRole;
        let mk = |seed: u8, role: RosterRole| {
            let mut view = super::RosterMemberView::from_group_member(
                group_row(&name_pair(seed), None, "Owner"),
                None,
                String::new(),
                "absent",
            );
            view.role = role;
            view
        };
        // Deliberately NOT owner-first: `from_group_member` preserves whatever the
        // signed roster's fingerprint sort produced.
        let (a, b, c) = ("11".repeat(32), "22".repeat(32), "33".repeat(32));
        let mut views = vec![
            {
                let mut v = mk(0x11, RosterRole::Member);
                v.fingerprint_hex = a.clone();
                v
            },
            {
                let mut v = mk(0x22, RosterRole::Owner);
                v.fingerprint_hex = b.clone();
                v
            },
            {
                let mut v = mk(0x33, RosterRole::Member);
                v.fingerprint_hex = c.clone();
                v
            },
        ];
        super::sort_owner_first(&mut views);
        assert_eq!(views[0].role, RosterRole::Owner);
        assert_eq!(views[0].fingerprint_hex, b);
        // The others keep their order relative to each other.
        assert_eq!(views[1].fingerprint_hex, a);
        assert_eq!(views[2].fingerprint_hex, c);
    }

    // ── Explicit owner-approved NTV5 → NTV6 migration (myne-md/myne#712) ─────

    use crate::plugins::vault_unlock::state::UnlockedVault;
    use crate::test_support::{block_on, FAST_TEST_KDF};
    use crate::vault_io::StdVaultIo;
    use protocol::person_key::PersonKeyPair;

    const MIG_ROOT: [u8; 32] = [7u8; 32];
    const MIG_ITEMS: [u8; 32] = [9u8; 32];
    const MIG_ACCOUNT: [u8; 16] = [3u8; 16];
    const MIG_ITEMS_ID: [u8; 16] = [1u8; 16];

    fn migration_owner_pair() -> PersonKeyPair {
        let mut kem = [0u8; protocol::person_key::PERSON_DK_SEED_LEN];
        kem[..32].copy_from_slice(&[0x21; 32]);
        kem[32..].copy_from_slice(&[0x22; 32]);
        PersonKeyPair::generate_raw(&kem, &[0x23; 32], &[0x24; 32])
    }

    /// An `NTV5` `vault.meta` at `<base>/vaults/<id>/`, plus an owner-held slot
    /// for that id. Returns the id and the bytes the anchor should carry.
    fn seed_ntv5_owner_vault(base: &std::path::Path) -> (crate::vault_id::VaultId, Vec<u8>) {
        let id = crate::vault_id::VaultId::mint();
        let root = crate::paths::vault_root_for_id_from_base(base, id);
        std::fs::create_dir_all(&root).expect("create vault dir");
        let bytes = protocol::encode_vault_meta_v0_2_raw(
            &MIG_ROOT,
            &MIG_ITEMS,
            &MIG_ITEMS_ID,
            "pw",
            "abandon abandon abandon",
            &MIG_ACCOUNT,
            &FAST_TEST_KDF,
            &[2u8; protocol::ARGON2_SALT_LEN],
            &[4u8; protocol::ARGON2_SALT_LEN],
            &[5u8; protocol::AEAD_NONCE_LEN],
            &[6u8; protocol::AEAD_NONCE_LEN],
            &[8u8; protocol::AEAD_NONCE_LEN],
        )
        .expect("encode NTV5")
        .to_vec();
        std::fs::write(root.join("vault.meta"), &bytes).expect("write vault.meta");
        (id, bytes)
    }

    async fn unlock_owner(state: &VaultRuntimeState, id: crate::vault_id::VaultId, bytes: &[u8]) {
        state
            .set_unlocked(
                id,
                UnlockedVault::owner(
                    zeroize::Zeroizing::new(MIG_ROOT),
                    None,
                    zeroize::Zeroizing::new(MIG_ITEMS),
                    MIG_ITEMS_ID,
                    0,
                    crate::vault_meta_hash::vault_meta_sha256(bytes),
                ),
            )
            .await;
    }

    #[test]
    fn start_b2b_migration_requires_a_held_person_identity() {
        block_on(async {
            let dir = ScopedTempDir::new("b2b-mig-no-person").expect("tempdir");
            let host = crate::host::test_host::TestHost::new(dir.path());
            let state = VaultRuntimeState::default();
            let (id, bytes) = seed_ntv5_owner_vault(&dir.path().join("data"));
            unlock_owner(&state, id, &bytes).await;

            let err = start_b2b_migration_from_host(&host, &state, &StdVaultIo, "Owner")
                .await
                .expect_err("no person identity must refuse");

            assert_eq!(err, SyncDeviceError::NotEnrolled);
        });
    }

    #[test]
    fn start_b2b_migration_refuses_a_member_authority() {
        block_on(async {
            let dir = ScopedTempDir::new("b2b-mig-member").expect("tempdir");
            let host = crate::host::test_host::TestHost::new(dir.path());
            let state = VaultRuntimeState::default();
            let (id, bytes) = seed_ntv5_owner_vault(&dir.path().join("data"));
            state
                .set_unlocked(
                    id,
                    UnlockedVault::member(
                        zeroize::Zeroizing::new([0x5Au8; 32]),
                        zeroize::Zeroizing::new(MIG_ITEMS),
                        MIG_ITEMS_ID,
                        0,
                        crate::vault_meta_hash::vault_meta_sha256(&bytes),
                    ),
                )
                .await;
            state
                .set_person_identity_and_id(migration_owner_pair(), [0x42u8; 16])
                .await;

            let err = start_b2b_migration_from_host(&host, &state, &StdVaultIo, "Owner")
                .await
                .expect_err("member authority must refuse");

            assert_eq!(err, SyncDeviceError::NotOwner);
        });
    }

    #[test]
    fn start_b2b_migration_commits_ntv6_and_refreshes_the_anchor() {
        block_on(async {
            let dir = ScopedTempDir::new("b2b-mig-ok").expect("tempdir");
            let host = crate::host::test_host::TestHost::new(dir.path());
            let state = VaultRuntimeState::default();
            let (id, bytes) = seed_ntv5_owner_vault(&dir.path().join("data"));
            unlock_owner(&state, id, &bytes).await;
            state
                .set_person_identity_and_id(migration_owner_pair(), [0x42u8; 16])
                .await;

            let view = start_b2b_migration_from_host(&host, &state, &StdVaultIo, "Owner")
                .await
                .expect("explicit owner migration commits");
            assert_eq!(view.group_key_epoch, 1);

            // The on-disk meta is now NTV6, and the slot anchor tracks it, so a
            // later change-password does not read the migration's own write as
            // external tampering.
            let root = crate::paths::vault_root_for_id_from_base(&dir.path().join("data"), id);
            let on_disk = std::fs::read(root.join("vault.meta")).expect("read committed meta");
            assert_eq!(
                on_disk.get(..4),
                Some(protocol::VAULT_META_NTV6_MAGIC.as_slice())
            );
            let expected = crate::vault_meta_hash::vault_meta_sha256(&on_disk);
            let (_, anchor) = state
                .peek_unlocked_root_key_and_hash_clone()
                .await
                .expect("slot still unlocked");
            assert_eq!(
                anchor, expected,
                "slot anchor must track the committed meta"
            );

            // Idempotent second call reports the committed epoch and rewrites
            // nothing.
            let again = start_b2b_migration_from_host(&host, &state, &StdVaultIo, "Owner")
                .await
                .expect("already-migrated is a success");
            assert_eq!(again.group_key_epoch, 1);
            assert_eq!(again.singletons_migrated, 0);
        });
    }
}
