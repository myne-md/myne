// SPDX-License-Identifier: AGPL-3.0
//! The read budget's arithmetic, driven by a supplied millisecond reading so no
//! test sleeps and nothing here reads a clock: `core/` gets its time from the host.

use super::budget::{BudgetLedger, MAX_TRACKED, NOTES_PER_WINDOW, WINDOW_MS};

/// A fixed clock reading the tests measure from, in milliseconds.
const BASE: u64 = 1_000_000;

fn at(seconds: u64) -> u64 {
    BASE + seconds * 1000
}

#[test]
fn a_fresh_connection_starts_with_a_full_budget() {
    let mut ledger = BudgetLedger::default();
    assert_eq!(ledger.remaining("claude-desktop", at(0)), NOTES_PER_WINDOW);
}

#[test]
fn charging_reduces_what_is_left_and_the_rest_counts_against_the_same_window() {
    let mut ledger = BudgetLedger::default();
    ledger.charge("a", at(0), 40);
    assert_eq!(ledger.remaining("a", at(5)), NOTES_PER_WINDOW - 40);
    ledger.charge("a", at(6), 10);
    assert_eq!(ledger.remaining("a", at(7)), NOTES_PER_WINDOW - 50);
}

#[test]
fn one_connection_cannot_spend_another() {
    // The whole point of keying by name: a client in a loop must not be able to
    // starve the connection the person actually uses.
    let mut ledger = BudgetLedger::default();
    ledger.charge("greedy", at(0), NOTES_PER_WINDOW);
    assert_eq!(ledger.remaining("greedy", at(0)), 0);
    assert_eq!(ledger.remaining("quiet", at(0)), NOTES_PER_WINDOW);
}

#[test]
fn the_window_rolls_over_and_the_budget_comes_back() {
    let mut ledger = BudgetLedger::default();
    ledger.charge("a", at(0), NOTES_PER_WINDOW);
    // One millisecond before the window ends the debt still stands.
    assert_eq!(ledger.remaining("a", at(0) + WINDOW_MS - 1), 0);
    // A millisecond later the previous window is over, and the next call opens a
    // new one rather than answering the old debt.
    assert_eq!(ledger.remaining("a", at(0) + WINDOW_MS), NOTES_PER_WINDOW);
}

#[test]
fn a_charge_past_the_budget_saturates_rather_than_wrapping() {
    let mut ledger = BudgetLedger::default();
    ledger.charge("a", at(0), NOTES_PER_WINDOW);
    ledger.charge("a", at(0), 50);
    assert_eq!(ledger.remaining("a", at(0)), 0);

    // And the roll still recovers a full budget, which is what proves the debt
    // was clamped rather than accumulated past a u32 boundary.
    assert_eq!(ledger.remaining("a", at(0) + WINDOW_MS), NOTES_PER_WINDOW);
}

#[test]
fn the_ledger_stops_growing_past_its_cap_without_refusing_an_untracked_name() {
    let mut ledger = BudgetLedger::default();
    for index in 0..MAX_TRACKED {
        ledger.charge(&format!("conn-{index}"), at(0), 5);
    }
    assert_eq!(ledger.tracked(), MAX_TRACKED);
    // A name past the cap is not tracked, so it reads as a full budget: failing
    // open for an untracked name is the safe direction here, because the grant
    // check upstream is what decides whether the caller may read at all.
    ledger.charge("overflow", at(0), 5);
    assert_eq!(ledger.tracked(), MAX_TRACKED);
    assert_eq!(ledger.remaining("overflow", at(0)), NOTES_PER_WINDOW);
}

#[test]
fn reset_clears_every_connection() {
    let mut ledger = BudgetLedger::default();
    ledger.charge("a", at(0), NOTES_PER_WINDOW);
    ledger.reset();
    assert_eq!(ledger.remaining("a", at(0)), NOTES_PER_WINDOW);
}
