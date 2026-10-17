#!/usr/bin/env node
// Guard: an exported function nobody calls, in the shared trees.
//
// # The failure this prevents
//
// `export function x()` with no caller anywhere runs nowhere, and nothing in the
// tree says so. No compiler objects — the declaration is valid. No lint: this
// repository has no eslint, and a TS file with an unused *export* is not even
// lintable in principle, since the file cannot know who imports it. No test:
// nothing calls it, so nothing fails.
//
// It is the third level of the same question, and the two guards below it are why
// it has to be said three times. `check-unwired.mjs` asks whether a MODULE has a
// production importer — a module can have plenty while one of its exports has
// none, and the audit that produced this guard deleted seven such functions from
// nine files that all pass that check today. `check-ipc-binding-callers.mjs` asks
// the same question one layer down, for a binding that wraps a `plugin:` invoke —
// a binding is a small fraction of what a module exports. This is the layer the
// other two cannot see: a single dead export inside an otherwise live module.
//
// # What it measures, and what it therefore cannot see
//
// A reference is the identifier appearing, word-bounded, in a TS file other than
// the one that declares it. The CONSUMER universe is the shared roots plus the
// in-repo test and E2E trees (`tests/`, `mobile/tests/`, `e2e/`, `e2e-web/`),
// because "referenced only by a test" is not dead and calling it dead would make
// this guard fight the pattern that makes pure helpers testable.
//
// Three things follow from reading text, and each is a place a reader should not
// over-trust the number:
//
//   * A name that appears only inside a STRING counts as a reference. That
//     direction is deliberate: the false positive is a dead export reported
//     live, which is a smaller failure than a live export reported dead.
//   * A same-named export in ANOTHER tree counts as a reference. The binding
//     guard scopes callers per tree for exactly this reason and measured twelve
//     false "live" results when it did not; this guard inherits the weaker
//     universe rather than carrying a second policy table, so a dead export whose
//     name happens to exist elsewhere is invisible to it.
//   * It cannot see the COMPANION REPOS. `@myne/ornaments` and `@myne/preview` are
//     imported by `myne-website`, so an export of those packages that nothing here
//     references may still be a published API. That is what EXEMPT is for, and the
//     reason has to say so.
//
// # A RATCHET, not a ban
//
// The record is a PER-FILE COUNT in `scripts/export-callers.json`. A file's count
// may fall; it may not rise, and a file that is not on the record may not have a
// single unreferenced export. `--record` moves counts DOWN only and refuses to
// bless a new or grown one, so the command the failure message suggests is never
// the way to make the failure go away.
//
// Run by hand:   node scripts/check-export-callers.mjs
//                node scripts/check-export-callers.mjs --record   (lock in shrinks)
//                node scripts/check-export-callers.mjs --emit     (print the measurement)
// Wired into:    lefthook `pre-commit`, CI `pnpm-build`.
//
// `--emit` exists for the ONE state `--record` cannot serve: the first seeding,
// where the record is empty and every measured file therefore reads as new (which
// is the refusal, correctly — `--record` may never bless a count that is not already
// recorded). It prints the measurement so the record can be written by hand and
// reviewed in the same change that adds the guard.

import { readFileSync, readdirSync, statSync, writeFileSync, existsSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { presentSharedRoots } from "./lib/shared-roots.mjs";

const ROOT = new URL("..", import.meta.url).pathname;
const RECORD = join(ROOT, "scripts/export-callers.json");

/** Trees whose exported functions this guard holds. The shared roster, never a private copy. */
const SCAN_ROOTS = presentSharedRoots().present;

/**
 * Trees that may CONSUME an export.
 *
 * The test and E2E trees are here on purpose: an export a test drives is not
 * dead, and a guard that said so would fight `src/AGENTS.md`'s own rule that a
 * seam can only be pinned by driving it.
 */
const CONSUMER_ROOTS = ["tests", "mobile/tests", "e2e", "e2e-web"];

/**
 * Files whose unreferenced exports are deliberate, with the reason.
 *
 * One shape belongs here and nothing else: an export that is PUBLIC API for a
 * CONSUMER THIS GUARD CANNOT SEE (a companion repo, a published package). The
 * reason has to name the consumer, because "we might need it" is the argument the
 * ratchet exists to refuse.
 */
export const EXEMPT = Object.freeze([]);

const SCAN_EXT = new Set([".ts", ".tsx", ".mts"]);

/** A test, a spec, a declaration file or anything under a `tests/` directory. */
export function isTestPath(rel) {
  return /\.test\.|\.spec\.|\.d\.ts$|(^|\/)tests?\//.test(rel);
}

/**
 * The exported FUNCTION names a source declares.
 *
 * Functions only. A `type`, an `interface` and a `const` that is not a function
 * are deliberately out of scope: a type is erased at build time and cannot be
 * dead (it is documentation that the compiler checks), and a const is as likely
 * to be a configuration table a consumer indexes by name as it is to be dead code.
 * Widening this would put thousands of entries in the record and bury the signal.
 *
 * Both arrow-function and `function` forms count: `export const x = () => …` is
 * how half of this tree writes a helper, and missing it was the reason the first
 * version of `check-ipc-binding-callers.mjs` reported nothing.
 */
export function exportedFunctionNames(source) {
  const names = [];
  for (const m of source.matchAll(/^export\s+(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/gm)) {
    names.push(m[1]);
  }
  for (const m of source.matchAll(/^export\s+const\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(?:async\s*)?\(/gm)) {
    names.push(m[1]);
  }
  return names;
}

/**
 * Every identifier every file MENTIONS, as an index of the first two files that
 * mention it.
 *
 * Two files rather than a list, because the question is never "does anyone
 * mention this name" but "does anyone OTHER THAN the definer" — and the definer is
 * always among its own mentions. Answering that from the first two distinct files
 * cannot be wrong and keeps the memory proportional to the identifier count rather
 * than to the tree.
 *
 * This replaced a per-name regex scan over every file. That version was correct and
 * took **9.5 s** on this tree — the whole of the pre-commit hook's remaining budget
 * — because 3318 exports × 2999 files is ten million regex scans. The index is one
 * pass over each file instead, and the identifier regex has the same word-boundary
 * semantics the scan did: a name inside a longer identifier is a different
 * identifier, and a name inside a string counts.
 */
export function mentionIndex(universe) {
  const index = new Map();
  for (const [file, source] of universe) {
    for (const m of source.matchAll(/[A-Za-z_$][\w$]*/g)) {
      const name = m[0];
      const seen = index.get(name);
      if (!seen) index.set(name, [file]);
      else if (seen.length < 2 && seen[0] !== file) seen.push(file);
    }
  }
  return index;
}

/** The one rule: mentioned by a file other than the one that declares it. */
export function isReferenced(index, name, definerKey) {
  const seen = index.get(name);
  if (!seen) return false;
  return seen.some((file) => file !== definerKey);
}

function walk(absDir, out = []) {
  let entries;
  try {
    entries = readdirSync(absDir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (entry.name === "node_modules" || entry.name === "dist" || entry.name === ".git") continue;
    const full = join(absDir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (SCAN_EXT.has(entry.name.slice(entry.name.lastIndexOf(".")))) out.push(full);
  }
  return out;
}

/** Every `[repo-relative path, source]` pair under `roots`. */
export function readTrees(roots, root = ROOT) {
  const out = [];
  for (const r of roots) {
    const abs = join(root, r);
    try {
      if (!statSync(abs).isDirectory()) continue;
    } catch {
      continue;
    }
    for (const f of walk(abs)) {
      const rel = relative(root, f).split(sep).join("/");
      out.push([rel, readFileSync(f, "utf8")]);
    }
  }
  return out;
}

/**
 * The per-file count of exports that nothing in the universe references.
 *
 * Only files that HAVE such an export appear, so the shape of the record is the
 * shape of the debt rather than the shape of the tree.
 */
export function measure({ exporters, universe }) {
  const index = mentionIndex(universe);
  const found = new Map();
  for (const [file, source] of exporters) {
    const names = exportedFunctionNames(source);
    if (names.length === 0) continue;
    const dead = names.filter((n) => !isReferenced(index, n, file));
    if (dead.length) found.set(file, dead);
  }
  return found;
}

/**
 * The ratchet, as a pure function so every arm is reachable from a test.
 *
 * @param {{record: Record<string, number>, found: Map<string, string[]>,
 *          exempt?: readonly any[], readFile?: unknown}} io
 * @returns {{failures: string[], findings: Array<{kind: string, message: string}>,
 *            blocking: string[], notes: string[], stats: object}}
 */
export function analyse(io) {
  if (!("record" in io)) {
    throw new Error("analyse: `record` is required. Pass the parsed record, or `{}` to opt out explicitly.");
  }
  // Every finding carries a KIND, and the kind decides whether `--record` may
  // answer it. A `stale-budget` IS the shrink signal, so refusing `--record` on one
  // would make the command the failure message suggests the one command that cannot
  // run; every other kind is a defect a re-baseline must not bless.
  const findings = [];
  const notes = [];
  const record = io.record || {};
  const found = io.found instanceof Map ? io.found : new Map(Object.entries(io.found || {}));
  const exempt = io.exempt || EXEMPT;
  const exempted = exemptSet(exempt);
  // The exemption is applied HERE rather than inside `measure`, and that split is
  // load-bearing: a file excused before measurement could never be checked for
  // staleness, because its own subject would have been removed from the answer.
  const rated = rate(found, exempt);

  // --- The ratchet's two directions, over the union of record and reality. ---
  for (const file of [...new Set([...Object.keys(record), ...rated.keys()])].sort()) {
    const budget = record[file] ?? 0;
    const dead = rated.get(file) || [];
    const count = dead.length;

    if (count > budget) {
      findings.push({
        kind: budget ? "grown" : "new",
        message:
          `${file}: ${count} exported function(s) that nothing references` +
          (budget ? `, up from a recorded ${budget}` : "") +
          `.\n      ${dead.join(", ")}\n` +
          `      Delete them, or record the file in this script's EXEMPT with the consumer that needs them.` +
          (budget ? ` A ratchet may shrink; it may not grow.` : ` A NEW file starts at zero.`),
      });
    } else if (count < budget) {
      findings.push({
        kind: "stale-budget",
        message:
          `${file}: recorded ${budget}, found ${count}. The budget is stale, so the number no longer ` +
          `describes the tree. Run \`node scripts/check-export-callers.mjs --record\` to lock the shrink in.`,
      });
    }
  }

  // --- The exemption list's own both-directions rule. -----------------------
  for (const entry of exempt) {
    const file = typeof entry === "string" ? entry : entry.file;
    const reason = typeof entry === "string" ? "" : (entry.reason || "").trim();
    if (reason.length < 40) {
      findings.push({
        kind: "exempt-reason",
        message:
          `EXEMPT[${file}]: the reason is shorter than 40 characters. An export kept for a consumer ` +
          `outside this repo has to name that consumer.`,
      });
      continue;
    }
    if (!found.has(file) && !deadInRecord(record, file)) {
      findings.push({
        kind: "exempt-stale",
        message:
          `EXEMPT[${file}] is stale: the file has no unreferenced export, so the exemption describes ` +
          `nothing. Remove it, or every future export here is pre-excused.`,
      });
    }
  }

  const total = [...rated.values()].reduce((a, v) => a + v.length, 0);
  notes.push(`${total} exported function(s) with no reference across ${rated.size} file(s)`);
  return {
    failures: findings.map((f) => f.message),
    findings,
    // What `--record` may NOT answer. A stale budget is deliberately not here.
    blocking: findings.filter((f) => f.kind !== "stale-budget").map((f) => f.message),
    notes,
    stats: { total, files: rated.size, exempt: exempt.length },
  };
}

/** The exemption list as a set of files. */
function exemptSet(exempt) {
  return new Set(exempt.map((e) => (typeof e === "string" ? e : e.file)));
}

/**
 * The measured counts with the exemptions subtracted — the map the ratchet and
 * `--record` both read. Exported so the CLI and `analyse` cannot disagree about
 * which files are rated, which is the shape that let the reason-prefix filter in
 * `check-version-routing.mjs` pass while printing zero.
 */
export function rate(found, exempt = EXEMPT) {
  const excused = exemptSet(exempt);
  return new Map([...found].filter(([file]) => !excused.has(file)));
}

/** Is `file` carried by the record at all? Used by the exemption staleness arm. */
function deadInRecord(record, file) {
  return Object.prototype.hasOwnProperty.call(record, file);
}

/** The record a `--record` run may write: measured counts, and refusals for anything that grew. */
export function recordFrom(record, found) {
  const grown = [];
  for (const [file, dead] of found) {
    const budget = record[file] ?? 0;
    if (dead.length > budget) grown.push({ file, was: budget, now: dead.length });
  }
  if (grown.length) return { grown, next: null };
  const next = {};
  for (const file of [...found.keys()].sort()) next[file] = found.get(file).length;
  return { grown, next };
}

function main() {
  const argv = process.argv.slice(2);
  const wantRecord = argv.includes("--record");
  const wantEmit = argv.includes("--emit");

  const universe = readTrees(SCAN_ROOTS.concat(CONSUMER_ROOTS));
  const exporters = readTrees(SCAN_ROOTS).filter(([rel]) => !isTestPath(rel));
  const found = measure({ exporters, universe });

  if (wantEmit) {
    console.log(JSON.stringify(Object.fromEntries([...found.keys()].sort().map((k) => [k, found.get(k).length])), null, 2));
    return;
  }

  const record = existsSync(RECORD) ? JSON.parse(readFileSync(RECORD, "utf8")) : {};
  const rated = rate(found, EXEMPT);
  const { failures, blocking, notes } = analyse({ record, found, exempt: EXEMPT });
  const { grown, next } = recordFrom(record, rated);

  if (wantRecord) {
    // Only the findings a re-baseline may not answer. A stale budget is the one it
    // exists to answer; a new or grown count is the one it must never bless.
    if (blocking.length) {
      console.error(`check-export-callers: --record refused, ${blocking.length} failure(s) first.\n`);
      for (const f of blocking) console.error(`  - ${f}\n`);
      process.exit(1);
    }
    if (grown.length) {
      console.error(
        "check-export-callers: --record refuses to bless a new or grown count " +
          `(${grown.map((g) => `${g.file} ${g.was}->${g.now}`).join(", ")}). ` +
          "Delete the exports, or argue them into EXEMPT.",
      );
      process.exit(1);
    }
    writeFileSync(RECORD, `${JSON.stringify(next, null, 2)}\n`);
    console.log(`check-export-callers: --record: ${Object.keys(next).length} file(s) recorded.`);
    return;
  }

  if (failures.length) {
    console.error(`check-export-callers: ${failures.length} failure(s)\n`);
    for (const f of failures) console.error(`  - ${f}\n`);
    process.exit(1);
  }
  console.log(`export-callers: ok (${exporters.length} file(s) exported from)`);
  console.log(
    `  ${notes.join("; ")}. This number must only go down.` +
      (EXEMPT.length ? ` ${EXEMPT.length} reasoned exemption(s).` : ""),
  );
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main();
}
