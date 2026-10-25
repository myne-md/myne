// Vitest config for the E2E harness (e2e-harness, MYND-129).
//
// Deliberately a SEPARATE config from `vitest.config.ts`: `pnpm test`
// (the unit/component suite, `tests/**`) must stay hermetic and fast,
// while E2E specs (`e2e/**/*.e2e.ts`) drive the real production binary
// through tauri-driver — Linux-only (SYNC-1), up to `shardCount` apps in
// parallel (see its own comment for the measurement), with wall-clock budgets
// that include Argon2id
// at production parameters (the VR-1 recovery-drill scenario, SYNC-9).
//
// Run via `pnpm test:e2e` (locally inside the container — see
// docs/dev/e2e.md — or in the Woodpecker E2E step).

import { cpus } from "node:os";

import { defineConfig } from "vitest/config";

/**
 * How many file-workers to run.
 *
 * `MYNE_E2E_SHARDS` wins when set. Otherwise the MACHINE decides, because a flat
 * 2 left a 16-core box running 7 of the suite's slowest files in 371 s that it
 * finishes in 137 s.
 *
 * **Measured (2026-10-17, this 16-core box, the 7 slowest files, 37 scenarios),
 * against this pipeline's own criterion** — `docs/dev/e2e.md`: "the reading that
 * would justify raising this is a run at N+1 whose SUMMED FILE TIME is unchanged
 * from N":
 *
 *   | shards | wall  | summed file time | failures (`--retry=0`) |
 *   |    2   | 371 s |      650 s       |          0            |
 *   |    4   | 168 s |      559 s       |          2            |
 *   |    6   | 163 s |      528 s       |          2            |
 *
 * So the summed time did not expand (it fell), and the wall clock fell 2.7x. The
 * two failures at 4 and 6 are the contention class this file's retry exists for:
 * a `waitForElement` 45 s default that expires under several concurrent WebKit
 * apps. With the repo's own retry policy in place the same 6-shard run was 137 s
 * and 37/37 GREEN (2 tests needed a retry).
 *
 * **What this formula protects.** A small runner keeps today's behaviour: 4 cores
 * or fewer yields 2, exactly as before, so the 2 -> 3 experiment this file records
 * (1627 s on a CI runner, worse than 2) cannot be reopened by this change on that
 * runner. The cap of 6 is where the measurement stops, not a claim about more.
 *
 * **What bounds the win.** Not the shard count: `maxConcurrency: 1` keeps a file's
 * scenarios sequential, so the floor is the LONGEST SINGLE FILE — `vault-creation`
 * measured 156-161 s alone, and every shard waits for it. The next lever therefore
 * lives inside the long files, which is what `scripts/e2e-wait-profile.mjs`
 * (`MYNE_E2E_WAIT_PROFILE=1`) is for.
 */
const shardCount = ((): number => {
  const explicit = process.env.MYNE_E2E_SHARDS;
  if (explicit !== undefined) return Number(explicit);
  return Math.max(2, Math.min(6, Math.floor(cpus().length / 2)));
})();

/** See `e2e/support/webdriver.ts`'s `TIMEOUT_SCALE` for why this exists. */
const timeoutScale = ((): number => {
  const raw = process.env.MYNE_E2E_TIMEOUT_SCALE;
  if (raw === undefined || raw.trim() === "") return 1;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : 1;
})();

/**
 * Which lane this run is. One name, read by three places: the report filename
 * here, `scripts/ci-e2e-lane.sh` (which sets it) and
 * `scripts/check-e2e-floor.mjs --lane <name>`.
 *
 * The lanes are not decoration: the gate runs `stable`, the AI inference suites
 * run as `ai` on their own schedule, and `quarantine` runs the contended specs
 * the gate skips. A shared report path would let whichever lane finished last
 * overwrite the other's floor evidence, which is the failure the old
 * `quarantine ? quarantine : stable` ternary only half-closed.
 */
const lane =
  process.env.MYNE_E2E_LANE ??
  (process.env.MYNE_E2E_QUARANTINE === "1" ? "quarantine" : "stable");

export default defineConfig({
  test: {
    include: ["e2e/**/*.e2e.ts"],
    environment: "node",
    globals: false,
    // Per-worker setup: give each worker slot its own driver/native port band
    // (keyed on VITEST_POOL_ID) so parallel workers never collide on the fixed
    // 4444/4445 default. session.ts + multi-device.ts read those env vars, so
    // this parallelises the harness with no change to either.
    setupFiles: ["./e2e/support/worker-ports.ts"],
    // ONE-TIME setup, before any worker starts and outside every test budget.
    // It builds `e2e-fixture-gen`, which `seedVault` otherwise builds LAZILY
    // inside whichever test seeds first — a ~171 s `cargo build --release`
    // against a 180 s `testTimeout`, which is the whole of the "nav1 is flaky"
    // story and of several others. The file's header carries the measurement.
    globalSetup: ["./e2e/support/global-setup.ts"],
    // Parallelise across worker PROCESSES: N = `shardCount` (above) file workers
    // run concurrently, each driving its own tauri-driver + app on its own port
    // pair. `forks` (not threads) so each worker has its own
    // process.env for the port; within a worker `maxConcurrency: 1` keeps ONE
    // app at a time (a file's scenarios stay sequential). The concurrent apps
    // share the single CI Xvfb display — the pattern multi-device.ts already
    // proves (two apps on one display; WebDriver routes input to each session's
    // WebView, not the X-focused window).
    pool: "forks",
    fileParallelism: true,
    maxWorkers: shardCount,
    maxConcurrency: 1,
    // Production-KDF unlocks (m=256 MiB, t=3) and full create flows run
    // inside scenarios; budget generously, fail loudly.
    // Scaled by the same `MYNE_E2E_TIMEOUT_SCALE` the harness applies to every
    // wait (`e2e/support/webdriver.ts`): a 45 s wait doubled to 90 s inside a
    // 180 s test budget would fail the test rather than the wait, and the report
    // would then name the whole scenario instead of the step that starved.
    testTimeout: 180_000 * timeoutScale,
    hookTimeout: 120_000 * timeoutScale,
    // Retry a failed e2e test (up to 3 attempts total). The whole suite drives a
    // real tauri-driver + production binary across MYNE_E2E_SHARDS parallel
    // worker processes (default 2) for ~84 files — so running the full suite puts
    // the host under cumulative load that ISOLATED runs never see, and timing-
    // sensitive steps (a post-reload editor re-mount, an autosave settle, a
    // cross-device tombstone propagation) occasionally exceed their wait budgets.
    // Each test owns a fresh vault + app instance (`scenario()` launches and
    // tears down per test, teardown in `finally`), so a retry runs against a
    // clean seat. This recovers TRANSIENT infra flakiness WITHOUT masking real
    // bugs — a genuinely broken or consistently-too-slow test fails every
    // attempt; the e2e/AGENTS.md "green 3× consecutive" authoring gate still owns
    // correctness. (Verified: notes-nc2 / spell / table-editing / sync-tombstone
    // each pass in isolation but flaked once under full-suite load.)
    retry: 2,
    // E2E failures should surface immediately in CI logs.
    //
    // The json + junit reporters are not decoration and are not for humans.
    // They are the two things a suite's exit code cannot tell you:
    //
    //   json  — HOW MANY tests executed, which `scripts/check-e2e-floor.mjs`
    //           turns into a failure when the count drops. Without it, a run
    //           that skipped everything and a run that verified everything are
    //           the same green.
    //   junit — per-test results in the one format every flake tracker reads.
    //           `retry` above silently rescues a test that failed twice, so the
    //           suite's own summary reports a flake rate of zero no matter how
    //           bad it gets; the archived XML is the only record that the first
    //           two attempts happened at all.
    //
    // Lane-keyed filename: the quarantine lane runs a different (much smaller)
    // set, and one shared path would let whichever lane finished last overwrite
    // the other's floor evidence.
    reporters: process.env.CI ? ["default", "json", "junit"] : ["verbose"],
    outputFile: {
      json: `.e2e-report/${lane}.json`,
      junit: `.e2e-report/${lane}.junit.xml`,
    },
  },
});
