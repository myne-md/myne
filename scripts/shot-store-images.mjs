#!/usr/bin/env node
// Capture the store listing images from the live design gallery.
//
//   node scripts/shot-store-images.mjs --sets iphone-6.9 --frames notes --out /tmp/probe
//   node scripts/shot-store-images.mjs --sets all
//
// This is a CAPTURE TOOL, not a test. It writes artefacts, asserts nothing about
// behaviour, and edits no production code, the contract `e2e/capture/` states for
// the desktop passes and `scripts/shot-ai-panels.mjs` states for the mobile one.
// Neither `pnpm test:e2e` nor the mobile flow-logic tier collects it, because the
// browser half lives in its own Playwright lane with its own `testDir`.
//
// WHY THIS EXISTS AT ALL
// The sets it replaces were hand-redrawn from the design tokens in
// `myne-branding/app-store/src/`, and that README says of the link: "Nothing
// enforces that link but this note". A frame rendered from the board cannot drift
// from the app, because it IS the app: the board mounts every real screen inside a
// real device frame with the real stylesheet.
//
// THE TWO THINGS THAT MAKE IT SAFE TO RUN
// It starts its OWN dev server, on a port it chose, with reuse off. The port is a
// machine-wide resource and `mobile/playwright.config.ts` runs
// `reuseExistingServer: true`, which is right for a test that must not fight a
// developer for a port and wrong here: a server started from another worktree
// would answer, and this capture would commit THAT branch's app into the images
// this one ships. Silently, because the output is a PNG nobody diffs by eye.
//
// It fixes nothing and guesses nothing. An unknown set or frame id fails by name
// before a browser opens, and a frame whose screen is not on the board fails by
// name from inside the browser half rather than writing an empty plate.

import { mkdirSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { buildPlan, describePlan } from "./lib/store-shots/plan.mjs";
import { ALL_SET_IDS, BLOCKED_SET_IDS, SLOTS } from "./lib/store-shots/slots.mjs";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const MOBILE_DIR = join(REPO_ROOT, "mobile");

/** A port nobody else owns, overridable, never shared with the flow-logic tier. */
const DEFAULT_PORT = "1433";

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i === -1 ? fallback : (process.argv[i + 1] ?? fallback);
}

function list(name) {
  const raw = arg(name, "");
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Where a set's frames land by default, myne-owned.
 *
 * The Apple sets stage under `mobile/store/`, which is gitignored and is where
 * this generator lived before it moved to `myne-branding` in 2026-10; the
 * published copies are mirrored there afterwards. The Android sets write
 * straight into the F-Droid directory, because that is where both stores read
 * them and there is nothing to mirror.
 *
 * `--out` overrides this for every set, which is how a probe writes to a scratch
 * directory and how the branding checkout could be targeted when that companion
 * is present. Nothing here requires it to be.
 */
function outDirFor(slot, override) {
  if (override) return resolve(override);
  if (slot.root === "fastlane") {
    const images = join(REPO_ROOT, "fastlane/metadata/android/en-US/images");
    // The feature graphic sits directly in `images/` under a store-assigned name;
    // the screenshot sets sit in their device directories.
    if (slot.filename) return images;
    return join(images, slot.frame === "android" ? "phoneScreenshots" : "tenInchScreenshots");
  }
  return join(REPO_ROOT, "mobile/store/staged", slot.id);
}

async function main() {
  const outOverride = arg("--out", "");
  const sets = list("--sets").map((s) => (s === "all" ? s : s));
  const frames = list("--frames");
  const port = arg("--port", DEFAULT_PORT);
  // Writes ONE image per set with every frame joined, instead of one file per
  // frame. The canvas is already the whole panorama; this just photographs it
  // whole rather than clipping a frame out of it, which is what a reader wants
  // when they are judging the continuity rather than any single frame.
  const panorama = process.argv.includes("--panorama");

  const plan = buildPlan({
    // `all` expands here rather than in the pure module, because "everything the
    // repository publishes" is a CLI concern and the plan should be explicit.
    sets: sets.includes("all") ? ALL_SET_IDS : sets,
    frames,
    outDirFor: (slot) => outDirFor(slot, outOverride),
  });

  for (const s of plan.slots) {
    for (const f of s.frames) mkdirSync(f.out, { recursive: true });
  }

  for (const id of BLOCKED_SET_IDS) {
    console.warn(`skipped "${id}": ${SLOTS[id].blocked}`);
  }

  console.log("plan:");
  console.log(describePlan(plan));
  console.log(`\ndev server: its own, on port ${port}, reuse disabled`);

  const planFile = join(tmpdir(), `myne-store-plan-${process.pid}.json`);
  writeFileSync(planFile, JSON.stringify(plan, null, 1), "utf8");

  const exit = await new Promise((resolvePromise) => {
    const child = spawn(
      "pnpm",
      ["exec", "playwright", "test", "--config=playwright.store.config.ts"],
      {
        cwd: MOBILE_DIR,
        stdio: "inherit",
        env: {
          ...process.env,
          STORE_PLAN_FILE: planFile,
          STORE_DEV_PORT: port,
          ...(panorama
            ? { STORE_PANORAMA: "1", STORE_PANORAMA_DIR: join(REPO_ROOT, "mobile/store/panorama") }
            : {}),
        },
      },
    );
    child.on("close", (code) => resolvePromise(code ?? 1));
  });

  if (exit !== 0) {
    console.error(`\ncapture failed (playwright exited ${exit})`);
    process.exit(exit);
  }

  const written = plan.slots.flatMap((s) => s.frames.map((f) => join(f.out, f.filename)));
  console.log(`\nwrote ${written.length} frame(s):`);
  for (const p of written) console.log(`  ${p}`);
}

main().catch((err) => {
  console.error(`shot-store-images: ${err.message}`);
  process.exit(1);
});
