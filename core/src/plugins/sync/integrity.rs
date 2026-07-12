//! Integrity-alert classification (MYND-427 task 2).
//!
//! Decides when the engine must raise the hard, honest integrity alert
//! (`SYNC_INTEGRITY_ALERT`, `src/lib/load-bearing-copy.ts`) — never silently
//! accepting a rollback / non-extending head. Two inputs:
//!
//! - a pull-path failure ([`PullError`]): a rejected rollback, a MAC/structural
//!   head-verify failure, or a head_id inconsistency are integrity events; a
//!   transient (network / 401 / 429 / cursor-expired / bad-response) is NOT — it
//!   is an availability/recoverable condition, not server misbehaviour.
//! - a cross-read convergence verdict ([`ConvergenceVerdict`]): a `Fork` (heads
//!   that never re-converge) raises the advisory; `Concurrency`/`Converging` do not.
//!
//! The copy honesty (it says "possible", never claims general tamper-detection)
//! is pinned in `load-bearing-copy.ts`; this module only decides *whether* to show
//! it, so the engine has one place that maps signals → the alert.

use super::engine::PullError;
use super::fork_audit::ConvergenceVerdict;

/// `true` when a pull failure is an integrity event (rollback / forged or
/// malformed head), as opposed to a transient/availability error.
pub fn pull_error_is_integrity_failure(e: &PullError) -> bool {
    matches!(
        e,
        PullError::RollbackRejected | PullError::HeadInvalid | PullError::HeadIdMismatch
    )
}

/// `true` when a convergence verdict warrants the integrity advisory (a fork).
pub fn verdict_raises_integrity_alert(v: ConvergenceVerdict) -> bool {
    matches!(v, ConvergenceVerdict::Fork)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::plugins::sync::transport::TransportError;

    #[test]
    fn rollback_and_bad_head_are_integrity_failures() {
        assert!(pull_error_is_integrity_failure(
            &PullError::RollbackRejected
        ));
        assert!(pull_error_is_integrity_failure(&PullError::HeadInvalid));
        assert!(pull_error_is_integrity_failure(&PullError::HeadIdMismatch));
    }

    #[test]
    fn transient_errors_are_not_integrity_failures() {
        for e in [
            PullError::Unauthenticated,
            PullError::RateLimited,
            PullError::CursorExpired,
            PullError::BadResponse,
            PullError::Transport(TransportError::Network),
        ] {
            assert!(!pull_error_is_integrity_failure(&e), "{e:?} must not alarm");
        }
    }

    #[test]
    fn only_fork_raises_the_advisory() {
        assert!(verdict_raises_integrity_alert(ConvergenceVerdict::Fork));
        assert!(!verdict_raises_integrity_alert(
            ConvergenceVerdict::Concurrency
        ));
        assert!(!verdict_raises_integrity_alert(
            ConvergenceVerdict::Converging
        ));
    }
}
