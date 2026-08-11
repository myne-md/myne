// SPDX-License-Identifier: AGPL-3.0
//! How far through the whole-vault re-key is this device? (`protocol.md`
//! §10.4.1 point 2, myne-md/myne#441)
//!
//! §10.4.1 point 2 requires the migration to re-encrypt every note and singleton
//! "**emitting per-blob progress**". It emitted none — while the UI shipped a
//! `migrate.progress` testid rendering a constant string, so the surface existed
//! and reported nothing. On a large vault this is a multi-minute operation, and
//! the user watched a static line.
//!
//! # Why a cell rather than an event or a callback
//!
//! Deliberately the same shape as [`crate::plugins::sync::progress`], and for the
//! same reasons its module doc gives: the migration's on-disk pass takes no host
//! (so a test can drive it with no Tauri app), its CPU core runs inside a
//! `'static` blocking closure that cannot borrow one, and an event per blob would
//! be thousands of postMessages for a progress bar. Three atomics the loop stores
//! into and a command reads: no allocation, no lock, no await, cheap enough to
//! update per blob — which is what makes the number honest rather than
//! interpolated.
//!
//! # Counts, never a percentage or an ETA
//!
//! Also inherited, and here the reason is sharper than the sync case: a
//! migration's cost is dominated by four Argon2id derivations at
//! `m=256 MiB, t=3` whose duration varies by an order of magnitude across the
//! machines Myne runs on, and which happen BEFORE the per-note loop this counter
//! measures. Any ETA derived from note throughput would be wrong by that whole
//! prefix.

use core::sync::atomic::{AtomicU32, AtomicU64, Ordering};
use serde::Serialize;

/// Blobs re-encrypted so far in the current migration.
static DONE: AtomicU32 = AtomicU32::new(0);
/// Blobs this migration expects to re-encrypt. `0` when none is in flight.
static TOTAL: AtomicU32 = AtomicU32::new(0);
/// Bumped once per migration, so a reader can tell a finished run from a stale one.
static GENERATION: AtomicU64 = AtomicU64::new(0);

/// A migration-progress reading, as the UI sees it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct MigrationProgress {
    /// Blobs re-encrypted so far.
    pub done: u32,
    /// Blobs this migration expects. `0` means nothing is in flight.
    pub total: u32,
    /// Which migration this reading belongs to.
    pub generation: u64,
    /// `true` while a migration is in flight (`total > 0 && done < total`).
    pub active: bool,
}

/// Begin a migration of `total` blobs (notes + singletons).
///
/// A `total` of 0 is a no-op: an empty vault must not bump the generation, or a
/// UI watching for "a migration finished" would see one for a vault that had
/// nothing to migrate.
pub fn begin(total: u32) {
    if total == 0 {
        return;
    }
    DONE.store(0, Ordering::Relaxed);
    TOTAL.store(total, Ordering::Relaxed);
    GENERATION.fetch_add(1, Ordering::Relaxed);
}

/// One more blob is re-encrypted and on disk.
///
/// `Relaxed` throughout: a reader that observes a count one behind is showing a
/// number that was true a microsecond ago, and paying for stronger ordering per
/// blob on the path whose cost this exists to measure would be measuring the
/// instrument.
pub fn advance() {
    DONE.fetch_add(1, Ordering::Relaxed);
}

/// Mark the migration finished, whatever its outcome.
///
/// Called on the failure paths too. A migration that aborts must not leave a
/// reading that says a run is still in flight — the UI would show a stuck bar
/// with no way to learn otherwise.
pub fn finish() {
    TOTAL.store(0, Ordering::Relaxed);
    DONE.store(0, Ordering::Relaxed);
}

/// The current reading.
pub fn read() -> MigrationProgress {
    let done = DONE.load(Ordering::Relaxed);
    let total = TOTAL.load(Ordering::Relaxed);
    MigrationProgress {
        done,
        total,
        generation: GENERATION.load(Ordering::Relaxed),
        active: total > 0 && done < total,
    }
}

/// IPC command: read the migration's progress.
#[cfg(all(feature = "tauri-ipc", not(target_arch = "wasm32")))]
#[tauri::command]
pub async fn vault_migrate_progress() -> Result<MigrationProgress, ()> {
    Ok(read())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The three readings a UI has to be able to tell apart, and the one the
    /// sync twin's doc calls out: "about to start" is not "nothing to do", and
    /// neither is a stale reading from a run that ended.
    #[test]
    fn a_finished_run_does_not_read_as_one_in_flight() {
        begin(2);
        let started = read();
        assert!(started.active, "0 of 2 is a run about to do work");
        assert_eq!((started.done, started.total), (0, 2));

        advance();
        assert!(read().active, "1 of 2 is still in flight");

        // The failure path: finish() without every advance() must still clear.
        finish();
        let after = read();
        assert!(!after.active, "an aborted run must not read as in flight");
        assert_eq!(after.total, 0);
    }

    /// An empty vault must not look like a migration to a UI watching the
    /// generation counter.
    #[test]
    fn an_empty_migration_does_not_bump_the_generation() {
        let before = read().generation;
        begin(0);
        assert_eq!(read().generation, before);
    }
}
