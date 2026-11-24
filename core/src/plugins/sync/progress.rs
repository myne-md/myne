// SPDX-License-Identifier: AGPL-3.0-only
//! How far through materialising a vault is this device? (phase3-web-client
//! task 39)
//!
//! # Why a cell and not an event or a callback
//!
//! `run_sync_cycle` takes no host — deliberately, so `sim.rs` can drive it with
//! no Tauri app — and every side-effect emit lives one layer up in `cycle.rs`,
//! off the finished summary. That shape is right for "a cycle happened" and
//! useless for "note 1 400 of 3 000", which has to be observable *during* the
//! loop.
//!
//! The alternatives were worse in specific ways. A host parameter threaded
//! through `run_sync_cycle` changes a signature every test and the simulator
//! call, for one readout. A callback closure is the same thing wearing a
//! different type. An event per note is 3 000 postMessages for a progress bar.
//!
//! So: three atomics the loop stores into and a command reads. No allocation, no
//! lock, no await — cheap enough to update per note, which is what makes the
//! number honest.
//!
//! # Why counts and never a percentage or an ETA
//!
//! The measured cost of first-run materialisation is roughly 1.9 s / 4.1 s /
//! 9.4 s for 3 000 notes on Safari / Chrome / Firefox, and 4.8 s / 12.6 s /
//! 29.9 s at 10 000 — a **6×** spread across engines at the same note count. Any
//! ETA computed from elapsed time would be wrong by that factor on the browser
//! the user happens to be running, and a progress bar that lies is worse than a
//! count that is merely coarse. `done` / `total` are facts.
//!
//! # The generation counter, and what it is for
//!
//! A reader needs to tell "0 of 3 000, about to start" from "0 of 0, nothing to
//! do" from a stale reading left by a cycle that ended. `generation` increments
//! once per cycle that materialises anything, so a UI can detect that the run it
//! was watching finished rather than inferring it from counts that happen to be
//! equal.

use core::sync::atomic::{AtomicU32, AtomicU64, Ordering};
use serde::Serialize;

/// Blobs written locally so far in the current materialisation run.
static DONE: AtomicU32 = AtomicU32::new(0);
/// Blobs the current run expects to write. `0` when nothing is in flight.
static TOTAL: AtomicU32 = AtomicU32::new(0);
/// Bumped once per run, so a reader can tell a finished run from a stale one.
static GENERATION: AtomicU64 = AtomicU64::new(0);

/// A materialisation-progress reading, as the UI sees it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct MaterialisationProgress {
    /// Blobs written locally so far.
    pub done: u32,
    /// Blobs this run expects. `0` means nothing is in flight.
    pub total: u32,
    /// Which run this reading belongs to.
    pub generation: u64,
    /// `true` while a run is in flight (`total > 0 && done < total`).
    pub active: bool,
}

/// Begin a run of `total` blobs. A `total` of 0 is a no-op — an empty pull must
/// not bump the generation, or a UI watching for "a run finished" would see one
/// on every idle poll cycle.
pub fn begin(total: u32) {
    if total == 0 {
        return;
    }
    DONE.store(0, Ordering::Relaxed);
    TOTAL.store(total, Ordering::Relaxed);
    GENERATION.fetch_add(1, Ordering::Relaxed);
}

/// One more blob is on disk.
///
/// `Relaxed` throughout: this is a progress readout, and a reader that observes
/// a count one behind is showing a number that was true a microsecond ago. Paying
/// for stronger ordering per note on the path whose cost this exists to measure
/// would be measuring the instrument.
pub fn advance() {
    DONE.fetch_add(1, Ordering::Relaxed);
}

/// End the run. Leaves `done`/`total` equal so a final reading is coherent
/// rather than snapping to zero — a UI that polled once more should see
/// "3 000 of 3 000", not "0 of 0" a beat after the last note appeared.
pub fn finish() {
    let total = TOTAL.load(Ordering::Relaxed);
    if total > 0 {
        DONE.store(total, Ordering::Relaxed);
    }
}

/// Read the current progress.
pub fn read() -> MaterialisationProgress {
    let done = DONE.load(Ordering::Relaxed);
    let total = TOTAL.load(Ordering::Relaxed);
    MaterialisationProgress {
        done,
        total,
        generation: GENERATION.load(Ordering::Relaxed),
        active: total > 0 && done < total,
    }
}

/// Test-only reset, so one test's run cannot leak into the next.
#[cfg(test)]
pub(crate) fn reset_for_test() {
    DONE.store(0, Ordering::Relaxed);
    TOTAL.store(0, Ordering::Relaxed);
    GENERATION.store(0, Ordering::Relaxed);
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Serialised: the cell is process-wide by design, so the tests that mutate
    /// it must not run concurrently with each other.
    static LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

    #[test]
    fn a_run_reports_counts_and_goes_inactive_when_complete() {
        let _g = LOCK.lock().unwrap();
        reset_for_test();
        begin(3);
        let p = read();
        assert_eq!((p.done, p.total, p.active), (0, 3, true));
        advance();
        advance();
        assert_eq!(read().done, 2);
        assert!(read().active, "still active at 2 of 3");
        advance();
        assert!(!read().active, "3 of 3 is not in flight");
    }

    /// The reading a UI polls just after the last note lands must be coherent.
    /// Snapping to `0 of 0` would render as a progress bar jumping back to empty
    /// at the exact moment it completed.
    #[test]
    fn finishing_leaves_a_coherent_final_reading() {
        let _g = LOCK.lock().unwrap();
        reset_for_test();
        begin(5);
        advance();
        finish();
        let p = read();
        assert_eq!((p.done, p.total), (5, 5));
        assert!(!p.active);
    }

    /// An empty pull must not look like a run. Otherwise every idle poll cycle
    /// bumps the generation and a UI watching for "a run finished" fires
    /// continuously while nothing is happening.
    #[test]
    fn an_empty_pull_is_not_a_run() {
        let _g = LOCK.lock().unwrap();
        reset_for_test();
        let before = read().generation;
        begin(0);
        let after = read();
        assert_eq!(after.generation, before, "an empty pull must not bump it");
        assert!(!after.active);
    }

    /// The generation is what lets a reader tell a NEW run from a stale reading
    /// whose counts happen to match.
    #[test]
    fn each_run_gets_its_own_generation() {
        let _g = LOCK.lock().unwrap();
        reset_for_test();
        begin(2);
        let first = read().generation;
        finish();
        begin(2);
        assert_ne!(read().generation, first);
    }
}
