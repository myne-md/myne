#!/usr/bin/env node
// Guard: a client tree that READS the shared date/time display store must also
// PUBLISH into it (myne-md/myne#609).
//
// The failure this prevents, stated as it actually happened rather than in the
// abstract. `editor/src/host/lib/datetimeFormat.ts` holds one module-scope store
// of the reader's date format, time format, zone and language. Task rows, saved-
// view property cells and (since #609) in-note task chips all read it. Exactly
// one file in the entire tree ever wrote to it: `src/hooks/useDateTimeDisplaySync.ts`,
// mounted on the desktop editor screen.
//
// The mobile client renders the desktop's own task panel, so it READ that store
// from the day it moved in-repo, and published nothing into it. The store
// therefore sat at its defaults for the life of the process. `date_format` and
// `time_format` are Shared scalar-LWW, so a format chosen on a computer syncs
// into `vault.prefs` and arrives on the phone: the phone was holding the value
// and printing something else. Nothing reported it. It type-checks, every lint
// passes, the store has a sane default, and the wrong output is a plausible
// date.
//
// WHAT THIS GUARD WOULD NOT HAVE CAUGHT, WHICH HAS TO BE SAID FIRST.
// It would NOT have failed on the tree that shipped the defect. Measured
// against the merge base rather than reasoned about: a marker grep over
// `mobile/src` at 5e1ebb8 returns nothing, because mobile's read was
// TRANSITIVE. It renders the desktop task panel, which lives in `src/`, so a
// per-tree literal scan sees `reads: false` and reports ok. The guard is armed
// today only because the same change gave mobile a DIRECT consumer, its
// settings sheet.
//
// That is a real limit and it is left in place deliberately, because the
// alternative is worse: following imports across package boundaries turns a
// zero-dependency string scan into a module resolver, and a resolver that gets
// one alias wrong fails open exactly like the scan does. What the limit costs is
// bounded by `ARMED_TREES` below, which fails when a tree stops holding any read
// marker at all, so the guard cannot disarm in silence the way it would have if
// somebody moved the settings rows into a shared component.
//
// WHY THIS IS NOT COVERED BY A GUARD THAT ALREADY EXISTS.
// `check-unwired.mjs` asks whether a MODULE has a production importer. The
// adapter had one on desktop, and on mobile there was no module to be unwired.
// `check-ipc-binding-callers.mjs` asks whether a BINDING has a caller. Neither
// can express "this tree consumes a store nobody in this tree fills", because
// the consumer and the publisher are different files in different packages and
// the link between them is a module-scope variable rather than a call.
//
// THE RULE. For each shared client tree, if any file under it reads the store
// (`useDateTimeDisplay`, `dateTimeDisplay(`, `subscribeDateTimeDisplay` or
// `formatStoredValue`/`formatCivilDate`/`formatWallClockTime`/`formatInstant`/
// `todayIn`), then some file under it must call `setDateTimeDisplay(`.
//
// WHICH TREES. `presentSharedRoots()` from `scripts/lib/shared-roots.mjs`,
// imported rather than copied. A private roster copy is precisely the drift that
// left `check-prefs-nonce.mjs` blind to a whole client while printing `ok`, and
// this guard exists because of a blind spot of the same family. A root on the
// roster but absent from the checkout is a FAILURE here, not a smaller walk.
//
// FIVE TREES ARE EXEMPT, and the reason is that none of them is a client. The
// roster of record is `NOT_A_CLIENT` below, which carries the reason per tree;
// this comment says only what the shape of the exemption is. Do not restate the
// count or the members here: the first version of this header said TWO and then
// listed four, which is the miscount this repository's own guard-verification
// rule exists to catch, in a guard written to catch a miscount.
//
// `editor/src` DEFINES the store, so it reads it by construction and has nobody
// to publish on behalf of. `web/src` mounts the desktop app rather than being a
// second bundle. `dialect/src`, `copy/src` and `ornaments/src` are leaf packages
// with no host to read preferences from. The exemption is a named list rather
// than a heuristic, so adding a tree to it costs an argument, and it is checked
// for staleness in both directions.
//
// VERIFYING THIS GUARD MEANS BREAKING IT. Delete a client's
// `setDateTimeDisplay(` call and it must name that client. `tests/scripts/
// dateTimeDisplayPublisher.test.ts` injects exactly that, in both directions,
// and through BOTH halves of this file: the rule, with an injected scan result,
// and the scan, over real files in a directory the spec builds. The second seam
// was added because the first version had only the first, which left every
// marker and the directory walk itself asserted by nothing.

import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { presentSharedRoots } from "./lib/shared-roots.mjs";

const ROOT = new URL("..", import.meta.url).pathname;

/**
 * Trees that read the store without being a client of it.
 *
 * Each entry carries the reason it is not a client, because "it was failing" is
 * not one. The list is checked for staleness: a root here that is no longer a
 * shared root at all is a failure, so it cannot outlive its subject.
 */
export const NOT_A_CLIENT = Object.freeze({
  "editor/src":
    "defines the store. It reads its own module-scope value by construction and has no host preferences to publish from.",
  "web/src":
    "is not a separate client BUNDLE. It mounts the desktop `src/App` (web/src/main.tsx), so its publisher legitimately lives in src/hooks/useDateTimeDisplaySync.ts and a second one here would be a duplicate. Listed rather than left to pass vacuously: it holds no read marker today, so the rule would allow it either way, and the first web-only surface that prints a date would fail this guard with a message telling the author to mount an adapter the web client does not need.",
  "dialect/src":
    "is the markdown grammar: no host, no preferences, no React. It DOES hit a read marker, and the reason is worth writing down rather than leaving for the next reader to rediscover: `dialect/src/civilDate.ts` exports its own unrelated `formatCivilDate`, so the match is a NAME COLLISION and not a read of the display store. The markers are plain string matches, which is deliberate (a comment-aware or import-aware scan is a scan with a bypass), and this is the one place that costs a false positive.",
  "copy/src":
    "is a string table kept byte-identical across clients. It holds no host seam to read a preference through, and hits no marker, so this entry is documentation rather than a suppression.",
  "ornaments/src":
    "is a stylesheet plus a role helper, consumed by the website and the theme gallery as well as by the clients. No host, and it hits no marker either.",
});

/**
 * Trees that must hold at least one READ marker of their own.
 *
 * The rule above is conditional (`reads` implies `publishes`), so a tree that
 * stops reading passes vacuously. For `mobile/src` that is exactly the state the
 * defect shipped in, since its consumption was transitive through the shared
 * `src/` task panel, and it would return the moment somebody moved the settings
 * rows into a shared component. A named list rather than "every client", so
 * adding a client to it is a decision.
 */
export const ARMED_TREES = Object.freeze({
  "mobile/src":
    "consumed the store TRANSITIVELY before myne-md/myne#609, through the desktop task panel it renders, which is why this guard would have reported ok on the tree that shipped the defect. It holds a direct consumer now (its settings sheet), and this entry is what fails if that goes away rather than letting the guard quietly stop covering the client it was written for.",
});

/** Reading the store, in every spelling a consumer actually writes. */
export const READ_MARKERS = Object.freeze([
  "useDateTimeDisplay",
  "dateTimeDisplay(",
  "subscribeDateTimeDisplay",
  "formatStoredValue",
  "formatCivilDate",
  "formatWallClockTime",
  "formatInstant",
  "todayIn",
]);

/** Publishing into it. One spelling, because there is one setter. */
export const PUBLISH_MARKER = "setDateTimeDisplay(";

function* walk(dir) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(full);
    else if (/\.(ts|tsx)$/.test(entry.name)) yield full;
  }
}

/**
 * Run the rule and return what it found. EXPORTED so the spec can assert on the
 * return rather than restate the rule: a spec that reimplemented the scan could
 * pass while the script failed, or agree with a bug.
 *
 * `trees` injects the scan result so a spec can drive the RULE without deleting
 * a real client's publish call. Shape: `{ [root]: { reads: bool, publishes: bool } }`.
 * `missingTrees` injects the absent-root list, for the same reason
 * `check-prefs-nonce.mjs` does: every shared root is on disk, so the only way to
 * watch that rule fire for real would be to delete one.
 *
 * `presentTrees` plus `root` are the OTHER seam, and they exist because the
 * first version had only the one above. Every injected case handed in a boolean
 * map, so the half of this function that opens files and matches markers was
 * exercised by nothing at all: deleting a marker from `READ_MARKERS`, or
 * breaking `walk` so it skipped `.tsx`, would have left every case green. The
 * pair points the walk at a directory a spec built, so the scan itself can be
 * driven with real files and a real defect.
 */
export function analyse({ trees, missingTrees, exemptions, presentTrees, root, armedTrees } = {}) {
  const failures = [];
  // Read the roster ONCE. Four calls asked the disk the same question four
  // times, and worse, made two lines read as though the halves could come from
  // different snapshots.
  const roots = presentSharedRoots();
  const present = trees !== undefined ? Object.keys(trees) : (presentTrees ?? roots.present);
  const missing = missingTrees ?? roots.missing;
  const exempt = exemptions ?? NOT_A_CLIENT;
  const armed = armedTrees ?? ARMED_TREES;

  for (const rel of missing) {
    failures.push({
      root: rel,
      why: "is on the shared-root roster and is NOT in this checkout, so this guard silently covered one client fewer. Restore the tree or remove it from scripts/lib/shared-roots.mjs; a smaller walk that still prints ok is the failure this guard was written about.",
    });
  }

  // Staleness is asked of the ROSTER, not of the scanned set. Asking the scanned
  // set was the first shape and it was wrong in a way worth recording: an
  // injected run passes a subset of trees, so every exemption outside that
  // subset looked stale and the guard reported four failures on every spec that
  // drove any other rule. The question here is "is this exempted root still a
  // shared tree", which the roster answers and a partial scan cannot.
  const roster = new Set([...roots.present, ...roots.missing]);
  for (const rel of Object.keys(armed)) {
    if (!roster.has(rel)) {
      failures.push({
        root: rel,
        why: "is listed as an armed tree and is no longer a shared root at all. Remove it: a roster entry that outlives its subject reads as coverage that is not there.",
      });
    }
  }

  for (const rel of Object.keys(exempt)) {
    if (!roster.has(rel)) {
      failures.push({
        root: rel,
        why: "is exempted as 'not a client' but is no longer a shared root at all. Remove the exemption: one that outlives its subject reads as a considered decision about a tree that does not exist.",
      });
    }
  }

  for (const rel of present) {
    if (rel in exempt) continue;

    let reads = false;
    let publishes = false;
    if (trees !== undefined) {
      ({ reads, publishes } = trees[rel]);
    } else {
      for (const file of walk(join(root ?? ROOT, rel))) {
        const src = readFileSync(file, "utf8");
        if (!reads && READ_MARKERS.some((marker) => src.includes(marker))) reads = true;
        if (!publishes && src.includes(PUBLISH_MARKER)) publishes = true;
        if (reads && publishes) break;
      }
    }

    if (!reads && rel in armed) {
      failures.push({
        root: rel,
        why: `holds no read marker at all, so this guard passes over it vacuously. ${armed[rel]}`,
      });
    }

    if (reads && !publishes) {
      failures.push({
        root: rel,
        why: `reads the shared date/time display store and never calls ${PUBLISH_MARKER}. The store then holds its defaults for the life of the process, so this client prints dates in a format the user did not choose, and a SYNCED date_format arrives and is disregarded. Mount an adapter that publishes displayFromPrefs(prefs, language) high enough in the tree that it cannot unmount (see src/hooks/useDateTimeDisplaySync.ts and mobile/src/lib/useDateTimeDisplaySync.ts).`,
      });
    }
  }

  // Filtered against the exemptions this run actually ENFORCED, not against the
  // module constant. An injected run with custom exemptions was otherwise
  // reporting a scanned list computed from a different set than the one it had
  // just applied.
  return { failures, scanned: present.filter((rel) => !(rel in exempt)) };
}

function main() {
  const { failures, scanned } = analyse();
  if (failures.length > 0) {
    console.error("\n✗ datetime-display-publisher check failed:\n");
    for (const f of failures) console.error(`  ${f.root} ${f.why}\n`);
    process.exit(1);
  }
  console.log(
    `datetime-display-publisher: ok (${scanned.length} client tree(s) checked; ` +
      `${Object.keys(NOT_A_CLIENT).length} exempted as not-a-client)`,
  );
}

if (process.argv[1] && relative(ROOT, process.argv[1]).endsWith("check-datetime-display-publisher.mjs")) {
  main();
}
