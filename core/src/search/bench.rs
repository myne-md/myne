// SPDX-License-Identifier: AGPL-3.0
//! Search-engine benchmark harness (`search-index` feature, MYND-29 Task 9).
//!
//! **Approach B (user decision, 2026-05-31 — see the feature `progress.md`).**
//! The PRE-SHIP engine gate is *budget-gated*, NOT a tantivy head-to-head:
//! tantivy is a **documented fallback** adopted ONLY if the custom
//! [`InvertedIndex`] misses a 10k budget. So this harness benchmarks the
//! custom engine against the target budget table and emits a PASS/FAIL
//! report; it deliberately does NOT pull tantivy's large transitive tree
//! into the dependency graph just to benchmark (`CLAUDE.md` minimal
//! direct-dependency surface / TB9 audit anchor / reproducible builds).
//! If a 10k budget is missed, THEN tantivy is added + a real comparison run
//! (and a `decisions.md` dep-justification) — only then.
//!
//! Dependency-free by construction: timing via [`std::time::Instant`], RAM
//! via a **test-only** counting global allocator (delegates to `System`;
//! exists only under `cfg(test)`, so production keeps the default
//! allocator). No `criterion`, no `tantivy`.
//!
//! The headline report is `#[ignore]`d (timing + RAM are environment-
//! dependent — same posture as `auto_lock::machine_idle_smoke`). Run it
//! single-threaded so the process-wide allocator counter is not polluted by
//! concurrent tests:
//!
//! ```text
//! cargo test -p myne-desktop --lib search::bench::engine_budget_report \
//!   -- --ignored --nocapture --test-threads=1
//! ```
//!
//! The printed numbers + the final engine decision land in `design-notes.md`
//! via Task 10. The corpus is SYNTHETIC (deterministic templates + a
//! pseudo-vocabulary spread) — a reproducible proxy, not a real-note
//! distribution; RAM/blob ratios are indicative, query/rebuild timing is
//! representative.

use super::persist::{decode_snapshot, encode_snapshot, NonceManifest};
use super::{Document, InvertedIndex, SearchIndex};
use protocol::{AEAD_KEY_LEN, SEARCH_BLOB_ACCOUNT_HASH_LEN};
use std::time::Instant;

// ---- target budgets (the engine-gate inputs, from tasks.md Task 9) --------

/// Warm-unlock blob decode budget at 10k notes.
const BUDGET_BLOB_LOAD_MS: u128 = 200;
/// Full-rebuild budget at 10k notes.
const BUDGET_REBUILD_MS: u128 = 5_000;
/// Query p95 budget at 10k notes (50 ms expressed in µs).
const BUDGET_QUERY_P95_US: u128 = 50_000;
/// Steady-state index RAM budget at 10k notes.
const BUDGET_RAM_BYTES: usize = 100 * 1024 * 1024;
/// Encrypted-blob size budget as a multiple of the indexed text bytes.
const BUDGET_BLOB_RATIO: f64 = 2.0;

/// Number of query executions per size, cycling [`bench_queries`]; the p95 is
/// taken over the per-execution latencies.
const QUERY_RUNS: usize = 500;

/// Fixed key + account-hash for the encrypted-blob round-trip measurement
/// (the AEAD adds a ~constant overhead the warm-unlock budget must cover).
const KEY: [u8; AEAD_KEY_LEN] = [0x5a; AEAD_KEY_LEN];
const ACCT: [u8; SEARCH_BLOB_ACCOUNT_HASH_LEN] = [0x16; SEARCH_BLOB_ACCOUNT_HASH_LEN];

// ---- synthetic corpus -----------------------------------------------------

/// A real-language paragraph per supported language so each note carries
/// enough text for whatlang detection + the language stemmer path (build
/// cost realism); the per-note pseudo-vocabulary fill (below) supplies term
/// diversity (postings / RAM realism).
fn lang_template(lang: usize) -> &'static str {
    match lang % 3 {
        0 => {
            "The quarterly project report covers the engineering roadmap and the testing \
              strategy for the next release cycle with detailed notes and open questions. "
        }
        1 => {
            "Bu çeyrek proje raporu, sonraki sürüm döngüsü için mühendislik yol haritasını ve \
              test stratejisini ayrıntılı notlar ve açık sorularla kapsıyor. "
        }
        _ => {
            "Der vierteljährliche Projektbericht behandelt die technische Roadmap und die \
              Teststrategie für den nächsten Releasezyklus mit ausführlichen Notizen. "
        }
    }
}

/// Build a deterministic synthetic note `i` with three parts: a UUID-shaped
/// id (so the manifest + blob size reflect real 36-char note ids), a short
/// H1 title, and a ~2 KB body. The body concatenates the language template
/// (twice, for whatlang detection), then a deterministic pseudo-vocabulary
/// spread over a 5000-term space (realistic posting growth), then a unique
/// `noteNNNNN` token (single-hit query target).
fn synthetic_note(i: usize) -> Document {
    let lang = i % 3;
    let template = lang_template(lang);

    let mut body = String::with_capacity(2200);
    body.push_str(template);
    body.push_str(template);
    // Deterministic pseudo-vocabulary fill (Knuth multiplicative spread) — no
    // RNG dependency, reproducible across runs and machines.
    let mut k: u64 = 0;
    while body.len() < 2000 {
        let w = (i as u64)
            .wrapping_mul(2_654_435_761)
            .wrapping_add(k.wrapping_mul(40_503))
            % 5000;
        body.push_str(&format!("term{w:04} "));
        k += 1;
    }
    body.push_str(&format!("note{i:05}\n"));

    Document {
        id: format!("00000000-0000-7000-8000-{i:012x}"),
        title: format!("# Note {i:05}"),
        body,
    }
}

/// `n` deterministic synthetic notes (1k/5k/10k corpora for the report).
fn synthetic_corpus(n: usize) -> Vec<Document> {
    (0..n).map(synthetic_note).collect()
}

/// Representative query mix: a high-frequency template word (worst case —
/// matches ~n/3 docs, stressing BM25 scoring + the result sort), a
/// type-ahead prefix, a two-term AND, and a unique token (single hit).
fn bench_queries() -> Vec<&'static str> {
    vec![
        "project",       // EN template — large result set
        "test strategy", // two-term AND
        "proj",          // prefix / type-ahead
        "rapor",         // TR template word
        "teststrategie", // DE compound-ish
        "note04096",     // unique token — single hit
    ]
}

// ---- percentile -----------------------------------------------------------

/// `p`-quantile (0.0..=1.0) of an ASCENDING-sorted slice via nearest-rank.
/// Empty slice → 0.
fn percentile(sorted: &[u128], p: f64) -> u128 {
    if sorted.is_empty() {
        return 0;
    }
    let rank = (p * (sorted.len() as f64 - 1.0)).round() as usize;
    sorted[rank.min(sorted.len() - 1)]
}

// ---- per-size measurement -------------------------------------------------

/// One size's measured metrics.
struct Metrics {
    n: usize,
    rebuild_ms: u128,
    blob_load_ms: u128,
    query_p95_us: u128,
    index_ram_bytes: usize,
    blob_bytes: usize,
    text_bytes: usize,
}

fn measure(n: usize) -> Metrics {
    // --- rebuild timing + steady-state index RAM -------------------------
    // Baseline BEFORE the corpus is allocated; `build` consumes the corpus
    // (each `Document`'s body String is dropped after its terms are indexed),
    // so after `build` returns the only net-new live allocation is the index
    // itself → `current() - baseline` ≈ steady-state index RAM. (Requires the
    // counting allocator + a single-threaded run; see the module docs.)
    let baseline = alloc::current();
    let corpus = synthetic_corpus(n);
    let build_started = Instant::now();
    let index = InvertedIndex::build(corpus);
    let rebuild_ms = build_started.elapsed().as_millis();
    let index_ram_bytes = alloc::current().saturating_sub(baseline);

    // --- query p95 -------------------------------------------------------
    let queries = bench_queries();
    let mut latencies: Vec<u128> = Vec::with_capacity(QUERY_RUNS);
    for &q in queries.iter().cycle().take(QUERY_RUNS) {
        let started = Instant::now();
        let _ = index.query(q);
        latencies.push(started.elapsed().as_micros());
    }
    latencies.sort_unstable();
    let query_p95_us = percentile(&latencies, 0.95);

    // --- encrypted-blob size + warm-load (decode) timing -----------------
    // Regenerate the corpus to recover text bytes + a realistic manifest
    // (the original was consumed by `build`); deterministic → identical ids.
    let corpus2 = synthetic_corpus(n);
    let text_bytes: usize = corpus2.iter().map(|d| d.title.len() + d.body.len()).sum();
    let manifest: NonceManifest = corpus2
        .iter()
        .enumerate()
        .map(|(i, d)| (d.id.clone(), [(i % 256) as u8; 24]))
        .collect();
    drop(corpus2);

    let blob = encode_snapshot(&KEY, &ACCT, &manifest, &index).expect("encode snapshot");
    let blob_bytes = blob.len();
    let load_started = Instant::now();
    let _ = decode_snapshot(&KEY, &ACCT, &blob).expect("decode snapshot");
    let blob_load_ms = load_started.elapsed().as_millis();

    Metrics {
        n,
        rebuild_ms,
        blob_load_ms,
        query_p95_us,
        index_ram_bytes,
        blob_bytes,
        text_bytes,
    }
}

// ---- test-only counting global allocator ----------------------------------

mod alloc {
    use std::alloc::{GlobalAlloc, Layout, System};
    use std::sync::atomic::{AtomicUsize, Ordering};

    static CURRENT: AtomicUsize = AtomicUsize::new(0);

    /// Counting allocator: delegates every allocation to `System` and tracks
    /// the live byte count. Test-only (this whole module compiles under
    /// `cfg(test)` via `#[cfg(test)] mod bench;`), so production keeps the
    /// default System allocator untouched. No allocation happens inside the
    /// allocator itself (atomics only) → no recursion.
    pub struct Counting;

    // SAFETY: every method forwards to `System` (a sound `GlobalAlloc`); the
    // only added work is relaxed atomic accounting, which neither allocates
    // nor touches the returned memory. The default `alloc_zeroed` / `realloc`
    // are inherited and route through these `alloc`/`dealloc`.
    unsafe impl GlobalAlloc for Counting {
        unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
            let ptr = System.alloc(layout);
            if !ptr.is_null() {
                CURRENT.fetch_add(layout.size(), Ordering::Relaxed);
            }
            ptr
        }
        unsafe fn dealloc(&self, ptr: *mut u8, layout: Layout) {
            System.dealloc(ptr, layout);
            CURRENT.fetch_sub(layout.size(), Ordering::Relaxed);
        }
    }

    #[global_allocator]
    static GLOBAL: Counting = Counting;

    /// Currently-live allocated bytes (process-wide; meaningful as a delta on
    /// a single-threaded run).
    pub fn current() -> usize {
        CURRENT.load(Ordering::Relaxed)
    }
}

// ---- tests ----------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    fn kib(bytes: usize) -> usize {
        bytes / 1024
    }

    fn pass(ok: bool) -> &'static str {
        if ok {
            "PASS"
        } else {
            "FAIL"
        }
    }

    // ---- harness-logic unit tests (run under normal `cargo test`) --------

    #[test]
    fn corpus_is_deterministic_n_sized_and_mixed_language() {
        let a = synthetic_corpus(9);
        let b = synthetic_corpus(9);
        assert_eq!(a.len(), 9);
        // Deterministic across calls (no RNG) — reproducible benchmark.
        assert!(a
            .iter()
            .zip(&b)
            .all(|(x, y)| x.id == y.id && x.title == y.title && x.body == y.body));
        // ~2 KB bodies (template ×2 + fill to >=2000 + a trailing token line).
        assert!(a
            .iter()
            .all(|d| d.body.len() >= 2000 && d.body.len() < 2600));
        // All three language templates are exercised across i % 3.
        assert!(a[0].body.contains("project")); // EN
        assert!(a[1].body.contains("proje")); // TR
        assert!(a[2].body.contains("Projektbericht")); // DE
                                                       // Unique per-note token + UUID-shaped id.
        assert!(a[5].body.contains("note00005"));
        assert_eq!(a[5].id.len(), 36);
    }

    #[test]
    fn corpus_content_is_searchable() {
        let index = InvertedIndex::build(synthetic_corpus(30));
        // A high-frequency template word hits many docs.
        assert!(!index.query("project").is_empty());
        // A unique token hits exactly its one note.
        assert_eq!(index.query("note00007").len(), 1);
    }

    #[test]
    fn percentile_picks_expected_ranks() {
        let v: Vec<u128> = (1..=100).collect(); // v[i] = i + 1
        assert_eq!(percentile(&v, 0.0), 1);
        assert_eq!(percentile(&v, 1.0), 100);
        // nearest-rank: round(0.95 * 99) = 94 → v[94] = 95.
        assert_eq!(percentile(&v, 0.95), 95);
        assert_eq!(percentile(&v, 0.5), 51); // round(0.5 * 99) = 50 → v[50] = 51
        assert_eq!(percentile(&[], 0.5), 0);
        assert_eq!(percentile(&[42], 0.95), 42);
    }

    #[test]
    fn measure_produces_coherent_metrics_on_a_small_corpus() {
        // Exercises the full `measure` pipeline (build → query → encrypt →
        // decode) on a tiny corpus so the harness itself is covered by a
        // normal (non-ignored) test. No budget assertion (timing/RAM are
        // env-dependent) — just structural coherence.
        let m = measure(50);
        assert_eq!(m.n, 50);
        assert!(m.blob_bytes > 0);
        assert!(m.text_bytes > 0);
        // The encrypted blob carries the index + manifest + AEAD overhead; it
        // must at least be non-trivial relative to the text.
        assert!(m.text_bytes > 50 * 2000);
    }

    // ---- headline report (env-dependent → #[ignore]) ---------------------

    #[test]
    #[ignore = "env-dependent timing/RAM report; run --test-threads=1 --nocapture"]
    fn engine_budget_report() {
        println!("\n=== MYND-29 Task 9 — custom InvertedIndex budget report (approach B) ===");
        println!(
            "(synthetic corpus; env-dependent — run single-threaded; numbers feed the \
             decisions.md engine decision)\n"
        );
        println!(
            "{:>7} | {:>9} | {:>10} | {:>11} | {:>11} | {:>9} | {:>6}",
            "notes", "rebuild", "blob-load", "query p95", "index RAM", "blob", "ratio"
        );

        let mut at_10k: Option<Metrics> = None;
        for &n in &[1_000usize, 5_000, 10_000] {
            let m = measure(n);
            let ratio = m.blob_bytes as f64 / m.text_bytes as f64;
            println!(
                "{:>7} | {:>7}ms | {:>8}ms | {:>9}µs | {:>8}KB | {:>7}KB | {:>5.2}x",
                m.n,
                m.rebuild_ms,
                m.blob_load_ms,
                m.query_p95_us,
                kib(m.index_ram_bytes),
                kib(m.blob_bytes),
                ratio
            );
            if n == 10_000 {
                at_10k = Some(m);
            }
        }

        let m = at_10k.expect("10k row measured");
        let ratio = m.blob_bytes as f64 / m.text_bytes as f64;
        println!("\n--- 10k budget verdict ---");
        println!(
            "  rebuild   <{:>5}ms : {:>6}ms  {}",
            BUDGET_REBUILD_MS,
            m.rebuild_ms,
            pass(m.rebuild_ms <= BUDGET_REBUILD_MS)
        );
        println!(
            "  blob-load <{:>5}ms : {:>6}ms  {}",
            BUDGET_BLOB_LOAD_MS,
            m.blob_load_ms,
            pass(m.blob_load_ms <= BUDGET_BLOB_LOAD_MS)
        );
        println!(
            "  query p95 <{:>5}µs : {:>6}µs  {}",
            BUDGET_QUERY_P95_US,
            m.query_p95_us,
            pass(m.query_p95_us <= BUDGET_QUERY_P95_US)
        );
        println!(
            "  index RAM <{:>5}MB : {:>6}MB  {}",
            BUDGET_RAM_BYTES / (1024 * 1024),
            m.index_ram_bytes / (1024 * 1024),
            pass(m.index_ram_bytes <= BUDGET_RAM_BYTES)
        );
        println!(
            "  blob size <{:>5.1}x : {:>5.2}x  {}",
            BUDGET_BLOB_RATIO,
            ratio,
            pass(ratio <= BUDGET_BLOB_RATIO)
        );
        println!(
            "\nEngine decision rule (approach B): ALL pass → ship custom; tantivy stays a \
             documented fallback (NOT added). Any miss → adopt tantivy for that gate + a \
             decisions.md dep-justification. Record the numbers + decision in decisions.md (Task 10)."
        );

        // Sanity (not a budget assertion): the harness actually ran end-to-end.
        assert!(m.index_ram_bytes > 0 && m.blob_bytes > 0);
    }
}
