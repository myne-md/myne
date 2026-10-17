// SPDX-License-Identifier: AGPL-3.0
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

use super::persist::{decode_snapshot, encode_snapshot};
use super::state::{
    NoteRecord, PropertyEntry, TagEntry, TaskRecord, VaultIndicesState, WikilinkEdge,
};
use crate::search::persist::NonceManifest;
use protocol::AEAD_KEY_LEN;
use std::time::Instant;

/// Full-build (apply N notes) budget at 10k notes.
const BUDGET_BUILD_MS: u128 = 2_000;
/// Query p95 budget at 10k notes (50 ms expressed in µs).
const BUDGET_QUERY_P95_US: u128 = 50_000;
/// MYI1 persist (snapshot + postcard + AEAD) budget at 10k notes WITH typed
/// properties (MYND-271 Task 8). Generous debug-build headroom; the real
/// persist runs in `spawn_blocking` off the lock-await path.
const BUDGET_PERSIST_MS: u128 = 2_000;
/// MYI1 persisted-load (AEAD + postcard decode) budget at 10k notes. This is
/// the cost the heavier typed payload adds to a warm unlock's fast path.
const BUDGET_HYDRATE_MS: u128 = 2_000;
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
                // Two typed properties per note — the realistic Bases-style
                // frontmatter the MYI1 payload must carry (MYND-271 Task 8).
                properties: vec![
                    PropertyEntry {
                        key: "status".to_string(),
                        r#type: "string".to_string(),
                        value: Some(format!("state-{}", i % 5)),
                        elements: None,
                    },
                    PropertyEntry {
                        key: "priority".to_string(),
                        r#type: "number".to_string(),
                        value: Some(format!("{}", i % 10)),
                        elements: None,
                    },
                ],
                block_anchors: Vec::new(),
                // MYND-612 task 10: a realistic task density. Most notes carry
                // none; the ones that do carry a handful. Every fourth note gets
                // three tasks — ~0.75 tasks/note, which at 10k notes is 7.5k
                // records crossing the IPC boundary on a single whole-vault
                // fetch. Fields are populated on two of the three so the payload
                // reflects real records rather than empty locators.
                tasks: if i % 4 == 0 {
                    (0..3)
                        .map(|k| TaskRecord {
                            line_index: (k * 7 + 3) as u32,
                            raw_line: format!(
                                "- [{}] synthetic task {k} in note {i} [due:: 2026-08-0{}] [priority:: high]",
                                if k == 2 { "x" } else { " " },
                                (k % 9) + 1
                            ),
                            completed: k == 2,
                            due: if k < 2 {
                                Some(format!("2026-08-0{}", (k % 9) + 1))
                            } else {
                                None
                            },
                            repeat: None,
                            done: None,
                            priority: if k < 2 { Some("high".to_string()) } else { None },
                            remind: None,
                            oversized: false,
                        })
                        .collect()
                } else {
                    Vec::new()
                },
                headings: Vec::new(),
                live: true,
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

        // MYND-612 task 10: the whole-vault task fetch. The design deliberately
        // returns EVERY record and filters client-side, so the number that
        // matters is not query time (this is a scan with no comparison) but the
        // cost of materializing the whole list on each index change. Measured
        // here so the single-fetch decision has a figure behind it rather than
        // an assumption — the index nonce bumps on every autosave, and it is the
        // shared cache, not this call being cheap, that makes that affordable.
        let tasks_p95 = p95((0..QUERY_RUNS)
            .map(|_| {
                let t = Instant::now();
                let rows = state.all_tasks(100_000);
                let us = t.elapsed().as_micros();
                assert!(!rows.is_empty(), "synthetic corpus must carry tasks");
                us
            })
            .collect());
        let task_count = state.all_tasks(100_000).len();

        // MYI1 persistence round-trip (MYND-271 Task 8): snapshot → postcard →
        // AEAD (persist) and AEAD → postcard (hydrate) of the full typed index.
        // This is the cost the heavier typed-property payload adds vs the
        // RAM-only MVP; the manifest is synthetic (one nonce per note).
        let key = [0x42u8; AEAD_KEY_LEN];
        let account_hash = [0x33u8; 16];
        let manifest: NonceManifest = (0..n)
            .map(|i| (format!("note-{i}"), [(i % 256) as u8; 24]))
            .collect();
        let records = state.snapshot();

        let t = Instant::now();
        let blob = encode_snapshot(&key, &account_hash, &manifest, &records).expect("encode");
        let persist_ms = t.elapsed().as_millis();

        let t = Instant::now();
        let decoded = decode_snapshot(&key, &account_hash, &blob).expect("decode");
        let hydrate_ms = t.elapsed().as_millis();
        assert_eq!(decoded.1.len(), n, "decoded record count must match");

        let build_pass = n != 10_000 || build_ms <= BUDGET_BUILD_MS;
        let query_pass = backlink_p95 <= BUDGET_QUERY_P95_US && by_tag_p95 <= BUDGET_QUERY_P95_US;
        let persist_pass = n != 10_000 || persist_ms <= BUDGET_PERSIST_MS;
        let hydrate_pass = n != 10_000 || hydrate_ms <= BUDGET_HYDRATE_MS;
        println!(
            "[vault-indices bench] n={n}: build={build_ms}ms backlink_p95={backlink_p95}us \
             by_tag_p95={by_tag_p95}us tag_tree={tag_tree_us}us nodes={} \
             all_tasks_p95={tasks_p95}us tasks={task_count} \
             persist={persist_ms}ms hydrate={hydrate_ms}ms blob={}KiB build_pass={build_pass} \
             query_pass={query_pass} persist_pass={persist_pass} hydrate_pass={hydrate_pass}",
            tree.len(),
            blob.len() / 1024,
        );
    }
    println!(
        "[vault-indices bench] budgets: build<={BUDGET_BUILD_MS}ms@10k, \
         query_p95<={BUDGET_QUERY_P95_US}us@10k, persist<={BUDGET_PERSIST_MS}ms@10k, \
         hydrate<={BUDGET_HYDRATE_MS}ms@10k (MYI1 with typed properties). A missed persist / \
         hydrate budget → revisit the MYI1 payload (e.g. a leaner property encoding)."
    );
}
