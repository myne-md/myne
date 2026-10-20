#!/usr/bin/env node
// Warn when a committed store set no longer depicts the app.
//
//   node scripts/check-store-set-freshness.mjs             # compare the tree to the record
//   node scripts/check-store-set-freshness.mjs --render    # re-render, then compare frame by frame
//   node scripts/check-store-set-freshness.mjs --record    # append what is on disk now
//
// WHY THIS EXISTS
// The whole argument for rendering these frames from the app is that a frame
// cannot drift from the app, because it IS the app. That argument is about the
// RENDER, and the PNGs are committed artefacts, so the moment a screen changes
// and nobody re-renders, they drift anyway, silently, which is exactly the
// failure the hand-set it replaced had: "Nothing enforces that link but this
// note".
//
// A WARNING, NOT A GATE. `check-preview-freshness.mjs` is the precedent and it
// warns for the same reason: a byte-exact gate needs a pinned browser and a fixed
// scale factor, and it reddens on a browser bump, a font-hinting change or a GPU
// path difference. A permanently red gate is one people learn to route around, so
// this one always exits 0 and says what moved.
//
// THE RECORD IS APPEND-ONLY. Every entry is kept, so the history of what was
// published survives every later render, and the check reads the LATEST entry per
// set. `--record` appends only sets whose hash actually moved, so a no-op run
// adds nothing and the file stays readable.
//
// WHAT IT ALSO ASSERTS, because nothing else does: that `featureGraphic.png`
// exists and measures 1024x500. `check-fdroid-metadata.mjs` knows the NAME (it
// lists the names F-Droid reads and warns that a misspelling is ignored) but does
// not require the file, so a missing graphic is silent everywhere else.

import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { SLOTS, ALL_SET_IDS, FEATURE_GRAPHIC } from "./lib/store-shots/slots.mjs";
import { buildPlan } from "./lib/store-shots/plan.mjs";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const RECORD_PATH = join(REPO_ROOT, "scripts/store-shots-record.json");
const GRAPHIC_SIZE = { width: 1024, height: 500 };

/** Where a set's frames live, in this repository. */
function rootsFor(slot) {
  if (slot.root === "fastlane") {
    const images = join(REPO_ROOT, "fastlane/metadata/android/en-US/images");
    if (slot.filename) return { dir: images, names: [slot.filename] };
    const dir = join(images, slot.frame === "android" ? "phoneScreenshots" : "tenInchScreenshots");
    return { dir, names: null };
  }
  return { dir: join(REPO_ROOT, "mobile/store/staged", slot.id), names: null };
}

/** The names a set's frames should have, from the plan rather than from disk. */
function plannedNames(slot) {
  const plan = buildPlan({
    sets: [slot.id],
    frames: [],
    outDirFor: () => rootsFor(slot).dir,
  });
  return plan.slots[0].frames.map((f) => f.filename).sort();
}

function sha(bytes) {
  return createHash("sha256").update(bytes).digest("hex").slice(0, 16);
}

/** Hash every frame of a set. Missing files are named, never skipped quietly. */
function hashSet(slot, dirOverride = null) {
  const { dir } = rootsFor(slot);
  const target = dirOverride ?? dir;
  const names = (dirOverride ? plannedNames(slot) : plannedNames(slot)).filter((n) =>
    existsSync(join(target, n)),
  );
  const frames = {};
  for (const name of names) {
    frames[name] = sha(readFileSync(join(target, name)));
  }
  return { frames, hash: sha(JSON.stringify(frames)), missing: plannedNames(slot).length - names.length };
}

function loadRecord() {
  if (!existsSync(RECORD_PATH)) return { $comment: RECORD_COMMENT, entries: [] };
  return JSON.parse(readFileSync(RECORD_PATH, "utf8"));
}

const RECORD_COMMENT =
  "Append-only record of every store set this repository has published, one entry per SET PER RENDER. " +
  "scripts/check-store-set-freshness.mjs reads the LATEST entry per set and warns when the committed " +
  "frames differ from it (a re-render nobody recorded) or when `--render` finds a frame whose pixels " +
  "moved. Entries are never rewritten: the history is what makes a drift report readable. Written by " +
  "`--record`, read by everything else.";

/** The most recent entry for a set, or null. */
function latestFor(record, setId) {
  for (let i = record.entries.length - 1; i >= 0; i -= 1) {
    if (record.entries[i].set === setId) return record.entries[i];
  }
  return null;
}

/**
 * Compare against the record, and (with `--render`) against a fresh render.
 *
 * Exported and parameterised so a test can drive every arm without the real tree
 * or a browser: `record` and `hashOf` are the two seams.
 */
/**
 * @param {{ [key: string]: any }} [options]  Same reason as the sibling guards.
 */
export function freshnessReport({
  record = loadRecord(),
  renderDirFor = null,
  hashOf = (slot, dir) => hashSet(slot, dir),
  existsFor = (slot) => existsSync(rootsFor(slot).dir),
  graphicPath = join(rootsFor(FEATURE_GRAPHIC).dir, FEATURE_GRAPHIC.filename),
} = {}) {
  const warnings = [];
  const failures = [];
  const skipped = [];
  const examined = [];

  for (const id of ALL_SET_IDS) {
    const slot = id === FEATURE_GRAPHIC.id ? FEATURE_GRAPHIC : SLOTS[id];
    if (slot.blocked) continue;
    const { dir } = rootsFor(slot);
    // Only the `fastlane` roots are committed, so only they are a claim about
    // what a store receives. A `staged` set is the harness's gitignored scratch:
    // its absence is the state of every clone but the author's, so reporting it
    // would be a warning nobody can clear on a tree that is correct. It is
    // named in the skip list instead, and counted rather than assumed.
    const committed = slot.root !== "staged";

    if (!existsFor(slot)) {
      if (committed) {
        warnings.push(`set "${id}" has no output directory at ${dir.replace(REPO_ROOT + "/", "")}`);
      } else {
        skipped.push({ id, reason: "gitignored staging root, not committed" });
      }
      continue;
    }

    const onDisk = hashOf(slot, null);
    examined.push({ id, hash: onDisk.hash, frames: Object.keys(onDisk.frames).length });

    if (onDisk.missing > 0) {
      warnings.push(
        `set "${id}" is missing ${onDisk.missing} frame(s) the plan would write, so it is incomplete`,
      );
    }

    const recorded = latestFor(record, id);
    if (!recorded) {
      warnings.push(`set "${id}" is committed and has no entry in the record; run --record`);
    } else if (recorded.hash !== onDisk.hash) {
      // Name the FRAMES that moved, not only the set. This is the arm a maintainer
      // meets in the hook, and "set X changed" sends them to diff eight PNGs by
      // eye; the frame names are the answer.
      const names = new Set([
        ...Object.keys(recorded.frames ?? {}),
        ...Object.keys(onDisk.frames),
      ]);
      const moved = [...names]
        .filter((n) => (recorded.frames ?? {})[n] !== onDisk.frames[n])
        .sort();
      // A FAILURE for a committed root and a warning for the author's scratch.
      // The committed comparison is bytes against bytes: no browser, no GPU, no
      // scale factor, so the reason this check is warning-only (a byte-exact
      // re-render reddens on a browser bump) does not reach it. A published PNG
      // that changed without a `--record` is the one thing in this file that no
      // other guard can see, and it is exactly what a listing makes permanent.
      const message =
        `set "${id}" no longer matches the record (recorded ${recorded.hash}, on disk ${onDisk.hash}). ` +
        `Frames that changed: ${moved.join(", ")}. ` +
        "Either the frames were re-rendered and not recorded, or a frame was edited by hand.";
      if (committed) failures.push(message);
      else warnings.push(message);
    }

    if (renderDirFor) {
      const fresh = hashOf(slot, renderDirFor(slot));
      const moved = Object.keys(onDisk.frames).filter((n) => fresh.frames[n] !== onDisk.frames[n]);
      if (moved.length > 0) {
        warnings.push(`set "${id}" has drifted from the app; frames that moved: ${moved.join(", ")}`);
      }
    }
  }

  // The graphic's size, which nothing else asserts.
  if (!existsSync(graphicPath)) {
    warnings.push(
      `featureGraphic.png is missing from ${graphicPath.replace(REPO_ROOT + "/", "")}`,
    );
  } else {
    const size = pngSize(readFileSync(graphicPath));
    if (!size) {
      warnings.push("featureGraphic.png is not a PNG");
    } else if (size.width !== GRAPHIC_SIZE.width || size.height !== GRAPHIC_SIZE.height) {
      warnings.push(
        `featureGraphic.png measures ${size.width}x${size.height}, not ${GRAPHIC_SIZE.width}x${GRAPHIC_SIZE.height}`,
      );
    }
  }

  return { warnings, failures, skipped, examined };
}

/** Read a PNG's IHDR dimensions without an image library. */
export function pngSize(buf) {
  if (buf.length < 24) return null;
  if (buf.readUInt32BE(0) !== 0x89504e47 || buf.readUInt32BE(4) !== 0x0d0a1a0a) return null;
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

/**
 * Append one entry per set whose hash moved. NEVER rewrites or drops an entry.
 *
 * Exported so a test can drive it: the property worth holding is that the earlier
 * entries survive, because a record that can be rewritten is a record whose
 * history means nothing, and the tool is the half nobody tests (`AGENTS.md`:
 * "A guard that WRITES its own record has a second half nobody verifies").
 */
export function appendEntries(record, hashOf = (slot) => hashSet(slot, null)) {
  const next = { ...record, entries: [...record.entries] };
  let appended = 0;
  for (const id of ALL_SET_IDS) {
    const slot = id === FEATURE_GRAPHIC.id ? FEATURE_GRAPHIC : SLOTS[id];
    if (slot.blocked || !existsSync(rootsFor(slot).dir)) continue;
    const onDisk = hashOf(slot);
    const recorded = latestFor(next, id);
    if (recorded && recorded.hash === onDisk.hash) continue;
    next.entries.push({
      set: id,
      at: new Date().toISOString().slice(0, 10),
      hash: onDisk.hash,
      frames: onDisk.frames,
    });
    appended += 1;
  }
  return { record: next, appended };
}

function main() {
  const record = loadRecord();
  const doRecord = process.argv.includes("--record");
  const doRender = process.argv.includes("--render");

  if (doRecord) {
    const { record: next, appended } = appendEntries(record);
    next.$comment = RECORD_COMMENT;
    writeFileSync(RECORD_PATH, JSON.stringify(next, null, 1) + "\n", "utf8");
    console.log(
      `store-set-freshness: appended ${appended} entr${appended === 1 ? "y" : "ies"} (${next.entries.length} total)`,
    );
    return;
  }

  let scratch = null;
  let renderDirFor = null;
  if (doRender) {
    scratch = mkdtempSync(join(tmpdir(), "myne-store-render-"));
    // ONE RENDER PER SET, into its own directory. A single `--out` for all sets is
    // flat, and the two Apple sets name their frames identically (`01-notes.png`
    // and friends), so the iPad render overwrote the iPhone's and the comparison
    // reported the iPad's bytes as three moved iPhone frames. Each set therefore
    // gets its own scratch directory, which is the only mapping with no collision.
    const renderable = ALL_SET_IDS.filter((id) => {
      const slot = id === FEATURE_GRAPHIC.id ? FEATURE_GRAPHIC : SLOTS[id];
      return !slot.blocked;
    });
    for (const id of renderable) {
      const run = spawnSync(
        "node",
        ["scripts/shot-store-images.mjs", "--sets", id, "--out", join(scratch, id)],
        { cwd: REPO_ROOT, stdio: "inherit" },
      );
      if (run.status !== 0) {
        console.warn(`store-set-freshness: the re-render of "${id}" failed, so its drift could not be checked`);
        rmSync(scratch, { recursive: true, force: true });
        return;
      }
    }
    renderDirFor = (slot) => join(scratch, slot.id);
  }

  const { warnings, failures, skipped, examined } = freshnessReport({ record, renderDirFor });
  if (scratch) rmSync(scratch, { recursive: true, force: true });

  for (const s of skipped) console.log(`  skip: set "${s.id}" (${s.reason})`);
  for (const w of warnings) console.warn(`  warn: ${w}`);
  for (const f of failures) console.error(`  FAIL: ${f}`);

  const frames = examined.reduce((a, e) => a + e.frames, 0);
  const tail =
    `${examined.length} set(s), ${frames} frame(s) hashed` +
    `${doRender ? ", re-rendered and compared" : ""}; ${skipped.length} skipped, ` +
    `${warnings.length} warning(s), ${failures.length} failure(s)`;
  if (failures.length > 0) {
    console.error(`store-set-freshness: a committed store set changed without a --record (${tail})`);
    process.exit(1);
  }
  console.log(`store-set-freshness: ok (${tail})`);
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main();
}
