#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0
//
// ## The failure this prevents
//
// "Which device am I?" is answered by two on-disk records: the vault enrolment
// (`sync-state.json`, field `device_id_hex`) and the person credential
// (`person-auth.json`, same field name). For a vault born from a person identity the
// first is written LAST and can stay empty for a long time while the second is
// populated. That is the observed state of the reporting device, where
// `sync-state.json` said `"device_id_hex": null` and `person-auth.json` said
// `fe073b33…`.
//
// Two modules each picked one record, and neither knew about the other:
//
//   * `sync::cycle::person_device_id` read the person credential,
//   * the authoring path, the live-session actor, the binding claim and the
//     `0x03` signed-head decision read the enrolment.
//
// So the same device was `fe073b33…` in the version vector and `None` everywhere
// else. That produced a cascade nobody could trace back to this line: every note edit
// committed under a fresh random actor (no attribution), the device never wrote its
// `MYU5` binding row, every signed head fell back to the phrase-signed `0x02` path,
// and, the symptom the user reported, the live-session actor fell back to sixteen
// zero bytes, which the identity resolver then rendered as a device named `000000`.
// Every device without an id shared that one roster row.
//
// A comment saying "read it here" is not a mechanism: the wrong read COMPILED, both
// times, and it produced no error anywhere. So the reads are recorded.
//
// ## The rule
//
// `device_id_hex` reached through a value (`.device_id_hex`) is the only way either
// record's id is read, so every such site in the Rust trees is recorded here with the
// reason it is allowed. Exactly one site is the reader of the vault's own identity:
// `core/src/plugins/sync/device_actor.rs`, whose `durable_device_id` is the single
// answer to "which device is this". The rest are one of:
//
//   * a WRITE (enrolment, adoption), which cannot create a second reading;
//   * a device ROW id from the server's device list, a different value that happens
//     to share a field name;
//   * an auth flow that authenticates WITH the credential rather than asking "who am
//     I", which `device_actor` cannot answer for it (it needs the raw string);
//   * a test fixture.
//
// A new read that is none of those fails this guard and has to argue for itself in
// review, which is the point, because the record is the only place the argument can
// be read later.
//
// ## Verified by injection, both directions
//
//   * A read planted in `core/src/plugins/live/session.rs` (or any file) fails with
//     the file, the line and the surrounding source.
//   * `--record` on a tree with an unseen read writes the entry with an EMPTY reason,
//     and an empty reason is itself a failure, so re-baselining cannot silently
//     license what it found. (The trap this closes is documented in AGENTS.md: a
//     placeholder reason that passes its own length check.)
//   * Deleting a recorded line fails as stale, so the record cannot rot into a
//     statement about a tree that no longer exists.
//   * The record carries an expected occurrence COUNT per (file, source text), not just
//     a permission, because the likeliest second reader is a copy-paste of a line that
//     is already there, and copy-paste produces identical text. Keyed by text alone,
//     one reason licenses every copy of that line forever, which is the arm that would
//     have been silent on the very defect this guard exists for.
//
// `MYNE_DEVICE_ACTOR_ROOT` moves the root (and the record with it), which is how the
// test plants its probe in a temp directory instead of inside a real source tree: a
// killed run must not leave a stray `.rs` file that turns every later `pre-commit` red.
//
// ## A comment is not a read, and the scan cannot tell
//
// The scan is textual on purpose: it has to see `.device_id_hex` through every expression
// shape, including ones no syntax-only rule anticipates. The cost is that a line which
// merely MENTIONS the field (a doc comment explaining what a test asserts) is reported
// like a read. Record the real ones and REWORD the prose: recording a comment would put a
// lie in the record, since the reason field licenses a read and there is none there.
//
// Zero dependencies, node builtins only, sub-second: it runs in `pre-commit` and in
// CI's `pnpm-build`.

import {
  readFileSync,
  writeFileSync,
  readdirSync,
  statSync,
  existsSync,
  mkdirSync,
} from "node:fs";
import { join, relative, dirname } from "node:path";

const ROOT = process.env.MYNE_DEVICE_ACTOR_ROOT ?? process.cwd();
const RECORD = join(ROOT, "scripts", "device-actor-readers.json");

// The Rust trees that can answer "which device is this". `mobile/src-tauri` is here
// even though it consumes `myne-core` rather than reimplementing it: a client that
// grows its own read is the same defect one crate over.
const ROOTS = [
  "core/src",
  "src-tauri/src",
  "web/wasm/src",
  "mobile/src-tauri/src",
  "cli/src",
  "mcp/src",
  "format/src",
  "decrypt/src",
];

// The one reader. Its reads are recorded like every other, so a second reader cannot
// hide by living in the same file: adding one there also needs a reason.
const READER = "core/src/plugins/sync/device_actor.rs";

const PATTERN = /\.device_id_hex\b/g;

/** Every `.device_id_hex` access in the Rust trees, as `{file, line, text}`. */
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
      if (!text.includes(".device_id_hex")) continue;
      // `lastIndex` is meaningless with the `g` flag reused across lines.
      PATTERN.lastIndex = 0;
      if (!PATTERN.test(text)) continue;
      found.push({ file, line: i + 1, text: normalise(text) });
    }
  }
}

/** Whitespace-collapsed source text: an entry survives an unrelated reformat, a new
 *  statement does not. */
function normalise(text) {
  return text.replace(/\s+/g, " ").trim();
}

function loadRecord() {
  if (!existsSync(RECORD)) return { readers: {} };
  return JSON.parse(readFileSync(RECORD, "utf8"));
}

function saveRecord(record) {
  // One line per entry, grouped by file: a diff on this file must read as a list of
  // sentences about reads, not as a reflowed JSON blob.
  const out = {};
  for (const file of Object.keys(record.readers).sort()) {
    const lines = record.readers[file];
    out[file] = Object.fromEntries(
      Object.keys(lines)
        .sort()
        .map((k) => [k, lines[k]]),
    );
  }
  // `mkdir` because `MYNE_DEVICE_ACTOR_ROOT` can name a root that has no `scripts/`
  // yet, and a guard that cannot write its record fails as an unrelated ENOENT.
  mkdirSync(dirname(RECORD), { recursive: true });
  writeFileSync(RECORD, `${JSON.stringify({ readers: out }, null, 2)}\n`);
}

/** Group the scan by `file` then by source text, keeping every LINE of each text: the
 *  count is what the record licenses, so the hits themselves have to survive the
 *  grouping. */
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

function main() {
  const args = process.argv.slice(2);
  let record = loadRecord();
  const found = scan();

  if (args.includes("--record")) {
    const next = { readers: {} };
    for (const [file, byText] of group(found)) {
      next.readers[file] = {};
      for (const [text, lines] of byText) {
        const prior = record.readers[file]?.[text];
        // A recorded reason is carried over; an unseen read gets NONE on purpose, so
        // the very next `--check` fails until a human writes one. The count is always
        // re-measured: it describes the tree, and the tree is what just changed.
        next.readers[file][text] = {
          count: lines.length,
          reason: typeof prior === "string" ? prior : (prior?.reason ?? ""),
        };
      }
    }
    saveRecord(next);
    // The check below must read what was just WRITTEN, not the copy loaded before
    // it: a guard that writes its record and then verifies the pre-write copy
    // reports entries it has already dropped as stale, which reads as a real
    // finding and hides whether the write was sound.
    record = next;
    const blank = Object.values(next.readers)
      .flatMap((l) => Object.values(l))
      .filter((entry) => entry.reason.trim() === "").length;
    console.log(
      blank === 0
        ? `device-actor: recorded ${found.length} reads (all reasoned).`
        : `device-actor: recorded ${found.length} reads, ${blank} WITHOUT a reason. \
write one in scripts/device-actor-readers.json before this can pass.`,
    );
    // Deliberately not an exit 0 shortcut: main() falls through to the check below,
    // which is what makes a bare re-baseline fail rather than license.
  }

  const problems = [];
  const observed = group(found);

  for (const [file, byText] of observed) {
    for (const [text, lines] of byText) {
      const entry = record.readers[file]?.[text];
      // A bare string is the pre-count record shape; it carries no licence because it
      // says nothing about how many copies it covers.
      if (entry === undefined || typeof entry === "string") {
        problems.push([
          "unrecorded",
          `${file}:${lines[0]}`,
          text,
          'a read of a device id that is not in scripts/device-actor-readers.json. \
route it through `sync::device_actor::durable_device_id` instead, or record it with a reason',
        ]);
        continue;
      }
      if (lines.length > entry.count) {
        // The copy-paste arm: identical text, more occurrences than were licensed. The
        // line numbers named are the copies nobody argued for.
        problems.push([
          "unrecorded copy",
          `${file}:${lines[entry.count]}`,
          text,
          `${lines.length} copies of this line are in the file but the record licenses ${entry.count} ` +
            "A second reader that reuses a licensed line's text is still a second reader.",
        ]);
      } else if (lines.length < entry.count) {
        problems.push([
          "stale count",
          `${file}:${lines.length === 0 ? 1 : lines[0]}`,
          text,
          `${entry.count} copies recorded, ${lines.length} in the tree. Re-run ` +
            "`node scripts/check-device-actor.mjs --record` so the count describes the tree",
        ]);
      }
      if (typeof entry.reason !== "string" || entry.reason.trim().length < 20) {
        problems.push([
          "no reason",
          `${file}:${lines[0]}`,
          text,
          "this read is recorded but says nothing about why it may read the raw field",
        ]);
      }
    }
  }

  for (const [file, byText] of Object.entries(record.readers)) {
    for (const text of Object.keys(byText)) {
      if (observed.get(file)?.has(text)) continue;
      problems.push([
        "stale",
        file,
        text,
        "recorded here but no longer in the tree. Re-run `node scripts/check-device-actor.mjs --record`",
      ]);
    }
  }

  if (problems.length === 0) {
    const files = new Set(found.map((h) => h.file)).size;
    console.log(
      `device-actor: ${found.length} recorded reads across ${files} files; the only reader of \
the vault's identity is ${READER}.`,
    );
    return 0;
  }

  for (const [kind, where, text, why] of problems) {
    console.error(`\n${kind}: ${where}`);
    console.error(`  ${text}`);
    console.error(`  ${why}`);
  }
  console.error(
    `\n${problems.length} device-id read(s) are not accounted for. The vault's own device \
identity has ONE reader, \`sync::device_actor::durable_device_id\`: the enrolment record first, \
the person credential second. A second reader is how this device became \`fe073b33…\` in its \
version vector and \`None\` in its authoring, binding and presence paths (myne-md/myne#958).`,
  );
  return 1;
}

process.exit(main());
