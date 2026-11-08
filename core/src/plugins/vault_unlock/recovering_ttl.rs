// SPDX-License-Identifier: AGPL-3.0
//! The `Slot::Recovering` absolute TTL. This module owns the deadline and the
//! driver each client runs to enforce it (myne-md/myne#758, security-audit lead
//! NV09).
//!
//! # Why this is here rather than in the desktop crate
//!
//! `vault_recover_with_phrase` populates `Slot::Recovering` **in this crate**,
//! so all three clients can enter that state: desktop and mobile register the
//! command, and the browser reaches it through its dispatcher. The deadline that
//! bounds it, though, lived in `src-tauri/src/auto_lock.rs` next to the idle-lock
//! timer, and only the desktop tick ever called it. Measured on the audit's tree:
//! `take_recovering_if_expired` had zero callers under `mobile/` and zero under
//! `web/`, so on two clients a freshly recovered `root_key` + `items_key` stayed
//! resident with no deadline at all. That is the A6 exposure window the TTL
//! exists to close, and it was open on exactly the clients most likely to be
//! lost.
//!
//! The constant and the drop belong together and belong to the state, not to one
//! client's timer loop. What stays client-side is the TIMER, because only the
//! client knows how to schedule one: desktop polls inside its existing idle-lock
//! tick, mobile spawns [`spawn_recovering_ttl_timer`], and the browser is driven
//! by a JS interval calling its `vault_recovering_ttl_tick` export (the Worker
//! has no Rust timer, for the same reason `sync_loop` is JS-driven there).

use super::state::{Slot, VaultRuntimeState};

/// How long a `Slot::Recovering` may hold recovered key material before the
/// deadline drops it (MYND-121 stories 8/9).
///
/// ABSOLUTE from `recovered_at`, not activity-reset: a user cannot keep the
/// recovered `root_key` alive by moving the mouse. A transient-state deadline
/// rather than a preference, so it is immune to a replayed `vault.prefs` and
/// there is no value a disk-level attacker can write to widen it.
///
/// Moved here from `src-tauri/src/auto_lock.rs` by myne-md/myne#758 without a
/// change of value; `agent-tooling/design-notes/storage/0180` names it as unchanged policy.
pub const RECOVERING_TTL: core::time::Duration = core::time::Duration::from_secs(600);

/// How often a client's timer should call [`bail_if_expired`].
///
/// Five seconds, matching the desktop idle-lock poll: the deadline is a
/// comparison against a timestamp, so the tick only decides how promptly an
/// expired session is noticed, and a session that outlives its deadline by one
/// tick is bounded by the same order of magnitude as the deadline itself.
///
/// Private, and gated exactly like its only reader: the browser's copy lives in
/// `web/src/worker/worker.ts` as `VAULT_RECOVERING_TTL_TICK_MS` because a
/// `#[wasm_bindgen]` export cannot carry a `Duration`. A `pub` constant with one
/// in-module consumer would widen the crate's surface for nothing, and an
/// ungated private one is dead code on `wasm32`, which the `wasm-protocol` gate
/// fails under `-D warnings`.
#[cfg(all(feature = "tauri-ipc", not(target_arch = "wasm32")))]
const RECOVERING_TICK: core::time::Duration = core::time::Duration::from_secs(5);

/// One tick of the deadline: drop the recovery session if its age has reached
/// [`RECOVERING_TTL`]. Returns whether it bailed.
///
/// `now_ms` is a monotonic reading from the CALLER's host
/// ([`crate::host::HostCtx::monotonic_millis`]), so this function needs no host
/// and stays testable with an injected clock. A backwards clock step yields an
/// age of 0 through the `saturating_sub`, which DELAYS the bail rather than
/// firing it early. That is the safe direction for a guard whose whole job is to
/// drop key material.
///
/// `hooks` receives the same `lock_reset` screen-capture re-application the
/// manual `vault_lock` path applies (`commands::lock_from_host`), so the two
/// ways of leaving `Recovering` cannot diverge in what they leave on screen. The
/// slot is dropped HERE, inside the one function every client calls, because a
/// returned slot is a dropped-or-not decision each caller gets to get wrong.
pub async fn bail_if_expired(
    state: &VaultRuntimeState,
    now_ms: u64,
    hooks: &crate::hooks::Hooks,
) -> bool {
    let bailed = state
        .take_recovering_if_expired(RECOVERING_TTL, |recovered_at| {
            core::time::Duration::from_millis(now_ms.saturating_sub(recovered_at))
        })
        .await;
    let Some(prior) = bailed else {
        return false;
    };
    debug_assert!(matches!(prior, Slot::Recovering { .. }));
    tracing::info!(
        event = "vault_locked",
        from_slot_kind = "recovering",
        reason = "recovering_ttl",
        "auto-lock TTL expired the recovery session; root_key + items_key wipe on Drop"
    );
    // Leg 1 only: the recovery form has no open notes, so there is no plaintext
    // on screen to reload. Dropping the slot is the whole teardown; the
    // frontend's existing needs-active-session path answers the next command.
    drop(prior);
    hooks.apply_screen_capture(true, "lock_reset");
    true
}

/// Drive the deadline from a client's own timer.
///
/// Desktop does NOT need this: its idle-lock tick already runs every five
/// seconds and calls [`bail_if_expired`] directly, which keeps it a single
/// global loop (`agent-tooling/design-notes/storage/0180`). Mobile has no such loop, so this
/// is where it gets one, and the shape is the one `spawn_sync_loop` uses.
#[cfg(all(feature = "tauri-ipc", not(target_arch = "wasm32")))]
pub fn spawn_recovering_ttl_timer<R: tauri::Runtime>(app: tauri::AppHandle<R>) {
    use tauri::Manager;

    tauri::async_runtime::spawn(async move {
        let mut ticker = tokio::time::interval(RECOVERING_TICK);
        loop {
            ticker.tick().await;
            // Both handles are `try_state`: the timer is spawned during setup,
            // where either may legitimately be absent for a moment, and a
            // recovering slot can only exist once the unlock plugin has
            // registered its state.
            let Some(state) = app.try_state::<VaultRuntimeState>() else {
                continue;
            };
            let Some(hooks) = app.try_state::<crate::hooks::Hooks>() else {
                continue;
            };
            let now_ms = crate::host::HostCtx::monotonic_millis(
                &crate::host::tauri_host::TauriHost::new(app.clone()),
            );
            bail_if_expired(&state, now_ms, &hooks).await;
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::hooks::NoopHooks;
    use crate::plugins::vault_unlock::state::{RecoveringMaterial, SlotKind};
    use crate::vault_id::VaultId;

    /// The same current-thread runtime shape `state.rs`'s tests use: the crate
    /// carries tokio without its `macros` feature, so a `#[tokio::test]` would
    /// not resolve.
    fn rt() -> tokio::runtime::Runtime {
        tokio::runtime::Builder::new_current_thread()
            .build()
            .expect("runtime")
    }

    fn hooks() -> crate::hooks::Hooks {
        std::sync::Arc::new(NoopHooks)
    }

    fn vault_id() -> VaultId {
        crate::paths::legacy_vault_id()
    }

    fn material(recovered_at: u64) -> RecoveringMaterial {
        RecoveringMaterial {
            root_key: zeroize::Zeroizing::new([1u8; 32]),
            items_key: zeroize::Zeroizing::new([2u8; 32]),
            items_key_id: [3u8; 16],
            recovered_at,
        }
    }

    /// The boundary the deadline exists for: an age at the TTL drops the
    /// session, and the keys go with the slot.
    #[test]
    fn an_expired_recovering_slot_is_bailed() {
        rt().block_on(async {
            let state = VaultRuntimeState::default();
            let id = vault_id();
            state.set_recovering(id, material(1_000)).await;
            let bailed =
                bail_if_expired(&state, 1_000 + RECOVERING_TTL.as_millis() as u64, &hooks()).await;
            assert!(bailed, "an age at the TTL must bail");
            assert!(matches!(state.slot_kind(id).await, SlotKind::Empty));
        });
    }

    /// A session younger than the TTL stays: the deadline is absolute, not
    /// activity-reset, and it must not fire on a recovery the user is still
    /// completing.
    #[test]
    fn a_fresh_recovering_slot_is_left_alone() {
        rt().block_on(async {
            let state = VaultRuntimeState::default();
            let id = vault_id();
            state.set_recovering(id, material(1_000)).await;
            let bailed = bail_if_expired(&state, 1_000, &hooks()).await;
            assert!(!bailed, "a younger-than-TTL recovery must survive a tick");
            assert!(matches!(state.slot_kind(id).await, SlotKind::Recovering));
        });
    }

    /// A backwards clock step reports age 0 through `saturating_sub`, which
    /// delays the bail rather than firing it early.
    #[test]
    fn a_clock_that_went_backwards_does_not_bail() {
        rt().block_on(async {
            let state = VaultRuntimeState::default();
            let id = vault_id();
            state.set_recovering(id, material(10_000_000)).await;
            let bailed = bail_if_expired(&state, 5_000, &hooks()).await;
            assert!(!bailed, "a negative age must not be read as an expired one");
        });
    }
}
