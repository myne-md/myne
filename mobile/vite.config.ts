import { fileURLToPath, URL } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import packageJson from "./package.json";

// @ts-expect-error process is a nodejs global
const host = process.env.TAURI_DEV_HOST;

// Resolve a path relative to THIS config file (myne-mobile/), so the sibling
// shared packages under the parent `myne/` repo resolve regardless of cwd.
const sib = (p: string) => fileURLToPath(new URL(p, import.meta.url));

// Tauri-aware Vite config — mirrors the main `myne` desktop repo.
// https://v2.tauri.app/start/frontend/vite/
export default defineConfig(async () => ({
  plugins: [react()],

  // The shared editor/dialect engines are consumed AS SOURCE from the sibling
  // `myne/{editor,dialect}` packages (the WebView analog of the Rust
  // `path`-dep on `../../core`; decisions.md 2026-07-05). Alias the `@myne/*`
  // specifiers straight to that source so Vite compiles them into the mobile
  // bundle — no publish/link step, exactly like the desktop repo does in-tree.
  resolve: {
    alias: [
      { find: /^@myne\/editor\/CMEditor$/, replacement: sib("../editor/src/CMEditor.tsx") },
      { find: /^@myne\/editor$/, replacement: sib("../editor/src/index.ts") },
      { find: /^@myne\/editor\/(.*)$/, replacement: sib("../editor/src/$1") },
      { find: /^@myne\/dialect$/, replacement: sib("../dialect/src/index.ts") },
      { find: /^@myne\/dialect\/(.*)$/, replacement: sib("../dialect/src/$1") },
      // The shared English catalog (repo-root `locales/en`) — now consumed only
      // by `src/lib/welcomeNote.ts` for its seed-time welcome-note copy. (The
      // editor host resolved its labels through this too until MYND-485 moved it
      // onto the full `@myne/i18n` runtime below.)
      { find: "@myne/locales-en", replacement: sib("../locales/en/common.json") },
      // The shared react-i18next RUNTIME (MYND-485). NOTE — unlike @myne/editor /
      // dialect / copy (extracted top-level workspace packages), this aliases the
      // desktop APP source `../src/i18n/` directly, so mobile source-depends on
      // desktop internals with no package contract. It works because that runtime
      // is Tauri-free + portable (its `import.meta.glob("../../locales/*")` is
      // file-relative → loads all 24 shared catalogs whichever client imports it).
      // FOLLOW-UP: extract `src/i18n/` into a real `@myne/i18n` package (like
      // `copy/`) and make desktop's `src/i18n` a re-export shim.
      { find: /^@myne\/i18n$/, replacement: sib("../src/i18n/index.ts") },
      { find: /^@myne\/i18n\/(.*)$/, replacement: sib("../src/i18n/$1") },
    ],
    // The aliased editor source lives OUTSIDE this repo (../editor/src), so its
    // bare-specifier imports could otherwise resolve to the parent repo's
    // node_modules — a second physical copy that silently breaks CM6's
    // cross-module `instanceof`/facet invariants. Dedupe every engine dep so
    // Vite always resolves them to mobile's own single copy.
    dedupe: [
      "@codemirror/state",
      "@codemirror/view",
      "@codemirror/language",
      "@codemirror/commands",
      "@codemirror/autocomplete",
      "@codemirror/search",
      "@codemirror/lang-css",
      "@codemirror/lang-html",
      "@codemirror/lang-javascript",
      "@codemirror/lang-json",
      "@codemirror/lang-markdown",
      "@codemirror/lang-python",
      "@codemirror/lang-rust",
      "@codemirror/lang-yaml",
      "@codemirror/legacy-modes",
      "@lezer/common",
      "@lezer/highlight",
      "@lezer/markdown",
      "katex",
      "mermaid",
      "dompurify",
      "js-yaml",
      "react",
      "react-dom",
      // i18n singletons: the aliased desktop runtime and mobile components must
      // share ONE react-i18next context instance, so dedupe to mobile's copy.
      "i18next",
      "react-i18next",
    ],
  },

  // Compile-time version injection (Settings → About reads __APP_VERSION__).
  define: {
    __APP_VERSION__: JSON.stringify(packageJson.version),
  },

  // Vite options tailored for Tauri development.
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      // 3. tell Vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**"],
    },
    // 4. the shared @myne/{editor,dialect} source + en catalog live in the parent
    //    `myne/` repo (one level up), so let the dev server serve from there.
    fs: {
      allow: [sib("."), sib("..")],
    },
  },
}));
