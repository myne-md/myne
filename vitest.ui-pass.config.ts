// Vitest config for the UI-pass screenshot CAPTURE pass (myne-md/myne#772).
//
// A fourth config beside `vitest.capture.config.ts` rather than a flag on it,
// and for the reason that file's own header gives: the capture include glob
// is what keeps `pnpm test:e2e` from picking these up, so two capture passes
// that must be runnable independently need two globs. The guide pass builds a
// whole demo vault and snaps ~60 frames over 10-14 minutes; this one snaps the
// handful of surfaces a branch changed and is meant to be cheap enough to run
// per PR.
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["e2e/capture/ui-pass.capture.ts"],
    environment: "node",
    globals: false,
    fileParallelism: false,
    maxConcurrency: 1,
    testTimeout: 900_000,
    hookTimeout: 120_000,
    reporters: ["verbose"],
  },
});
