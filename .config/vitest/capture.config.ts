// Vitest config for the user-guide screenshot CAPTURE pass.
//
// Separate from both `vitest.config.ts` (unit) and `.config/vitest/e2e.config.ts`
// (E2E suite). The capture pass rides the same tauri-driver harness but
// is NOT a test — it produces PNGs for the guide-golive screenshot gate
// (MYND-252). It lives under `e2e/capture/*.capture.ts` so `pnpm test:e2e`
// (which globs `e2e/**/*.e2e.ts`) never picks it up.
//
// Run via `scripts/capture-userguide.sh` (Linux container — tauri-driver
// has no macOS support, docs/dev/e2e.md). Self-skips off-platform.

import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["e2e/capture/**/*.capture.ts"],
    environment: "node",
    globals: false,
    fileParallelism: false,
    maxConcurrency: 1,
    // One app boot builds a vault through the UI and snaps every frame —
    // budget generously (Argon2id unlock + lazy KaTeX/mermaid mounts). The
    // expanded ~60-frame pass at @2x (--retina) needs headroom beyond the
    // original 600s: best-effort frames each wait out their timeout, and 2x
    // rendering is slower, so the full pass can run ~10-14 min.
    testTimeout: 900_000,
    hookTimeout: 120_000,
    reporters: ["verbose"],
  },
});
