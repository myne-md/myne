// SPDX-License-Identifier: AGPL-3.0
//! How many notes one external connection may read in one window
//! (mcp external access rework, myne-md/myne#1052).
//!
//! An approved connection may read every folder the user did not leave out, and the
//! grant cannot tell a lookup from a drain. The door's rate limiter counts REQUESTS,
//! which is the wrong unit: one `note_search` is one request and can return fifty
//! notes. So this counts NOTES.
//!
//! **A slowdown, not a protection**, like the door's limiter: a program running as
//! the same user can wait. What it buys is a drain slow enough for a human to be in
//! the loop, and a client that retries in a loop is refused rather than served.
//!
//! **In memory, cleared by a restart.** A counter in `vault.prefs` would mean a
//! re-encrypt and a nonce bump per read, for a number nobody reads back.
//!
//! **The charge comes after the call**, because the cost is only known once it has
//! run: "is anything left" before, "what was returned" after. A single call can
//! overshoot by at most what one call may return (fifty notes for a search, one for
//! a read), and over-charging a caller is the one direction a budget must not err in.
//!
//! It holds a count and a window start per connection name, and no note id, folder
//! or body.

use std::collections::BTreeMap;
use std::sync::Mutex;

/// Notes one connection may take out per window: sized against a working
/// conversation, not against the vault. Deliberately not configurable, since a
/// setting would invite raising it to the size of the vault.
pub const NOTES_PER_WINDOW: u32 = 300;

/// The window the budget is measured over, in milliseconds. Millis rather than
/// `Instant` because `core/` may not reach a clock directly: the host supplies
/// `monotonic_millis()`, which is the seam the task/clock guard holds.
pub const WINDOW_MS: u64 = 15 * 60 * 1000;

/// How many connections the ledger will track before it stops growing.
///
/// Only approved connection names reach this map, so the count is bounded by the
/// vault's grants anyway; the cap exists so a future caller cannot turn this into
/// an unbounded map by mistake.
pub(crate) const MAX_TRACKED: usize = 32;

/// One connection's spending inside the current window.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
struct Spent {
    window_start: Option<u64>,
    notes: u32,
}

impl Spent {
    /// Roll the window if it has elapsed, then report what is left.
    fn remaining(&mut self, now_ms: u64) -> u32 {
        match self.window_start {
            Some(start) if now_ms.saturating_sub(start) < WINDOW_MS => {
                NOTES_PER_WINDOW.saturating_sub(self.notes)
            }
            _ => {
                self.window_start = Some(now_ms);
                self.notes = 0;
                NOTES_PER_WINDOW
            }
        }
    }

    fn charge(&mut self, now_ms: u64, notes: u32) {
        let _ = self.remaining(now_ms);
        self.notes = self.notes.saturating_add(notes);
    }
}

/// The per-process ledger, keyed by the declared connection name.
#[derive(Debug, Default)]
pub struct BudgetLedger {
    spent: BTreeMap<String, Spent>,
}

impl BudgetLedger {
    /// What is left for `connection` at `now`, rolling the window if it elapsed.
    pub fn remaining(&mut self, connection: &str, now_ms: u64) -> u32 {
        self.entry(connection, now_ms).remaining(now_ms)
    }

    /// Record `notes` taken. Saturating: a charge past the budget is a debt the next call refuses.
    pub fn charge(&mut self, connection: &str, now_ms: u64, notes: u32) {
        self.entry(connection, now_ms).charge(now_ms, notes);
    }

    /// Test-only: in production nothing resets a budget except the process ending.
    #[cfg(test)]
    pub fn reset(&mut self) {
        self.spent.clear();
    }

    /// Test-only: the cap is a bound, not a number anything reads.
    #[cfg(test)]
    pub fn tracked(&self) -> usize {
        self.spent.len()
    }

    fn entry(&mut self, connection: &str, now_ms: u64) -> &mut Spent {
        if !self.spent.contains_key(connection) && self.spent.len() >= MAX_TRACKED {
            // The cap bounds the map: a full window for an untracked name fails open.
            if let Some(oldest) = self
                .spent
                .iter()
                .min_by_key(|(_, spent)| {
                    spent
                        .window_start
                        .map_or(0, |start| now_ms.saturating_sub(start))
                })
                .map(|(name, _)| name.clone())
            {
                self.spent.remove(&oldest);
            }
        }
        self.spent.entry(connection.to_string()).or_default()
    }
}

/// The one ledger this process has: the lifetime a budget means is the app's, so it
/// survives a lock and an unlock and ends when the process does.
pub fn process_ledger() -> &'static Mutex<BudgetLedger> {
    static LEDGER: std::sync::OnceLock<Mutex<BudgetLedger>> = std::sync::OnceLock::new();
    LEDGER.get_or_init(|| Mutex::new(BudgetLedger::default()))
}
