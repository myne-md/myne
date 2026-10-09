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
  },
  // The shared tree lives above the Vite root; allow the whole checkout.
  server: {
    port: 1423,
    strictPort: true,
    fs: { allow: [repoRoot] },
  },
  build: {
    outDir: fileURLToPath(new URL("./dist", import.meta.url)),
    emptyOutDir: true,
  },
});
