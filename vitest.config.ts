// Vitest config for the Myne markdown dialect parser test suite.
//
// Tests live under `tests/` (currently `tests/dialect/` for B10.1). Vitest
// uses esbuild for transpilation, so TypeScript paths from tsconfig.json
// (moduleResolution: bundler) work without extension-less import quirks.
//
// Spec discipline: tests are NOT in src/ and therefore NOT covered by
// `pnpm build` (`tsc --noEmit` only checks `include: ["src"]`). Vitest is
// the only check that exercises test files.

import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts", "tests/**/*.test.tsx"],
    environment: "node",
    globals: false,
  },
});
