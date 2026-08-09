#!/usr/bin/env node
// Warn when the theme-preview snapshot has fallen behind the interface it is a
// snapshot OF (myne#394).
//
// `preview/src/preview.{html,css}` are captured FROM the running desktop app by
// `e2e/capture/theme-preview.capture.ts`, and three consumers show them to
// people who have not installed Myne yet: the website's theme builder, the
// website's theme gallery, and the `myne-themes` PNG renderer. That is the whole
// point — a preview nobody hand-writes cannot drift on its own.
//
// What it CAN do is go stale. Nothing about editing `Editor.tsx` tells you a
// picture of `Editor.tsx` exists somewhere else, and a stale snapshot fails
// silently and slowly: it keeps rendering, keeps re-theming, and simply shows
// last quarter's interface. This guard turns that silence into a line of output.
//
// **A WARNING, not a gate, and deliberately so.** Most UI changes do not change
// what the preview shows — a new settings panel, a bug fix three screens away, a
// test-only edit. A hard gate would demand a container capture run (minutes, and
// Linux-only — tauri-driver has no macOS support) for changes that cannot
// possibly affect the snapshot, and would be routed around within a week. The
// value is a recorded decision, not a blocked commit. This is the same posture,
// for the same reason, as `check-twin-drift.mjs`.
//
// Staleness is measured by a CONTENT HASH over the depicted surfaces, not by a
// commit. The obvious design — record the commit the capture ran at, then diff
// against it — cannot express the normal case: a capture runs against the
// WORKING TREE (the container bind-mounts it), so the snapshot it produces is
// newer than any commit, and it is committed in the same change as the code it
// depicts. Recording a SHA there is a chicken-and-egg with no correct answer,
// and the guard fires on its own change. A hash of the surfaces has neither
// problem: it is recomputed and compared, and re-recorded whenever a capture is
// promoted.
//
// Exit code is always 0. What it prints is the whole product.
//
// Run by hand:  node scripts/check-preview-freshness.mjs
//               node scripts/check-preview-freshness.mjs --record   (after a capture)
// Wired into:   CI `pnpm-build` (the main repo's — the website's CI has no node).
//
// To refresh:   ./scripts/capture-theme-preview.sh
//               cp e2e/artifacts/theme-preview/* preview/src/
//               node scripts/check-preview-freshness.mjs --record

import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");
const META = join(REPO, "preview", "src", "meta.json");

// The trees the snapshot is a picture of. Deliberately the surfaces that decide
// what the captured editor LOOKS like, not every file the app is built from: the
// point is a signal worth reading, and a roster that fires on every commit is a
// roster nobody reads.
//
//   - the editor screen and the components it renders — the captured DOM
//   - `editor/src` — CodeMirror decorations ARE the callout, code block, quote
//     and task-chip appearance, so this is preview surface even though no
//     component under `src/` mentions it
//   - the token sheet and the ornament layer — captured verbatim into preview.css
const WATCHED = [
  "src/screens/Editor.tsx",
  "src/notes/components",
  "src/components",
  "src/styles/tokens.css",
  "editor/src",
  "ornaments/src/ornaments.css",
];

/** Only the extensions that can change what the capture LOOKS like. */
const SURFACE_EXT = /\.(ts|tsx|css)$/;
const SKIP_DIRS = new Set(["node_modules", "dist", "target", ".git"]);

/** Every watched file, repo-relative, sorted — the same set on every machine. */
function surfaceFiles() {
  const out = [];
  const walk = (abs) => {
    for (const name of readdirSync(abs).sort()) {
      if (SKIP_DIRS.has(name)) continue;
      const child = join(abs, name);
      const st = statSync(child);
      if (st.isDirectory()) walk(child);
      else if (SURFACE_EXT.test(name)) out.push(child);
    }
  };
  for (const p of WATCHED) {
    const abs = join(REPO, p);
    if (!existsSync(abs)) continue;
    if (statSync(abs).isDirectory()) walk(abs);
    else out.push(abs);
  }
  return out.sort();
}

/** One hash over the depicted surfaces: their paths and their bytes. */
function surfaceHash() {
  const h = createHash("sha256");
  for (const abs of surfaceFiles()) {
    // Paths are part of the hash so a deleted or renamed surface moves it too.
    h.update(relative(REPO, abs).split(sep).join("/"));
    h.update("\0");
    h.update(readFileSync(abs));
    h.update("\0");
  }
  return h.digest("hex");
}

const RECORD = process.argv.includes("--record");

if (RECORD) {
  if (!existsSync(META)) {
    console.error(
      "preview-freshness: nothing to record — preview/src/meta.json is absent.\n" +
        "  Capture first: ./scripts/capture-theme-preview.sh",
    );
    process.exit(1);
  }
  const meta = JSON.parse(readFileSync(META, "utf8"));
  meta.surfaceHash = surfaceHash();
  writeFileSync(META, `${JSON.stringify(meta, null, 2)}\n`);
  console.log(`preview-freshness: recorded surfaceHash ${meta.surfaceHash.slice(0, 12)}…`);
  process.exit(0);
}

if (!existsSync(META)) {
  console.warn(
    "⚠ preview-freshness: no snapshot recorded yet (preview/src/meta.json is absent).\n" +
      "  The theme builder and the theme gallery have nothing real to render until\n" +
      "  one exists. Capture it with ./scripts/capture-theme-preview.sh (myne#394).",
  );
  process.exit(0);
}

let meta;
try {
  meta = JSON.parse(readFileSync(META, "utf8"));
} catch (e) {
  console.warn(`⚠ preview-freshness: preview/src/meta.json is unreadable (${e.message}).`);
  process.exit(0);
}

const recorded = String(meta.surfaceHash ?? "").trim();
if (!/^[0-9a-f]{64}$/.test(recorded)) {
  console.warn(
    "⚠ preview-freshness: preview/src/meta.json carries no recorded `surfaceHash`.\n" +
      "  Record one after promoting a capture:\n" +
      "    node scripts/check-preview-freshness.mjs --record",
  );
  process.exit(0);
}

const actual = surfaceHash();
if (actual === recorded) {
  console.log("preview-freshness: ok (the snapshot depicts the current interface)");
  process.exit(0);
}

console.warn(
  "⚠ preview-freshness: the interface has changed since the snapshot was captured.\n" +
    `  recorded ${recorded.slice(0, 12)}…  now ${actual.slice(0, 12)}…\n\n` +
    "  The theme builder and the theme gallery are showing the OLDER interface.\n" +
    "  Re-capture if the change is visible there:\n" +
    "    ./scripts/capture-theme-preview.sh\n" +
    "    cp e2e/artifacts/theme-preview/* preview/src/\n" +
    "    node scripts/check-preview-freshness.mjs --record\n" +
    "  Otherwise re-record and say so in the PR body: `Preview: unaffected`.\n" +
    "  This is a warning, not a gate — most UI changes do not change what the\n" +
    "  preview shows, and a capture run costs a container (myne#394).",
);
process.exit(0);
