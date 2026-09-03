#!/usr/bin/env node
// The recorded twin-drift SET may shrink, never grow (myne-md/myne#473).
//
// **What the two neighbours leave open.** `scripts/check-twin-drift.mjs`
// (myne#261) warns when a change touches one side of a twin and leaves the
// other alone. That is a WARNING and stays one, most one-sided changes are
// legitimate and a hard gate would be bypassed within a week, and it only ever
// fires on a NEW one-sided change, so it says nothing about the drift that
// already exists. `scripts/check-twin-inventory.mjs` (myne#472) counts that
// drift and classifies every pair, but its `--check` half gates the ROSTER
// against a generated document, not the tree: a pair that starts differing
// changes no roster entry and passes. So every convergence a sibling
// sub-feature lands is unprotected the moment it lands, and nothing reports the
// next change re-introducing it.
//
// **A SET, not a count, and the difference is not cosmetic.** A count is blind
// to the case that actually happens: one pair converges while another diverges,
// the number is unchanged, and the guard says nothing. The record therefore
// holds which PAIRS differ, and the count is derived from it for the success
// line only.
//
// **Only the SEMANTIC field may gate**, which is `check-twin-inventory.mjs`'s
// own conclusion and is load-bearing here. Fifteen of the currently-different
// pairs differ ONLY in a comment or in the platform-seam import specifier, and
// gating the byte flag would redden `pre-commit` for adding a comment to either
// side of a byte-identical pair. Two files are semantically identical iff they
// compare equal after stripping comments, canonicalizing the seam import and
// eliding blank lines, the inventory owns that definition and this guard
// IMPORTS it rather than restating it, because a second copy of a comparison is
// a second copy that can drift.
//
// **A stale record fails too, and that is myne-md/myne#473's own criterion.** A
// recorded pair that no longer differs means the record claims more drift than
// the tree has, which is the shape `check-version-routing.mjs` fails on for its
// own budget. Reporting it on the success line instead, which this guard did
// for one round, leaves the win unlocked: nothing then stops the next change
// re-introducing the divergence, which is the whole property the ratchet exists
// to hold. Clearing it is one `--record`.
//
// **The record is a ratchet in one direction only.** `--record` writes the
// CURRENT set, and refuses when that set has GROWN: a re-baseline that locks in
// a regression is the one edit that is never legitimate, and it is exactly what
// a naive `--record` offers the moment the build goes red. That refusal is the
// half nobody tests, CLAUDE.md records `check-ipc-binding-callers.mjs`'s
// placeholder passing its own reason check, and the lesson generalises: run
// `--record` on a DIRTY tree and check that the guard still fails afterwards.
// `tests/scripts/twinDriftRatchet.test.ts` does exactly that.
//
// **The floor lives HERE, not in the JSON**, following
// `scripts/check-manual-test-roster.mjs`'s `RATCHET_BASELINE`: the JSON says
// which pairs differ today, and this says what the guard may never stop
// examining. Without it the set is trivially shrinkable by shrinking the
// DENOMINATOR, drop pairs from the inventory roster and the recorded set falls
// with it, reading as progress. A ratchet whose floor lives in the same file as
// the value it bounds is a ratchet you can lower in one line.
//
// Usage:
//   node scripts/check-twin-drift-ratchet.mjs
//   node scripts/check-twin-drift-ratchet.mjs --record

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  discover,
  grammarFor,
  normalize,
  pairKey,
  seamAliases,
} from "./check-twin-inventory.mjs";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");
const RECORD = resolve(REPO, "scripts/twin-drift-ratchet.json");

/**
 * The minimum number of twin pairs this guard must EXAMINE.
 *
 * Kept here rather than in the JSON, deliberately. The JSON records which pairs
 * differ; this records what the gate may never stop covering, so narrowing the
 * denominator has to touch two files with two different rationales, one of them
 * code under review. 112 is the roster as of myne-md/myne#473. It may be raised
 * by hand when the tree genuinely grows twins; lowering it is a claim that the
 * clients share LESS than they did, which is the opposite of this epic and
 * needs an argument in the commit, not a number edit.
 */
export const EXAMINED_FLOOR = 112;

/**
 * Measure the tree: every twin pair, and which of them differ semantically.
 *
 * Injectable so the test drives it with synthetic pairs rather than against
 * `src/` and `mobile/src/`.
 */
export function measure({ pairs, read }) {
  const aliases = seamAliases();
  const examined = [];
  const different = [];
  const unreadable = [];
  for (const t of pairs) {
    const key = pairKey(t);
    const a = read(t.a);
    const b = read(t.b);
    // A pair that cannot be read is NOT examined, deliberately: counting it
    // would pad the denominator `EXAMINED_FLOOR` measures, which is the one
    // number that stops the set being shrunk by shrinking the roster.
    if (a === null || b === null) {
      unreadable.push(key);
      continue;
    }
    examined.push(key);
    // Compared on injected TEXT rather than through the inventory's `compare`,
    // which resolves the paths and reads them itself. The first version of this
    // function called `compare` and took `read` only for the null check, so its
    // "injectable" seam injected nothing and the guard's own test compared the
    // real tree against itself while claiming to drive a fixture. The grammar
    // is computed PER SIDE, as the inventory does: a pair may legitimately
    // straddle two of them.
    const same =
      normalize(a, aliases, grammarFor(t.a)) === normalize(b, aliases, grammarFor(t.b));
    if (!same) different.push(key);
  }
  return { examined, different: different.sort(), unreadable };
}

/**
 * The verdicts, over an injected measurement and record. Pure, so the test can
 * drive every arm without touching disk.
 */
export function ratchet({ different, examined, recorded, floor }) {
  const rec = new Set(recorded);
  const now = new Set(different);
  return {
    // A pair that started differing. The finding this guard exists for.
    grew: different.filter((k) => !rec.has(k)),
    // A pair that stopped differing and was never locked in.
    //
    // This FAILS, and an earlier version of this guard only reported it on the
    // success line under the reasoning that a convergence is progress rather
    // than a defect. That reversed myne-md/myne#473's own criterion, which says
    // a stale record is itself a failure "exactly as `check-version-routing.mjs`
    // reports", and that precedent fails too. The reason is the same in both:
    // a record that claims more than the tree does has stopped describing
    // anything, and an unlocked-in win is a win the next change undoes with no
    // gate in the way. Clearing it is one `--record`, which is the one edit the
    // refusal below always allows.
    shrank: recorded.filter((k) => !now.has(k)),
    // The denominator narrowed. See EXAMINED_FLOOR.
    underFloor: examined.length < floor ? { examined: examined.length, floor } : null,
  };
}

/** The parsed record, or `null` when there is none yet. */
function readRecord() {
  if (!existsSync(RECORD)) return null;
  const raw = JSON.parse(readFileSync(RECORD, "utf8"));
  return Array.isArray(raw.semanticallyDifferent) ? raw : null;
}

/**
 * The one writer, so the seed path and the update path cannot drift in what
 * they preserve. `$comment` survives an update by construction rather than by
 * both branches remembering to carry it.
 */
function writeRecord(existing, different) {
  const body = {
    $comment: existing?.$comment ?? SEED_COMMENT,
    semanticallyDifferent: different,
  };
  writeFileSync(RECORD, `${JSON.stringify(body, null, 2)}\n`);
}

const SEED_COMMENT = [
  "Twin pairs that currently differ SEMANTICALLY, comment-only and seam-import",
  "differences excluded, per scripts/check-twin-inventory.mjs's comparison, which",
  "this record imports rather than restating.",
  "",
  "A RATCHET: the set may shrink, never grow. A pair appearing here that was not",
  "here before is a regression, and `--record` REFUSES to write a grown set, so",
  "the command the failure message suggests cannot be used to make the failure go",
  "away. Locking in a convergence is the only edit it will make.",
  "",
  "The denominator has its own floor, and it is NOT in this file:",
  "`EXAMINED_FLOOR` in scripts/check-twin-drift-ratchet.mjs. Shrinking the twin",
  "roster would shrink this set too, and read as progress.",
];

function main() {
  const record = readRecord();
  const wantsRecord = process.argv.includes("--record");

  const pairs = discover();
  const read = (p) => {
    const abs = resolve(REPO, p);
    return existsSync(abs) ? readFileSync(abs, "utf8") : null;
  };
  const { examined, different, unreadable } = measure({ pairs, read });

  const recorded = record?.semanticallyDifferent ?? null;

  if (recorded === null) {
    if (!wantsRecord) {
      console.error(
        "twin-drift-ratchet: no baseline. Run\n" +
          "  node scripts/check-twin-drift-ratchet.mjs --record\n" +
          "once, then review what it wrote: every entry is a pair that answers one\n" +
          "question twice.",
      );
      process.exit(1);
    }
    writeRecord(null, different);
    console.log(
      `twin-drift-ratchet: baseline written, ${different.length} differing pair(s) of ${examined.length} examined`,
    );
    return;
  }

  const r = ratchet({ different, examined, recorded, floor: EXAMINED_FLOOR });

  if (wantsRecord) {
    // The refusal that makes this a ratchet rather than a rubber stamp.
    if (r.grew.length > 0) {
      console.error(
        `twin-drift-ratchet: --record refused, ${r.grew.length} pair(s) started differing:\n`,
      );
      for (const k of r.grew) console.error(`    ${k.replace("::", "\n      against ")}`);
      console.error(
        "\n  Recording them would lock the regression in as the new normal, which is\n" +
          "  the one edit this record is here to prevent. Converge the pair, or argue\n" +
          "  for the divergence in `scripts/check-twin-inventory.mjs`'s roster first.\n",
      );
      process.exit(1);
    }
    if (r.shrank.length === 0) {
      console.log("twin-drift-ratchet: nothing to lock in; the record already describes the tree.");
      return;
    }
    writeRecord(record, different);
    console.log(
      `twin-drift-ratchet: locked in ${r.shrank.length} convergence(s); ${different.length} pair(s) still differ.`,
    );
    return;
  }

  let failed = false;

  if (r.underFloor) {
    failed = true;
    console.error(
      `twin-drift-ratchet: only ${r.underFloor.examined} twin pair(s) examined, floor is ${r.underFloor.floor}.\n\n` +
        "  The set of differing pairs is measured against a denominator, so a\n" +
        "  smaller denominator shrinks it for free and reads as progress. Either a\n" +
        "  pair left the roster in `scripts/check-twin-inventory.mjs`, or files it\n" +
        "  names are gone. If the tree genuinely has fewer twins, say so in the\n" +
        "  commit and lower `EXAMINED_FLOOR` by hand.\n",
    );
  }

  if (unreadable.length > 0) {
    failed = true;
    console.error("twin-drift-ratchet: pair(s) that could not be compared:\n");
    for (const k of unreadable) console.error(`    ${k}`);
    console.error(
      "\n  A pair the guard cannot read is a pair it is not checking. Fix the path\n" +
        "  in the inventory roster.\n",
    );
  }

  if (r.grew.length > 0) {
    failed = true;
    console.error(`twin-drift-ratchet: ${r.grew.length} twin pair(s) started differing:\n`);
    for (const k of r.grew) console.error(`    ${k.replace("::", "\n      against ")}`);
    console.error(
      "\n  These two files answer the same product question and now answer it\n" +
        "  differently, past comments and the platform-seam import. Nothing else\n" +
        "  reports it: both trees compile, both suites pass, and each copy is\n" +
        "  pinned to itself by its own tests.\n" +
        "\n  Port the change to the twin, or, if the divergence is deliberate, \n" +
        "  record the pair's reason in `scripts/check-twin-inventory.mjs` and only\n" +
        "  then re-run with --record.\n",
    );
  }

  if (r.shrank.length > 0) {
    failed = true;
    console.error(
      `twin-drift-ratchet: ${r.shrank.length} recorded pair(s) no longer differ:\n`,
    );
    for (const k of r.shrank) console.error(`    ${k.replace("::", "\n      against ")}`);
    console.error(
      "\n  Good news, and still a failure. The record now claims more drift than\n" +
        "  the tree has, so it has stopped describing anything, and the win is not\n" +
        "  locked in: nothing stops the next change re-introducing the divergence.\n" +
        "\n  Fix: node scripts/check-twin-drift-ratchet.mjs --record\n",
    );
  }

  if (failed) process.exit(1);

  console.log(
    `twin-drift-ratchet: ok (${different.length} of ${examined.length} twin pair(s) differ semantically)`,
  );
}

if (import.meta.url === `file://${process.argv[1]}`) main();
