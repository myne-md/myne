// Playwright config for the mobile review-evidence capture (myne-md/myne#1049).
//
// A sibling of `playwright.config.ts` rather than a flag on it: that config is the
// flow-logic TIER and its projects are the device shapes the tier asserts across.
// This one exists to photograph the phone's settings surfaces on one shape, so it
// reuses the same dev server and mock harness with a single project.
import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/flow-logic",
  testMatch: ["ux-fixes-shots.capture.ts"],
  fullyParallel: false,
  workers: 1,
  reporter: [["list"]],
  use: {
    baseURL: "http://localhost:1422",
    ...devices["Pixel 7"],
  },
  webServer: {
    command: "pnpm exec vite --port 1422 --strictPort",
    url: "http://localhost:1422",
    reuseExistingServer: true,
    timeout: 120_000,
  },
});
