#!/usr/bin/env node
// Floor guard for the desktop E2E suite (`pnpm test:e2e`).
//
// THE FAILURE THIS PREVENTS. The E2E step reports the suite's exit code and
// nothing else, so "green" and "ran nothing" are the same observation. Every
// mechanism in the harness that turns a missing precondition into a SKIP rather
// than a failure — an absent binary, an unmet platform gate, a `describe.skip`
// whose env flag was not set, a command earlier in the CI step that failed
// quietly — subtracts scenarios from the run without subtracting anything from
// the result. A suite that executes ZERO scenarios exits 0. That is not a
// hypothetical: the sync scenarios have been skipping on every CI run for
// months because the step never built `myne-server`, and the step stayed green
// the whole time.
//
// The fix is a number that has to be met. This guard reads the run's own JSON
// report, counts the tests that actually EXECUTED (passed + failed — skipped
// deliberately do not count, since a skip is the thing being guarded against),
// and fails when that count falls below a recorded floor.
//
// A missing report file is itself a failure. "The suite never produced a report"
// is exactly the crashed-before-running case this exists to catch, and treating
// it as "nothing to check" would reopen the hole.
//
// USAGE
//   node scripts/check-e2e-floor.mjs                      # stable lane
//   node scripts/check-e2e-floor.mjs --lane quarantine    # quarantine lane
//   node scripts/check-e2e-floor.mjs --record             # re-baseline (deliberate)
//
// The floor is a FLOOR, not an equality: adding scenarios must never require
// touching it, and removing them must be deliberate. Re-record only when the
// drop is intended, and say why in the commit message.
//
// PROVENANCE OF THE SHIPPED NUMBERS — read this before reacting to a failure.
//
// `stable: 290` / `stable_max_failures: 33` are MEASURED, from CI (pipeline
// 431), not invented and not from a laptop. They started as 279 / 15 from a
// local container run; CI's first end-to-end run in months disagreed, which the
// first version of this note predicted it might, and these are the re-record.
// Both differences are explained rather than mysterious:
//
//   +11 executed — CI runs the ~8 AI scenarios this machine skips
//                  (MYNE_E2E_AI=1 + the local-inference-stub feature), and the
//                  sync scenarios that only started running when the e2e step
//                  learned to build myne-server.
//   +18 failed   — the same two groups. Six AI specs and sync-attachments fail
//                  in CI and had simply never run anywhere before, so this is
//                  newly VISIBLE breakage, not new breakage.
//
// What the 33 is made of, so the number carries its own explanation:
//   ~8  click/wait timeouts — the same "one click then a blind wait" class as
//       flows.ts::clickNewMenuItem and clickUntilVisible. Cheapest to close.
//       (ai-chat, ai-summarize, transcription, vault-migrate, ai-ux-surface,
//        tag-browser, tag-suggestion-band, task-panel)
//   ~1  a real sync bug, first ever observed: sync-attachments fails with
//       `attachment_import failed: {"kind":"Locked"}`.
//   rest real assertion failures (ai-degradation, ai-embeddings-persistence,
//       note-export-html, theme-deep-link, right-panel-visibility, ...).
//
// The ceiling is a DEBT, not a target. It was 25 before the Views specs were
// repaired, then 15 measured locally, and is 33 as CI actually sees it. Raising
// it to make a red pipeline green is the one edit that is never legitimate; this
// raise is the opposite — replacing a number from the wrong machine with the
// first honest measurement from the one that matters. It goes down from here.

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const RECORD = join(ROOT, "scripts/e2e-scenario-floor.json");

const argv = process.argv.slice(2);
const laneIdx = argv.indexOf("--lane");
const lane = laneIdx === -1 ? "stable" : argv[laneIdx + 1];
if (!["stable", "quarantine"].includes(lane)) {
  console.error(`check-e2e-floor: unknown lane "${lane}" (expected stable|quarantine)`);
  process.exit(2);
}

// Where the vitest json reporter writes. Kept in step with vitest.e2e.config.ts;
// a mismatch surfaces as the missing-report failure below rather than silently.
const REPORT = join(ROOT, `.e2e-report/${lane}.json`);

if (!existsSync(REPORT)) {
  console.error(
    `check-e2e-floor: no report at ${REPORT}\n\n` +
      "  The suite produced no JSON report. Either it never started (a command\n" +
      "  earlier in the CI step failed), or the reporter is not wired for this\n" +
      "  lane. Both are the failure this guard exists for — a run that asserts\n" +
      "  nothing must not read as a run that passed.",
  );
  process.exit(1);
}

const report = JSON.parse(readFileSync(REPORT, "utf8"));
const passed = report.numPassedTests ?? 0;
const failed = report.numFailedTests ?? 0;
const skipped = report.numPendingTests ?? report.numTodoTests ?? 0;
const executed = passed + failed;

if (argv.includes("--record")) {
  const next = existsSync(RECORD) ? JSON.parse(readFileSync(RECORD, "utf8")) : {};
  next[lane] = executed;
  next[`${lane}_max_failures`] = failed;
  writeFileSync(RECORD, `${JSON.stringify(next, null, 2)}\n`);
  console.log(
    `check-e2e-floor: recorded ${lane} floor = ${executed}, failure ceiling = ${failed}`,
  );
  process.exit(0);
}

if (!existsSync(RECORD)) {
  console.error(
    "check-e2e-floor: no baseline. Run `node scripts/check-e2e-floor.mjs --record` once.",
  );
  process.exit(1);
}

const floor = JSON.parse(readFileSync(RECORD, "utf8"))[lane];
if (typeof floor !== "number") {
  console.error(`check-e2e-floor: no recorded floor for lane "${lane}" in ${RECORD}`);
  process.exit(1);
}

// The FAILURE CEILING — the other half of the gate, and the reason the `e2e`
// step can keep `failure: ignore` without the lane meaning nothing.
//
// Removing `failure: ignore` outright is not available today: the suite has a
// standing set of real failures, so a blocking step would be red on every
// pipeline forever, and a permanently-red gate teaches people to ignore red —
// strictly worse than the honest non-gate it replaced. A ratchet gets the
// property that actually matters NOW: the count may shrink freely, and may
// never grow. A new regression turns the lane red on the pipeline that
// introduced it, which is the whole job, and the recorded number is a debt
// visible in the diff instead of a mood.
//
// Same shape as `check-token-adoption` / `check-unwired`: shrink freely,
// re-record deliberately, say why in the commit message.
const record = JSON.parse(readFileSync(RECORD, "utf8"));
const ceiling = record[`${lane}_max_failures`];

console.log(
  `check-e2e-floor [${lane}]: executed ${executed} (passed ${passed}, failed ${failed}, skipped ${skipped}), floor ${floor}` +
    (typeof ceiling === "number" ? `, failure ceiling ${ceiling}` : ""),
);

if (typeof ceiling === "number" && failed > ceiling) {
  console.error(
    `\ncheck-e2e-floor: FAILURE COUNT ABOVE CEILING — ${failed} > ${ceiling}\n\n` +
      "  The suite is allowed its standing failures; it is not allowed MORE of\n" +
      "  them. Something that used to pass now fails. Find it in the report\n" +
      `  (${REPORT}) before merging.\n\n` +
      "  If a failure was added deliberately (a scenario landing red on purpose,\n" +
      "  a known-broken flow being covered), re-record with --record and say why.\n" +
      "  The ceiling is a DEBT: it should only ever go down.",
  );
  process.exit(1);
}

if (executed < floor) {
  console.error(
    `\ncheck-e2e-floor: EXECUTED COUNT BELOW FLOOR — ${executed} < ${floor}\n\n` +
      `  ${skipped} test(s) skipped this run. A skip is invisible in the suite's\n` +
      "  exit code, so this is the only place it can fail. Find what stopped\n" +
      "  running before treating the pipeline as healthy — the usual causes are a\n" +
      "  missing binary the harness self-skips on (myne-server, a model file, a\n" +
      "  sidecar), an env gate that was not set, or a platform guard.\n\n" +
      "  If the drop is deliberate, re-record with --record and say why in the\n" +
      "  commit message.",
  );
  process.exit(1);
}
