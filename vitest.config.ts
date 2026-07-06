// Vitest config for the Myne markdown dialect parser test suite.
//
// Tests live under `tests/` (currently `tests/dialect/` for B10.1). Vitest
// uses esbuild for transpilation, so TypeScript paths from tsconfig.json
// (moduleResolution: bundler) work without extension-less import quirks.
//
// Spec discipline: tests are NOT in src/ and therefore NOT covered by
// `pnpm build` (`tsc --noEmit` only checks `include: ["src"]`). Vitest is
// the only check that exercises test files.

import { resolve } from "node:path";
import { defineConfig } from "vitest/config";

const src = (p: string) => resolve(process.cwd(), p);

export default defineConfig({
  // The shared editor/dialect engines are pnpm-workspace packages symlinked into
  // node_modules, which Vitest treats as EXTERNAL deps — so `vi.mock` hoisting is
  // skipped for their internal imports and test mocks of `@tauri-apps/api/*` and
  // intra-package siblings (recordingBar, toast, …) silently miss. Aliasing the
  // package specifiers to their on-disk source (OUTSIDE node_modules) makes Vitest
  // inline + transform them, so module mocking behaves exactly as it did before
  // the editor/dialect extraction. Build (vite.config.ts) is untouched — it still
  // resolves the packages through their `exports` map from node_modules.
  resolve: {
    alias: [
      { find: /^@myne\/editor$/, replacement: src("editor/src/index.ts") },
      { find: /^@myne\/editor\/(.*)$/, replacement: src("editor/src/$1") },
      { find: /^@myne\/dialect$/, replacement: src("dialect/src/index.ts") },
      { find: /^@myne\/dialect\/(.*)$/, replacement: src("dialect/src/$1") },
      // The editor engine moved wholesale to the package, leaving `src/editor/*`
      // as re-export shims. A test that `vi.mock`s a shim path would target a
      // DIFFERENT module id than the sibling the module-under-test imports
      // internally (`./foo` → `editor/src/foo`), so the mock would miss. Collapse
      // any relative `…/src/editor/*` reference to the real package source so the
      // ids match and existing test mocks keep working untouched.
      { find: /^(?:\.\.\/)+src\/editor\/(.*)$/, replacement: src("editor/src/$1") },
    ],
  },
  test: {
    include: ["tests/**/*.test.ts", "tests/**/*.test.tsx"],
    environment: "node",
    globals: false,
    // Initialise the shared i18n instance so components calling
    // `useTranslation()` render with real source strings (see the file).
    setupFiles: ["./tests/setup-i18n.ts", "./tests/setup-editor-host.ts"],
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
