// Runtime probe: are we inside a Tauri host?
//
// **`closeApp()` used to live here and is gone** (phase3-web-client task 95).
// It was the fail-closed screens' primary CTA, and its web arm was a
// `console.warn` in dev and a bare `return` in production — so in the web build
// the only button on the screen where the user is most stuck did nothing at all.
// The action moved to the platform seam (`src/platform/app-exit.ts`), where the
// two arms differ honestly (destroy the window vs reload the page) and the CTA's
// LABEL travels with the behaviour so the button cannot lie about itself.
//
// Deleted rather than left unimported: task 95's criterion is that `closeApp` be
// ABSENT from the web bundle, and absence that depends on tree-shaking is a
// property of the bundler's mood rather than of the code.

/**
 * `true` when running inside `pnpm tauri dev` / production bundle (the
 * Tauri runtime injects `window.__TAURI_INTERNALS__`); `false` under
 * pure-browser dev (e.g. `pnpm dev` without `tauri dev`). Module-load
 * constant — cheaper than per-call check.
 */
export const HAS_TAURI = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
