// SPDX-License-Identifier: AGPL-3.0
//! Failed-attempt counter for quick-unlock (MYND-329, task 5).
//!
//! A **code-enforced**, replay-resistant counter that bounds *online* guessing
//! of the PIN / biometric: after [`MAX_QUICK_UNLOCK_ATTEMPTS`] consecutive
//! failures, the `vault.quickunlock` blob + provider credential are wiped and
//! the user falls back to the full master password. A success resets the count.
//!
//! It follows the `auto_lock.rs` two-class discipline (`threat-model.md` §7):
//! the threshold is a **code constant**, not a replayable preference, so a disk
//! attacker who tampers the on-disk count can only make quick-unlock *stricter*
//! (force the password sooner), never grant extra attempts beyond the code cap.
//! A **corrupt** count file is treated as "threshold reached" → wipe (fail
//! safe; the password still unlocks, so it is recoverable).
//!
//! **Scope of the guarantee:** this bounds the *online* attacker typing at the
//! keyboard. It does **not** bound an *offline* attacker who copied the blob —
//! that attacker brute-forces the AEAD directly, never touching this counter
//! (the PIN provider's Argon2id memory-hardness is the only offline bound; see
//! `protocol.md` §9.14.4 / `threat-model.md` §7).
//!
//! This module owns the pure counter logic + a tiny on-disk codec. The file
//! I/O wiring into the unlock flow lands with the plugin commands (task 6).

/// Consecutive-failure cap. A code constant (not a pref) so a tampered/replayed
/// on-disk count can only shorten the allowance, never extend it.
pub const MAX_QUICK_UNLOCK_ATTEMPTS: u32 = 5;

/// 1-byte magic for the device-local attempt-count file, distinguishing it from
/// a stray/zeroed file and giving the corrupt-→-strict check something to bite.
const ATTEMPT_FILE_MAGIC: u8 = 0xA7;

/// What the caller should do after recording a failed attempt.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AttemptOutcome {
    /// Still under the cap; `remaining` attempts before a wipe.
    Allowed { remaining: u32 },
    /// The cap is reached — the caller MUST wipe the blob + provider credential
    /// and force the full-password path.
    Wipe,
}

/// The consecutive-failure count for one vault's quick-unlock. Pure logic; the
/// command layer persists it via [`encode_attempt_count`] /
/// [`parse_attempt_count`] between attempts so it survives an app restart
/// (online-guessing defense, not merely per-session).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct AttemptState {
    failures: u32,
}

impl AttemptState {
    /// A fresh counter (no failures) — written at quick-unlock setup.
    pub fn fresh() -> Self {
        Self { failures: 0 }
    }

    /// Reconstruct from a persisted failure count, clamping an out-of-range
    /// (tampered / replayed-huge) value to the cap so it can only be *stricter*.
    pub fn from_count(failures: u32) -> Self {
        Self {
            failures: failures.min(MAX_QUICK_UNLOCK_ATTEMPTS),
        }
    }

    /// The persisted failure count.
    pub fn count(&self) -> u32 {
        self.failures
    }

    /// Attempts left before a wipe.
    pub fn remaining(&self) -> u32 {
        MAX_QUICK_UNLOCK_ATTEMPTS.saturating_sub(self.failures)
    }

    /// Record one failed attempt. Returns [`AttemptOutcome::Wipe`] once the cap
    /// is reached.
    pub fn record_failure(&mut self) -> AttemptOutcome {
        self.failures = self.failures.saturating_add(1);
        if self.failures >= MAX_QUICK_UNLOCK_ATTEMPTS {
            AttemptOutcome::Wipe
        } else {
            AttemptOutcome::Allowed {
                remaining: self.remaining(),
            }
        }
    }

    /// Record a successful unlock — resets the consecutive-failure count.
    pub fn record_success(&mut self) {
        self.failures = 0;
    }

    /// Whether the cap is already reached (e.g. after reconstructing a
    /// corrupted-→-clamped state) — the caller should wipe.
    pub fn must_wipe(&self) -> bool {
        self.failures >= MAX_QUICK_UNLOCK_ATTEMPTS
    }
}

impl Default for AttemptState {
    fn default() -> Self {
        Self::fresh()
    }
}

/// Encode the attempt count to the 2-byte device-local file body
/// (`magic || count_u8`). The count is clamped to the cap, so the file can
/// never advertise more headroom than the code allows.
pub fn encode_attempt_count(state: &AttemptState) -> [u8; 2] {
    [
        ATTEMPT_FILE_MAGIC,
        state.count().min(MAX_QUICK_UNLOCK_ATTEMPTS) as u8,
    ]
}

/// Parse a persisted attempt-count file. An **absent** file is the caller's
/// concern (fresh setup → `AttemptState::fresh`); this parses *present* bytes.
/// A wrong-magic / wrong-length file is **corrupt** → `None`, which the caller
/// treats as "threshold reached" (fail safe, § module docs).
pub fn parse_attempt_count(bytes: &[u8]) -> Option<AttemptState> {
    if bytes.len() != 2 || bytes[0] != ATTEMPT_FILE_MAGIC {
        return None;
    }
    Some(AttemptState::from_count(bytes[1] as u32))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fresh_allows_up_to_the_cap_then_wipes() {
        let mut s = AttemptState::fresh();
        assert_eq!(s.remaining(), 5);
        // Failures 1..=4 stay allowed.
        for expected_remaining in [4, 3, 2, 1] {
            assert_eq!(
                s.record_failure(),
                AttemptOutcome::Allowed {
                    remaining: expected_remaining
                }
            );
        }
        // The 5th failure trips the wipe.
        assert_eq!(s.record_failure(), AttemptOutcome::Wipe);
    }

    #[test]
    fn success_resets_the_count() {
        let mut s = AttemptState::fresh();
        s.record_failure();
        s.record_failure();
        assert_eq!(s.count(), 2);
        s.record_success();
        assert_eq!(s.count(), 0);
        assert_eq!(s.remaining(), 5);
    }

    #[test]
    fn from_count_clamps_tampered_huge_value_to_the_cap() {
        // A replayed/tampered count of 9999 can only be STRICTER (→ wipe), never
        // grant extra attempts.
        let s = AttemptState::from_count(9_999);
        assert_eq!(s.count(), MAX_QUICK_UNLOCK_ATTEMPTS);
        assert!(s.must_wipe());
        assert_eq!(s.remaining(), 0);
    }

    #[test]
    fn count_file_round_trips() {
        let s = AttemptState::from_count(3);
        let bytes = encode_attempt_count(&s);
        let parsed = parse_attempt_count(&bytes).expect("parse");
        assert_eq!(parsed.count(), 3);
    }

    #[test]
    fn corrupt_count_file_is_none_caller_treats_as_wipe() {
        assert_eq!(parse_attempt_count(&[0x00, 0x01]), None); // wrong magic
        assert_eq!(parse_attempt_count(&[ATTEMPT_FILE_MAGIC]), None); // wrong length
        assert_eq!(parse_attempt_count(&[]), None);
        assert_eq!(parse_attempt_count(&[ATTEMPT_FILE_MAGIC, 0x02, 0x03]), None);
    }

    #[test]
    fn encode_clamps_so_file_never_advertises_extra_headroom() {
        let s = AttemptState::from_count(MAX_QUICK_UNLOCK_ATTEMPTS);
        let bytes = encode_attempt_count(&s);
        assert_eq!(bytes[1] as u32, MAX_QUICK_UNLOCK_ATTEMPTS);
    }
}
