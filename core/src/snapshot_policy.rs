// SPDX-License-Identifier: AGPL-3.0
//! Snapshot capture + retention policy for encrypted per-note version history
//! (MYND-96). Pure logic, no I/O — owned by the snapshot-format-retention layer
//! and called inline by the notes write-path (`should_snapshot`) and by the
//! `snapshot_prune` command (retention, added in a later task). Keeping the
//! policy here is the single source of truth so the eager write-path prune and
//! the manual prune command cannot drift (sync-ledger SYNC-2 / SYNC-3).
//!
//! Timestamps are milliseconds since the Unix epoch (UTC). A snapshot's capture
//! time is the time component of its UUIDv7 filename (`spec/protocol.md` §9.1);
//! the host extracts it and passes it here — this module never reads a clock
//! itself, which keeps it pure and unit-testable.

/// Minimum spacing between two snapshots of the same note during active editing
/// (sync-ledger SYNC-3). Autosave fires every 1–10 s; without coalescing a
/// snapshot-per-save would produce hundreds of near-identical blobs per hour.
/// Tunable: this is the single named source of the cadence.
pub const SNAPSHOT_COALESCE_INTERVAL_MS: u64 = 5 * 60 * 1000; // 5 minutes

/// Decide whether a snapshot of the *pre-edit* note content should be captured
/// on this save.
///
/// - `last_snapshot_at_ms` — capture time of the note's most recent snapshot, or
///   `None` if it has none yet.
/// - `now_ms` — current wall-clock time (host-injected; never read here).
/// - `force` — bypass the coalescing gate. Used by the editor-close / vault-lock
///   flush and by `snapshot_restore` (which always captures the pre-restore
///   state as its undo point, regardless of the window).
///
/// Pure: deterministic in its arguments, with no clock or filesystem access.
/// Clock skew (`now_ms < last`) is treated conservatively as "within the
/// window" (no snapshot) via saturating subtraction.
pub fn should_snapshot(last_snapshot_at_ms: Option<u64>, now_ms: u64, force: bool) -> bool {
    if force {
        return true;
    }
    match last_snapshot_at_ms {
        None => true, // first-ever snapshot for this note
        Some(last) => now_ms.saturating_sub(last) >= SNAPSHOT_COALESCE_INTERVAL_MS,
    }
}

/// Default retention window: snapshots older than this are pruned (sync-ledger
/// SYNC-2). The primary retention rule.
pub const RETENTION_WINDOW_MS: u64 = 7 * 24 * 60 * 60 * 1000; // 7 days

/// Safety backstop: max snapshots kept per note regardless of the window, to
/// bound pathological edit bursts. Never hit in normal use.
pub const RETENTION_MAX_COUNT: usize = 200;

/// Safety backstop: max total on-disk bytes of a note's snapshots, to bound a
/// large note revised many times. Never hit in normal use.
pub const RETENTION_MAX_TOTAL_BYTES: u64 = 256 * 1024 * 1024; // 256 MiB

/// The single, canonical retention policy. Consumed by both the eager
/// write-path prune (on snapshot create) and the manual `snapshot_prune`
/// command, so the two enforcement points cannot drift (SYNC-2).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RetentionPolicy {
    /// Primary rule: prune snapshots captured more than this many ms ago.
    pub window_ms: u64,
    /// Backstop: keep at most this many in-window snapshots (oldest pruned).
    pub max_count: usize,
    /// Backstop: keep in-window snapshots within this total byte budget
    /// (oldest pruned). The newest in-window snapshot is always kept even if it
    /// alone exceeds the budget.
    pub max_total_bytes: u64,
}

impl Default for RetentionPolicy {
    fn default() -> Self {
        Self {
            window_ms: RETENTION_WINDOW_MS,
            max_count: RETENTION_MAX_COUNT,
            max_total_bytes: RETENTION_MAX_TOTAL_BYTES,
        }
    }
}

/// One note snapshot, as seen by the retention policy. The caller derives
/// `captured_at_ms` from the snapshot's UUIDv7 filename and `size_bytes` from
/// the on-disk file — no decryption needed (SYNC-6 decrypt-free).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SnapshotEntry {
    pub captured_at_ms: u64,
    pub size_bytes: u64,
}

/// Select which of a note's snapshots to prune under `policy`, given the current
/// time. Returns indices into `entries` (the caller maps them back to filenames
/// and unlinks). Pure: deterministic, no I/O.
///
/// Rules, newest-first: (1) prune anything older than the window; (2) of the
/// in-window survivors, always keep the newest, then prune the oldest beyond the
/// count backstop or the total-size backstop. Keeping the newest in-window
/// snapshot unconditionally guarantees a single huge revision can't prune the
/// only recent version.
pub fn snapshots_to_prune(
    entries: &[SnapshotEntry],
    now_ms: u64,
    policy: &RetentionPolicy,
) -> Vec<usize> {
    // Walk newest-first so the count/size backstops drop the OLDEST excess.
    let mut order: Vec<usize> = (0..entries.len()).collect();
    order.sort_by_key(|&i| core::cmp::Reverse(entries[i].captured_at_ms));

    let window_floor = now_ms.saturating_sub(policy.window_ms);
    let mut prune = Vec::new();
    let mut kept = 0usize;
    let mut kept_bytes = 0u64;

    for &i in &order {
        let e = &entries[i];
        if e.captured_at_ms < window_floor {
            prune.push(i); // out of window — primary rule
            continue;
        }
        if kept == 0 {
            // Always keep the newest in-window snapshot, ignoring backstops.
            kept += 1;
            kept_bytes = kept_bytes.saturating_add(e.size_bytes);
            continue;
        }
        let over_count = kept >= policy.max_count;
        let over_size = kept_bytes.saturating_add(e.size_bytes) > policy.max_total_bytes;
        if over_count || over_size {
            prune.push(i);
        } else {
            kept += 1;
            kept_bytes = kept_bytes.saturating_add(e.size_bytes);
        }
    }
    prune.sort_unstable();
    prune
}

#[cfg(test)]
mod tests {
    use super::*;

    const T0: u64 = 1_700_000_000_000; // arbitrary fixed epoch-ms base
    const HOUR_MS: u64 = 60 * 60 * 1000;
    const DAY_MS: u64 = 24 * HOUR_MS;

    #[test]
    fn first_ever_snapshot_is_always_taken() {
        assert!(should_snapshot(None, T0, false));
    }

    #[test]
    fn within_coalescing_window_is_skipped() {
        let last = T0;
        let now = T0 + SNAPSHOT_COALESCE_INTERVAL_MS - 1; // one ms short of the gate
        assert!(!should_snapshot(Some(last), now, false));
    }

    #[test]
    fn exactly_at_window_boundary_is_taken() {
        let last = T0;
        let now = T0 + SNAPSHOT_COALESCE_INTERVAL_MS; // boundary is inclusive
        assert!(should_snapshot(Some(last), now, false));
    }

    #[test]
    fn well_outside_window_is_taken() {
        let last = T0;
        let now = T0 + SNAPSHOT_COALESCE_INTERVAL_MS * 3;
        assert!(should_snapshot(Some(last), now, false));
    }

    #[test]
    fn force_overrides_the_window() {
        // Even one ms after the last snapshot, force captures (restore undo point
        // / on-close flush must never be coalesced away).
        assert!(should_snapshot(Some(T0), T0 + 1, true));
        // Force also captures when there is no prior snapshot.
        assert!(should_snapshot(None, T0, true));
    }

    #[test]
    fn clock_skew_does_not_panic_and_is_conservative() {
        // now before last (clock moved backwards) → saturating_sub == 0 < interval
        // → treated as within-window (no snapshot), and never overflows.
        assert!(!should_snapshot(Some(T0), T0 - 5_000, false));
        // ...unless forced.
        assert!(should_snapshot(Some(T0), T0 - 5_000, true));
    }

    // --- retention / prune-selection ---

    fn e(captured_at_ms: u64, size_bytes: u64) -> SnapshotEntry {
        SnapshotEntry {
            captured_at_ms,
            size_bytes,
        }
    }

    fn roomy() -> RetentionPolicy {
        RetentionPolicy {
            window_ms: 7 * DAY_MS,
            max_count: 100,
            max_total_bytes: 1u64 << 30,
        }
    }

    #[test]
    fn defaults_match_constants() {
        let d = RetentionPolicy::default();
        assert_eq!(d.window_ms, RETENTION_WINDOW_MS);
        assert_eq!(d.window_ms, 7 * DAY_MS);
        assert_eq!(d.max_count, 200);
        assert_eq!(d.max_total_bytes, 256 * 1024 * 1024);
    }

    #[test]
    fn empty_input_prunes_nothing() {
        assert!(snapshots_to_prune(&[], T0, &RetentionPolicy::default()).is_empty());
    }

    #[test]
    fn all_in_window_under_backstops_keeps_everything() {
        let entries = [e(T0, 10), e(T0 - HOUR_MS, 10), e(T0 - 2 * HOUR_MS, 10)];
        assert!(snapshots_to_prune(&entries, T0, &roomy()).is_empty());
    }

    #[test]
    fn out_of_window_is_pruned_in_window_kept() {
        let entries = [
            e(T0 - 8 * DAY_MS, 10),  // idx 0 — older than the 7-day window
            e(T0 - DAY_MS, 10),      // idx 1 — in window
            e(T0 - 2 * HOUR_MS, 10), // idx 2 — in window
        ];
        assert_eq!(snapshots_to_prune(&entries, T0, &roomy()), vec![0]);
    }

    #[test]
    fn count_backstop_prunes_oldest_excess_unsorted_input() {
        let policy = RetentionPolicy {
            max_count: 3,
            ..roomy()
        };
        // Deliberately not in age order, to exercise the internal sort.
        let entries = [
            e(T0 - 4 * HOUR_MS, 10), // idx 0 — oldest
            e(T0, 10),               // idx 1 — newest
            e(T0 - 2 * HOUR_MS, 10), // idx 2
            e(T0 - HOUR_MS, 10),     // idx 3
            e(T0 - 3 * HOUR_MS, 10), // idx 4
        ];
        // Keep newest 3 (idx 1,3,2); prune the two oldest (idx 0,4).
        assert_eq!(snapshots_to_prune(&entries, T0, &policy), vec![0, 4]);
    }

    #[test]
    fn size_backstop_prunes_oldest_over_budget() {
        let policy = RetentionPolicy {
            max_total_bytes: 1000,
            ..roomy()
        };
        let entries = [
            e(T0, 400),               // idx 0 newest — kept (400)
            e(T0 - HOUR_MS, 400),     // idx 1 — 800 <= 1000, kept
            e(T0 - 2 * HOUR_MS, 400), // idx 2 — 1200 > 1000, pruned
        ];
        assert_eq!(snapshots_to_prune(&entries, T0, &policy), vec![2]);
    }

    #[test]
    fn newest_in_window_is_kept_even_if_it_alone_exceeds_size_cap() {
        let policy = RetentionPolicy {
            max_total_bytes: 1000,
            ..roomy()
        };
        let entries = [e(T0, 5000)];
        assert!(snapshots_to_prune(&entries, T0, &policy).is_empty());
    }

    #[test]
    fn window_and_count_backstop_combine() {
        let policy = RetentionPolicy {
            max_count: 2,
            ..roomy()
        };
        let entries = [
            e(T0 - 10 * DAY_MS, 10), // idx 0 — out of window
            e(T0, 10),               // idx 1 — newest, kept
            e(T0 - HOUR_MS, 10),     // idx 2 — kept (2nd)
            e(T0 - 2 * HOUR_MS, 10), // idx 3 — over count, pruned
        ];
        assert_eq!(snapshots_to_prune(&entries, T0, &policy), vec![0, 3]);
    }
}
