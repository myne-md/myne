// Vitest config for this branch's review evidence (myne-md/myne#1049).
//
// A fifth config rather than an edit to `ui-pass.config.ts`, for the reason that
// file's own header gives: the include glob is what keeps a capture pass runnable
// on its own, and the UI-pass file photographs the surfaces of a different branch.
// Everything else is copied from it deliberately, including the 15-minute timeout:
// these frames drive a real app through tauri-driver, and a short timeout reports
// a slow surface as a missing one.
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["e2e/capture/ux-fixes.capture.ts"],
    environment: "node",
    globals: false,
    fileParallelism: false,
    maxConcurrency: 1,
    testTimeout: 900_000,
    hookTimeout: 120_000,
    reporters: ["verbose"],
  },
});
