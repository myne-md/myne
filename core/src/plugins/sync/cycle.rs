// SPDX-License-Identifier: AGPL-3.0
//! One orchestrated sync cycle: gathering its inputs, running it, and the side
//! effects that follow (MYND-424).
//!
//! **Lifted out of the host-gated `commands.rs`** (phase3-web-client task 84).
//! Almost nothing here was host-shaped — the gather reads the endpoint config,
//! the enrolment identity, the unlocked keys and the device token, all of which
//! are already on seams — and what little was is now expressed through them:
//!
//! * `AppHandle` → [`crate::host::HostCtx`] + the runtime state, passed in.
//! * `app.emit(...)` → `host.emit(...)`. The four events this fires
//!   (`sync://reconcile-started` / `-finished`, `sync://integrity-alert`,
//!   `sync://changed`) are exactly the shape the seam's `EventPayload` models:
//!   unit or a count, never a title or a path.
//! * `spawn_blocking` + `Handle::current().block_on` →
//!   [`crate::task::run_blocking`], which is `spawn_blocking` natively and
//!   INLINE on wasm. **Desktop scheduling is preserved rather than
//!   approximated**: the transport is blocking by design (task 35), so the
//!   native arm still parks a blocking thread on the round trip instead of an
//!   executor worker, and the browser still blocks the Worker it is supposed to
//!   block.
//!
//! The process-wide cycle mutex moved with it, and that matters more than it
//! looks: `run_sync_cycle` is a read-modify-write over `sync-state.json`,
//! staging and tombstones with no other guard, so two overlapping cycles
//! lost-update each other's cursor and baseline — and a dropped tombstone
//! revives a deleted note on another device. One serializer, shared by both
//! clients, is the only way that property holds on either.

use super::config::{config_pins, read_config};
use super::devices::hex16;
use super::enroll::{self, EnrollPath};
use super::token_store::TokenStore as _;
use crate::host::{EventPayload, HostCtx};
use crate::plugins::vault_unlock::state::VaultRuntimeState;
use protocol::{derive_subkey, SubkeyRole, AEAD_KEY_LEN};
use std::sync::OnceLock;
use tokio::sync::Mutex;
use zeroize::Zeroizing;

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
pub(crate) fn classify_cycle_error(
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
        // Task 94. Same park on every client; a DIFFERENT thing to say, and on
        // web a different thing to do — which is why it does not fold into the
        // arm above even though its retry delay is identical.
        SyncCycleError::Pull(PullError::DeviceRevoked)
        | SyncCycleError::Push(PushError::DeviceRevoked) => FailureClass::DeviceRevoked,
        // Refusal classes that must reach the UI as themselves, never as the
        // generic "sync failed" (MYND-570). Push-only by construction: a frozen
        // or over-quota account still PULLS ("frozen is minimal").
        SyncCycleError::Push(PushError::QuotaExceeded) => FailureClass::QuotaExceeded,
        SyncCycleError::Push(PushError::PayloadTooLarge) => FailureClass::PayloadTooLarge,
        SyncCycleError::Push(PushError::Frozen) => FailureClass::Frozen,
        SyncCycleError::Pull(PullError::Transport(_))
        | SyncCycleError::Push(PushError::Transport(_)) => FailureClass::Transport,
        // The LOCAL store, not the server's ceiling (task 91). Parks like a 507
        // because retrying cannot help until someone frees something — but the
        // sentence to the user is different, and only this one is fixable here.
        SyncCycleError::StorageFull => FailureClass::StorageFull,
        _ => FailureClass::Other,
    }
}

/// A still-`pending` device claims its token by re-running the SCRAM handshake
/// under the unlocked `root_key` (the verifier is already registered). Returns
/// the token once an existing device has approved this one, else `None` (still
/// pending / unreachable). Stores the token device-local on success.
pub(crate) async fn try_claim_token(
    io: &dyn crate::vault_io::VaultIo,
    url: String,
    pins: Vec<[u8; 32]>,
    dir: std::path::PathBuf,
    root_key: Zeroizing<[u8; AEAD_KEY_LEN]>,
    account_hash: [u8; 16],
    device_id: [u8; 16],
) -> Option<Vec<u8>> {
    let token = crate::task::run_blocking(move || {
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
            Some(out.token)
        } else {
            None // still pending approval
        }
    })
    .await
    .ok()
    .flatten()?;
    // The token WRITE moved out of the blocking closure (phase3-web-client task
    // 86): `TokenStore` is async now, because a browser-backed store has no
    // synchronous implementation to write. The network handshake above is what
    // belongs on the blocking pool; persisting one short line does not, and the
    // seam's native arm dispatches its own blocking anyway.
    super::token_store::default_store()
        .store(io, &dir, &token)
        .await
        .ok()?;
    Some(token)
}

/// Process-wide async lock serializing EVERY sync-cycle entry against every
/// other cycle AND against [`sync_reset_local`]. Phase 1 has exactly one active
/// unlocked vault, so a single mutex is a correct per-vault serializer (a future
/// multi-vault design would key it by vault id). Same `OnceLock<Mutex<()>>` shape
/// as `attachments::catalog_write_mutex`.
pub(crate) fn sync_cycle_mutex() -> &'static Mutex<()> {
    static M: OnceLock<Mutex<()>> = OnceLock::new();
    M.get_or_init(|| Mutex::new(()))
}

/// Gather the active vault's sync inputs (endpoint, enrollment identity, token,
/// `root_key`) and run one [`run_sync_cycle`](super::orchestrator::run_sync_cycle)
/// off-thread. `allow_push=false` is a poll-driven pull-only cycle (coalescing —
/// see `loop_control`); `true` also pushes pending local changes. Used by both
/// the `sync_now` command and the background loop, so the gathering lives once.
/// `io` is `&'static` deliberately, and it is the one signature quirk here.
///
/// The cycle's IO has to cross into the closure `task::run_blocking_future`
/// hands to the blocking pool, which is `Send + 'static`; a borrowed
/// `&dyn VaultIo` cannot. Every implementation is a unit struct
/// (`StdVaultIo`, `OpfsVaultIo`), so `&'static` costs nothing real — and it is
/// far better than the alternative this replaced, which was hardcoding
/// `StdVaultIo` inside the closure. That compiled on both targets and would have
/// pointed a browser at a filesystem that is not there.
pub async fn run_active_cycle_from_host(
    host: &dyn HostCtx,
    io: &'static dyn crate::vault_io::VaultIo,
    state: &VaultRuntimeState,
    allow_push: bool,
) -> CycleOutcome {
    // Serialize with any concurrent cycle + sync_reset_local: run_sync_cycle is a
    // read-modify-write on sync-state.json / staging / tombstones with no other
    // guard, so two overlapping cycles (a double "Sync now", or a click coinciding
    // with a poll tick) lost-update each other's cursor/baseline — and a dropped
    // tombstone revives a deleted note elsewhere. Held across the whole gather +
    // spawn_blocking so the token claim is serialized too.
    let _cycle_guard = sync_cycle_mutex().lock().await;
    let Ok(cfg) = async {
        let p = super::config::config_path_from_host(host, io).await?;
        read_config(io, &p).await
    }
    .await
    else {
        return CycleOutcome::Failed(super::loop_control::FailureClass::Other);
    };
    let pins = config_pins(&cfg);
    let Some(url) = cfg.endpoint_url else {
        return CycleOutcome::Disabled;
    };
    let Ok(dir) = crate::paths::active_vault_root_io_from_host(host, state.active_vault_id().await)
    else {
        return CycleOutcome::NotReady;
    };
    // An unreadable state is NOT "not enrolled" (task 86). Both arms decline to
    // run a cycle, so the immediate behaviour matches — but `NotReady` is the
    // quiet, expected answer the loop sees on every tick before enrolment, and
    // reporting it here would bury a corrupt file under normal traffic. A device
    // whose sync silently stopped, with nothing in the log saying why, is the
    // failure this distinction exists to prevent.
    let st = match super::state::read_sync_state(io, &dir).await {
        Ok(st) => st,
        Err(_) => {
            tracing::error!(
                stage = "read_sync_state",
                "sync-state.json unreadable; cycle refused (this is NOT the pre-enrolment path)"
            );
            return CycleOutcome::Failed(super::loop_control::FailureClass::Other);
        }
    };
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
    let token = match super::token_store::default_store().read(io, &dir).await {
        Ok(Some(t)) => t,
        _ => {
            match try_claim_token(
                io,
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

    let res = crate::task::run_blocking_future(move || async move {
        // A transport that cannot even be built is a Transport-class failure
        // (same retry posture as an unreachable socket).
        let transport = super::http_transport::build_transport(&url, pins).map_err(|e| {
            super::orchestrator::SyncCycleError::Pull(super::engine::PullError::Transport(e))
        })?;
        // The full `SyncCycleError` crosses the spawn_blocking boundary intact —
        // the integrity verdict (SYNC-10) and the scheduler's retry class are
        // both derived from it on the other side.
        // `run_sync_cycle` became `async` with phase3-web-client task 86 (its
        // sidecar IO is on the storage seam, and the seam is async because OPFS
        // handle acquisition is). It is driven HERE, on the blocking thread,
        // rather than awaited on an executor worker — and that is a deliberate
        // preservation rather than a workaround.
        //
        // The cycle's transport is BLOCKING by design (task 35: `SyncTransport`
        // is a synchronous trait, and the browser satisfies it with synchronous
        // XHR in a dedicated Worker). Awaiting the cycle on an async worker would
        // therefore park a tokio worker thread on a network round trip — up to
        // the transport's 60 s deadline — where today it parks a blocking thread
        // that exists for exactly that. `block_on` inside `spawn_blocking` is the
        // documented way to run async work from a blocking context, and it keeps
        // the desktop's scheduling property byte-identical across this port.
        super::orchestrator::run_sync_cycle(
            io,
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
        .await
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
                host.emit("sync://reconcile-started", EventPayload::Unit);
                host.emit("sync://reconcile-finished", EventPayload::Unit);
            }
            if summary.credential_ambiguous {
                // The meta phase refused to adopt because the two `vault.meta`
                // copies disagree on the password-side wrap and nothing says
                // which side moved (task 88). Published as an ERROR status even
                // though the cycle itself succeeded, and that is the point:
                // refusing is a permanent stall — every later cycle re-refuses —
                // so a user who is told nothing has no way to act, and the
                // silence would trade a silent password revert for a silent
                // freeze.
                //
                // A bounded detail tag, like every other status detail, so the
                // UI keys off a label rather than parsing prose.
                // The `emit` seam, matching the reconcile bracket above rather
                // than the status CELL — the cell is `Manager`-shaped and the
                // browser passes `None` for it, so a status-cell write would be
                // silent on exactly the client that most needs the warning.
                host.emit("sync://credential-ambiguous", EventPayload::Unit);
            }
            if summary.prefs_applied_remote {
                // A remote prefs change was merged onto disk this cycle
                // (MYND-478): refresh the switcher-facing RAM caches, then tell
                // the WebView to re-read (the same disk→cache→event choreography
                // as a local setter; the orchestrator stays AppHandle-free so
                // the side effects live at this boundary).
                if let Ok(view) =
                    crate::plugins::prefs::commands::prefs_read_with_dir(&dir_for_prefs, state, io)
                        .await
                {
                    if let Some(active) = state.active_vault_id().await {
                        state.set_cached_label(active, view.label.clone()).await;
                        state.set_cached_icon(active, view.icon.clone()).await;
                    }
                }
                host.emit(
                    crate::plugins::prefs::commands::PREFS_CHANGED_EVENT,
                    EventPayload::Unit,
                );
            }
            CycleOutcome::Ran(summary)
        }
        Ok(Err(e)) => {
            if matches!(&e, super::orchestrator::SyncCycleError::Pull(pe)
                if super::integrity::pull_error_is_integrity_failure(pe))
            {
                // Hard, honest integrity alert (rollback / non-extending head).
                // Copy is the pinned `SYNC_INTEGRITY_ALERT` literal on the UI side.
                host.emit("sync://integrity-alert", EventPayload::Unit);
            }
            CycleOutcome::Failed(classify_cycle_error(&e))
        }
        // Join error — no class information survives a panicked task.
        Err(_) => CycleOutcome::Failed(super::loop_control::FailureClass::Other),
    }
}

/// Run one cycle NOW (the manual "Sync now" button) and report the resulting
/// status.
///
/// Moved here with the cycle (task 84) because the mapping from a
/// [`CycleOutcome`] to a status is a correctness rule rather than glue: a
/// `NotReady` outcome must NOT collapse into `Idle`. Reporting "Synced" for a
/// device that cannot sync is the exact dishonesty the status derivation exists
/// to prevent, and clicking "Sync now" on an unenrolled device would otherwise
/// flip the dot to green. Only a genuine `Ran` is `Idle`.
pub async fn sync_now_from_host(
    host: &dyn HostCtx,
    io: &'static dyn crate::vault_io::VaultIo,
    state: &VaultRuntimeState,
) -> super::status::SyncRuntimeStatus {
    use super::status::SyncRuntimeStatus;
    match run_active_cycle_from_host(host, io, state, true).await {
        CycleOutcome::Disabled => SyncRuntimeStatus::Disabled,
        // `NotReady` is one outcome covering three situations — locked vault,
        // never enrolled, and enrolled-but-awaiting-approval. Answering
        // `NotEnrolled` for all three made this command contradict
        // `sync_status`, which reports `Pending` for the third (MYND-635). Ask
        // the one derivation instead of hard-coding a second opinion; it can
        // only return `Pending` or `NotEnrolled`, so the `Ran`-only-`Idle` rule
        // above still holds.
        CycleOutcome::NotReady => super::status::not_ready_reason(host, io, state).await,
        CycleOutcome::Ran(summary) => {
            if summary.pulled > 0 || summary.dropped > 0 {
                // A manual sync pulled notes to disk (or reconcile quarantined
                // absentees) — mirror the loop's refresh nudge so the UI
                // reloads. The loop emits the same event on its own cycles;
                // this covers the manual path on top of it.
                host.emit("sync://changed", EventPayload::Count(summary.pulled as u32));
            }
            SyncRuntimeStatus::Idle
        }
        CycleOutcome::Failed(class) => SyncRuntimeStatus::Error {
            detail: class.status_detail().into(),
        },
    }
}

/// Push the on-disk `vault.meta` to the server right now (F1; the io-seam
/// version, phase3-web-client task 41).
///
/// # Why this moved out of the host-gated `commands` module
///
/// `commands.rs` does not compile for `wasm32`, so this function — the one that
/// makes a credential change reach the server — was unreachable from the browser.
/// That is precisely the failure task 88 describes: a web password change that
/// stays local, whose evidence (`vault.meta-dirty` + `meta_baseline_hex`) then
/// evaporates with the OPFS container, after which the meta phase adopts the
/// server's older copy and the new password silently stops working.
///
/// # Best-effort, and the two "false" cases are different
///
/// A not-ready state (sync disabled, no token, no vault) is a silent `false`
/// with **no dirty marker** — nothing changed, so there is nothing to remember.
/// A transport failure is a `false` **with** the marker, so the meta phase
/// retries. Callers that need "the server has it" must use the return value;
/// `true` means the `PUT` was accepted.
pub async fn push_vault_meta_now_via_io(
    host: &dyn crate::host::HostCtx,
    io: &dyn crate::vault_io::VaultIo,
    state: &crate::plugins::vault_unlock::state::VaultRuntimeState,
) -> bool {
    // Serialize with cycles / reset — same guard run_active_cycle uses, so a push
    // never races the loop's own meta read-modify-write.
    let _cycle_guard = super::cycle::sync_cycle_mutex().lock().await;
    let Ok(cfg) = async {
        let p = crate::plugins::sync::config::config_path_from_host(host, io).await?;
        crate::plugins::sync::config::read_config(io, &p).await
    }
    .await
    else {
        return false;
    };
    let pins = crate::plugins::sync::config::config_pins(&cfg);
    let Some(url) = cfg.endpoint_url else {
        return false; // sync disabled
    };
    let Ok(dir) = crate::paths::active_vault_root_io_from_host(host, state.active_vault_id().await)
    else {
        return false;
    };
    // Stored per-device token only. A still-pending device no-ops (its meta is
    // seeded when enrollment completes), and does NOT get marked dirty.
    let token = match crate::plugins::sync::token_store::default_store()
        .read(io, &dir)
        .await
    {
        Ok(Some(t)) => t,
        _ => return false,
    };
    // Through the seam, like every other read on this path (task 87). It was the
    // last `std::fs` call in the production half of this file — and it sat on the
    // meta-push path, which a browser reaches whenever a credential changes.
    let meta_read = { io.read(&dir.join("vault.meta")).await };
    let Ok(meta_bytes) = meta_read else {
        return false;
    };
    let mut token_hex = String::with_capacity(token.len() * 2);
    for b in &token {
        token_hex.push_str(&format!("{b:02x}"));
    }
    let url_moved = url.clone();
    // `run_blocking`, not `spawn_blocking`: the native arm dispatches to a tokio
    // worker so a round trip does not park one, and the wasm arm runs inline —
    // which IS the design there, since the browser transport is synchronous XHR
    // in a dedicated Worker (task 35).
    let res = crate::task::run_blocking(move || {
        let transport = crate::plugins::sync::http_transport::build_transport(&url_moved, pins)
            .map_err(|_| ())?;
        crate::plugins::sync::enroll::put_vault_meta(transport.as_ref(), &token_hex, &meta_bytes)
            .map_err(|_| ())
    })
    .await;
    match res {
        Ok(Ok(())) => {
            // Pushed — the local change reached the server; clear any prior dirt.
            let _ = crate::plugins::sync::state::clear_vault_meta_dirty(io, &dir).await;
            true
        }
        _ => {
            // Offline / transport / join error: remember to push later (Faz B).
            let _ = crate::plugins::sync::state::mark_vault_meta_dirty(io, &dir).await;
            false
        }
    }
}
