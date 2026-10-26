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

/**
 * The dev-server port, overridable.
 *
 * **Why it is not simply 1422.** The port is a MACHINE-wide resource and
 * `reuseExistingServer` is on, so a mobile dev server started from another
 * worktree answers on it and this suite then drives THAT branch's app while
 * reporting against this one's spec files. It happened while myne-md/myne#609
 * was being reviewed: six new specs failed with "waiting for
 * getByTestId('settings.dateTime.date-select')" and a page snapshot showing an
 * Editor panel that genuinely had no such row, because the row is on this branch
 * and the server was on another. That reads as a missing testid, not as a wrong
 * server, which is why it cost an hour. The repo already records the same trap
 * one port down, where a desktop `tauri dev` on 1420 made this tier connect to
 * the desktop app.
 *
 * `MYNE_MOBILE_DEV_PORT=1522 pnpm test:flow` runs against a server you started
 * yourself, which is the answer when the shared port is taken and killing
 * somebody else's server is not.
 */
const PORT = process.env.MYNE_MOBILE_DEV_PORT ?? "1422";
const BASE_URL = `http://localhost:${PORT}`;

export default defineConfig({
  testDir: "./tests/flow-logic",
  testMatch: "**/*.flow.ts",
  fullyParallel: true,
  retries: 0,
  reporter: [["list"]],
  use: {
    baseURL: BASE_URL,
    trace: "off",
  },
  projects: [
    {
      // Phone tier. The viewport is PINNED to a phone size: Desktop Chrome's
      // default 1280×720 would flip the width-driven size-class (SizeClassContext)
      // into the tablet layout and silently change what every phone spec exercises.
      // `screen` is pinned too — the size-class phone guard reads window.screen.
      name: "chromium",
      testIgnore: ["tablet/**", "duo/**"],
      use: { ...devices["Desktop Chrome"], viewport: { width: 390, height: 844 }, screen: { width: 390, height: 844 } },
    },
    // Tablet tier — the same specs run at each form factor; they branch on
    // viewport width where expanded (three-pane) and medium (two-pane) differ.
    // `screen` matches the viewport so the SizeClassContext device guard
    // (min(screen.w,h) ≥ 480) sees a tablet; specs that simulate iPad Split
    // View narrow only the VIEWPORT, exactly like the real thing.
    {
      name: "tablet-ipad-landscape",
      testMatch: "tablet/**/*.flow.ts",
      use: { ...devices["Desktop Chrome"], viewport: { width: 1194, height: 834 }, screen: { width: 1194, height: 834 }, hasTouch: true },
    },
    {
      name: "tablet-ipad-portrait",
      testMatch: "tablet/**/*.flow.ts",
      use: { ...devices["Desktop Chrome"], viewport: { width: 834, height: 1194 }, screen: { width: 834, height: 1194 }, hasTouch: true },
    },
    {
      name: "tablet-android",
      testMatch: "tablet/**/*.flow.ts",
      use: { ...devices["Desktop Chrome"], viewport: { width: 1280, height: 800 }, screen: { width: 1280, height: 800 }, hasTouch: true },
    },
    // Folded-band tier (myne-md/myne#918). `screen` and `viewport` are pinned
    // independently here on purpose: the size class reads both, the guard reads
    // `screen`, and a foldable's two panels mean the platform can report either
    // one. The second project exists precisely because nobody knows yet which
    // one WebKit reports on an unfolded iPhone Duo, so both answers are kept
    // green rather than the design depending on the answer.
    {
      // Unfolded, platform reporting the unfolded panel: 626 x 890 pt.
      name: "duo-unfolded",
      testMatch: "duo/**/*.flow.ts",
      use: { ...devices["Desktop Chrome"], viewport: { width: 626, height: 890 }, screen: { width: 626, height: 890 }, hasTouch: true },
    },
    {
      // Unfolded, platform still reporting the FOLDED panel: 626 x 890 window
      // over a 466 x 618 screen. This is the row the stale-screen exception in
      // SizeClassContext exists for.
      name: "duo-unfolded-stale-screen",
      testMatch: "duo/**/*.flow.ts",
      use: { ...devices["Desktop Chrome"], viewport: { width: 626, height: 890 }, screen: { width: 466, height: 618 }, hasTouch: true },
    },
    {
      // Folded: the phone layout, and it must stay that.
      name: "duo-folded",
      testMatch: "duo/**/*.flow.ts",
      use: { ...devices["Desktop Chrome"], viewport: { width: 466, height: 618 }, screen: { width: 466, height: 618 }, hasTouch: true },
    },
    {
      // Unfolded landscape: 890 wide takes the iPad's `medium` two-pane.
      name: "duo-landscape",
      testMatch: "duo/**/*.flow.ts",
      use: { ...devices["Desktop Chrome"], viewport: { width: 890, height: 626 }, screen: { width: 890, height: 626 }, hasTouch: true },
    },
    {
      // The Duo running beside another app: half the unfolded width, same screen.
      name: "duo-half-width",
      testMatch: "duo/**/*.flow.ts",
      use: { ...devices["Desktop Chrome"], viewport: { width: 313, height: 890 }, screen: { width: 626, height: 890 }, hasTouch: true },
    },
  ],
  webServer: {
    // The Tauri-aware Vite dev server (strictPort 1422 — the MOBILE port; the
    // desktop holds 1420 and the web client 1421). Reuse a server the developer
    // already has running; start one otherwise. `pnpm dev` resolves against
    // `mobile/package.json` because Playwright runs it with this config's
    // directory as cwd, so it starts the mobile server and not the desktop one.
    command: `pnpm dev --port ${PORT} --strictPort`,
    url: BASE_URL,
    reuseExistingServer: true,
    timeout: 120_000,
  },
});
