import { defineConfig } from "vitest/config";

// Frontend unit tests for the mobile client — mirrors the main repo's vitest
// setup. Tests live under `tests/` (NOT `src/`), so `pnpm build` (tsc, which
// only checks `include: ["src"]`) does not cover them; `pnpm test` is the gate.
//
// The cryptographic primitives are validated upstream by `myne-test-vectors`
// against the shared `protocol` crate (reused here by path dep, byte-identical
// by construction), and the mirrored backend carries 560 Rust unit tests
// (`cargo test`). These TS tests cover the ported state machine + helpers.
export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts", "tests/**/*.test.tsx"],
    environment: "node",
    globals: false,
  },
});
