//! A short, renewable lease that DEFERS the idle auto-lock while an import runs.
//!
//! # Why a running import needs one
//!
//! `auto_lock.rs`'s timer branches on `SlotKind` and nothing else, so an open
//! import modal is invisible to it. Importing a large vault takes far longer
//! than the 300 s default, and the machine is genuinely idle throughout — the
//! user is watching a progress bar, not typing. The vault locked mid-run, the
//! WebView reload outran the error screen, and the user was left at the unlock
//! screen with a half-finished import (myne-md/myne#223).
//!
//! # Why this is NOT `report_activity`
//!
//! Resetting the idle clock is exactly what the CLI bridge is forbidden from
//! doing, and for a good reason: a background channel that keeps the clock
//! fresh can hold a vault open indefinitely, which pierces A6. That test
//! (`cli_bridge/socket.rs::socket_traffic_never_touches_the_auto_lock_activity_clock`)
//! still holds — nothing here touches `last_activity_millis`.
//!
//! The lease **defers** the decision instead of resetting the clock, and the
//! difference is the whole security argument: idle keeps accumulating while the
//! import runs, so the moment the lease lapses the very next tick sees an idle
//! far past the timeout and locks. An import postpones the lock; it cannot
//! cancel one the user has actually earned by walking away.
//!
//! Two more bounds fall out of the shape: the lease is short, so a WebView that
//! dies mid-import stops renewing and the vault locks within a minute; and it
//! is desktop-only and plugin-scoped, so nothing outside this seam can take it.

use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::State;

/// How long one `import_set_hold(true)` defers the lock. The frontend renews
/// well inside this while an import is running, so the value is a CEILING on
/// how long a dead WebView can hold the lock off — not an expected duration.
const LEASE: Duration = Duration::from_secs(60);

/// The deadline the auto-lock timer honours, or `None` when no import is
/// running. Managed by the `importer` plugin, read by `auto_lock.rs`.
#[derive(Default)]
pub struct ImportHold {
    until: Mutex<Option<Instant>>,
}

impl ImportHold {
    fn set(&self, value: Option<Instant>) {
        // A panic in another holder must not wedge the lock forever: recovering
        // the guard fails OPEN toward locking (the worst case is a stale
        // deadline that expires within `LEASE`), never toward holding it.
        *self.until.lock().unwrap_or_else(|e| e.into_inner()) = value;
    }

    /// Is an import currently holding the lock off?
    pub fn is_held(&self) -> bool {
        let until = *self.until.lock().unwrap_or_else(|e| e.into_inner());
        until.is_some_and(|deadline| Instant::now() < deadline)
    }
}

/// Take or drop the import lease. `active = true` renews it for `LEASE`;
/// `active = false` drops it immediately, so a finished import does not leave
/// the lock deferred for the remainder of the window.
#[tauri::command]
pub fn import_set_hold(active: bool, hold: State<'_, ImportHold>) {
    hold.set(active.then(|| Instant::now() + LEASE));
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_fresh_hold_is_not_held() {
        assert!(!ImportHold::default().is_held());
    }

    #[test]
    fn taking_the_lease_defers_and_releasing_it_stops_deferring() {
        let hold = ImportHold::default();
        hold.set(Some(Instant::now() + LEASE));
        assert!(hold.is_held());
        hold.set(None);
        assert!(!hold.is_held());
    }

    #[test]
    fn an_expired_lease_no_longer_defers() {
        // The ceiling is what bounds a WebView that stopped renewing: no
        // release call is needed for the vault to become lockable again.
        let hold = ImportHold::default();
        hold.set(Some(Instant::now() - Duration::from_secs(1)));
        assert!(!hold.is_held());
    }
}
