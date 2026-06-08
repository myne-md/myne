//! VaultIndices benchmark harness (MYND-31 / A11, Task 7).
//!
//! Gates the two deferred follow-ups: the `MYI1` encrypted-persistence
//! work-item and the Task-3 `title-key → [edges]` aux-index optimization.
//! Build-B puts the heavy rebuild step (note_read + parse) on the TS side,
//! so the **Rust-measurable** cost is (a) `apply` throughput (the warm /
//! reconcile build) and (b) the scan-based queries — `backlink_candidates`
//! (O(all edges)) and `by_tag` / `tag_tree` (O(all tags)). This harness
//! measures those at 1k / 5k / 10k synthetic notes and prints a PASS/FAIL
//! report against a budget table; the numbers land in `decisions.md` when
//! the `MYI1` follow-up is scoped.
//!
//! Dependency-free (timing via [`std::time::Instant`] — no `criterion`).
//! The report is `#[ignore]`d (timing is environment-dependent — same
//! posture as `search::bench`). Run single-threaded:
//!
//! ```text
//! cargo test -p myne-desktop --lib vault_indices::bench::index_budget_report \
//!   -- --ignored --nocapture --test-threads=1
//! ```
//!
//! The corpus is SYNTHETIC (deterministic templates) — a reproducible
//! proxy, not a real-note distribution; the timings are representative of
//! the scan/apply shapes, not of the TS-side read+parse sweep.

use super::state::{NoteRecord, TagEntry, VaultIndicesState, WikilinkEdge};
use std::time::Instant;

/// Full-build (apply N notes) budget at 10k notes.
const BUDGET_BUILD_MS: u128 = 2_000;
/// Query p95 budget at 10k notes (50 ms expressed in µs).
const BUDGET_QUERY_P95_US: u128 = 50_000;
/// Query executions per size; p95 over the per-execution latencies.
const QUERY_RUNS: usize = 500;

fn synthetic_title(i: usize) -> String {
    format!("Note {i}")
}

/// Bench proxy for the TS `foldSegment` (ASCII lowercase suffices for the
/// synthetic corpus — the real fold runs TS-side).
fn fold(s: &str) -> String {
    s.to_lowercase()
}

/// Build a synthetic index: N notes, each linking to 3 neighbours by title
/// and carrying 2 tags (one nested), so the scans have realistic fan-out.
fn build(n: usize) -> VaultIndicesState {
    let state = VaultIndicesState::default();
    for i in 0..n {
        let mut edges = Vec::with_capacity(3);
        for d in 1..=3 {
            let target = synthetic_title((i + d) % n);
            edges.push(WikilinkEdge {
                title_key: fold(&target),
                target,
                target_kind: "title".to_string(),
                embed: d == 2,
                ..Default::default()
            });
        }
        let tags = vec![
            TagEntry {
                folded: format!("area/{}", i % 20),
                display: format!("Area/{}", i % 20),
            },
            TagEntry {
                folded: format!("topic{}", i % 50),
                display: format!("Topic{}", i % 50),
            },
        ];
        state.apply(
            &format!("note-{i}"),
            NoteRecord {
                title: Some(synthetic_title(i)),
                folder: None,
                title_key: Some(synthetic_title(i).to_lowercase()),
                edges,
                tags,
            },
        );
    }
    state
}

fn p95(mut samples: Vec<u128>) -> u128 {
    samples.sort_unstable();
    let idx = (samples.len() * 95 / 100).min(samples.len().saturating_sub(1));
    samples.get(idx).copied().unwrap_or(0)
}

#[test]
#[ignore = "environment-dependent timing; manual perf gate (see module docs)"]
fn index_budget_report() {
    for &n in &[1_000usize, 5_000, 10_000] {
        let t0 = Instant::now();
        let state = build(n);
        let build_ms = t0.elapsed().as_millis();

        let backlink_p95 = p95((0..QUERY_RUNS)
            .map(|r| {
                let key = fold(&synthetic_title(r % n));
                let t = Instant::now();
                let _ = state.backlink_candidates(&key);
                t.elapsed().as_micros()
            })
            .collect());

        let by_tag_p95 = p95((0..QUERY_RUNS)
            .map(|r| {
                let key = format!("area/{}", r % 20);
                let t = Instant::now();
                let _ = state.by_tag(&key);
                t.elapsed().as_micros()
            })
            .collect());

        let t = Instant::now();
        let tree = state.tag_tree();
        let tag_tree_us = t.elapsed().as_micros();

        let build_pass = n != 10_000 || build_ms <= BUDGET_BUILD_MS;
        let query_pass = backlink_p95 <= BUDGET_QUERY_P95_US && by_tag_p95 <= BUDGET_QUERY_P95_US;
        println!(
            "[vault-indices bench] n={n}: build={build_ms}ms backlink_p95={backlink_p95}us \
             by_tag_p95={by_tag_p95}us tag_tree={tag_tree_us}us nodes={} build_pass={build_pass} \
             query_pass={query_pass}",
            tree.len()
        );
    }
    println!(
        "[vault-indices bench] budgets: build<={BUDGET_BUILD_MS}ms@10k, \
         query_p95<={BUDGET_QUERY_P95_US}us@10k. If a budget is missed → promote the MYI1 \
         persistence follow-up and/or the title-key aux index."
    );
}
