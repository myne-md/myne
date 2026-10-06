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
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import packageJson from "../package.json";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const storiesRoot = fileURLToPath(new URL(".", import.meta.url));

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
    // Both are referenced by components the catalogue mounts (AboutPanel reads
    // them). The commit is a fixed sentinel here: the catalogue is dev tooling,
    // not a shipped build whose provenance needs recording.
    __APP_VERSION__: JSON.stringify(packageJson.version),
    __BUILD_COMMIT__: JSON.stringify("stories"),
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
