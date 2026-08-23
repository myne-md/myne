#!/usr/bin/env node
// The per-release manual test plan, generated from the roster, plus the
// write-back that turns a ticked plan into the record.
//
// WHY THIS IS GENERATED AND NOT WRITTEN. `scripts/manual-test-roster.mjs` holds
// what a human must verify and why no machine can. This turns that into the
// tickable thing somebody actually walks on release day, ordered so the areas
// this release touched come first. Nothing is hand-copied, so nothing drifts.
//
// WHY IT REFUSES TO TRIM. The plan prints its summed estimate at the top and,
// when the gating half exceeds the budget, says so loudly and schedules
// everything anyway. A generator that quietly dropped the tail would report a
// plan that covers the release while covering less than it claims, which is the
// same lie a green `failure: ignore` step tells. An overage is a real signal and
// it has exactly one honest answer: move items into `e2e/` as automation debt,
// so the roster shrinks because a machine took the work, not because a script
// hid it.
//
// WHY THE RECORD IS THE ROSTER AND NOT A SECOND DOCUMENT. `--record` writes
// verdicts into `scripts/manual-test-verified.json`, keyed by entry id, and the
// history is git log. A per-release run document would be a second copy of the
// roster with ticks on it, which is the drift `check-manual-test-roster.mjs`
// exists to stop, one file over. Day-of ticking still happens in the release
// issue, per `myne-ops/runbooks/release-checklist.md`.
//
// THAT RUNBOOK IS THE ONLY CALLER, and it is in another repository. Nothing in
// this repo invokes this script: not lefthook, not `.woodpecker.yml`, not a
// release script. So until the companion `myne-ops` PR merges, this file is
// inert here, and that is stated rather than left for somebody to discover.
// `scripts/check-manual-test-roster.mjs` beside it is the half that gates a
// commit and needs no caller of its own.
//
// WHAT IT DOES NOT DECIDE FOR ITSELF. Which rows gate, how many minutes a row
// costs and how minutes render as hours all come from
// `check-manual-test-roster.mjs`, imported rather than re-derived. An earlier
// version wrote the gating predicate out twice here and the guard held a third
// copy, which is three places one rule can disagree, and the disagreement is
// invisible, because each copy prints a plausible answer and this file's copy is
// the one that decides whether a tag is cut.
//
// USAGE
//   node scripts/manual-test-plan.mjs --since v0.5.0 --version v0.6.0
//   node scripts/manual-test-plan.mjs --since v0.5.0 --out /tmp/plan.md
//   node scripts/manual-test-plan.mjs --record /tmp/plan.md --version v0.6.0
//   node scripts/manual-test-plan.mjs --status
//
// `--since` is optional: without it every entry is scheduled and none is
// promoted, which is the right answer when there is no previous tag to diff
// against rather than a reason to schedule less.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { WALK_PREAMBLE, gates, gatedMinutes, hours, totalMinutes, writeAtomically } from "./check-manual-test-roster.mjs";

// `fileURLToPath` rather than `.pathname`: see the same note in the guard. The
// encoded form silently resolves to a directory that does not exist under a
// checkout path carrying a space or a non-ASCII character.
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const VERIFIED = join(ROOT, "scripts", "manual-test-verified.json");
const RATCHET = join(ROOT, "scripts", "manual-test-ratchet.json");

/**
 * The budget, in minutes.
 *
 * Eight hours: one maintainer, one release day. It is a REPORTING threshold and
 * not a cap. Nothing is dropped when the plan exceeds it.
 */
export const BUDGET_MIN = 480;

const arg = (argv, name, fallback = null) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : fallback;
};

/** Repo-relative paths changed since `ref`, or null when the ref is unusable. */
export function changedSince(ref, rootDir = ROOT) {
  if (!ref) return null;
  try {
    const out = execFileSync("git", ["diff", "--name-only", `${ref}..HEAD`], {
      cwd: rootDir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return out
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean);
  } catch {
    return null;
  }
}

/** Does this entry own any of the changed files? Directory paths end in a slash. */
export function entryTouched(entry, changed) {
  if (!changed) return false;
  return (entry.paths || []).some((p) =>
    p.endsWith("/") ? changed.some((f) => f.startsWith(p)) : changed.includes(p),
  );
}

const minutes = (list) => list.reduce((n, r) => n + r.estimateMin, 0);

/**
 * Build the plan.
 *
 * A ROW IS ONE (item, client) PAIR, not one item, and that is the difference
 * between a plan that describes the work and one that undercounts it by more
 * than half. `estimateMin` is minutes for ONE execution on ONE client, so an
 * item naming macOS, Linux and Windows is three sittings. Summed once per item
 * the first derived roster read 65 hours; summed per (item, client) the same
 * roster reads 157. A generator that prints the smaller number is telling the
 * same lie a green `failure: ignore` step tells.
 *
 * GROUPED BY CLIENT FIRST, because that is how the work actually happens: you
 * sit at a Mac and walk every macOS row, then pick up the iPhone. Ordering by
 * feature instead would make a tester change machine several hundred times, and
 * a plan nobody can walk in the order it is written gets walked in some other
 * order, unrecorded.
 *
 * Within a client: core first, because data loss and a broken security boundary
 * are the two findings that must not arrive at hour seven; then the areas this
 * release touched, where a regression is most likely and least expected; then
 * everything else by entry id, so two releases walk it in the same order.
 *
 * `ratchet` may be null, and then EVERY row is marked as gating. That direction
 * is deliberate and is the opposite of the guard's, which skips its ratchet
 * rules when none is supplied: here a missing ratchet must not quietly turn the
 * gate off, and `main()` refuses to run without the file anyway.
 */
export function buildPlan({ roster, changed, verified, version, since, ratchet }) {
  const rows = [];
  for (const entry of roster) {
    const touched = entryTouched(entry, changed);
    (entry.manual || []).forEach((item, index) => {
      for (const client of item.clients || []) {
        rows.push({
          // `...item` FIRST, so the computed fields below win. The other order let
          // a roster item shadow the generator by growing a key named `gating`,
          // `title`, `client`, `touched` or `key`, and `gating` is what renders
          // STOPS THE TAG. The whole reason `gates` is imported is that one
          // predicate decides what blocks a release; a data file able to override
          // its result puts that decision back in the data.
          ...item,
          key: `${entry.id}#${index}@${client}`,
          entryId: entry.id,
          title: entry.title,
          client,
          touched,
          gating: ratchet ? gates(item, client, ratchet) : true,
        });
      }
    });
  }

  const rank = (r) => (r.tier === "core" ? 0 : r.touched ? 1 : 2);
  rows.sort((a, b) => rank(a) - rank(b) || a.entryId.localeCompare(b.entryId) || a.key.localeCompare(b.key));

  // Grouped once. The comparator used to call `rows.filter` twice per comparison
  // and each section re-filtered the whole array again, which is the same
  // expression written in four places a future "group by client and tier" would
  // have to be repeated in.
  const byClient = new Map();
  for (const r of rows) {
    if (!byClient.has(r.client)) byClient.set(r.client, []);
    byClient.get(r.client).push(r);
  }
  const clients = [...byClient.keys()].sort((a, b) => minutes(byClient.get(b)) - minutes(byClient.get(a)));

  // The two headline totals come from the guard's exported sums, not from a local
  // reduce over `rows`. They agreed by construction, and only by construction:
  // this file's own header states that the numbers deciding whether a tag is cut
  // are imported rather than re-derived, and a second implementation is a second
  // place the rule can drift. The guard's version is also the more defensive one
  // (`(i.estimateMin || 0)` against a bare field that yields `NaN`).
  //
  // `minutes(list)` stays for the per-client and per-section subtotals, which are
  // sums over a ROW SUBSET rather than over the roster, so there is nothing to
  // import for them.
  const total = ratchet ? totalMinutes(roster) : minutes(rows);
  const gatingRows = rows.filter((r) => r.gating);
  const gatingMinutes = ratchet ? gatedMinutes(roster, ratchet) : minutes(gatingRows);

  const line = (r) => {
    const stamp = verified[r.entryId];
    const last = stamp ? `last: ${stamp.version} ${stamp.verdict}` : "never verified";
    const mark = r.gating ? "STOPS THE TAG" : "recorded, does not block yet";
    return [
      `- [ ] \`${r.key}\` **[${r.tier}, ${r.estimateMin} min, ${mark}]** ${r.title} (${last})`,
      `      ${r.see}`,
      `      *No machine can judge it:* ${r.whyNotAutomated}`,
    ].join("\n");
  };

  // Blocks, joined with a blank line between them. Pushing `""` by hand to make
  // the separator appear is twelve chances to drop one and produce a document
  // that renders subtly wrong with nothing checking it.
  const blocks = [
    // No dash in the separator. `myne-agents/reference/writing-rules.md` bans em
    // and en dashes outright, and its one structural exception is a dash a format
    // someone else defined requires: "a format you are inventing right now does
    // not get to require a dash". This heading is that format, and `planVersion`
    // below parses it back, so the two move together.
    `# Manual test plan${version ? ` for ${version}` : ""}`,
    `**${rows.length} rows across ${clients.length} client surfaces, ${hours(total)} h estimated.** ` +
      `A row is one observation on one client. ` +
      `${rows.filter((r) => r.tier === "core").length} core tier, ` +
      `${rows.filter((r) => r.touched && r.tier !== "core").length} in areas this release touched` +
      `${since ? ` (diffed against \`${since}\`)` : ""}.`,
    [
      "| Client | Rows | Core | Gating | Estimated |",
      "|---|---:|---:|---:|---:|",
      ...clients.map((c) => {
        const mine = byClient.get(c);
        return `| ${c} | ${mine.length} | ${mine.filter((r) => r.tier === "core").length} | ${
          mine.filter((r) => r.gating).length
        } | ${hours(minutes(mine))} h |`;
      }),
    ].join("\n"),
    `**${gatingRows.length} of these rows (${hours(gatingMinutes)} h) STOP THE TAG.** A failed gating row means ` +
      "the release does not go out. Passing one anyway takes a written `override` reason, recorded with " +
      "`--record`, and that reason lands in git under the name of whoever committed it.",
    `The other ${rows.length - gatingRows.length} rows (${hours(total - gatingMinutes)} h) are walked and ` +
      "recorded and do not block yet. That share only shrinks: `scripts/manual-test-ratchet.json` records which " +
      "tiers gate on which clients, and those sets may only grow, while the ceiling on total manual minutes may " +
      "only fall, so the gate widens as automation debt is paid. Every row here is meant to gate eventually.",
    gatingMinutes > BUDGET_MIN
      ? `> **The gating half alone is ${hours(gatingMinutes - BUDGET_MIN)} h over the ${hours(BUDGET_MIN)} h budget, ` +
        `and nothing has been dropped to fit.** Trimming would report coverage the release did not have. There are ` +
        `two honest answers and neither is a shorter plan: pay automation debt, so the roster shrinks because a ` +
        `machine took the work, or narrow the client matrix to the platforms this release actually ships.`
      : "",
    "Tick a row, then run:",
    ["```bash", `node scripts/manual-test-plan.mjs --record <this-file> --version ${version || "<version>"}`, "```"].join(
      "\n",
    ),
    "A ticked row records `pass`. A row left unticked with `FAIL:` after it records `fail`. " +
      "A row with `OVERRIDE: <reason>` after it records `override`, and the reason has to be a real one.",
    // The safety rules go LAST in the preamble, immediately before the first row,
    // because this is the document somebody actually holds while walking. They
    // lived only in the byte-gated projection, which is a reference nobody opens
    // on the day, and one of the three sends a tester to uninstall an app whose
    // app-private storage is the only copy of a vault. A rule that is not in the
    // document being followed is not in force.
    WALK_PREAMBLE.trim(),
  ];

  const GROUPS = [
    ["Core", "Data loss, a security or privacy boundary, or the upgrade over a real vault."],
    ["Touched by this release", "The diff reached these areas."],
    [
      "Standing",
      "Untouched by this release, and walked anyway: an area nobody looked at is an area nobody can vouch for.",
    ],
  ];

  for (const client of clients) {
    const mine = byClient.get(client);
    blocks.push(`## ${client} (${mine.length} rows, ${hours(minutes(mine))} h)`);
    const partition = [
      mine.filter((r) => r.tier === "core"),
      mine.filter((r) => r.tier !== "core" && r.touched),
      mine.filter((r) => r.tier !== "core" && !r.touched),
    ];
    partition.forEach((list, i) => {
      if (!list.length) return;
      blocks.push(`### ${GROUPS[i][0]} (${list.length}, ${hours(minutes(list))} h)`, GROUPS[i][1], ...list.map(line));
    });
  }

  return blocks.filter(Boolean).join("\n\n");
}

/**
 * Parse a ticked plan into ONE RECORD PER ROW.
 *
 * Row-level rather than entry-level because the exit code depends on it: a
 * failed row that gates stops the tag and a failed row that does not yet gate is
 * recorded and reported. Rolling up to the entry first would lose which client
 * and which item failed, and with it the only thing that decides the difference.
 *
 * ONE regex with named parts, rather than a blob match taken apart afterwards.
 * `buildPlan` always emits `id#index@client`, so a key of any other shape is a
 * hand-mangled line, and ignoring it is the safer of the two failures: `main()`
 * exits non-zero when nothing parsed, so a mangled file is loud rather than
 * half-recorded.
 */
export function parseRows(text) {
  const out = [];
  const lines = text.split("\n");
  for (const row of lines) {
    // The annotation is read from the CHECKBOX LINE ONLY. An earlier version
    // joined the row's three lines so an annotation could sit anywhere in the
    // block, and the first real round trip showed what that costs: `OVERRIDE:`
    // ran past the end of its own line and swallowed the item's `see` text into
    // the recorded reason, so the record said the release was overridden for a
    // paragraph that was the test instruction. Widening a match to be forgiving
    // is how a record starts describing something other than what was written.
    const m = row.match(/^- \[( |x|X)\] `(([a-z0-9.-]+)#(\d+)@([a-z-]+))`/);
    if (!m) continue;
    const [, box, key, entryId, itemIndex, client] = m;
    const override = row.match(/OVERRIDE:\s*(.+?)\s*$/);
    // `FAIL:` is tested BEFORE the checkbox, and the order is the whole point. It
    // used to be the other way round, so a row written `- [x] ... FAIL:` recorded
    // `pass`, exit 0, with the failure not counted, not warned about and visible
    // nowhere. That is the keystroke a tired tester makes on release day (tick the
    // row, then write down why it failed), and it is the one input shape where the
    // gate silently inverts. Worst-wins within a row, matching `rollUp`'s
    // worst-wins across an entry's rows.
    const verdict = override
      ? "override"
      : /FAIL:/.test(row)
        ? "fail"
        : box.toLowerCase() === "x"
          ? "pass"
          : null;
    if (!verdict) continue;
    out.push({
      key,
      entryId,
      itemIndex: Number(itemIndex),
      client,
      verdict,
      reason: override ? override[1].trim() : undefined,
    });
  }
  return out;
}

/**
 * Row lines a generated plan carries that `parseRows` cannot read.
 *
 * `parseRows` skips a line it cannot match, and its own comment argued that was
 * safe because "main() exits non-zero when nothing parsed". That holds only when
 * NOTHING parses. With 881 rows parsing and one hand-mangled, the mangled one is
 * dropped in silence: `blockingRows` never sees it, the summary counts entries
 * rather than rows, and nothing compares what was read against what was written.
 * A `FAIL:` on a gating row can vanish at exit 0, which is the release reporting
 * green for a keystroke.
 *
 * Untouched rows are NOT malformed: `parseRows` returns only rows carrying a
 * verdict, by design, so the test is whether the line's KEY is readable, not
 * whether the box is ticked.
 */
export function malformedRowLines(text) {
  return text
    .split("\n")
    .filter((l) => /^- \[/.test(l) && !/^- \[( |x|X)\] `[a-z0-9.-]+#\d+@[a-z-]+`/.test(l));
}

/**
 * How many GATING rows the plan's own header says it carries, or null when absent.
 *
 * The companion to {@link planRowCount}, and the one that makes a completeness
 * check possible: the total tells you rows went missing, this tells you whether
 * the rows that STOP THE TAG were walked at all.
 */
export function planGatingCount(text) {
  const m = text.match(/^\*\*(\d+) of these rows \(/m);
  return m ? Number(m[1]) : null;
}

/**
 * How many rows the plan's own header says it carries, or null when absent.
 *
 * `buildPlan` writes the count into the heading block, so the plan states its own
 * denominator and a row deleted from the middle of a 882-row file stops being
 * invisible. Same coupling as {@link planVersion}: the format is written in one
 * place and parsed back here, so the two move together.
 */
export function planRowCount(text) {
  const m = text.match(/^\*\*(\d+) rows across /m);
  return m ? Number(m[1]) : null;
}

/** The version a generated plan says it is for, or null when the heading carries none. */
export function planVersion(text) {
  const m = text.match(/^# Manual test plan(?:\s+for)?\s+(\S+)\s*$/m);
  return m ? m[1] : null;
}

/**
 * Which rows actually stop the tag, resolved against the roster and the ratchet.
 *
 * Exported and pure so a test can reach it. It used to live inside `main()`, which
 * meant the step that decides whether a release ships was the one step no test
 * touched, in a file whose own header argues that row-level parsing exists
 * BECAUSE the exit code depends on it.
 */
export function blockingRows(rows, roster, ratchet) {
  const byId = new Map(roster.map((e) => [e.id, e]));
  return rows.filter((row) => {
    if (row.verdict !== "fail") return false;
    const item = (byId.get(row.entryId)?.manual || [])[row.itemIndex];
    // An index that no longer resolves is a STALE PLAN, and it fails closed. The
    // first version returned false there, so a recorded failure whose item had
    // shifted was written into the record and then did not stop the tag, at exit
    // 0. One branch up, an unknown ENTRY id already exits 1, so the same class of
    // staleness was fail-closed at entry level and fail-open at item level, and
    // the open direction is the one this whole file argues against.
    if (!item) {
      throw new Error(
        `${row.key} names item ${row.itemIndex} of ${row.entryId}, which the roster no longer has. ` +
          `The plan is stale: regenerate it rather than recording against an index that has moved.`,
      );
    }
    return gates(item, row.client, ratchet);
  });
}

/** How bad a verdict is. An entry is as verified as its worst row. */
const WORSE = { pass: 0, override: 1, fail: 2 };

/**
 * Roll rows up to one verdict per entry, which is what the record stores.
 *
 * Worst wins: one failed observation on one client means the entry did not pass,
 * whatever its siblings did. Storing the best verdict, or the last one written,
 * would let a record say an entry passed at v0.6 when a client it names failed.
 */
export function rollUp(rows) {
  const verdicts = {};
  for (const row of rows) {
    const prior = verdicts[row.entryId];
    if (!prior || WORSE[row.verdict] > WORSE[prior.verdict]) {
      verdicts[row.entryId] = { verdict: row.verdict, reason: row.reason };
    }
  }
  return verdicts;
}


async function main() {
  const argv = process.argv.slice(2);
  const { ROSTER } = await import("./manual-test-roster.mjs");
  const stored = existsSync(VERIFIED) ? JSON.parse(readFileSync(VERIFIED, "utf8")) : { verified: {} };
  const verified = stored.verified || {};

  // A missing ratchet is refused rather than defaulted, exactly as in
  // `check-manual-test-roster.mjs`: without it every row would read as gating,
  // and a plan that claims 856 blocking rows is a plan that gets overridden
  // wholesale on its first outing.
  if (!existsSync(RATCHET)) {
    console.error("manual-test-plan: scripts/manual-test-ratchet.json is missing. Nothing says which rows gate.");
    process.exit(1);
  }
  const ratchet = JSON.parse(readFileSync(RATCHET, "utf8"));
  const byId = new Map(ROSTER.map((e) => [e.id, e]));

  if (argv.includes("--status")) {
    const withManual = ROSTER.filter((e) => (e.manual || []).length > 0);
    const never = withManual.filter((e) => !verified[e.id]);
    console.log(`${withManual.length} entries carry manual items.`);
    console.log(`${withManual.length - never.length} have been verified at least once, ${never.length} never.`);
    for (const e of withManual) {
      const s = verified[e.id];
      console.log(`  ${s ? `${s.verdict.padEnd(8)} ${s.version}` : "never          "}  ${e.id}`);
    }
    return;
  }

  const version = arg(argv, "--version");
  const recordFrom = arg(argv, "--record");

  // `--record` is an OPTION taking a value, not a mode, and `arg()` returns null
  // when the next token starts with `--`. So `--record --version v0.6.0`, which is
  // the shape a forgotten or misplaced path takes, fell through the whole record
  // branch and re-ran the GENERATOR: 3528 lines to stdout, exit 0, nothing
  // written and nothing saying so. On release day that reads as a successful
  // record. Every other malformed input on this path is already loud, and this
  // file's own header argues that a silently-green gate tells the same lie a
  // green `failure: ignore` step tells.
  if (argv.includes("--record") && !recordFrom) {
    console.error("manual-test-plan: --record needs the path to a ticked plan. Nothing was recorded.");
    process.exit(1);
  }

  if (recordFrom) {
    if (!version) {
      console.error(
        "manual-test-plan: --record needs --version, or the stamp says nothing about which release it describes.",
      );
      process.exit(1);
    }
    const text = readFileSync(recordFrom, "utf8");

    // The plan carries the version it was generated for, and nothing used to
    // compare the two. Recording last release's ticked plan under this release's
    // tag produced a record asserting that observations were made against a build
    // they were not, and that record is what the ship gate reads. `--force-version`
    // is the deliberate escape for a genuine re-record.
    const headed = planVersion(text);
    if (headed && headed !== version && !argv.includes("--force-version")) {
      console.error(
        `manual-test-plan: ${recordFrom} is a plan for ${headed} and you are recording it as ${version}. ` +
          `Regenerate the plan, or pass --force-version if you really mean to re-record it.`,
      );
      process.exit(1);
    }

    // Two shape checks before any verdict is read, both against what `buildPlan`
    // wrote rather than against a convention. A row nobody can parse and a row
    // that has gone missing are the two ways a ticked plan can under-report, and
    // neither is visible from the verdicts that DID parse.
    const malformed = malformedRowLines(text);
    if (malformed.length) {
      console.error(
        `manual-test-plan: ${malformed.length} row line(s) in ${recordFrom} carry no readable key, so they would ` +
          `be dropped in silence. Nothing recorded.\n  ${malformed.join("\n  ")}`,
      );
      process.exit(1);
    }
    const declared = planRowCount(text);
    const present = text.split("\n").filter((l) => /^- \[/.test(l)).length;
    // An ABSENT header is refused, never skipped. The first version read
    // `declared !== null && declared !== present`, so deleting rows TOGETHER with
    // the one header line that counts them satisfied the check by removing its
    // own denominator: the guard turned itself off from inside its input. Same
    // reasoning as the gating-count header below, and the same reasoning
    // `check-e2e-floor.mjs` records for a missing report ("the suite never
    // produced one" is the crashed-before-running case, not the clean one).
    if (declared === null) {
      console.error(
        `manual-test-plan: ${recordFrom} carries no row-count header, so whether rows went missing cannot be ` +
          `established. Regenerate the plan rather than recording against a file whose own denominator is gone.`,
      );
      process.exit(1);
    }
    if (declared !== present) {
      console.error(
        `manual-test-plan: ${recordFrom} says it carries ${declared} rows and ${present} are present. ` +
          `Rows were added or removed by hand, and a record built from it would describe a walk that did not ` +
          `happen. Regenerate the plan. Nothing recorded.`,
      );
      process.exit(1);
    }

    // COMPLETENESS, which is the half a verdict-shaped read cannot see. `parseRows`
    // returns only rows carrying a verdict, so a plan on which five of 882 rows
    // were ticked parsed five passes, recorded five stamps and exited 0. That is
    // the shape `scripts/check-e2e-floor.mjs` exists to refuse one lane over: "some
    // scenarios failed" and "no scenarios ran" are different states behind the same
    // exit code, and a release gate reporting green on silence is the failure this
    // whole system was written to end. Found by the myne-bot review of PR #576.
    //
    // The GATING rows are what this measures, not every row: the recorded-not-
    // blocking half is walked and recorded and legitimately incomplete while the
    // ratchet is still widening, so demanding all 882 would make the check unusable
    // and it would be turned off. Demanding the 243 that stop the tag is the claim
    // the plan actually makes about itself.
    const declaredGating = planGatingCount(text);
    if (declaredGating === null) {
      console.error(
        `manual-test-plan: ${recordFrom} carries no gating-row header, so how much of it was walked cannot be ` +
          `established. Regenerate the plan rather than recording against a file whose own denominator is gone.`,
      );
      process.exit(1);
    }
    const gatingLines = text.split("\n").filter((l) => /^- \[.\] `[^`]+`\s+\*\*\[[^\]]*STOPS THE TAG/.test(l));
    const gatingWalked = gatingLines.filter((l) => /^- \[[xX]\]/.test(l) || /FAIL:|OVERRIDE:/.test(l)).length;
    if (gatingLines.length !== declaredGating) {
      console.error(
        `manual-test-plan: ${recordFrom} says it carries ${declaredGating} gating rows and ${gatingLines.length} ` +
          `are present. Nothing recorded.`,
      );
      process.exit(1);
    }
    if (gatingWalked < declaredGating) {
      console.error(
        `manual-test-plan: ${declaredGating - gatingWalked} of ${declaredGating} GATING rows in ${recordFrom} ` +
          `carry no verdict, so the release was not walked. Nothing recorded.\n` +
          `  A gating row is passed by ticking it, failed with FAIL: after it, or passed anyway with ` +
          `OVERRIDE: <reason>. Leaving it blank is none of the three, and recording it as though the walk ` +
          `were complete is exactly the green-on-silence this gate exists to refuse.`,
      );
      process.exit(1);
    }

    const rows = parseRows(text);
    const verdicts = rollUp(rows);
    if (!Object.keys(verdicts).length) {
      console.error(`manual-test-plan: no ticked or annotated lines found in ${recordFrom}. Nothing recorded.`);
      process.exit(1);
    }

    // A row whose key survives but whose ITEM has moved is a stale plan, and it is
    // rejected whole rather than row by row. Collecting first matters twice: the
    // old loop exited on the first bad id from inside the write loop, so one
    // unknown entry threw away every verdict the tester had recorded that day,
    // and it only ever validated the entry, never the index, so a `pass` was
    // stamped against an observation belonging to a different item at exit 0.
    const stale = [];
    for (const row of rows) {
      const entry = byId.get(row.entryId);
      if (!entry) {
        stale.push(`${row.key}: no entry ${row.entryId} in the roster`);
      } else if (!(entry.manual || [])[row.itemIndex]) {
        stale.push(`${row.key}: entry ${row.entryId} has no item ${row.itemIndex}`);
      }
    }
    if (stale.length) {
      console.error(
        `manual-test-plan: ${recordFrom} is STALE against the roster and nothing was recorded.\n  ` +
          `${stale.join("\n  ")}\nRegenerate the plan rather than recording against rows that have moved.`,
      );
      process.exit(1);
    }
    const date = (arg(argv, "--date") || new Date().toISOString()).slice(0, 10);
    let recorded = 0;
    const downgrades = [];
    for (const [id, v] of Object.entries(verdicts)) {
      const prior = verified[id];
      // Worst-wins across the STORED value too, and only at the same version: a
      // new version legitimately supersedes an old verdict, a second file at the
      // same version is the other half of one walk.
      if (prior && prior.version === version && WORSE[prior.verdict] > WORSE[v.verdict]) {
        downgrades.push(`${id}: recorded ${prior.verdict} at ${version}, this plan says ${v.verdict}`);
        continue;
      }
      verified[id] = { version, date, verdict: v.verdict, ...(v.reason ? { reason: v.reason } : {}) };
      recorded += 1;
    }
    if (downgrades.length) {
      // Loud rather than silent, and kept rather than overwritten. A stored fail
      // that a later partial record turns into a pass is a ship gate reporting
      // green, which is the one outcome this file exists to prevent.
      console.error(
        `manual-test-plan: KEPT the worse verdict for ${downgrades.length} entr${downgrades.length === 1 ? "y" : "ies"} ` +
          `already recorded at ${version}:\n  ${downgrades.join("\n  ")}\n` +
          `A second plan at one version is half of one walk, so worst-wins applies across the record too. ` +
          `To retract a failure, edit scripts/manual-test-verified.json by hand and say why in the commit.`,
      );
    }
    stored.verified = Object.fromEntries(Object.entries(verified).sort(([a], [b]) => a.localeCompare(b)));
    writeAtomically(VERIFIED, `${JSON.stringify(stored, null, 2)}\n`);

    const failedRows = rows.filter((r) => r.verdict === "fail");
    const blocking = blockingRows(rows, ROSTER, ratchet);
    const blockingKeys = new Set(blocking.map((r) => r.key));
    const overrides = rows.filter((r) => r.verdict === "override");
    console.log(
      `manual-test-plan: recorded ${recorded} entries at ${version}. ` +
        `${failedRows.length} rows failed, ${blocking.length} of them gating, ` +
        `${overrides.length} overridden.`,
    );
    // An override is a failed ship gate passed anyway, so it is named. The summary
    // used to print `0 rows failed` and never mention it, which made a waved-through
    // gating row indistinguishable from a clean pass.
    for (const r of overrides) {
      console.warn(`manual-test-plan: OVERRIDE on ${r.key}: ${r.reason}`);
    }
    for (const r of failedRows.filter((r) => !blockingKeys.has(r.key))) {
      console.warn(`manual-test-plan: recorded failure (does not block yet): ${r.key}`);
    }
    if (blocking.length) {
      console.error("manual-test-plan: these rows stop the tag. Fix them, or record a written override on each:");
      for (const r of blocking) console.error(`  - ${r.key}`);
      process.exit(1);
    }
    return;
  }

  const since = arg(argv, "--since");
  const changed = changedSince(since);
  if (since && changed === null) {
    console.error(`manual-test-plan: cannot diff against ${since}. Every entry will be scheduled as standing.`);
  }
  const plan = buildPlan({ roster: ROSTER, changed, verified, version, since: changed ? since : null, ratchet });
  const out = arg(argv, "--out");
  if (out) {
    writeAtomically(out, `${plan}\n`);
    console.log(`manual-test-plan: wrote ${out}`);
  } else {
    console.log(plan);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main().catch((err) => {
    console.error(`manual-test-plan: ${err && err.stack ? err.stack : err}`);
    process.exit(1);
  });
}
