// SPDX-License-Identifier: AGPL-3.0
//! The browser's sync tick driver (phase3-web-client task 84).
//!
//! # What this is, and what it deliberately is not
//!
//! It is the browser's counterpart of `loop_control::spawn_sync_loop` — but
//! only of that function's *glue*, not of its decisions. The
//! [`SyncScheduler`](myne_core::plugins::sync::loop_control::SyncScheduler) it
//! drives is the SAME state machine the desktop drives: the poll cadence, the
//! focus rate-limit, the push-coalescing window and the extend-only retry ladder
//! are privacy-load-bearing answers (`sync-protocol.md` §8.3, the A13 timing
//! posture), and a browser that re-derived them is how two clients end up
//! disclosing at two different granularities.
//!
//! So what lives here is exactly the part that genuinely differs between hosts:
//!
//! | desktop | here |
//! |---|---|
//! | `tokio::time::interval` | a JS timer calling [`sync_tick`] |
//! | `Manager::try_state` signal cells | [`sync_signal`], called from JS |
//! | `AppHandle`-driven cycle | `cycle::run_active_cycle_from_host` |
//!
//! # Why the tick arrives from JS rather than looping in here
//!
//! A `loop { sleep }` inside wasm would hold the Worker between ticks, and the
//! Worker is what answers every command. `setInterval` in the Worker's own event
//! loop costs nothing while idle and cannot starve a command — the same reason
//! `task::sleep`'s wasm arm yields instead of blocking.
//!
//! # The clock
//!
//! [`HostCtx::monotonic_millis`], never `Instant::now()` — which compiles for
//! `wasm32` and then panics. The scheduler takes its time as a parameter for
//! precisely this reason: it has no clock of its own to get wrong.

use myne_core::host::HostCtx;

/// The host seam this driver reads its clock from.
///
/// `NoopHost` on the host build — which is correct rather than a stub: that
/// build exists to type-check and to run `dispatched_names_match_the_router`,
/// and a scheduler ticking against a frozen clock simply decides `Idle`, which
/// is the honest answer when there is no browser to sync in.
#[cfg(target_arch = "wasm32")]
fn host() -> &'static dyn HostCtx {
    &crate::host::WebHost
}
#[cfg(not(target_arch = "wasm32"))]
fn host() -> &'static dyn HostCtx {
    &myne_core::host::NoopHost
}
use myne_core::plugins::sync::cycle::CycleOutcome;
use myne_core::plugins::sync::loop_control::{
    CycleResult, SyncAction, SyncScheduler, DEFAULT_COALESCE_WINDOW_MS, DEFAULT_POLL_INTERVAL_MS,
};
use std::cell::RefCell;

thread_local! {
    /// The Worker's single scheduler.
    ///
    /// `RefCell` rather than a lock: a dedicated Worker is single-threaded, so
    /// there is no contention to arbitrate — but there IS a re-entrancy hazard,
    /// because a cycle awaits. Every borrow below is therefore taken, used and
    /// dropped **without crossing an `.await`**; holding one across the cycle
    /// would panic the instance the first time a tick overlapped a signal.
    static SCHED: RefCell<SyncScheduler> = RefCell::new(SyncScheduler::new(
        0,
        DEFAULT_POLL_INTERVAL_MS,
        DEFAULT_COALESCE_WINDOW_MS,
    ));
    /// Previous tick's unlock state, for the locked→unlocked edge.
    static PREV_UNLOCKED: RefCell<bool> = const { RefCell::new(false) };
}

/// A device-local signal the scheduler reacts to, named on the JS side.
///
/// A closed set rather than one export per signal: they are all "tell the
/// scheduler something happened", and an unknown name is ignored rather than
/// trapping — a page that learns a new signal before the wasm does should degrade
/// to not-firing-it, not to a dead Worker (`panic = "abort"` makes every panic
/// terminal here).
/// The signal body, ungated so the host build compiles the module.
///
/// `pub` rather than `pub(crate)`: these two ARE this module's API — the
/// `#[wasm_bindgen]` wrappers are only the JS door onto them — and a
/// `pub(crate)` item with no host-side caller reads as dead code to clippy on
/// the lane where the wrappers are gated out.
///
/// Only the two `#[wasm_bindgen]` wrappers are `wasm32`-gated — the same split
/// `loop_control` uses, and for the same reason: everything except the JS
/// boundary is ordinary Rust, and gating the whole module would have put the
/// tick logic outside every host-side check while leaving the router's arm
/// referring to a module that is not there.
pub fn signal(kind: &str) {
    let now = host().monotonic_millis();
    SCHED.with(|s| {
        let mut s = s.borrow_mut();
        match kind {
            // A local note changed — starts the coalescing window (push).
            "local-change" => s.on_local_change(now),
            // The tab regained focus. Rate-limited inside the scheduler
            // (`FOCUS_POLL_FLOOR_MS`), so alt-tab flapping cannot become a
            // polling channel.
            "focus" => s.on_focus(now),
            // An SSE poke arrived (task 38 owns the `EventSource`; this is the
            // entry point it calls). Honored unconditionally per §8.3.
            "poke" => s.on_poke(),
            _ => {}
        }
    });
}

/// Fire the "a local change happened" signal from Rust.
///
/// [`sync_signal`] is the JS-facing door; this is the same door for callers
/// already inside wasm — today the enrolment command, which must trigger a
/// one-shot bootstrap push on approval (the desktop bumps a
/// `Manager::try_state` counter at that point). Kept as a named function rather
/// than a `sync_signal("local-change")` call so a Rust caller cannot typo the
/// string.
pub fn signal_local_change() {
    let now = host().monotonic_millis();
    SCHED.with(|s| s.borrow_mut().on_local_change(now));
}

/// One scheduler tick: decide, maybe run a cycle, feed the outcome back.
///
/// Returns the action taken as a short tag, for the Worker to log or surface —
/// `"idle"`, `"pull"`, `"push"`, `"pull-and-push"`. Returning it rather than
/// nothing is what makes the loop observable from a browser test without
/// exporting the scheduler's internals.
/// Everything the JS side needs to open the poke stream: the origin and this
/// device's token, as JSON. `null` when sync is not usable yet (no endpoint, or
/// no token because this device is not enrolled).
///
/// **Why the token crosses into JS at all**, since that looks like a widening:
/// it already does, on every single sync request. `web/src/worker/sync-transport.ts`
/// receives it in `headers_json` and puts it on the `Authorization` header,
/// because the transport IS JS. This adds no exposure — same Worker, same trust
/// domain, same credential — and the alternative (re-implementing the
/// double-buffered token read in TypeScript) would duplicate container logic
/// that has already bitten this project once.
/// See `entry::sync_poke_target`.
pub async fn poke_target() -> Option<String> {
    use myne_core::plugins::sync::token_store::TokenStore as _;
    let host = host();
    let io = crate::dispatch::vault_io();
    let state = crate::session::state();
    let cfg_path = myne_core::plugins::sync::config::config_path_from_host(host, io)
        .await
        .ok()?;
    let cfg = myne_core::plugins::sync::config::read_config(io, &cfg_path)
        .await
        .ok()?;
    let url = cfg.endpoint_url?;
    let dir = myne_core::paths::active_vault_root_io_from_host(host, state.active_vault_id().await)
        .ok()?;
    let token = myne_core::plugins::sync::token_store::default_store()
        .read(io, &dir)
        .await
        .ok()
        .flatten()?;
    let mut token_hex = String::with_capacity(token.len() * 2);
    for b in &token {
        token_hex.push_str(&format!("{b:02x}"));
    }
    serde_json::to_string(&serde_json::json!({
        "endpoint": url,
        "token": token_hex,
    }))
    .ok()
}

/// The tick body. See [`signal`] for why only the wrapper is gated.
pub async fn tick() -> String {
    let host = host();
    let now = host.monotonic_millis();
    let state = crate::session::state();
    // Unlock gate. `active_vault_id` is `Some` only for an Unlocked slot, which
    // is the same predicate the desktop loop uses.
    let unlocked = state.active_vault_id().await.is_some();

    // Up-path: drain any queued awareness frames through the shared ~100 ms
    // coalescer and POST one batch if a window is due, gated on the same unlock
    // predicate the down-stream reader runs under (`SYNC-30`). A no-op until the
    // editor bridge queues a frame, which is why it is safe to call on every
    // tick.
    if unlocked {
        crate::awareness::flush(now).await;
    }

    let action = SCHED.with(|s| {
        let mut s = s.borrow_mut();
        s.set_unlocked(unlocked);
        // Locked→unlocked edge (and a page that boots with a vault already
        // unlocked): sync immediately instead of waiting out the first full
        // interval — the same one-shot arm the desktop loop makes, so the
        // steady-state cadence is untouched.
        let edge = PREV_UNLOCKED.with(|p| {
            let mut p = p.borrow_mut();
            let edge = unlocked && !*p;
            *p = unlocked;
            edge
        });
        if edge {
            s.arm_immediate_poll();
        }
        // Mirror the verify hold into the scheduler, exactly as the shared
        // `spawn_sync_loop` does for the two Tauri clients.
        //
        // This client drives `SyncScheduler::tick` itself and was not wired, and
        // the consequence is the failure the mirror exists to prevent: `tick`
        // returns `Push`, CONSUMES `dirty_since`, the cycle then resolves
        // `PushGate::VerifyHold` and pushes nothing, reports `Success`, and
        // `on_cycle_outcome` re-arms the anchor only on `Failed`. The edit sits
        // unpushed until some unrelated local change re-dirties the scheduler.
        // Web is also the client that runs this ceremony hardest, because OPFS is
        // evictable and a re-bootstrap re-runs the compare.
        s.set_verify_hold(myne_core::plugins::sync::verify_hold::verify_hold().is_held(now));
        s.tick(now)
    });

    if action == SyncAction::Idle {
        return "idle".to_string();
    }
    let allow_push = matches!(action, SyncAction::Push | SyncAction::PullAndPush);

    // The borrow is dropped before this await — see the `SCHED` doc.
    let outcome = myne_core::plugins::sync::cycle::run_active_cycle_from_host(
        host,
        crate::dispatch::vault_io(),
        state,
        crate::session::hooks(),
        crate::session::live_sessions(),
        allow_push,
    )
    .await;

    // Re-read the clock: the cycle takes real time, and the failure gate + the
    // re-armed push anchor must be relative to its END, exactly as on desktop.
    let now_after = host.monotonic_millis();
    let result = match &outcome {
        CycleOutcome::Ran(_) => CycleResult::Success,
        CycleOutcome::Failed(class) => CycleResult::Failed(*class),
        CycleOutcome::NotReady | CycleOutcome::Disabled => CycleResult::Skipped,
    };
    SCHED.with(|s| s.borrow_mut().on_cycle_outcome(action, result, now_after));

    match action {
        SyncAction::Idle => "idle",
        SyncAction::Pull => "pull",
        SyncAction::Push => "push",
        SyncAction::PullAndPush => "pull-and-push",
    }
    .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Drive a future that must not suspend on the locked path.
    ///
    /// Shared with the router's tests, because the reason it re-polls rather
    /// than panicking on the first `Pending` is one they have in common: `tick`
    /// reads the process-wide slot map through an async `RwLock` that the
    /// router's tests take for writing in parallel. See `crate::test_support`.
    fn block_on<F: std::future::Future>(fut: F) -> F::Output {
        crate::test_support::block_on(fut, "sync_loop")
    }

    /// A LOCKED vault ticks to `Idle`, whatever signals arrived.
    ///
    /// The unlock gate, and the property worth a host test rather than only a
    /// browser probe: a locked client must not talk to the server at all. Signals
    /// are retained by the scheduler (a poke while locked is honored after
    /// unlock), but nothing fires while the gate is shut.
    #[test]
    fn a_locked_vault_never_leaves_idle() {
        signal("local-change");
        signal("poke");
        signal("focus");
        assert_eq!(block_on(tick()), "idle");
    }

    /// An unknown signal name is IGNORED, not a panic.
    ///
    /// `panic = "abort"` makes every panic terminal for the Worker, so a page
    /// that learns a new signal before the wasm does must degrade to
    /// not-firing-it rather than to a dead vault. Cheap to assert, and the kind
    /// of thing a future `match` arm could quietly turn into `unreachable!()`.
    #[test]
    fn an_unknown_signal_is_ignored() {
        signal("no-such-signal");
        signal("");
        assert_eq!(block_on(tick()), "idle");
    }
}
