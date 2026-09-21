//! "When did the CLI door last serve a command?" — session memory only
//! (cli-thin-client task 12; MYND-490).
//!
//! ## Why this is not a preference
//!
//! Settings shows a last-access line so a user can tell "nothing has used
//! this" apart from "something used it minutes ago". The obvious home for
//! that timestamp would be `vault.prefs` — and it is the wrong one: every
//! `myne` command would then rewrite, re-encrypt and re-sync the prefs blob,
//! so a `for id in $(myne list); do myne show $id; done` loop would turn a
//! read-only pass into hundreds of vault writes. The indicator is worth one
//! atomic in RAM and nothing more, so that is what it is: **never written to
//! disk, never synced, never in a backup.**
//!
//! ## Monotonic, not wall-clock
//!
//! The stored value is an [`Instant`], and what crosses IPC is an *age in
//! seconds*, not a timestamp. Two consequences, both deliberate: a system
//! clock that jumps cannot make "last used" read as the future or as days
//! ago, and no absolute time ever leaves this process — an age is a strictly
//! weaker fact than "the CLI ran at 14:02:11", which is the kind of value a
//! screenshot or a support log should not be able to carry.
//!
//! ## Cleared when the door closes
//!
//! [`LastAccess::clear`] runs from `super::socket::teardown`, so relocking the
//! vault — or turning the toggle off — resets the indicator. A stale age must
//! not outlive the open door it described: "last used 3 minutes ago" under a
//! vault that has since been locked and unlocked would describe a session the
//! user cannot see any more.
//!
//! ## One instance, passed explicitly
//!
//! There is no process global here, deliberately. The marker is created once in
//! `lib.rs`'s `setup`, handed to the lifecycle supervisor (which hands it to
//! every socket it opens) and read back by the `cli-bridge` command through
//! Tauri's managed state. A `static` would have been three fewer lines and
//! would have made every test that opens a socket mutate state every other test
//! can observe — the tests here and in `super::socket` assert exact ages, and
//! that only works when the instance under test is the test's own.
//!
//! See: src-tauri/AGENTS.md "Secret-handling logging discipline" — this
//! module holds one timestamp. It never sees a note id, a folder name, a
//! path or a body, and it logs nothing at all.

use std::sync::{Arc, Mutex};
use std::time::Instant;

/// The marker as it travels: `lib.rs` manages one, the supervisor clones it
/// into every socket it opens, and the `cli-bridge` command reads it back out
/// of Tauri's managed state.
pub type SharedLastAccess = Arc<LastAccess>;

/// The last moment the command socket finished serving a request, or `None`
/// for "not since the door opened".
#[derive(Debug, Default)]
pub struct LastAccess {
    at: Mutex<Option<Instant>>,
}

impl LastAccess {
    /// Record a served request at `now`.
    ///
    /// A poisoned lock is dropped silently: a missing last-access line is a
    /// cosmetic loss, and there is nothing here worth failing a CLI command
    /// over. (Nothing inside the critical section can panic, so this is a
    /// theoretical branch kept honest rather than an expected one.)
    pub fn record(&self, now: Instant) {
        if let Ok(mut slot) = self.at.lock() {
            *slot = Some(now);
        }
    }

    /// Forget the last access — the door just closed. See module docs.
    pub fn clear(&self) {
        if let Ok(mut slot) = self.at.lock() {
            *slot = None;
        }
    }

    /// Age of the last served request in whole seconds at `now`, or `None`
    /// when nothing has been served since the door opened.
    ///
    /// Saturating: a recorded instant that somehow sits in the future
    /// (an `Instant` cannot normally, but the arithmetic should not be the
    /// thing anyone has to trust) reads as `0` — "just now" — rather than
    /// panicking.
    pub fn elapsed_secs(&self, now: Instant) -> Option<u64> {
        let slot = self.at.lock().ok()?;
        let at = (*slot)?;
        Some(now.saturating_duration_since(at).as_secs())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    #[test]
    fn a_fresh_marker_reports_nothing() {
        let marker = LastAccess::default();
        assert_eq!(marker.elapsed_secs(Instant::now()), None);
    }

    #[test]
    fn a_recorded_access_ages_in_whole_seconds() {
        let marker = LastAccess::default();
        let t0 = Instant::now();
        marker.record(t0);
        assert_eq!(marker.elapsed_secs(t0), Some(0));
        assert_eq!(
            marker.elapsed_secs(t0 + Duration::from_millis(999)),
            Some(0)
        );
        assert_eq!(marker.elapsed_secs(t0 + Duration::from_secs(1)), Some(1));
        assert_eq!(
            marker.elapsed_secs(t0 + Duration::from_secs(7_200)),
            Some(7_200)
        );
    }

    #[test]
    fn the_newest_access_wins() {
        let marker = LastAccess::default();
        let t0 = Instant::now();
        marker.record(t0);
        marker.record(t0 + Duration::from_secs(60));
        // Aged from the SECOND record, not the first — the line says "last
        // used", so an earlier command must not keep it looking fresh or
        // stale.
        assert_eq!(marker.elapsed_secs(t0 + Duration::from_secs(90)), Some(30));
    }

    #[test]
    fn clear_resets_to_nothing() {
        let marker = LastAccess::default();
        let t0 = Instant::now();
        marker.record(t0);
        assert_eq!(marker.elapsed_secs(t0), Some(0));
        marker.clear();
        // This is the relock case: the age is gone, not frozen.
        assert_eq!(marker.elapsed_secs(t0 + Duration::from_secs(5)), None);
    }

    #[test]
    fn clear_is_idempotent_and_safe_before_any_access() {
        let marker = LastAccess::default();
        marker.clear();
        marker.clear();
        assert_eq!(marker.elapsed_secs(Instant::now()), None);
    }

    #[test]
    fn a_future_instant_reads_as_just_now_rather_than_panicking() {
        let marker = LastAccess::default();
        let t0 = Instant::now();
        marker.record(t0 + Duration::from_secs(30));
        assert_eq!(marker.elapsed_secs(t0), Some(0));
    }

    #[test]
    fn every_clone_of_the_shared_marker_sees_the_same_state() {
        // What makes the writer (a socket connection thread) and the reader
        // (the `cli-bridge` command, through managed state) agree without a
        // process global: they hold clones of one `Arc`.
        let a: SharedLastAccess = SharedLastAccess::default();
        let b = SharedLastAccess::clone(&a);
        let t0 = Instant::now();
        a.record(t0);
        assert_eq!(b.elapsed_secs(t0), Some(0));
        b.clear();
        assert_eq!(a.elapsed_secs(t0), None);
    }

    #[test]
    fn recording_is_visible_across_threads() {
        let marker = std::sync::Arc::new(LastAccess::default());
        let writer = std::sync::Arc::clone(&marker);
        let t0 = Instant::now();
        std::thread::spawn(move || writer.record(t0))
            .join()
            .expect("writer thread");
        // The connection thread that records is never the thread that reads.
        assert_eq!(marker.elapsed_secs(t0), Some(0));
    }
}
