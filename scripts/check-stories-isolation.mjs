#!/usr/bin/env node
// check-stories-isolation.mjs, the story catalogue must never enter an app
// bundle (myne-md/myne#832).
//
// The catalogue is a separate Vite target, so it cannot enter a bundle by
// construction. What this guard protects is that CONSTRUCTION: the moment an
// app build config, a Tauri bundle manifest or the pnpm workspace roster starts
// pointing at `stories/`, the guarantee becomes an accident rather than a
// property. Nothing else would notice. The desktop build would compile the
// catalogue's fixtures in, and "deployable" would quietly become "shipped to
// users".
//
// The guarantee is "not inside the app bundles". The catalogue's OWN static
// build and its deploy are expected and are not flagged.

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname.replace(/\/$/, "");

/**
 * The configs that decide what an app ships, each with what a `stories`
 * reference in it would mean.
 *
 * The root `package.json` is deliberately ABSENT: it carries the `stories:*`
 * scripts and MUST name the directory. To keep that exemption honest rather than
 * a blanket gap, the guard checks `package.json` in the OTHER direction: it is
 * allowed to name `stories`, and it must still carry the `stories:build` script.
 */
export const GUARDED_CONFIGS = Object.freeze([
  {
    path: "vite.config.ts",
    reason: "the desktop WebView build root",
  },
  {
    path: "web/vite.config.ts",
    reason: "the web client Vite build",
  },
  {
    path: "mobile/vite.config.ts",
    reason: "the mobile client Vite build",
  },
  {
    path: "src-tauri/tauri.conf.json",
    reason: "the desktop Tauri bundle manifest (resources / externalBin)",
  },
  {
    path: "mobile/src-tauri/tauri.conf.json",
    reason: "the mobile Tauri bundle manifest",
  },
  {
    path: "pnpm-workspace.yaml",
    reason: "the workspace member roster (a `stories` member would be a second build graph)",
  },
]);

/** A token that, in a guarded config, means the catalogue leaked into an app. */
const LEAK = /\bstories\b/;

/** The pure comparison, so the test drives it without a real tree. */
export function findLeaks({ configs }) {
  const problems = [];
  for (const cfg of configs) {
    if (cfg.content == null) {
      problems.push(
        `${cfg.path} is listed as a guarded config but could not be read. A guard that skips a missing input reads as a pass.`,
      );
      continue;
    }
    if (LEAK.test(cfg.content)) {
      problems.push(
        `${cfg.path} references "stories" (${cfg.reason}). The catalogue must not enter an app bundle. Remove the reference.`,
      );
    }
  }
  return problems;
}

/** The scripts the root `package.json` must still carry for the catalogue. */
export const REQUIRED_SCRIPTS = ["stories", "stories:build"];

/** Which required scripts are missing, given a parsed `package.json`. */
export function missingScripts(pkg) {
  return REQUIRED_SCRIPTS.filter((s) => !pkg.scripts?.[s]);
}

function main() {
  const configs = GUARDED_CONFIGS.map((cfg) => {
    const full = join(ROOT, cfg.path);
    return {
      ...cfg,
      content: existsSync(full) ? readFileSync(full, "utf8") : null,
    };
  });

  const problems = findLeaks({ configs });

  // The one file allowed to name `stories` must actually still wire it.
  const pkgRaw = readFileSync(join(ROOT, "package.json"), "utf8");
  const pkg = JSON.parse(pkgRaw);
  for (const script of missingScripts(pkg)) {
    problems.push(
      `package.json no longer defines the "${script}" script. The catalogue's entry point is gone; either restore it or remove its guards.`,
    );
  }

  if (problems.length > 0) {
    console.error("check-stories-isolation: FAIL");
    for (const p of problems) console.error(`  - ${p}`);
    process.exit(1);
  }
  console.log(
    `check-stories-isolation: ok (${configs.length} app configs clean; catalogue is a separate target).`,
  );
}

const invokedDirectly =
  process.argv[1] && import.meta.url.endsWith(process.argv[1].split("/").pop());
if (invokedDirectly) main();
