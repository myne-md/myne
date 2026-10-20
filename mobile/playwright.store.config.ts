// Store-image capture lane. NOT a test suite.
//
// Its own config rather than a flag on `playwright.config.ts`, for the reason
// `.config/vitest/ui-pass.config.ts` states in its own header: the include glob
// is what keeps a pass from being collected by its neighbours. `testDir` and
// `testMatch` here are disjoint from the flow-logic tier's, so `pnpm test:flow`
// cannot pick these up and this lane cannot accidentally run a flow spec.
//
// TWO DELIBERATE DIFFERENCES FROM `playwright.config.ts`, both load-bearing:
//
// 1. **`reuseExistingServer: false`.** The flow-logic config sets it true, which
//    is right for a test that must not fight a developer for a port. It is wrong
//    here. The dev server port is machine-wide, so a server started from another
//    worktree would answer, and this pass would render THAT branch's app into
//    images this one commits to a store. Silently, because the output is a PNG
//    nobody reads line by line. A capture starts its own server or fails.
// 2. **Its own port.** `MYNE_MOBILE_DEV_PORT` is honoured so a caller can move it
//    again, but the default is not 1422 and never will be: sharing the
//    developer's port is exactly the collision the line above is about.
//
// The viewport and device scale factor are NOT set here. They are per set, a
// store rejects a screenshot at the wrong pixel size, and the plan carries them,
// so the spec creates its own context per set instead of inheriting one.

import { defineConfig } from "@playwright/test";

const PORT = process.env.STORE_DEV_PORT ?? "1433";
const BASE_URL = `http://localhost:${PORT}`;

export default defineConfig({
  testDir: "./tests/store-shots",
  testMatch: "**/*.spec.ts",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["list"]],
  use: {
    baseURL: BASE_URL,
    trace: "off",
  },
  webServer: {
    command: `pnpm dev --port ${PORT} --strictPort`,
    url: BASE_URL,
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
