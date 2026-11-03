#!/usr/bin/env node
// Warn when a change touches one side of a twin module pair (#261).
//
// The failure this prevents: a fix lands in one client and never reaches its
// counterpart. Nothing — not a label, not a checklist, not a guard — says "this
// module has a twin", so the gap persists for months because BOTH trees stay
// green. Observed instances, all confirmed:
//
//   - `98acbcc9` added the tombstone filter to `src/notes/sidebarState.tsx`;
//     mobile's Trash list and Conflicts sheet never got it, so "Delete
//     permanently" was a visible no-op and "Discard" never cleared a conflict
//   - `src/App.tsx` replaced post-delete routing with `reprobe`;
//     `mobile/src/lib/stage.ts` still routes to the first-run Welcome
//     screen — SEVEN MONTHS of commits later
//   - `mobile/src-tauri/src/hooks.rs` HAD `emit_snapshot_write_failed` as a
//     bare empty body while desktop emitted and rendered an indicator. FIXED:
//     mobile emits, with a comment naming the defect it closed. Kept in this
//     list rather than deleted, because the list is what this guard was written
//     from and a fixed instance still shows the shape; the tense is the part
//     that has to stay true (myne-md/myne#479).
//   - `mobile/src-tauri/src/hooks.rs` returned an UNCLAMPED
//     `effective_auto_lock_secs`, and so did `web/wasm/src/hooks.rs`. Found by
//     comparing the twins for myne-md/myne#479, not by any check. Worth stating
//     at its real size: that value is read only by the desktop tick loop, which
//     neither client compiles, so it was a trap for the next Rust-side reader
//     rather than a shipped A6 window. Chasing it is what surfaced the one that
//     WAS live, in the web client's TypeScript timer, which took the raw pref
//     and read `null` as "disabled". The fix moved the envelope into
//     `myne-core`, gave the trait method a clamping DEFAULT, and routed both
//     WebView call sites through the TypeScript mirror.
//   - `mobile/src-tauri/src/plugins/workspace/` was a 297-line local fork of a
//     core plugin desktop had already migrated to, and it had fallen behind by
//     a v0.1-only `vault.meta` parser, so on a MIGRATED vault the phone's
//     workspace reads and writes both failed while every other plugin worked.
//     `scripts/check-version-routing.mjs` is the guard for that class and its
//     `ROOTS` did not include `mobile/src-tauri/src`; it does now.
//   - `mobile/src/lib/welcomeNote.ts` was still English-only after
//     `@myne/i18n` went live on mobile. (It and its desktop counterpart are now
//     gone: myne-md/myne#960 deleted the Welcome note and both clients seed the
//     shared `exampleVault` set, which is a resolved twin rather than a watched
//     one.)
//
// Every one of those was found by hand, because until the mobile client moved
// in-repo this check could not run where it mattered: the mobile tree was a
// gitignored companion clone, absent from every CI run, so the guard written
// FOR the desktop/mobile twin problem printed "skipped" on the runner and had
// never once executed there. That is why the not-cloned branch below is gone.
//
// **This is a WARNING, not a gate, and that is deliberate.** A hard gate would
// be wrong and would be bypassed within a week: most one-sided changes are
// legitimate (a desktop-only feature has no mobile twin). The value is turning
// silence into a recorded decision — the developer states what happened to the
// twin, in one line, in the PR body.
//
// Exit code is always 0. What it prints is the whole product.
//
// Run by hand:  node scripts/check-twin-drift.mjs [<changed-file>...]
// With no arguments it reads the working tree's changed files from git.

import { runTool } from "./lib/run-tool.mjs";
import { existsSync, readdirSync, statSync } from "node:fs";
import { basename, join, relative } from "node:path";

import { CURATED_TWINS } from "./check-twin-inventory.mjs";

const ROOT = new URL("..", import.meta.url).pathname;
const MOBILE = "mobile";

/**
 * Pairs that are twins by NAME rather than by path — one client's module and
 * the other's, where the two trees put them in different places. Same-relative-
 * path twins are discovered automatically below.
 *
 * **Imported rather than kept here** (myne-md/myne#472). This file used to hold
 * its own four-entry `NAMED_TWINS`, and the two lists disagreed: it paired
 * `src/App.tsx` with `mobile/src/lib/stage.ts`, which is the Stage table rather
 * than the shell, and `mobile/src/lib/stage.ts` already has its own same-path
 * twin in `src/lib/stage.ts`. Aiming the pair one file to the left is why two
 * live routing divergences went unseen, and the inventory's entry says so. Two
 * of the other three were same-path pairs this file's own sweep already finds.
 *
 * So the roster lives in one place and this guard reads it. That is the
 * `scripts/lib/shared-roots.mjs` rule applied to a roster rather than to a tree
 * list: a private copy of a list is a second source that drifts, and here it had
 * already drifted into being wrong.
 */
const NAMED_TWINS = CURATED_TWINS.map((t) => ({ a: t.a, b: t.b, what: t.what }));

function changedFiles() {
  const args = process.argv.slice(2);
  if (args.length > 0) return args;
  // FATAL, deliberately: a `git diff` that cannot run used to return [] here,
  // which silently shrinks the sweep to zero files and the warning to nothing —
  // a warn-only guard that checks nothing reads as "no twins touched" (myne#528).
  const r = runTool(["git", "diff", "--name-only", "HEAD"], {
    cwd: ROOT,
    onToolFailure: "fatal",
  });
  return (r.stdout ?? "").split("\n").filter(Boolean);
}

/** Every file under `dir`, repo-relative. */
function* walk(dir) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of entries) {
    if (name === "node_modules" || name === "target" || name === ".git") continue;
    const full = join(dir, name);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) yield* walk(full);
    else yield relative(ROOT, full);
  }
}

/**
 * Twins by identical relative path under the two trees, plus twins by basename.
 *
 * Both are needed and neither subsumes the other: `hooks.rs` is the same
 * relative path under two `src-tauri/` roots, while `sidebarState.tsx` and
 * `EditorFlow.tsx` share neither path nor name and only the curated list above
 * knows about them.
 */
function discoverTwins() {
  const mobileRoot = join(ROOT, MOBILE);
  // In-repo since the mobile client moved here, so an absent tree is a broken
  // checkout rather than the normal companion-not-cloned case this used to
  // return an empty map for. Say so instead of silently finding no twins.
  if (!existsSync(mobileRoot)) {
    console.error(`twin-drift: ${MOBILE}/ is missing — this is an in-repo tree, so the checkout is broken.`);
    process.exit(1);
  }

  const mobileFiles = [...walk(mobileRoot)];
  const byPath = new Map();
  const byName = new Map();
  for (const file of mobileFiles) {
    const stripped = file.slice(MOBILE.length + 1);
    byPath.set(stripped, file);
    const base = basename(file);
    if (!byName.has(base)) byName.set(base, []);
    byName.get(base).push(file);
  }
  return { byPath, byName };
}

const { byPath, byName } = discoverTwins();
const changed = changedFiles();
const changedSet = new Set(changed);
const notes = [];

for (const file of changed) {
  // Curated pairs first — they carry the most specific explanation.
  for (const twin of NAMED_TWINS) {
    if (file === twin.a && !changedSet.has(twin.b)) {
      notes.push({ file, counterpart: twin.b, why: twin.what });
    } else if (file === twin.b && !changedSet.has(twin.a)) {
      notes.push({ file, counterpart: twin.a, why: twin.what });
    }
  }

  // Same relative path under both trees, checked in BOTH directions.
  //
  // This block used to be gated on `!file.startsWith(MOBILE)`, so it only ever
  // looked from desktop towards mobile. A one-sided change to the MOBILE half
  // warned nobody, and mobile is the side that lags: measured on
  // `navigation.rs`, touching the desktop file alone reported the pair and
  // touching the mobile file alone reported nothing. The curated `NAMED_TWINS`
  // block above was already symmetric, which is why the gap was invisible for
  // any pair somebody had thought to name.
  if (file.startsWith(`${MOBILE}/`)) {
    const desktopTwin = file.slice(MOBILE.length + 1);
    if (existsSync(join(ROOT, desktopTwin)) && !changedSet.has(desktopTwin)) {
      notes.push({
        file,
        counterpart: desktopTwin,
        why: "same relative path outside the mobile tree",
      });
    }
    continue;
  }

  const twin = byPath.get(file);
  if (twin && !changedSet.has(twin)) {
    notes.push({
      file,
      counterpart: twin,
      why: "same relative path in the mobile tree",
    });
    continue;
  }
  // Same basename, different path: weaker, so only reported when the path
  // twin did not already fire.
  const sameName = (byName.get(basename(file)) ?? []).filter(
    (t) => !changedSet.has(t),
  );
  if (sameName.length === 1) {
    notes.push({
      file,
      counterpart: sameName[0],
      why: "same module name in the mobile tree",
    });
  }
}

if (notes.length === 0) {
  console.log(`twin-drift: ok (no one-sided twin change in ${changed.length} changed file(s))`);
  process.exit(0);
}

const seen = new Set();
for (const n of notes) {
  const key = `${n.file}→${n.counterpart}`;
  if (seen.has(key)) continue;
  seen.add(key);
  console.warn(
    `⚠ twin: ${n.file} has a counterpart that was not touched — ${n.counterpart}\n` +
      `  (${n.why})\n` +
      "  Add one line to the PR body: `Twin: ported | n/a | issue #N`",
  );
}
console.warn(
  "\nThis is a warning, not a gate: most one-sided changes are legitimate.\n" +
    "The point is that the decision is recorded rather than silent (#261).",
);
process.exit(0);
