// Flow-logic test config (MYND-462 task 3) — the Playwright-vs-dev-server tier.
//
// THIS IS NOT AN END-TO-END SUITE. It drives the React app in headless Chromium
// against the Vite DEV SERVER with a MOCK Tauri IPC (`tests/flow-logic/mock-ipc`),
// so it exercises component + flow-machine logic ONLY — there is no device, no
// WKWebView, no Rust backend, no real transport. Device-level UI end-to-end
// testing is the SYNC-44 exemption, tracked separately (MYND-467). Keep the
// "flow-logic" label on the script, this config, and any CI step — never label
// this tier end-to-end.

import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/flow-logic",
  testMatch: "**/*.flow.ts",
  fullyParallel: true,
  retries: 0,
  reporter: [["list"]],
  use: {
    baseURL: "http://localhost:1420",
    trace: "off",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    // The Tauri-aware Vite dev server (strictPort 1420). Reuse a server the
    // developer already has running; start one otherwise.
    command: "pnpm dev",
    url: "http://localhost:1420",
    reuseExistingServer: true,
    timeout: 120_000,
  },
});
