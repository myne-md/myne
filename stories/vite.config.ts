// Vite config for the `stories/` target: the in-repo design-system story
// catalogue (myne-md/myne#832).
//
// Same model as `web/`: the root is a subdirectory, it owns no `package.json`,
// and the root `package.json` carries the scripts. Unlike `web/`, nothing is
// substituted: the desktop platform seam (`src/platform/*`) is exactly what we
// want, and `stories/src/host/internals.ts` installs a fake
// `window.__TAURI_INTERNALS__` before boot so every `invoke(cmd)` routes to
// canned fixture data instead of Rust. Mounting the real seam against a fake
// host is the point: the catalogue shows the app, not an imitation of it.
//
// It shares the repository's `public/` so the catalogue serves the same fonts,
// marks and Excalidraw assets. Its own dev server is on 1423; desktop holds
// 1420, web 1421, mobile 1422, so all four can run at once.

import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import packageJson from "../package.json";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const storiesRoot = fileURLToPath(new URL(".", import.meta.url));

/**
 * The PUBLIC variant, built with `STORIES_PUBLIC=1` (`pnpm stories:build:public`).
 *
 * The catalogue mounts the real screens against canned fixtures and, in its
 * default build, offers two affordances that only make sense to somebody with
 * access to this repository: "Show on GitHub", which links the surface's source
 * to `github.com/myne-md/myne`, and "File issue", which opens that repository's
 * issue form. Both are dead for anyone else, because every `myne-md` repository
 * is private and both URLs answer 404 to a non-member.
 *
 * So the variant that ships to `design.myne.md` renders neither. That is a
 * DIFFERENT build rather than a runtime check on purpose: a runtime flag would
 * leave the URLs in the served bundle, one devtools breakpoint away, and the
 * whole property is about what is IN the artefact. The `data-catalogue`
 * attribute below is the positive sentinel `check-stories-public-bundle.mjs`
 * asserts, so "no GitHub URL" cannot be satisfied by an empty or mis-wired
 * build.
 *
 * Output goes to its own directory so the two variants do not clobber each
 * other, and so a reviewer can tell at a glance which one they are looking at.
 */
const isPublic = process.env.STORIES_PUBLIC === "1";

/** The branch the source links point at, so a link resolves for a reader on it. */
function branchName(): string {
  try {
    return execSync("git rev-parse --abbrev-ref HEAD", { cwd: repoRoot, encoding: "utf8" }).trim();
  } catch {
    return "develop";
  }
}

export default defineConfig({
  root: storiesRoot,
  plugins: [react()],
  // **Its OWN dependency cache** (2026-10-24). Vite's optimizer is per-project
  // but every target in this repository resolves the SAME `node_modules/.vite`
  // directory, so the catalogue (:1423) and the app (`pnpm dev`, :1420) evict
  // each other's pre-bundled chunks: the server that re-optimizes last wins, and
  // the other one's page keeps requesting hashes that are no longer served, which
  // Vite answers with `504 Outdated Optimize Dep`. The damage is not the 504 —
  // it is what a lazy chunk import does with it, and the password step's strength
  // meter was the surface where it showed: `Checking strength…` forever. Separate
  // directories make the two servers independent; running them at once is the
  // documented workflow, so they have to be.
  cacheDir: fileURLToPath(new URL("../node_modules/.vite-stories", import.meta.url)),
  publicDir: fileURLToPath(new URL("../public", import.meta.url)),
  resolve: {
    alias: {
      "@app": fileURLToPath(new URL("../src", import.meta.url)),
      "@stories": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  define: {
    // All three compile-time globals are referenced by components the catalogue
    // mounts (AboutPanel reads every one of them). Missing `__UPDATE_CHANNEL__`
    // was not a missing label: it is a bare identifier read during render, so
    // the panel threw `ReferenceError` and, with no boundary in the shell, took
    // the whole catalogue down with it. The commit and channel are fixed
    // sentinels here: the catalogue is dev tooling, not a shipped build whose
    // provenance needs recording.
    __APP_VERSION__: JSON.stringify(packageJson.version),
    __BUILD_COMMIT__: JSON.stringify("stories"),
    __UPDATE_CHANNEL__: JSON.stringify("stable"),
    // The branch a source link is pinned to (myne-md/myne#845). A link is only
    // useful if it resolves to the tree the reader is looking at.
    __STORIES_BRANCH__: JSON.stringify(branchName()),
    // The public variant (see `isPublic` above). Compile-time rather than
    // runtime, because the property is about what reaches the artefact.
    __STORIES_PUBLIC__: JSON.stringify(isPublic),
  },
  // The shared tree lives above the Vite root; allow the whole checkout.
  server: {
    port: 1423,
    strictPort: true,
    fs: { allow: [repoRoot] },
  },
  build: {
    outDir: fileURLToPath(
      new URL(isPublic ? "./dist-public" : "./dist", import.meta.url),
    ),
    emptyOutDir: true,
  },
});
