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
  // Vite's compile-time `define`s (vite.config.ts) don't apply here — Vitest
  // has its own config, not an extension of vite.config.ts (this file's own
  // header). AboutPanel.tsx references both directly, so a bare render throws
  // `ReferenceError: __APP_VERSION__ is not defined` without these; the actual
  // values are irrelevant to any test, so fixed stubs are fine.
  define: {
    __APP_VERSION__: JSON.stringify("test"),
    __BUILD_COMMIT__: JSON.stringify("test"),
    __UPDATE_CHANNEL__: JSON.stringify("stable"),
  },
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
    // The story catalogue's render checks live under `tests/stories/` and are
    // owned by `vitest.stories.config.ts` (myne-md/myne#832): they need the
    // fake-IPC story host installed before any app module body runs and a jsdom
    // environment, neither of which belongs in this suite's setup. Excluded
    // here explicitly rather than left to fall through `include` above, so the
    // two lanes cannot both claim the same specs. The defaults are restated
    // because setting `exclude` replaces them.
    exclude: [
      "**/node_modules/**",
      "**/dist/**",
      "**/cypress/**",
      "**/.{idea,git,cache,output,temp}/**",
      "**/{karma,rollup,webpack,vite,vitest,jest,ava,babel,nyc,cypress,tsup,build,eslint,prettier}.config.*",
      "tests/stories/**",
    ],
    // Initialise the shared i18n instance so components calling
    // `useTranslation()` render with real source strings (see the file).
    setupFiles: [
      "./tests/setup-jsdom-cm6.ts",
      "./tests/setup-i18n.ts",
      "./tests/setup-editor-host.ts",
    ],
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
