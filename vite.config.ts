import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import packageJson from "./package.json";

// @ts-expect-error process is a nodejs global
const host = process.env.TAURI_DEV_HOST;

// https://vite.dev/config/
/**
 * The short commit this build came from, or `"unknown"`.
 *
 * Never throws: a source tarball, a shallow CI checkout or a machine without
 * git must still be able to build. An unavailable commit is a missing readout,
 * not a broken build.
 */
function buildCommit(): string {
  try {
    return execFileSync("git", ["rev-parse", "--short=9", "HEAD"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return "unknown";
  }
}

// ── The dev server's watch roots ──────────────────────────────────────────────
//
// This list is READ BY `scripts/perf-baseline.mjs`, which counts what the
// dev server walks and fails by name when it can no longer find this array —
// one copy of the rule, so the instrument cannot drift from the thing it
// measures.
//
// `src/` is the shared React tree; `public/` is served by the dev server;
// `locales/` is globbed by `src/i18n`; and the last five are the pnpm workspace
// packages consumed as SOURCE (`pnpm-workspace.yaml`), so a change in one is a
// change to the running app and each needs HMR. `preview/` and `mobile/` are
// workspace members too and are deliberately absent: neither is reachable from
// this app's module graph, and each has its own dev server (`mobile/`, `web/`).
export const WATCHED_ROOTS = [
  "src",
  "public",
  "locales",
  "client-core",
  "copy",
  "dialect",
  "editor",
  "ornaments",
] as const;

/** The repository root, taken from this config file's own location rather than
 *  `process.cwd()`. `tauri dev` runs the dev command with `src-tauri` as the
 *  working directory, and a root resolved from the wrong cwd would match no real
 *  path at all: everything would be ignored and HMR would stop with nothing
 *  logged anywhere. */
const WATCH_ROOT = fileURLToPath(new URL(".", import.meta.url))
  .replace(/\\/g, "/")
  .replace(/\/$/, "");

/** Whether the dev server should watch `watched`, which is absolute as chokidar
 *  hands it over.
 *
 *  An entry in the repository root itself — `index.html`, `pdf-export.html`,
 *  `vite.config.ts`, `package.json`, `tsconfig*.json` — is always watched: Vite
 *  reloads on a config edit, and naming those in a second list would be a second
 *  place for them to go stale. The cost is that `target/` is READ one directory
 *  deep (chokidar finds `target/debug` and the rule refuses it there), which is
 *  a handful of `readdir` calls rather than 70,217 paths. */
export function isWatchedByDevServer(watched: string): boolean {
  const p = watched.replace(/\\/g, "/");
  // The root ITSELF is asked about before chokidar descends, and refusing it
  // stops the walk at depth zero. The first version of this predicate did
  // exactly that, because `WATCH_ROOT` carries no trailing slash here and
  // `startsWith(WATCH_ROOT + "/")` was therefore false for it: HMR went silent
  // and the only thing that said so was a counting probe in this position.
  // Keep the equality arm.
  if (p === WATCH_ROOT) return true;
  if (!p.startsWith(WATCH_ROOT + "/")) return false;
  const rel = p.slice(WATCH_ROOT.length + 1);
  const slash = rel.indexOf("/");
  if (slash === -1) return true;
  return (WATCHED_ROOTS as readonly string[]).includes(rel.slice(0, slash));
}

export default defineConfig(async () => ({
  plugins: [react()],

  // Compile-time injection of package.json version. Surfaces in the
  // Settings → About panel ("Myne 0.1.0"). `package.json` is the
  // single source of truth; reading it here keeps `tauri.conf.json`
  // version + AboutPanel display + bundle metadata in lockstep
  // without runtime JSON parsing or bundling unrelated package.json
  // fields into the WebView. Type declaration: `src/vite-env.d.ts`.
  define: {
    __APP_VERSION__: JSON.stringify(packageJson.version),
    // The commit this build came from (phase3-web-client task 114). An INPUT to
    // the build, so it can be a define — unlike the bundle hash, which is an
    // output and therefore cannot be (a bundle cannot contain its own hash;
    // `scripts/emit-web-version.mjs` computes it afterwards).
    //
    // Resolved at config time with a fallback, because a source tarball or a
    // CI checkout without git history must still build — an unavailable commit
    // is "unknown", never a failed build.
    __BUILD_COMMIT__: JSON.stringify(buildCommit()),
    // The update channel this build follows (`stable` or `beta`). A build-time
    // input, like the other defines: the release sets `MYNE_UPDATE_CHANNEL=beta`
    // for the beta flavor, and the updater's endpoint is resolved from the same
    // variable in Rust (`src-tauri/src/update/mod.rs`, `Channel::from_env`).
    // Nothing here needs to match a second config: `tauri.conf.json`
    // deliberately carries no endpoint, because the plugin's own list would be
    // overridden rather than merged. `scripts/check-update-channel.mjs` holds
    // this define and the Rust table together. Defaults to `stable`.
    __UPDATE_CHANNEL__: JSON.stringify(process.env.MYNE_UPDATE_CHANNEL ?? "stable"),
  },

  // Multi-page build: `pdf-export.html` is the hidden PDF-export render
  // window's page (MYND-255) — the Rust side loads it via
  // `WebviewUrl::App("pdf-export.html")` under the near-empty
  // `src-tauri/capabilities/pdf-export.json` capability. The dev server
  // serves it at /pdf-export.html automatically; the production build
  // needs the explicit rollup input so it lands in dist/.
  build: {
    rollupOptions: {
      input: {
        main: fileURLToPath(new URL("./index.html", import.meta.url)),
        "pdf-export": fileURLToPath(
          new URL("./pdf-export.html", import.meta.url),
        ),
      },
    },
  },

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
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
      // ── What the dev server watches, as an ALLOWLIST ────────────────────────
      //
      // This used to be `ignored: ["**/src-tauri/**"]` — a denylist, so every
      // other path under the repository root was watched. Measured on
      // 2026-10-17 with a counting predicate in this position, Vite asked about
      // **84,379 distinct paths**, of which **70,217 were under `target/`**
      // (83%): a build-output directory that has never been an input to the
      // client. The rest of the top of that list was `myne-agents/` (2,672) and
      // the other nested companion checkouts, then `mobile/`, `tests/`, `docs/`,
      // `web/`, `e2e/` and `.opencode/` — none of them reachable from this app.
      // (One more top-level directory belongs on that list and is deliberately
      // not named here: a guard fails a plain string match on the story
      // catalogue's own name anywhere in an app build root, and it is right to,
      // because a regex cannot tell a comment from an import.)
      //
      // Chokidar consults the ignore rule on a DIRECTORY before descending into
      // it, so an allowlist skips the walk rather than filtering its events. The
      // 84,379 above is a filesystem walk, and skipping it is the whole win.
      //
      // The failure a denylist cannot see, and the reason this is written as an
      // allowlist rather than as more globs: a new build-output directory (a
      // second target dir, a fixture cache, a coverage report) joins the watch
      // set on the day it appears, and nothing anywhere reports that. Here the
      // default is "not watched" and gaining a watched root is an edit to this
      // list.
      //
      // `**/src-tauri/**` is gone rather than kept: the allowlist subsumes it,
      // and Tauri watches its own crate. Two mechanisms for it would be two
      // places for it to drift.
      //
      // Verify with `node scripts/perf-baseline.mjs` (it prints the walk count),
      // with `tests/vite/watchedPaths.test.ts` (it drives this predicate through
      // the real config file, including the root case whose absence kills HMR),
      // and by editing a file in each root and watching the HMR update land.
      ignored: (watched: unknown) => {
        // Vite hands chokidar `[path, stats]`; chokidar may also probe a bare
        // path. Both shapes reach here.
        const p = Array.isArray(watched) ? String(watched[0]) : String(watched);
        return !isWatchedByDevServer(p);
      },
    },
  },
}));
