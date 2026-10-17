// Vitest config for the WEB E2E lane (MYND-574 task 105).
//
// A third config, and each of the three exists for a reason the other two
// cannot serve:
//
// * `vitest.config.ts` — the hermetic unit/component suite (`tests/**`). No
//   browser, no binary, must stay fast.
// * `.config/vitest/e2e.config.ts` — the desktop lane: the production Tauri binary
//   through tauri-driver. Linux-only, Argon2id-sized timeouts.
// * **this one** — the built web bundle in a real browser, served by the
//   harness's own server with the PRODUCTION security headers.
//
// The web lane needs no binary build and no display server, so it is cheap
// relative to the tauri-driver suite — but it does need a built bundle and a
// pinned driver, and it **self-skips with one actionable reason** when either is
// missing (`e2e-web/support/harness.ts`) rather than failing or, worse, passing
// vacuously.
//
// Run via `pnpm test:e2e:web`.

import { defineConfig } from "vitest/config";
// Resolved against THIS FILE's directory, not the repo root: a config that moved
// away from the root owes its own relative imports a re-count of `../`.
import { harnessEnv, harnessSupport } from "../../e2e-web/support/harness";

// The reason is printed HERE, from the main process, and that is a fix rather
// than a preference. `support/scenario.ts` already warns at import time — but it
// imports inside a forked WORKER, and vitest does not surface a worker's console
// output for a file whose every suite is skipped. So the module that exists to
// stop a suite skipping silently was, itself, skipping silently: `pnpm
// test:e2e:web` printed "1 skipped" and nothing else on a machine with no
// driver, which is precisely the three-weeks-of-nobody-noticing failure its own
// header warns about. The config runs before any worker and its output is never
// filtered.
const support = harnessSupport(harnessEnv());
if (!support.ok) {
  // eslint-disable-next-line no-console
  console.warn(`\n[e2e-web] the web E2E lane will SKIP: ${support.reason}\n`);
}

export default defineConfig({
  test: {
    include: ["e2e-web/**/*.e2e.ts"],
    environment: "node",
    globals: false,
    // Per-worker setup: each slot gets its own driver port AND its own bundle
    // port. The second is the load-bearing one — OPFS is keyed by ORIGIN, so two
    // slots sharing a bundle server would share a vault, and one test's data
    // would be visible to its neighbour.
    setupFiles: ["./e2e-web/support/worker-ports.ts"],
    // `forks` (not threads) so each worker owns its own `process.env` for those
    // ports, exactly as the desktop lane does.
    pool: "forks",
    fileParallelism: true,
    maxWorkers: Number(process.env.MYNE_WEB_E2E_SHARDS ?? "2"),
    // One browser session at a time within a file, so a file's scenarios stay
    // sequential and a failure names one scenario rather than a race.
    maxConcurrency: 1,
    // Production-KDF unlocks run in the browser here (Argon2id m=256 MiB, t=3,
    // measured 464–680 ms across engines in the Phase 0 spike), plus a real
    // first-sync materialisation. Generous, and it fails loudly rather than
    // quietly stretching.
    testTimeout: 120_000,
    hookTimeout: 60_000,
  },
});
