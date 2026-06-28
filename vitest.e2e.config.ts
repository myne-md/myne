// Vitest config for the E2E harness (e2e-harness, MYND-129).
//
// Deliberately a SEPARATE config from `vitest.config.ts`: `pnpm test`
// (the unit/component suite, `tests/**`) must stay hermetic and fast,
// while E2E specs (`e2e/**/*.e2e.ts`) drive the real production binary
// through tauri-driver — Linux-only (SYNC-1), one app instance at a
// time, with wall-clock budgets that include Argon2id at production
// parameters (the VR-1 recovery-drill scenario, SYNC-9).
//
// Run via `pnpm test:e2e` (locally inside the container — see
// docs/dev/e2e.md — or in the Woodpecker E2E step).

import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["e2e/**/*.e2e.ts"],
    environment: "node",
    globals: false,
    // One tauri-driver/app pair at a time: the driver binds fixed ports
    // and the scenarios assume exclusive ownership of the window.
    fileParallelism: false,
    maxConcurrency: 1,
    // Production-KDF unlocks (m=256 MiB, t=3) and full create flows run
    // inside scenarios; budget generously, fail loudly.
    testTimeout: 180_000,
    hookTimeout: 120_000,
    // Retry a failed e2e test (up to 3 attempts total). The whole suite drives a
    // real tauri-driver + production binary, ONE at a time, in a single worker
    // process for all ~60 files — so running every file back-to-back puts the
    // host under cumulative load that ISOLATED runs never see, and timing-
    // sensitive steps (a post-reload editor re-mount, an autosave settle, a
    // cross-device tombstone propagation) occasionally exceed their wait budgets.
    // Each test owns a fresh vault + app instance (`scenario()` launches and
    // tears down per test, teardown in `finally`), so a retry runs against a
    // clean seat. This recovers TRANSIENT infra flakiness WITHOUT masking real
    // bugs — a genuinely broken or consistently-too-slow test fails every
    // attempt; the e2e/CLAUDE.md "green 3× consecutive" authoring gate still owns
    // correctness. (Verified: notes-nc2 / spell / table-editing / sync-tombstone
    // each pass in isolation but flaked once under full-suite load.)
    retry: 2,
    // E2E failures should surface immediately in CI logs.
    reporters: process.env.CI ? ["default"] : ["verbose"],
  },
});
