#!/usr/bin/env node
// The published-bundle-hash record's two gates (phase3-web-client task 56).
//
//   node scripts/check-bundle-record.mjs --has <sha256:…>   # deploy precondition
//   node scripts/check-bundle-record.mjs --append-only [ref] # history gate
//
// # Why a precondition rather than a log
//
// "Every released bundle's hash goes into a public record so substitution is
// detectable after the fact" can be built two ways, and only one of them is
// worth having. A record WRITTEN AFTER the deploy detects nothing: whoever
// substituted the bundle also writes the record, and the two agree. A record
// the deploy is GATED ON inverts that — a bundle whose hash was not published
// first cannot reach the origin at all, so the attacker has to publish their
// substitution before performing it.
//
// That gate is only usable because the build is reproducible (task 16): the
// hash for a commit can be known before the deploy, by anyone, which is what
// lets it be written down first.
//
// # What the append-only gate can and cannot promise
//
// It re-reads the table as it existed at a base ref and fails if an existing
// row changed or vanished. Anyone who controls this repository can still
// rewrite history — what they cannot do is rewrite it QUIETLY, because the
// rewrite has to arrive as a force-push. The record file says this in its own
// text too; a security property nobody states precisely gets read as stronger
// than it is.
//
// Node built-ins only.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

const repoRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const RECORD = "docs/web-bundle-hashes.md";

/** One row of the record table. */
function parseRows(markdown) {
  const rows = [];
  for (const line of markdown.split("\n")) {
    // A data row of the record table: three backticked-or-plain cells, the
    // third of which is a sha256. Matching on the HASH shape rather than on
    // position means a new column cannot silently break the parse into
    // "everything is fine, zero rows".
    const m = line.match(/^\|\s*([0-9]{4}-[0-9]{2}-[0-9]{2})\s*\|\s*`?([0-9a-f]{7,40})`?\s*\|\s*`?(sha256:[0-9a-f]{64})`?\s*\|/);
    if (m) rows.push({ date: m[1], commit: m[2], hash: m[3] });
  }
  return rows;
}

function readRecordAt(ref) {
  try {
    return execFileSync("git", ["show", `${ref}:${RECORD}`], {
      cwd: repoRoot,
      encoding: "utf8",
    });
  } catch {
    // Absent at that ref is not a failure: the record has a first commit, and
    // before it there was nothing to preserve.
    return null;
  }
}

const args = process.argv.slice(2);
const current = readFileSync(resolve(repoRoot, RECORD), "utf8");
const rows = parseRows(current);

if (rows.length === 0) {
  console.error(
    `${RECORD} parsed to ZERO rows. Either the table is empty or its shape changed\n` +
      `and this parser no longer recognises it — both must fail, because a gate that\n` +
      `silently reads nothing approves everything.`,
  );
  process.exit(1);
}

const hasIndex = args.indexOf("--has");
if (hasIndex !== -1) {
  const wanted = args[hasIndex + 1];
  if (!wanted || !/^sha256:[0-9a-f]{64}$/.test(wanted)) {
    console.error("usage: check-bundle-record.mjs --has sha256:<64 hex chars>");
    process.exit(2);
  }
  if (!rows.some((r) => r.hash === wanted)) {
    console.error(
      `REFUSING THE DEPLOY: ${wanted}\nis not in ${RECORD}.\n\n` +
        `The record is a precondition, not a log. Publish the hash first — add a row\n` +
        `to that table in a reviewed commit — and deploy after. If this hash surprises\n` +
        `you, that is the gate doing its job: the origin was about to serve a bundle\n` +
        `nobody published.\n\n` +
        `Reproduce the hash for a commit with the procedure in the record's own header.`,
    );
    process.exit(1);
  }
  console.log(`ok — ${wanted} is published (${rows.length} row(s) in the record)`);
  process.exit(0);
}

if (args.includes("--append-only")) {
  const base = args[args.indexOf("--append-only") + 1] ?? "origin/develop";
  const before = readRecordAt(base);
  if (before === null) {
    console.log(`ok — no record at ${base}; nothing to preserve yet (${rows.length} row(s) now)`);
    process.exit(0);
  }
  const oldRows = parseRows(before);
  const problems = [];
  for (const [i, old] of oldRows.entries()) {
    const now = rows[i];
    if (!now) {
      problems.push(`row ${i + 1} (${old.date}, ${old.hash.slice(0, 20)}…) was REMOVED`);
      continue;
    }
    if (now.hash !== old.hash || now.commit !== old.commit || now.date !== old.date) {
      problems.push(`row ${i + 1} was EDITED (was ${old.date} ${old.commit.slice(0, 8)})`);
    }
  }
  if (problems.length > 0) {
    console.error(
      `${RECORD} is append-only and this change is not an append:\n  ` +
        problems.join("\n  ") +
        `\n\nRows are added, never edited or removed. A withdrawn build is published as a\n` +
        `NEW row for its replacement — deleting the bad entry is exactly the rewrite the\n` +
        `record exists to make impossible to do quietly.`,
    );
    process.exit(1);
  }
  console.log(
    `ok — ${oldRows.length} existing row(s) unchanged, ${rows.length - oldRows.length} appended`,
  );
  process.exit(0);
}

console.error("usage: check-bundle-record.mjs (--has <hash> | --append-only [base-ref])");
process.exit(2);
