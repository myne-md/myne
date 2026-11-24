// SPDX-License-Identifier: AGPL-3.0-only
//! Cross-read VV-convergence tracker (MYND-427 task 1; SYNC-10 + SYNC-12).
//!
//! A fork is distinguished from mere concurrency by **convergence over time**
//! (`sync-protocol.md` §5): two devices that author incomparable heads are
//! *concurrent* if a later head re-converges them (a merge dominates both); they
//! are a **fork** if their incomparable histories **never** re-converge.
//!
//! This consumes the engine's `vv_dominance` verdicts over the device-local
//! VV-observation log (the `(head_id, VV)` sequence `state.rs` records) — it does
//! NOT re-derive dominance (SYNC-10: the engine owns the §5.3 comparison). It
//! only reads the log and renders the convergence verdict the MYND-427 UI shows.

use protocol::{vv_dominance, Dominance, VvEntry};

/// The convergence verdict over a VV-observation log.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ConvergenceVerdict {
    /// All observed heads are linearly related (each extends the prior). No fork.
    Converging,
    /// Incomparable heads were seen but a later head re-converged them (a merge
    /// dominated both branches) → ordinary concurrency, resolved by keep-both.
    Concurrency,
    /// Incomparable heads that NEVER re-converged across the log → a fork: a
    /// device's accepted head is never an ancestor of what another later reads.
    /// Surfaces the §6 out-of-band fingerprint advisory (possible malicious server).
    Fork,
}

/// `true` when `candidate` strictly dominates `baseline` (the §5.3 Extension
/// case — a merge head dominates each parent this way).
fn dominates(baseline: &[VvEntry], candidate: &[VvEntry]) -> bool {
    matches!(vv_dominance(baseline, candidate), Dominance::Extension)
}

/// Classify a VV-observation log (oldest→newest) into a convergence verdict.
///
/// Algorithm: for every incomparable pair `(a, b)` in the log, check whether any
/// **later** observation dominates BOTH (re-convergence). If any incomparable
/// pair is never re-converged, the verdict is [`ConvergenceVerdict::Fork`]; if
/// every incomparable pair re-converged, [`ConvergenceVerdict::Concurrency`]; if
/// no incomparable pair exists at all, [`ConvergenceVerdict::Converging`].
pub fn classify_convergence(log: &[Vec<VvEntry>]) -> ConvergenceVerdict {
    let mut saw_incomparable = false;

    for i in 0..log.len() {
        for j in (i + 1)..log.len() {
            if vv_dominance(&log[i], &log[j]) != Dominance::Incomparable {
                continue;
            }
            saw_incomparable = true;
            // Is there a later observation dominating both branches?
            let reconverged = log[(j + 1)..]
                .iter()
                .any(|later| dominates(&log[i], later) && dominates(&log[j], later));
            if !reconverged {
                return ConvergenceVerdict::Fork;
            }
        }
    }

    if saw_incomparable {
        ConvergenceVerdict::Concurrency
    } else {
        ConvergenceVerdict::Converging
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn vv(pairs: &[(u8, u64)]) -> Vec<VvEntry> {
        pairs
            .iter()
            .map(|&(d, c)| VvEntry {
                device_id: [d; 16],
                counter: c,
            })
            .collect()
    }

    #[test]
    fn linear_log_is_converging() {
        let log = vec![vv(&[(0xA1, 1)]), vv(&[(0xA1, 2)]), vv(&[(0xA1, 3)])];
        assert_eq!(classify_convergence(&log), ConvergenceVerdict::Converging);
    }

    #[test]
    fn incomparable_then_merge_is_concurrency() {
        // A:2,B:1 and A:1,B:2 are incomparable; A:2,B:2 dominates both (the merge).
        let log = vec![
            vv(&[(0xA1, 2), (0xB2, 1)]),
            vv(&[(0xA1, 1), (0xB2, 2)]),
            vv(&[(0xA1, 2), (0xB2, 2)]),
        ];
        assert_eq!(classify_convergence(&log), ConvergenceVerdict::Concurrency);
    }

    #[test]
    fn incomparable_never_reconverging_is_fork() {
        // Two branches that diverge and never merge — a later head extends only
        // one branch, never dominating both.
        let log = vec![
            vv(&[(0xA1, 2), (0xB2, 1)]),
            vv(&[(0xA1, 1), (0xB2, 2)]),
            vv(&[(0xA1, 3), (0xB2, 1)]), // extends branch A only
        ];
        assert_eq!(classify_convergence(&log), ConvergenceVerdict::Fork);
    }

    #[test]
    fn empty_or_single_is_converging() {
        assert_eq!(classify_convergence(&[]), ConvergenceVerdict::Converging);
        assert_eq!(
            classify_convergence(&[vv(&[(0xA1, 1)])]),
            ConvergenceVerdict::Converging
        );
    }
}
