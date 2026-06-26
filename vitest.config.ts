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
    // Initialise the shared i18n instance so components calling
    // `useTranslation()` render with real source strings (see the file).
    setupFiles: ["./tests/setup-i18n.ts"],
    // Coverage targets the application code under `src/`; the `tests/`
    // unit suite is what drives the measurement. E2E + capture configs
    // live elsewhere and are not part of this report. `all: true` reports
    // untested `src/` files as 0% so the denominator is honest.
    coverage: {
      provider: "v8",
      reporter: ["text", "html", "lcov"],
      reportsDirectory: "./coverage",
      include: ["src/**/*.{ts,tsx}"],
      exclude: [
        "src/**/*.d.ts",
        "src/**/__mocks__/**",
        "src/main.tsx",
        "src/vite-env.d.ts",
      ],
      all: true,
    },
  },
});
