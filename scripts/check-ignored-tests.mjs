#!/usr/bin/env node
// check-ignored-tests.mjs — an `#[ignore]` that carries a reason is a DEFERRED
// CLAIM, and a deferred claim owes a tracking issue and a roster entry.
//
// WHY THIS EXISTS. `decisions/security/0614-unfixed-security-findings-ship-as-ignored-invariant-tests.md`
// records the convention: when a verification pass establishes a security defect whose fix is
// not available in the same change, the test asserts the INVARIANT and carries
// `#[ignore = "unfixed: … see <issue>"]`. `cargo test` stays green, and
// `cargo test -- --ignored` is the standing record of what is not yet fixed.
//
// A convention nothing checks decays, and this one had already decayed twice inside the change
// that wrote it: the decision entry's first draft said "four tests, all red today" while the
// branch carried five, and a later draft said "three" while the tree carried two. Both errors
// were invisible to every compiler, because a wrong count in prose is not a wrong count anywhere
// a compiler looks. `check-e2e-floor.mjs` exists for the same reason on the E2E side.
//
// THREE PROPERTIES, all machine-checkable offline:
//
//   1. THE REASON NAMES A TRACKING ISSUE. A deferral with no issue is a note, not a deferral.
//   2. THE REASON SAYS WHAT IS MISSING ("unfixed"). Otherwise `cargo test -- --ignored` reads
//      as an unexplained skip rather than as a record.
//   3. THE ROSTER MATCHES THE TREE, BOTH WAYS. `scripts/ignored-tests.json` lists every
//      reasoned `#[ignore]` with its path and its issue. A test in the tree that the roster
//      does not know about, and a roster entry whose test is gone, both fail — which is what
//      catches a rename, a deletion, and a silent addition. The roster also makes the
//      issue-to-test mapping visible in a diff, so a reason repointed at an issue that has
//      since closed shows up as a changed line rather than as prose nobody re-reads.
//
// WHAT IS GOVERNED, and the discriminator is the reason rather than the shape. A reasoned
// `#[ignore]` is a DEFERRAL when it names a tracking issue or says a defect is unfixed, and it is
// an OPT-OUT otherwise: a case-table generator, a slow SOAK, an env-dependent timing report. The
// tree carries three of the second kind today (`core/src/plugins/notes/daily_match.rs`,
// `core/src/plugins/sync/sim.rs`, `core/src/search/bench.rs`) and they are legitimately not
// claims about correctness, so a rule that demanded an issue of every reasoned `#[ignore]` would
// have demanded three fake issues on the first run and been relaxed afterwards.
//
// The two failure directions that matter are therefore:
//
// - a reason that names an issue but does not say what is missing, which is a deferral that reads
//   as an unexplained skip;
// - a reason that says a defect is unfixed but names no issue, which is a deferral with no owner.
//
// A developer who wants the governed shape therefore has to write a reason that does both, and
// the roster is what keeps the two kinds apart.
//
// DELIBERATELY NOT CHECKED HERE, because a scan cannot judge it:
//
// - Whether the invariant the test asserts is the RIGHT invariant. A test can satisfy all three
//   properties above and assert the wrong thing.
// - Whether the FIXTURE can reach the defective state. That is the failure this repository has
//   already shipped twice, and only INJECTION catches it: apply the fix, confirm the test turns
//   red, restore. No static check stands in for that, which is why this guard's own test injects
//   defects into the guard rather than only into the tree.
//
// Zero dependencies.
//
//   node scripts/check-ignored-tests.mjs                 check the tree/roster offline
//   node scripts/check-ignored-tests.mjs --record        rewrite the roster from the tree
//   node scripts/check-ignored-tests.mjs --check-issues  additionally require each named
//                                                       issue to be OPEN on GitHub
//   node scripts/check-ignored-tests.mjs --root <p>      check a different tree (testing)
//   node scripts/check-ignored-tests.mjs --roster <path> check against a different roster
//
// `--roster` exists so the guard's own test never writes a TRACKED file. The first
// version of that test re-recorded the real roster in `beforeEach` and restored it
// in `afterEach`, which means a cancelled, timed-out or OOM-killed run leaves a
// rewritten roster behind with nothing reporting it, and `pnpm test` runs in both
// `pre-push` and CI's `vitest` step.
//
// NOT CHECKED, and named rather than implied:
//
// - Whether a named issue is still OPEN by default. That is a tracker read and
//   would make the normal check network/auth-dependent. `--check-issues` performs
//   it explicitly; the default success line says the half was skipped rather
//   than printing `ok` on half its name (`check-clipper-identifiers.mjs`).
//
// `--record` is a re-baseline, so read the diff it produces before committing it. A re-baseline
// that lands without a human reading it is a re-baseline that licensed whatever it found.

import { readFileSync, writeFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, isAbsolute, join, relative } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const rosterArg = process.argv.indexOf("--roster");
const ROSTER =
  rosterArg !== -1 ? process.argv[rosterArg + 1] : join(ROOT, "scripts/ignored-tests.json");
// The denominator. `core/src` and `core/tests` are BOTH listed, and the second one is
// the point: an integration spec is a `.rs` file in the same crate, and a test-only
// deferral lands there next. A roster whose denominator is the guard rather than a
// sentence describing it is the failure `check-prefs-nonce.mjs` records, where a
// `ok` was printed over a tree the guard never read.
//
// `--root <path>` overrides the list so the missing-root arm is testable; without it
// that arm would be the one behaviour in this file with no test behind it, which is
// the same omission the guard exists to prevent in someone else's code.
const rootArg = process.argv.indexOf("--root");
const GOVERNED_ROOTS = rootArg !== -1 ? [process.argv[rootArg + 1]] : ["core/src", "core/tests"];

const RECORD = process.argv.includes("--record");
const CHECK_ISSUES = process.argv.includes("--check-issues");

if (!GOVERNED_ROOTS.every((r) => existsSync(isAbsolute(r) ? r : join(ROOT, r)))) {
  console.error(
    `check-ignored-tests: a governed root is missing (${GOVERNED_ROOTS.join(", ")}). ` +
      `A check that skips on a missing input reads as a pass.`,
  );
  process.exit(1);
}

// ── scan ─────────────────────────────────────────────────────────────────────

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (p.endsWith(".rs")) out.push(p);
  }
  return out;
}

/** Strip COMMENTS before matching, so a doc example or a prose mention cannot
 *  register as a real attribute. String literals are KEPT, because the reason
 *  lives inside one and the first version of this stripped strings too and then
 *  scanned for `= "…"` in the result, which matched nothing and reported an
 *  empty roster over a tree carrying two deferred tests. Offsets are preserved
 *  apart from the comment text itself, which is why the reason is read here
 *  rather than from a second pass over the raw text. */
function withoutComments(text) {
  let out = "";
  let inLine = false;
  let inStr = false;
  let inChar = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    const n = text[i + 1];
    if (inLine) {
      if (c === "\n") {
        inLine = false;
        out += c;
      }
      continue;
    }
    if (inStr) {
      out += c;
      if (c === "\\") {
        out += n ?? "";
        i++;
      } else if (c === '"') {
        inStr = false;
      }
      continue;
    }
    if (inChar) {
      out += c;
      if (c === "\\") {
        out += n ?? "";
        i++;
      } else if (c === "'") {
        inChar = false;
      }
      continue;
    }
    if (c === "/" && n === "/") {
      inLine = true;
      i++;
      continue;
    }
    if (c === "/" && n === "*") {
      const end = text.indexOf("*/", i + 2);
      i = end === -1 ? text.length : end + 1;
      continue;
    }
    if (c === '"') {
      inStr = true;
      out += c;
      continue;
    }
    if (c === "'" && n !== undefined && /^'(\\.|[^\\'])'/.test(text.slice(i))) {
      inChar = true;
      out += c;
      continue;
    }
    out += c;
  }
  return out;
}

const found = [];
for (const root of GOVERNED_ROOTS) {
  for (const file of walk(isAbsolute(root) ? root : join(ROOT, root))) {
    const rel = relative(ROOT, file);
    const code = withoutComments(readFileSync(file, "utf8"));
    for (const m of code.matchAll(/#\[ignore(?:\s*=\s*"([^"]*)")?\s*\]/g)) {
      const line = code.slice(0, m.index).split("\n").length;
      const reason = m[1] ?? null;
      if (reason === null) continue; // bare: a time/soak opt-out, not a claim
      const issue = reason.match(/myne-md\/myne#(\d+)/);
      // Governed iff it claims a defect is outstanding. See the header for why the
      // discriminator is the reason and not the shape.
      const claimsDefect =
        // "known-bug" is deliberately NOT a signal: a SOAK opt-out in
        // core/src/plugins/sync/sim.rs says "(not a known-bug RED)", so matching
        // the phrase made a negated mention read as a claim. The first version
        // did match it and classified that opt-out as a deferral with no owner.
        issue !== null || /\bunfixed\b|\bknown defect\b|\bnot yet fixed\b/i.test(reason);
      if (!claimsDefect) continue;
      found.push({ path: rel, line, reason, issue: issue ? issue[1] : null });
    }
  }
}

// ── rules 1 and 2 ────────────────────────────────────────────────────────────

const findings = [];
for (const f of found) {
  if (f.issue === null) {
    findings.push(
      `${f.path}:${f.line}: #[ignore = "…"] names no tracking issue. An ignored invariant ` +
        `test is a deferral, and a deferral with no issue is a note. Name the issue that ` +
        `owns the fix, or drop the = "…" and make it a bare #[ignore] if it is a time or ` +
        `soak opt-out rather than a claim. (Reason was: ${f.reason})`,
    );
  }
  if (!/unfixed/i.test(f.reason)) {
    findings.push(
      `${f.path}:${f.line}: #[ignore = "…"] does not say the test is unfixed. The convention ` +
        `is that the reason states what is missing, so \`cargo test -- --ignored\` reads as a ` +
        `record rather than as an unexplained skip. (Reason was: ${f.reason})`,
    );
  }
}

// ── rule 3, the roster, both ways ────────────────────────────────────────────

if (RECORD) {
  const roster = {
    $comment:
      "Every `#[ignore = \"…\"]` in the governed roots, with the issue that owns its fix. " +
      "Written by `node scripts/check-ignored-tests.mjs --record`; checked by the same script " +
      "without the flag, BOTH WAYS, so a rename or a deletion fails and so does a test the " +
      "roster has never heard of. A bare `#[ignore]` is deliberately absent: those are " +
      "time/soak opt-outs and make no claim about correctness. Read the diff before " +
      "committing a re-baseline.",
    ignored: found
      .map((f) => ({ path: f.path, reason: f.reason, issue: f.issue }))
      .sort((a, b) => (a.path + a.reason).localeCompare(b.path + b.reason)),
  };
  writeFileSync(ROSTER, JSON.stringify(roster, null, 2) + "\n", "utf8");
  console.log(`check-ignored-tests: recorded ${roster.ignored.length} deferred #[ignore] entries`);
  process.exit(0);
}

if (!existsSync(ROSTER)) {
  console.error(
    `check-ignored-tests: no ${relative(ROOT, ROSTER)}. Run ` +
      `\`node scripts/check-ignored-tests.mjs --record\` and read the diff.`,
  );
  process.exit(1);
}

let roster;
try {
  roster = JSON.parse(readFileSync(ROSTER, "utf8"));
} catch (e) {
  console.error(`check-ignored-tests: ${relative(ROOT, ROSTER)} is not valid JSON: ${e.message}`);
  process.exit(1);
}
if (!Array.isArray(roster.ignored)) {
  console.error(`check-ignored-tests: ${relative(ROOT, ROSTER)} has no \`ignored\` array.`);
  process.exit(1);
}

const key = (p, r) => `${p}::${r}`;
const treeKeys = new Set(found.map((f) => key(f.path, f.reason)));
const rosterKeys = new Set(roster.ignored.map((e) => key(e.path, e.reason)));

for (const f of found) {
  if (!rosterKeys.has(key(f.path, f.reason))) {
    findings.push(
      `${f.path}:${f.line}: this deferred #[ignore] is not in ` +
        `${relative(ROOT, ROSTER)}. Add it with --record and read the diff, or drop the = "…" ` +
        `if it is not a claim about correctness. (Reason was: ${f.reason})`,
    );
  }
}
for (const e of roster.ignored) {
  if (!treeKeys.has(key(e.path, e.reason))) {
    findings.push(
      `${relative(ROOT, ROSTER)}: ${e.path} is recorded as deferred for ` +
        `myne-md/myne#${e.issue ?? "?"} but no such #[ignore] exists. Either the test was ` +
        `un-ignored (good — say so in the commit) or it was renamed or deleted, and a stale ` +
        `roster entry is a record of a deferral that no longer exists.`,
    );
  }
}

// ── optional issue-state check ───────────────────────────────────────────────

if (CHECK_ISSUES) {
  if (roster.ignored.length === 0) {
    console.log("check-ignored-tests: issue-state check: no deferred entries to check.");
  }
  for (const e of roster.ignored) {
    if (!e.issue) {
      findings.push(
        `${relative(ROOT, ROSTER)}: ${e.path} has no issue number, so its open state cannot be checked.`,
      );
      continue;
    }
    try {
      const out = execFileSync(
        "gh",
        ["issue", "view", String(e.issue), "--repo", "myne-md/myne", "--json", "state,number,url"],
        { cwd: ROOT, encoding: "utf8", stdio: "pipe" },
      );
      const issue = JSON.parse(out);
      if (String(issue.state).toUpperCase() !== "OPEN") {
        findings.push(
          `${relative(ROOT, ROSTER)}: ${e.path} names myne-md/myne#${e.issue}, ` +
            `which is ${issue.state}, not OPEN (${issue.url}). Remove the deferral or repoint it at an open issue.`,
        );
      }
    } catch (err) {
      findings.push(
        `${relative(ROOT, ROSTER)}: could not read myne-md/myne#${e.issue} for ${e.path}: ` +
          `${err.message}. A tracker read that fails must not read as a pass.`,
      );
    }
  }
}

// ── report ───────────────────────────────────────────────────────────────────

if (findings.length > 0) {
  console.error("check-ignored-tests: FAIL");
  for (const f of findings) console.error(`  - ${f}`);
  process.exit(1);
}
console.log(
  `check-ignored-tests: ok (${found.length} deferred #[ignore] across ` +
    `${GOVERNED_ROOTS.join(", ")}, each naming a tracking issue and each on the roster). ` +
    (CHECK_ISSUES
      ? "Every named issue was required to be OPEN."
      : "Issue state was not checked; pass --check-issues for the tracker read."),
);
