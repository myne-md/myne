#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0
//
// ## The failure this prevents
//
// "May this device sign a vault head, and with what?" is answered by ONE resolver,
// `core/src/plugins/sync/authority`. It reads the device id, the key at rest, the
// binding row and the held person identity and returns a decision plus a cause.
//
// Before it existed that question was answered in three places and each answer was
// slightly different: the head context loaded the key with `load_for_fallback` (which
// swallows every error), the roster verification loaded it again with a different error
// policy, and the binding claim compared a stored row against halves it never read back
// from the store. The consequence was not a crash. A `0x02` binding row published a
// signing key the OS store did not hold, every sync cycle refused with "Unlock your
// identity to sync", and typing the 24-word phrase fixed it for exactly one session
// (myne-md/myne#983). Nothing in the tree could see it: three answers that agree on the
// states that exist today disagree silently on the state that does not exist yet.
//
// A comment saying "ask the resolver" is not a mechanism. That is why the call sites are
// RECORDED, the same way `scripts/check-device-actor.mjs` records the readers of the
// device id: the second answer COMPILES, produces no error anywhere, and is invisible in
// review unless something names it.
//
// ## The rule
//
// Every call to one of the four primitives that answer a piece of the authority question
// is recorded here with the reason it is allowed to bypass the resolver:
//
//   * `device_identity::load(` and `::load_for_fallback(` read the key at rest;
//   * `clone_person_identity(` reads the held person identity;
//   * `durable_device_id(` answers "which device is this" (as `device_actor`, which owns
//     that question, and which this guard treats as authoritative rather than repeats).
//
// A new call site fails this guard and has to argue for itself in review. The record is
// the only place that argument survives.
//
// ## Verified by injection, both directions
//
//   * A call planted in any `core/src` file fails with the file, the line and the source.
//   * `--record` on a tree with an unseen call writes the entry with an EMPTY reason, and
//     an empty reason is itself a failure, so re-baselining cannot silently license what
//     it found. (The trap this closes is in AGENTS.md: a placeholder reason that passes its
//     own length check. The seed is `TODO`, four characters, so it cannot.)
//   * Deleting a recorded line fails as stale, so the record cannot rot into a statement
//     about a tree that no longer exists.
//   * The record carries an expected COUNT per (file, source text) rather than a bare
//     permission, because the likeliest second reader is a copy-paste of a line that is
//     already there and copy-paste produces identical text.
//
// `MYNE_SYNC_AUTHORITY_ROOT` moves the root (and the record with it), which is how a test
// plants its probe in a temp directory instead of inside a real source tree.
//
// Zero dependencies, node builtins only, sub-second: it runs in `pre-commit`.

import { readFileSync, writeFileSync, readdirSync, statSync, existsSync, mkdirSync } from "node:fs";
import { join, relative, dirname } from "node:path";

const ROOT = process.env.MYNE_SYNC_AUTHORITY_ROOT ?? process.cwd();
const RECORD = join(ROOT, "scripts", "sync-authority-sites.json");

// Only `core/src`: the authority question is a backend one, and `device_identity` is a
// core module. A client that grows its own answer cannot reach these symbols without a
// command, and the command boundary is where `check-web-command-coverage.mjs` already is.
const ROOTS = ["core/src"];

/** The primitives that answer a piece of the authority question, with what each answers. */
const PATTERNS = [
  { re: /\bdevice_identity::load\s*\(/g, what: "key at rest" },
  { re: /\bdevice_identity::load_for_fallback\s*\(/g, what: "key at rest, errors swallowed" },
  // The MINT is the fourth answer to the authority question: the first `Some` out of it is a
  // key this device will sign with, so a site that mints outside the resolver has decided the
  // question without asking it (myne-md/myne#983 review, D9).
  { re: /\bdevice_identity::load_or_create\s*\(/g, what: "minting the key at rest" },
  { re: /\bclone_person_identity\s*\(/g, what: "held person identity" },
  { re: /\bdurable_device_id\s*\(/g, what: "which device is this" },
];

/** Every matching call in the Rust tree, as `{file, line, text, what}`. */
function scan() {
  const found = [];
  for (const root of ROOTS) {
    const abs = join(ROOT, root);
    if (!existsSync(abs)) continue;
    walk(abs, found);
  }
  return found;
}

function walk(dir, found) {
  for (const entry of readdirSync(dir)) {
    const abs = join(dir, entry);
    const st = statSync(abs);
    if (st.isDirectory()) {
      walk(abs, found);
      continue;
    }
    if (!entry.endsWith(".rs")) continue;
    const file = relative(ROOT, abs).split("\\").join("/");
    const lines = readFileSync(abs, "utf8").split("\n");
    for (const [i, text] of lines.entries()) {
      if (text.trimStart().startsWith("//")) continue;
      for (const { re, what } of PATTERNS) {
        // `lastIndex` is meaningless with the `g` flag reused across lines.
        re.lastIndex = 0;
        if (!re.test(text)) continue;
        found.push({ file, line: i + 1, text: normalise(text), what });
        break;
      }
    }
  }
}

/** Whitespace-collapsed source text: an entry survives an unrelated reformat, a new
 *  statement does not. */
function normalise(text) {
  return text.replace(/\s+/g, " ").trim();
}

function loadRecord() {
  if (!existsSync(RECORD)) return { sites: {} };
  return JSON.parse(readFileSync(RECORD, "utf8"));
}

function saveRecord(record) {
  const out = {};
  for (const file of Object.keys(record.sites).sort()) {
    const lines = record.sites[file];
    out[file] = Object.fromEntries(
      Object.keys(lines)
        .sort()
        .map((k) => [k, lines[k]]),
    );
  }
  mkdirSync(dirname(RECORD), { recursive: true });
  writeFileSync(RECORD, `${JSON.stringify({ sites: out }, null, 2)}\n`);
}

/** Group the scan by `file` then by source text, keeping every line of each text. */
function group(found) {
  const byFile = new Map();
  for (const hit of found) {
    if (!byFile.has(hit.file)) byFile.set(hit.file, new Map());
    const byText = byFile.get(hit.file);
    if (!byText.has(hit.text)) byText.set(hit.text, []);
    byText.get(hit.text).push(hit.line);
  }
  return byFile;
}

const SEED = "TODO";

function main() {
  let record = loadRecord();
  const found = scan();

  if (process.argv.includes("--record")) {
    const next = { sites: {} };
    for (const [file, byText] of group(found)) {
      next.sites[file] = {};
      for (const [text, lines] of byText) {
        const prior = record.sites[file]?.[text];
        // A recorded reason is carried over; an unseen call gets the SEED on purpose, so
        // the very next check fails until a human writes a sentence. The count is always
        // re-measured: it describes the tree, and the tree is what just changed.
        next.sites[file][text] = {
          count: lines.length,
          reason: typeof prior === "string" ? prior : (prior?.reason ?? SEED),
        };
      }
    }
    saveRecord(next);
    record = next;
    const blank = Object.values(next.sites)
      .flatMap((l) => Object.values(l))
      .filter((e) => e.reason.trim() === "" || e.reason.trim() === SEED).length;
    console.log(
      blank === 0
        ? `sync-authority: recorded ${found.length} call(s) (all reasoned).`
        : `sync-authority: recorded ${found.length} call(s), ${blank} WITHOUT a reason. ` +
            "Write one in scripts/sync-authority-sites.json before this can pass.",
    );
    // Deliberately no exit-0 shortcut: main() falls through to the check below, which is
    // what makes a bare re-baseline fail rather than license what it found.
  }

  const problems = [];
  const observed = group(found);

  for (const [file, byText] of observed) {
    for (const [text, lines] of byText) {
      const entry = record.sites[file]?.[text];
      if (!entry) {
        problems.push(
          `${file}:${lines[0]} answers part of the authority question on its own:\n` +
            `    ${text}\n` +
            "  Ask `sync::authority` instead, or record the call with its reason in\n" +
            "  scripts/sync-authority-sites.json (`--record` seeds it with TODO, which fails\n" +
            "  until a sentence is written).",
        );
        continue;
      }
      if (entry.reason.trim() === "" || entry.reason.trim() === SEED) {
        problems.push(
          `${file}:${lines[0]} is recorded WITHOUT a usable reason:\n    ${text}\n` +
            "  Write the sentence that says why this call is allowed to bypass the resolver.",
        );
      }
      if (lines.length > entry.count) {
        problems.push(
          `${file}:${lines[0]} appears ${lines.length} times where the record licenses ` +
            `${entry.count}:\n    ${text}\n` +
            "  A copy-paste of an allowed line is a second answer with the same text.",
        );
      }
    }
  }

  // Stale entries: a recorded call that no longer exists describes a tree that is gone.
  for (const [file, byText] of Object.entries(record.sites)) {
    for (const [text, entry] of Object.entries(byText)) {
      const seen = observed.get(file)?.get(text)?.length ?? 0;
      if (seen === 0) {
        problems.push(
          `${file} records a call that is no longer there:\n    ${text}\n` +
            "  Run `node scripts/check-sync-authority.mjs --record` and drop the entry.",
        );
      } else if (seen !== entry.count) {
        problems.push(
          `${file} records ${entry.count} occurrence(s), the tree has ${seen}:\n    ${text}`,
        );
      }
    }
  }

  if (problems.length > 0) {
    console.error(`sync-authority: ${problems.length} problem(s)\n`);
    for (const p of problems) console.error(`  * ${p}\n`);
    process.exit(1);
  }
  console.log(
    `sync-authority: ok (${found.length} recorded call(s); "may this device sign" is answered ` +
      "by `sync::authority` everywhere else)",
  );
}

main();
