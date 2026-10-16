// Vitest config for the story catalogue's render checks (myne-md/myne#832).
//
// The smoke and drift checks render real components, so they need a DOM and the
// app's boot setup. That is why they are Vitest specs rather than standalone
// `.mjs` guards: a Node script cannot import the catalogue's `.css` or its
// `@myne/*` source, and Vite is what resolves both. The build-free guards
// (coverage, isolation) stay standalone and run in `pre-commit`.
//
// The shared `vitest.config.ts` is not extended: it scopes its own aliases and
// setup to the main suite, and this lane needs a story host installed before any
// app module body runs.

import { resolve } from "node:path";
import { defineConfig } from "vitest/config";

const src = (p: string) => resolve(process.cwd(), p);

export default defineConfig({
  define: {
    __APP_VERSION__: JSON.stringify("test"),
    __BUILD_COMMIT__: JSON.stringify("test"),
    // The shell reads this for the source links and the issue URL. Without it a
    // test that mounts `App` throws on a free variable the moment either path
    // runs, which is why the shell had no test at all until now.
    __STORIES_BRANCH__: JSON.stringify("test"),
    // The shell's two leak-free guards read this too (`STORIES_PUBLIC=1` in
    // `stories/vite.config.ts`). `false` because every test mounts the DEFAULT
    // shell: the public variant is a different build with a different rendering,
    // and `scripts/check-stories-public-bundle.mjs` is what asserts it — on the
    // artefact, where the property actually lives. Leaving this undefined is the
    // same free-variable failure the comment above records, one global later.
    __STORIES_PUBLIC__: JSON.stringify(false),
    // `AboutPanel` reads all three compile-time globals during render. Without
    // this one the smoke check died on `settings/aboutpanel/default` with
    // `ReferenceError: __UPDATE_CHANNEL__ is not defined`. The same gap the
    // catalogue's own Vite config had (myne-md/myne#843).
    __UPDATE_CHANNEL__: JSON.stringify("stable"),
  },
  resolve: {
    alias: [
      // String aliases (not regex) for the stories' own imports: this is the
      // form the working `stories/vite.config.ts` uses, and the regex form left
      // the resolved path without extension resolution under Vitest.
      { find: "@stories", replacement: src("stories/src") },
      { find: "@app", replacement: src("src") },
      { find: /^@myne\/editor$/, replacement: src("editor/src/index.ts") },
      { find: /^@myne\/editor\/(.*)$/, replacement: src("editor/src/$1") },
      { find: /^@myne\/dialect$/, replacement: src("dialect/src/index.ts") },
      { find: /^@myne\/dialect\/(.*)$/, replacement: src("dialect/src/$1") },
    ],
  },
  test: {
    include: ["tests/stories/**/*.test.{ts,tsx}"],
    environment: "jsdom",
    globals: false,
    setupFiles: [
      "./tests/setup-jsdom-cm6.ts",
      "./tests/setup-jsdom-observer.ts",
      "./tests/setup-i18n.ts",
      "./tests/setup-editor-host.ts",
      "./tests/setup-story-host.ts",
    ],
  },
});
