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
use std::sync::OnceLock;
use tauri::{AppHandle, Emitter, Manager, Runtime};
use tokio::sync::Mutex;

/// The runtime sync status surfaced to the UI (MYND-424 task 10). The live
/// `syncing` / `error` / `conflicts` states light up once the engine loop is
/// wired over a real transport (task 2, R3-blocked); until then the status is
/// derived honestly from whether an endpoint is configured.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "state", rename_all = "snake_case")]
pub enum SyncRuntimeStatus {
    /// No endpoint configured — sync is off.
    Disabled,
    /// Endpoint configured, but THIS device has no device-local token — it is not
    /// enrolled and cannot sync until it is added. Distinct from `Disabled` (no
    /// endpoint) and from `Idle` (enrolled, nothing in flight); reporting `Idle` here
    /// would falsely show "Synced" for a device that cannot sync.
    NotEnrolled,
    /// Configured + enrolled but still awaiting approval by an existing device. The
    /// device identity IS persisted (it will claim its token once approved), so this
    /// is distinct from `NotEnrolled` (never added) — the UI says "Awaiting approval",
    /// not "add this device".
    Pending,
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
pub(crate) fn config_path<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf, SyncConfigError> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|_| SyncConfigError::Io {
            io_error_kind: crate::io_failure_kind::IoFailureKind::Other,
        })?;
    std::fs::create_dir_all(&dir)?;
    Ok(dir.join("sync-config.json"))
}

/// The endpoint config plus the DERIVED pin source (SYNC-43) — not persisted;
/// computed at read so the UI distinguishes a hosted static pin from a self-host
/// TOFU pin without changing the on-disk config schema.
#[derive(Debug, Clone, serde::Serialize)]
pub struct SyncEndpointView {
    /// The sync server base URL, or `None` when unconfigured.
    pub endpoint_url: Option<String>,
    /// The pinned leaf-cert fingerprint (lowercase SHA-256 hex), or `None`.
    pub cert_pin_hex: Option<String>,
    /// Where the pin came from: `static` (hosted) vs `tofu` (self-host).
    pub pin_source: Option<super::config::PinSource>,
}

/// Read the device-local sync endpoint config + its derived pin source (SYNC-43).
#[tauri::command]
pub async fn sync_get_endpoint<R: Runtime>(
    app: AppHandle<R>,
) -> Result<SyncEndpointView, SyncConfigError> {
    let path = config_path(&app)?;
    let cfg = read_config(&path)?;
    let pin_source = cfg
        .endpoint_url
        .as_deref()
        .and_then(|u| super::config::pin_source_for(u, &cfg));
    Ok(SyncEndpointView {
        endpoint_url: cfg.endpoint_url,
        cert_pin_hex: cfg.cert_pin_hex,
        pin_source,
    })
}

use super::to_hex as hex_lower;
use super::token_store::TokenStore;

/// Parse a 64-char lowercase-hex cert pin into raw SHA-256 bytes.
fn parse_pin_hex(s: &str) -> Option<[u8; 32]> {
    if s.len() != 64 || !s.bytes().all(|b| b.is_ascii_hexdigit()) {
        return None;
    }
    let mut out = [0u8; 32];
    for (i, byte) in out.iter_mut().enumerate() {
        *byte = u8::from_str_radix(&s[i * 2..i * 2 + 2], 16).ok()?;
    }
    Some(out)
}

/// The cert pins to verify an `https` connection against: the **static-hosted-pin
/// slot ∪ the TOFU pin** (SYNC-43). The static slot is deferred (`None`) until
/// hosted launch, so today this is just the captured TOFU pin; when hosted ships,
/// a hosted endpoint additionally verifies against its pre-vetted static pin.
/// Empty for a loopback `http` endpoint or an unpinned config.
pub(crate) fn config_pins(cfg: &SyncEndpointConfig) -> Vec<[u8; 32]> {
    let mut pins = Vec::new();
    if let Some(url) = cfg.endpoint_url.as_deref() {
        if let Some(sp) = super::config::hosted_static_pin(url) {
            pins.push(sp);
        }
    }
    if let Some(tofu) = cfg.cert_pin_hex.as_deref().and_then(parse_pin_hex) {
        pins.push(tofu);
    }
    pins
}

/// Set (or clear, with `None`) the sync endpoint. Validates against the A4/TB5
/// policy, then — for an `https` endpoint — **TOFU-pins the server's leaf cert**
/// and returns its fingerprint (lowercase SHA-256 hex) for the user to
/// eye-compare across devices (`self-host-policy.md` §6). A loopback `http`
/// endpoint has no TLS, so it returns `None`. Clearing drops the pin too.
/// The endpoint-set result: the pinned fingerprint + its source (SYNC-43), so the
/// UI can render a self-host first-connect TOFU pin ("compare across devices")
/// distinctly from a pre-vetted hosted static pin — never silently normalizing
/// TOFU-for-hosted.
#[derive(Debug, Clone, serde::Serialize)]
pub struct EndpointPinInfo {
    /// The pinned leaf-cert fingerprint (lowercase SHA-256 hex) for eye-compare,
    /// or `None` for a loopback `http` endpoint / cleared config.
    pub fingerprint: Option<String>,
    /// Where the pin came from: `static` (hosted) vs `tofu` (self-host).
    pub pin_source: Option<super::config::PinSource>,
}

#[tauri::command]
pub async fn sync_set_endpoint<R: Runtime>(
    app: AppHandle<R>,
    endpoint_url: Option<String>,
) -> Result<EndpointPinInfo, SyncConfigError> {
    let path = config_path(&app)?;
    let Some(url) = endpoint_url else {
        write_config(&path, &SyncEndpointConfig::default())?;
        return Ok(EndpointPinInfo {
            fingerprint: None,
            pin_source: None,
        });
    };
    validate_endpoint_url(&url)?;
    let (scheme, host, port) =
        super::http_transport::parse_endpoint(&url).ok_or(SyncConfigError::InvalidUrl)?;
    let cert_pin_hex = if scheme == "https" {
        // Reach the server once, accept-and-record its cert, pin it (blocking).
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
        None
    };
    let cfg = SyncEndpointConfig {
        endpoint_url: Some(url.clone()),
        cert_pin_hex: cert_pin_hex.clone(),
    };
    write_config(&path, &cfg)?;
    Ok(EndpointPinInfo {
        fingerprint: cert_pin_hex,
        pin_source: super::config::pin_source_for(&url, &cfg),
    })
}

/// Pure endpoint+token+identity → status mapping (unit-testable; the `#[tauri::command]`
/// glue that resolves the endpoint and reads the device-local token + persisted
/// identity calls this). No endpoint → `Disabled` (the rest is irrelevant); endpoint +
/// token → `Idle`; endpoint + no token + a persisted enrollment identity → `Pending`
/// (added, awaiting approval); endpoint + no token + no identity → `NotEnrolled`.
fn status_from(
    endpoint_present: bool,
    token_present: bool,
    identity_present: bool,
) -> SyncRuntimeStatus {
    match (endpoint_present, token_present, identity_present) {
        (false, _, _) => SyncRuntimeStatus::Disabled,
        (true, true, _) => SyncRuntimeStatus::Idle,
        (true, false, true) => SyncRuntimeStatus::Pending,
        (true, false, false) => SyncRuntimeStatus::NotEnrolled,
    }
}

/// A live sync-status overlay (SYNC-36): the background loop / `sync_now`
/// publishes `Syncing` while a cycle runs and `Error` after a failed cycle;
/// `sync_status` overlays it on the derived base state. Cleared after a clean
/// cycle. (`Conflicts` is derived from the on-disk staging dir, not held here.)
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum LiveStatus {
    /// A pull/push is in flight.
    Syncing,
    /// The last cycle failed (bounded, non-secret detail tag).
    Error(String),
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
    /// Clear the overlay (a clean/idle cycle → fall back to base + conflicts).
    pub fn clear(&self) {
        *self.0.lock().unwrap() = None;
    }
    pub(crate) fn get(&self) -> Option<LiveStatus> {
        self.0.lock().unwrap().clone()
    }
}

/// Overlay the live status + unresolved-conflict count on the derived base state
/// (pure — the testable heart of `sync_status`, mirroring `status_from`).
///
/// Precedence: a config state (`Disabled`/`NotEnrolled`/`Pending`) dominates — a
/// device that cannot sync shows WHY, never a stale live overlay. Only for an
/// enrolled, idle-eligible device does the overlay apply: an in-flight
/// `Syncing` or a last-cycle `Error` wins over conflicts, and unresolved
/// conflicts win over a bare `Idle`.
fn overlay_status(
    base: SyncRuntimeStatus,
    live: Option<LiveStatus>,
    conflict_count: u32,
) -> SyncRuntimeStatus {
    if !matches!(base, SyncRuntimeStatus::Idle) {
        return base;
    }
    match live {
        Some(LiveStatus::Syncing) => SyncRuntimeStatus::Syncing,
        Some(LiveStatus::Error(detail)) => SyncRuntimeStatus::Error { detail },
        None if conflict_count > 0 => SyncRuntimeStatus::Conflicts {
            count: conflict_count,
        },
        None => SyncRuntimeStatus::Idle,
    }
}

/// Report the current sync status for the status indicator (task 10), derived honestly:
/// no endpoint → `Disabled`; endpoint set but no device-local token → `NotEnrolled`
/// (cannot sync); a persisted enrollment identity without a token → `Pending` (awaiting
/// approval); else `Idle`. (`Syncing`/`Error`/`Conflicts` light up once the engine loop
/// is wired over a real transport.) The enrollment check keeps the indicator consistent
/// with the device panel — without it a configured-but-unenrolled device reads "Synced".
#[tauri::command]
pub async fn sync_status<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, VaultRuntimeState>,
) -> Result<SyncRuntimeStatus, SyncConfigError> {
    let cfg = read_config(&config_path(&app)?)?;
    let dir_opt = crate::paths::active_vault_root_io(&app, state.active_vault_id().await).ok();
    let (token_present, identity_present, conflict_count) = match &dir_opt {
        Some(dir) => {
            let token = matches!(super::token_store::default_store().read(dir), Ok(Some(_)));
            // A pending device persists its identity (device_id) even before its
            // token is issued, so identity-without-token = awaiting approval.
            let identity = super::state::read_sync_state(dir)
                .map(|s| s.device_id_hex.is_some())
                .unwrap_or(false);
            // Unresolved conflict copies (decryption-free — reads the staging dir).
            let conflicts = super::orchestrator::list_pending_conflicts(dir).len() as u32;
            (token, identity, conflicts)
        }
        None => (false, false, 0),
    };
    let base = status_from(cfg.endpoint_url.is_some(), token_present, identity_present);
    // Overlay the live loop status (Syncing/Error) if the cell is registered.
    let live = app
        .try_state::<SyncRuntimeStatusCell>()
        .and_then(|c| c.get());
    Ok(overlay_status(base, live, conflict_count))
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
    /// A transport / protocol failure, coarsened to the class the scheduler's
    /// retry policy needs (429 / 401 / socket / other).
    Failed(super::loop_control::FailureClass),
}

/// Coarsen a cycle error to its scheduler-facing retry class. Lives at this
/// boundary (not in `loop_control`) because it is the one place that still
/// holds the full `SyncCycleError` before it crosses to the loop.
fn classify_cycle_error(
    e: &super::orchestrator::SyncCycleError,
) -> super::loop_control::FailureClass {
    use super::engine::{PullError, PushError};
    use super::loop_control::FailureClass;
    use super::orchestrator::SyncCycleError;
    match e {
        SyncCycleError::Pull(PullError::RateLimited)
        | SyncCycleError::Push(PushError::RateLimited) => FailureClass::RateLimited,
        SyncCycleError::Pull(PullError::Unauthenticated)
        | SyncCycleError::Push(PushError::Unauthenticated) => FailureClass::Unauthenticated,
        SyncCycleError::Pull(PullError::Transport(_))
        | SyncCycleError::Push(PushError::Transport(_)) => FailureClass::Transport,
        _ => FailureClass::Other,
    }
}

/// A still-`pending` device claims its token by re-running the SCRAM handshake
/// under the unlocked `root_key` (the verifier is already registered). Returns
/// the token once an existing device has approved this one, else `None` (still
/// pending / unreachable). Stores the token device-local on success.
async fn try_claim_token(
    url: String,
    pins: Vec<[u8; 32]>,
    dir: std::path::PathBuf,
    root_key: Zeroizing<[u8; AEAD_KEY_LEN]>,
    account_hash: [u8; 16],
    device_id: [u8; 16],
) -> Option<Vec<u8>> {
    tokio::task::spawn_blocking(move || {
        let transport = super::http_transport::build_transport(&url, pins).ok()?;
        let secret = derive_subkey(&root_key, SubkeyRole::ServerAuth);
        let mut nonce = [0u8; 16];
        getrandom::getrandom(&mut nonce).ok()?;
        let mut client_nonce = String::with_capacity(32);
        for b in &nonce {
            client_nonce.push_str(&format!("{b:02x}"));
        }
        let out = enroll::enroll(
            transport.as_ref(),
            &account_hash,
            secret.as_slice(),
            EnrollPath::Password,
            &client_nonce,
            device_id,
        )
        .ok()?;
        if out.approved && !out.token.is_empty() {
            super::token_store::default_store()
                .store(&dir, &out.token)
                .ok()?;
            Some(out.token)
        } else {
            None // still pending approval
        }
    })
    .await
    .ok()
    .flatten()
}

/// Process-wide async lock serializing EVERY sync-cycle entry against every
/// other cycle AND against [`sync_reset_local`]. Phase 1 has exactly one active
/// unlocked vault, so a single mutex is a correct per-vault serializer (a future
/// multi-vault design would key it by vault id). Same `OnceLock<Mutex<()>>` shape
/// as `attachments::catalog_write_mutex`.
fn sync_cycle_mutex() -> &'static Mutex<()> {
    static M: OnceLock<Mutex<()>> = OnceLock::new();
    M.get_or_init(|| Mutex::new(()))
}

/// Gather the active vault's sync inputs (endpoint, enrollment identity, token,
/// `root_key`) and run one [`run_sync_cycle`](super::orchestrator::run_sync_cycle)
/// off-thread. `allow_push=false` is a poll-driven pull-only cycle (coalescing —
/// see `loop_control`); `true` also pushes pending local changes. Used by both
/// the `sync_now` command and the background loop, so the gathering lives once.
pub async fn run_active_cycle<R: Runtime>(app: &AppHandle<R>, allow_push: bool) -> CycleOutcome {
    // Serialize with any concurrent cycle + sync_reset_local: run_sync_cycle is a
    // read-modify-write on sync-state.json / staging / tombstones with no other
    // guard, so two overlapping cycles (a double "Sync now", or a click coinciding
    // with a poll tick) lost-update each other's cursor/baseline — and a dropped
    // tombstone revives a deleted note elsewhere. Held across the whole gather +
    // spawn_blocking so the token claim is serialized too.
    let _cycle_guard = sync_cycle_mutex().lock().await;
    let Ok(cfg) = config_path(app).and_then(|p| read_config(&p)) else {
        return CycleOutcome::Failed(super::loop_control::FailureClass::Other);
    };
    let pins = config_pins(&cfg);
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
    let (Some(acct_hex), Some(dev_hex)) = (st.account_hash_hex.clone(), st.device_id_hex.clone())
    else {
        return CycleOutcome::NotReady; // not enrolled
    };
    let (Some(account_hash), Some(device_id)) = (hex16(&acct_hex), hex16(&dev_hex)) else {
        return CycleOutcome::Failed(super::loop_control::FailureClass::Other);
    };
    // Attachment sync (MYND-468) verifies downloaded MYA1 blobs end-to-end, so
    // the cycle needs the itemsKey material alongside root_key. Cloned out of
    // the slot and the guard dropped immediately (holding the read guard across
    // the network cycle would block lock/auto-lock).
    let Some((items_key, items_key_id, root_key)) = state
        .hold_unlocked_attachment_material()
        .await
        .map(|(_guard, items_key, items_key_id, root_key)| (items_key, items_key_id, root_key))
    else {
        return CycleOutcome::NotReady; // vault locked
    };
    // Token: the stored per-device token, or — for a still-pending device — one
    // claimed now if an existing device has just approved it (re-handshake under
    // the unlocked root_key). Still pending → nothing to sync this tick.
    let token = match super::token_store::default_store().read(&dir) {
        Ok(Some(t)) => t,
        _ => {
            match try_claim_token(
                url.clone(),
                pins.clone(),
                dir.clone(),
                root_key.clone(),
                account_hash,
                device_id,
            )
            .await
            {
                Some(t) => t,
                None => return CycleOutcome::NotReady, // still pending approval
            }
        }
    };

    let mut token_hex = String::with_capacity(token.len() * 2);
    for b in &token {
        token_hex.push_str(&format!("{b:02x}"));
    }
    let notes_dir = dir.join("notes");
    let dir_for_prefs = dir.clone();

    let res = tokio::task::spawn_blocking(move || {
        // A transport that cannot even be built is a Transport-class failure
        // (same retry posture as an unreachable socket).
        let transport = super::http_transport::build_transport(&url, pins).map_err(|e| {
            super::orchestrator::SyncCycleError::Pull(super::engine::PullError::Transport(e))
        })?;
        // The full `SyncCycleError` crosses the spawn_blocking boundary intact —
        // the integrity verdict (SYNC-10) and the scheduler's retry class are
        // both derived from it on the other side.
        super::orchestrator::run_sync_cycle(
            transport.as_ref(),
            &root_key,
            account_hash,
            device_id,
            &token_hex,
            &notes_dir,
            &dir,
            allow_push,
            Some(super::orchestrator::AttachmentKeys {
                items_key: &items_key,
                items_key_id: &items_key_id,
            }),
        )
    })
    .await;

    // Emit the alert/reconcile events here (both `sync_now` and the loop call
    // this) — the orchestrator stays AppHandle-free (sim.rs drives it without a
    // Tauri app), so the emit lives at this boundary off the summary/error.
    match res {
        Ok(Ok(summary)) => {
            if summary.reconcile_ran {
                // A 410-beyond-horizon full reconcile ran this cycle — bracket it
                // so the reconcile banner (reassuring, "caught up") can show.
                let _ = app.emit("sync://reconcile-started", ());
                let _ = app.emit("sync://reconcile-finished", ());
            }
            if summary.prefs_applied_remote {
                // A remote prefs change was merged onto disk this cycle
                // (MYND-478): refresh the switcher-facing RAM caches, then tell
                // the WebView to re-read (the same disk→cache→event choreography
                // as a local setter; the orchestrator stays AppHandle-free so
                // the side effects live at this boundary).
                if let Ok(view) = crate::plugins::prefs::commands::prefs_read_with_dir(
                    &dir_for_prefs,
                    state.inner(),
                )
                .await
                {
                    if let Some(active) = state.active_vault_id().await {
                        state.set_cached_label(active, view.label.clone()).await;
                        state.set_cached_icon(active, view.icon.clone()).await;
                    }
                }
                let _ = app.emit(crate::plugins::prefs::commands::PREFS_CHANGED_EVENT, ());
            }
            CycleOutcome::Ran(summary)
        }
        Ok(Err(e)) => {
            if matches!(&e, super::orchestrator::SyncCycleError::Pull(pe)
                if super::integrity::pull_error_is_integrity_failure(pe))
            {
                // Hard, honest integrity alert (rollback / non-extending head).
                // Copy is the pinned `SYNC_INTEGRITY_ALERT` literal on the UI side.
                let _ = app.emit("sync://integrity-alert", ());
            }
            CycleOutcome::Failed(classify_cycle_error(&e))
        }
        // Join error — no class information survives a panicked task.
        Err(_) => CycleOutcome::Failed(super::loop_control::FailureClass::Other),
    }
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
pub async fn push_vault_meta_now<R: Runtime>(app: &AppHandle<R>) -> bool {
    // Serialize with cycles / reset — same guard run_active_cycle uses, so a push
    // never races the loop's own meta read-modify-write.
    let _cycle_guard = sync_cycle_mutex().lock().await;
    let Ok(cfg) = config_path(app).and_then(|p| read_config(&p)) else {
        return false;
    };
    let pins = config_pins(&cfg);
    let Some(url) = cfg.endpoint_url else {
        return false; // sync disabled
    };
    let Some(state) = app.try_state::<VaultRuntimeState>() else {
        return false;
    };
    let Ok(dir) = crate::paths::active_vault_root_io(app, state.active_vault_id().await) else {
        return false;
    };
    // Stored per-device token only. A still-pending device no-ops (its meta is
    // seeded when enrollment completes), and does NOT get marked dirty.
    let token = match super::token_store::default_store().read(&dir) {
        Ok(Some(t)) => t,
        _ => return false,
    };
    let Ok(meta_bytes) = std::fs::read(dir.join("vault.meta")) else {
        return false;
    };
    let mut token_hex = String::with_capacity(token.len() * 2);
    for b in &token {
        token_hex.push_str(&format!("{b:02x}"));
    }
    let url_moved = url.clone();
    let res = tokio::task::spawn_blocking(move || {
        let transport = super::http_transport::build_transport(&url_moved, pins).map_err(|_| ())?;
        super::enroll::put_vault_meta(transport.as_ref(), &token_hex, &meta_bytes).map_err(|_| ())
    })
    .await;
    match res {
        Ok(Ok(())) => {
            // Pushed — the local change reached the server; clear any prior dirt.
            let _ = super::state::clear_vault_meta_dirty(&dir);
            true
        }
        _ => {
            // Offline / transport / join error: remember to push later (Faz B).
            let _ = super::state::mark_vault_meta_dirty(&dir);
            false
        }
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
        // NotReady (locked / not enrolled) must NOT collapse into Idle — reporting
        // "Synced" for a device that cannot sync is the exact dishonesty the status
        // fix removed; clicking "Sync now" on an unenrolled device would otherwise
        // flip the dot to green. Only a genuine Ran is Idle.
        CycleOutcome::NotReady => SyncRuntimeStatus::NotEnrolled,
        CycleOutcome::Ran(summary) => {
            if summary.pulled > 0 || summary.dropped > 0 {
                // A manual sync pulled notes to disk (or reconcile quarantined
                // absentees) — mirror the loop's refresh nudge so the UI
                // reloads. Both clients run the foreground `spawn_sync_loop`
                // (mobile is foreground-only, SYNC-37), which emits the same
                // event on its own cycles; this covers the manual `sync_now`
                // path on top of the loop.
                let _ = app.emit("sync://changed", summary.pulled);
            }
            SyncRuntimeStatus::Idle
        }
        CycleOutcome::Failed(class) => SyncRuntimeStatus::Error {
            detail: class.status_detail().into(),
        },
    })
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
    let token = super::token_store::default_store()
        .read(&dir)
        .map_err(|_| SyncDeviceError::Internal)?
        .ok_or(SyncDeviceError::NotEnrolled)?;
    let mut token_hex = String::with_capacity(token.len() * 2);
    for b in &token {
        token_hex.push_str(&format!("{b:02x}"));
    }
    let cfg_path = config_path(app).map_err(|_| SyncDeviceError::Internal)?;
    let cfg = read_config(&cfg_path).map_err(|_| SyncDeviceError::NotConfigured)?;
    let pins = config_pins(&cfg);
    let url = cfg.endpoint_url.ok_or(SyncDeviceError::NotConfigured)?;
    let transport = super::http_transport::build_transport(&url, pins)
        .map_err(|_| SyncDeviceError::Transport)?;
    Ok((token_hex, transport))
}

/// List the account's devices (the device-list UI + pending-discovery render).
#[tauri::command]
pub async fn sync_list_devices<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, VaultRuntimeState>,
) -> Result<Vec<DeviceEntry>, SyncDeviceError> {
    // The locally-stored device_id identifies which roster entry is "this
    // device" (the server roster never marks it — it cannot know which client is
    // asking). Read it before consuming `state` in `authed_transport`.
    let current_device = crate::paths::active_vault_root_io(&app, state.active_vault_id().await)
        .ok()
        .and_then(|dir| super::state::read_sync_state(&dir).ok())
        .and_then(|st| st.device_id_hex);
    let (token, transport) = authed_transport(&app, state.inner()).await?;
    let mut roster =
        tokio::task::spawn_blocking(move || devices::list_devices(transport.as_ref(), &token))
            .await
            .map_err(|_| SyncDeviceError::Internal)?
            .map_err(SyncDeviceError::from_mgmt)?;
    for d in &mut roster {
        d.is_current = Some(&d.device_id_hex) == current_device.as_ref();
    }
    Ok(roster)
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
    // Serialize against an in-flight cycle: without this a reset can clear the
    // token / device-local sync files while a cycle's spawn_blocking is finishing,
    // and the cycle then writes them back — reviving the enrollment/baseline the
    // reset removed.
    let _cycle_guard = sync_cycle_mutex().lock().await;
    let dir = crate::paths::active_vault_root_io(&app, state.active_vault_id().await)
        .map_err(|_| SyncDeviceError::Internal)?;
    super::token_store::default_store()
        .clear(&dir)
        .map_err(|_| SyncDeviceError::Internal)?;
    super::state::clear_device_local_sync(&dir).map_err(|_| SyncDeviceError::Internal)?;
    // Nudge both the status indicator and the device roster to re-read immediately —
    // they poll independently (5s / 4s), so without this they would disagree (one still
    // "Synced") for up to a poll interval after the reset.
    let _ = app.emit("sync://enrollment-changed", ());
    Ok(())
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
    Ok(super::orchestrator::list_pending_conflicts(&dir))
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
    let id = hex16(&original_id_hex).ok_or(SyncDeviceError::BadRequest)?;
    let blob = super::orchestrator::read_staged_conflict_blob(&dir, &original_id_hex)
        .ok_or(SyncDeviceError::BadRequest)?;
    let (items_key, items_key_id, _root) = state
        .peek_unlocked_attachment_material()
        .await
        .ok_or(SyncDeviceError::Internal)?;
    tokio::task::spawn_blocking(move || {
        let decrypted = protocol::decode_note(&blob, &id, &items_key, &items_key_id)
            .map_err(|_| SyncDeviceError::Internal)?;
        let body = String::from_utf8(decrypted.plaintext().to_vec())
            .map_err(|_| SyncDeviceError::Internal)?;
        drop(decrypted);
        Ok::<String, SyncDeviceError>(body)
    })
    .await
    .map_err(|_| SyncDeviceError::Internal)?
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
    super::orchestrator::resolve_conflict(&dir, &original_id_hex)
        .map_err(|_| SyncDeviceError::Internal)
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
    let _ = hex16(&note_id_hex).ok_or(SyncDeviceError::BadRequest)?;
    let dir = crate::paths::active_vault_root_io(&app, state.active_vault_id().await)
        .map_err(|_| SyncDeviceError::Internal)?;
    super::orchestrator::add_pending_tombstone(&dir, &note_id_hex)
        .map_err(|_| SyncDeviceError::Internal)
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
    derive_recovery_wrap_key_from_normalized, derive_subkey, head_fingerprint,
    normalize_user_phrase, parse_account_number, parse_vault_meta, validate_kdf_params, SubkeyRole,
    AEAD_KEY_LEN, HEAD_ID_LEN,
};
use zeroize::Zeroizing;

/// Decode a 32-byte `head_id` hex → the frozen SAS fingerprint. Delegates to the
/// vector-locked [`protocol::head_fingerprint`] — no re-derivation, one encoding
/// (SYNC-17). Returns `None` only on a malformed hex string (wrong length /
/// non-hex). Factored out so the encoding is host-unit-testable against the
/// `head-fingerprint` golden vector without a live vault.
fn head_fingerprint_of_hex(head_id_hex: &str) -> Option<String> {
    if head_id_hex.len() != HEAD_ID_LEN * 2 || !head_id_hex.bytes().all(|b| b.is_ascii_hexdigit()) {
        return None;
    }
    let mut head_id = [0u8; HEAD_ID_LEN];
    for (i, b) in head_id.iter_mut().enumerate() {
        *b = u8::from_str_radix(&head_id_hex[i * 2..i * 2 + 2], 16).ok()?;
    }
    Some(head_fingerprint(&head_id))
}

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
    let dir = crate::paths::active_vault_root_io(&app, state.active_vault_id().await)
        .map_err(|_| SyncDeviceError::Internal)?;
    let sync_state = super::state::read_sync_state(&dir).map_err(|_| SyncDeviceError::Internal)?;
    match sync_state.vv_log.last() {
        Some(obs) => Ok(Some(
            head_fingerprint_of_hex(&obs.head_id_hex).ok_or(SyncDeviceError::Internal)?,
        )),
        None => Ok(None),
    }
}

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
    let pins = config_pins(&cfg);
    let url = cfg.endpoint_url.ok_or(SyncDeviceError::NotConfigured)?;

    let account =
        parse_account_number(account_number.trim()).map_err(|_| SyncDeviceError::BadRequest)?;
    let path = match credential_kind {
        EnrollCredential::Password => EnrollPath::Password,
        EnrollCredential::Recovery => EnrollPath::Recovery,
    };
    // The SCRAM username is derived inside `enroll` as the account-hash hex —
    // the display-form account number never crosses the wire (AS9).
    let outcome = tokio::task::spawn_blocking(move || -> Result<bool, SyncDeviceError> {
        let transport = super::http_transport::build_transport(&url, pins)
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
        // The `vault.meta` came from the (untrusted, TB5) sync server, so its
        // `kdf_params` are attacker-controlled. Validate the Argon2id memory/time
        // floor+ceiling BEFORE deriving — otherwise a hostile server could pin an
        // absurd `m_kib` (e.g. multi-TiB) and force a pre-auth OOM/DoS. Every
        // other derive site (unlock / recover / change-password / quick-unlock)
        // already gates on this; the sync enroll path was the one gap.
        validate_kdf_params(&meta.kdf_params).map_err(|_| SyncDeviceError::BadRequest)?;

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
        enroll::register_verifier(transport.as_ref(), &account.hash, secret.as_slice())
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
            secret.as_slice(),
            path,
            &client_nonce,
            device_id,
        )
        .map_err(|_| SyncDeviceError::Unauthenticated)?;

        // 6. On approval: store the token, seed vault.meta to the server (so the
        //    next device can fetch it), and persist the account/device identity
        //    sync_now needs to author heads.
        // Persist the device identity ALWAYS (even when pending), so a pending
        // device can later claim its token by re-running the handshake under the
        // unlocked root_key once an existing device approves it.
        let mut st = super::state::read_sync_state(&dir).unwrap_or_default();
        st.account_hash_hex = Some(acct_hex.clone());
        let mut dev_hex = String::with_capacity(32);
        for b in &device_id {
            dev_hex.push_str(&format!("{b:02x}"));
        }
        st.device_id_hex = Some(dev_hex);
        let _ = super::state::write_sync_state(&dir, &st);

        if out.approved && !out.token.is_empty() {
            super::token_store::default_store()
                .store(&dir, &out.token)
                .map_err(|_| SyncDeviceError::Internal)?;
            let mut token_hex = String::with_capacity(out.token.len() * 2);
            for b in &out.token {
                token_hex.push_str(&format!("{b:02x}"));
            }
            // Best-effort seed (a returning device's meta already matches).
            let _ = enroll::put_vault_meta(transport.as_ref(), &token_hex, &meta_bytes);
        }
        Ok(out.approved)
    })
    .await
    .map_err(|_| SyncDeviceError::Internal)??;

    // Bootstrap upload (MYND-424): an approved device that just enrolled with an
    // existing, populated vault must push it WITHOUT waiting for a note edit.
    // `sync_enroll` itself does not author a head; the background loop only pushes
    // once a local change is signalled. Reuse that same coalesced-push trigger
    // (the SyncLocalChange counter note_create / note_update bump) so the loop's
    // next tick opens the coalescing window and runs an allow_push cycle. Safe re:
    // the resolution-blur side-channel — a one-shot bootstrap, not edit timing. A
    // pending (not-yet-approved) device is skipped: it cannot push and, as a
    // joining device, has no local vault to upload.
    if outcome {
        if let Some(sig) = app.try_state::<super::loop_control::SyncLocalChange>() {
            sig.bump();
        }
    }

    Ok(EnrollResult { approved: outcome })
}

/// Outcome of joining an existing account on a fresh device.
#[derive(Debug, Clone, Serialize)]
pub struct JoinResult {
    /// The new local vault's id — the frontend routes to its unlocked editor.
    pub vault_id: String,
    /// True when the device is pending approval by an existing device (the
    /// common password-path case); false if it was approved immediately.
    pub pending: bool,
    /// The server cert fingerprint (https) for eye-compare, or `null` (loopback).
    pub fingerprint: Option<String>,
}

/// **Add this device to an existing account.** On a fresh device, bootstrap the
/// whole local vault from the server: TOFU-pin the endpoint, fetch the account's
/// `vault.meta` pre-auth, derive `root_key` from `{account# + password}`, write
/// the meta to a NEW local vault + unlock it, then SCRAM-enroll (password →
/// **pending** until an existing device approves). No 24-word recovery. After
/// approval the background loop claims the token + pulls the account's notes.
#[tauri::command]
pub async fn sync_join_account<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, VaultRuntimeState>,
    server_url: String,
    account_number: String,
    password: String,
) -> Result<JoinResult, SyncDeviceError> {
    let password = Zeroizing::new(password);

    // 1. Set + TOFU-pin the endpoint (https) before any transport use.
    let fingerprint = sync_set_endpoint(app.clone(), Some(server_url))
        .await
        .map_err(|_| SyncDeviceError::NotConfigured)?
        .fingerprint;
    let cfg = read_config(&config_path(&app).map_err(|_| SyncDeviceError::Internal)?)
        .map_err(|_| SyncDeviceError::NotConfigured)?;
    let pins = config_pins(&cfg);
    let url = cfg.endpoint_url.ok_or(SyncDeviceError::NotConfigured)?;

    let account =
        parse_account_number(account_number.trim()).map_err(|_| SyncDeviceError::BadRequest)?;
    let account_hash = account.hash;
    let acct_hex = {
        let mut s = String::with_capacity(32);
        for b in &account_hash {
            s.push_str(&format!("{b:02x}"));
        }
        s
    };

    // 2. Fetch the account's vault.meta pre-auth (AEAD-protected — useless
    //    without the credential, the accepted A4-equivalent exposure).
    let url_fetch = url.clone();
    let pins_fetch = pins.clone();
    let acct_q = acct_hex.clone();
    let meta_bytes: Vec<u8> =
        tokio::task::spawn_blocking(move || -> Result<Vec<u8>, SyncDeviceError> {
            let transport = super::http_transport::build_transport(&url_fetch, pins_fetch)
                .map_err(|_| SyncDeviceError::Transport)?;
            let resp = transport
                .request(
                    super::transport::HttpMethod::Get,
                    &format!("/vault.meta?account={acct_q}"),
                    &[],
                    None,
                )
                .map_err(|_| SyncDeviceError::Transport)?;
            if resp.status != 200 {
                return Err(SyncDeviceError::DeviceNotFound); // no such account seeded
            }
            Ok(resp.body)
        })
        .await
        .map_err(|_| SyncDeviceError::Internal)??;
    parse_vault_meta(&meta_bytes).map_err(|_| SyncDeviceError::Internal)?; // must be real meta

    // 3. Mint a fresh local vault, write the fetched meta, and UNLOCK it (the
    //    normal password-unlock path derives root_key + items_key).
    let base = app
        .path()
        .app_data_dir()
        .map_err(|_| SyncDeviceError::Internal)?;
    let vault_id = crate::vault_registry::mint_unique_vault_id(&base);
    let vault_dir = crate::paths::vault_dir_for_id(&app, Some(vault_id))
        .map_err(|_| SyncDeviceError::Internal)?;
    let meta_path = vault_dir.join("vault.meta");
    crate::atomic_write::atomic_write(&meta_path, &meta_bytes, false)
        .map_err(|_| SyncDeviceError::Internal)?;
    crate::plugins::vault_unlock::commands::unlock_with_path(
        (*password).clone(),
        Some(vault_id),
        &meta_path,
        state.inner(),
    )
    .await
    .map_err(|_| SyncDeviceError::BadRequest)?; // wrong account# / password

    // 4. Register the verifier + SCRAM enroll (password → pending). The SCRAM
    //    secret is re-derived from the now-unlocked root_key (no credential reuse).
    let root_key = state
        .peek_unlocked_root_key_clone()
        .await
        .ok_or(SyncDeviceError::Internal)?;
    let approved = tokio::task::spawn_blocking(move || -> Result<bool, SyncDeviceError> {
        let transport = super::http_transport::build_transport(&url, pins)
            .map_err(|_| SyncDeviceError::Transport)?;
        let secret = derive_subkey(&root_key, SubkeyRole::ServerAuth);
        enroll::register_verifier(transport.as_ref(), &account_hash, secret.as_slice())
            .map_err(|_| SyncDeviceError::Transport)?;
        let device_id = enroll::generate_device_id();
        let mut nonce = [0u8; 16];
        getrandom::getrandom(&mut nonce).map_err(|_| SyncDeviceError::Internal)?;
        let mut client_nonce = String::with_capacity(32);
        for b in &nonce {
            client_nonce.push_str(&format!("{b:02x}"));
        }
        let out = enroll::enroll(
            transport.as_ref(),
            &account_hash,
            secret.as_slice(),
            EnrollPath::Password,
            &client_nonce,
            device_id,
        )
        .map_err(|_| SyncDeviceError::Unauthenticated)?;

        // Persist identity so the loop can claim the token after approval.
        let mut st = super::state::read_sync_state(&vault_dir).unwrap_or_default();
        st.account_hash_hex = Some(acct_hex);
        let mut dev_hex = String::with_capacity(32);
        for b in &device_id {
            dev_hex.push_str(&format!("{b:02x}"));
        }
        st.device_id_hex = Some(dev_hex);
        let _ = super::state::write_sync_state(&vault_dir, &st);
        if out.approved && !out.token.is_empty() {
            super::token_store::default_store()
                .store(&vault_dir, &out.token)
                .map_err(|_| SyncDeviceError::Internal)?;
        }
        Ok(out.approved)
    })
    .await
    .map_err(|_| SyncDeviceError::Internal)??;

    Ok(JoinResult {
        vault_id: vault_id.to_string(),
        pending: !approved,
        fingerprint,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn head_fingerprint_of_hex_matches_golden_vector() {
        // head-fingerprint/v0.1/all-zero golden: head_id = 0x00×32 → "TYRS-N318".
        // Proves the command's encoding delegates to the vector-locked primitive
        // verbatim (no re-derivation, one encoding — SYNC-17).
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
