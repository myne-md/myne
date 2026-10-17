#!/usr/bin/env node
// Aggregate the opt-in E2E wait profile (`MYNE_E2E_WAIT_PROFILE=1`) across shards
// and rank what the suite's wall clock is actually going to.
//
// Usage:
//   MYNE_E2E_WAIT_PROFILE=1 MYNE_E2E_SHARDS=4 pnpm test:e2e <specs...>
//   node scripts/e2e-wait-profile.mjs [path]        # default /tmp/myne-e2e-waits.jsonl
//
// The point is the ranking, not the total: a scenario's cost is dominated by a
// handful of waits, and the JSON reporter cannot separate "the app was slow"
// from "this budget is too long". `timedOut` entries are pure waste.

import { readFileSync } from "node:fs";

const path = process.argv[2] ?? "/tmp/myne-e2e-waits.jsonl";
let lines;
try {
  lines = readFileSync(path, "utf8").split("\n").filter((l) => l.trim() !== "");
} catch (e) {
  console.error(`cannot read ${path}: ${e.message}`);
  console.error("Run the suite with MYNE_E2E_WAIT_PROFILE=1 first.");
  process.exit(1);
}

const byLabel = new Map();
let total = 0;
let waits = 0;
for (const line of lines) {
  let w;
  try {
    w = JSON.parse(line);
  } catch {
    continue;
  }
  waits += 1;
  total += w.ms;
  const key = w.label;
  const e = byLabel.get(key) ?? { ms: 0, n: 0, timeouts: 0 };
  e.ms += w.ms;
  e.n += 1;
  if (w.timedOut) e.timeouts += 1;
  byLabel.set(key, e);
}

const launches = [...byLabel.entries()].filter(([l]) => l.startsWith("[launch] "));
const launchTotal = launches.reduce((a, [, e]) => a + e.ms, 0);
const byFile = new Map();
for (const [label, e] of byLabel) {
  if (label.startsWith("[launch] ")) continue;
  // Waits are labelled by the call site, not by the file, so group by the
  // label's own first token (the helpers name themselves: `waitForElement(…)`,
  // `the renamed title appears…`). The per-file view is the test report's job.
  const bucket = /^waitForElement/.test(label)
    ? "waitForElement (all specs)"
    : /^waitForGone/.test(label)
      ? "waitForGone (all specs)"
      : /^element interactable/.test(label) || /^.*located \+ clicked/.test(label)
        ? "click helpers (all specs)"
        : label;
  const cur = byFile.get(bucket) ?? { ms: 0, n: 0, timeouts: 0 };
  cur.ms += e.ms;
  cur.n += e.n;
  cur.timeouts += e.timeouts;
  byFile.set(bucket, cur);
}

const secs = (ms) => (ms / 1000).toFixed(0).padStart(6);
console.log(`wait profile: ${waits} waits, ${secs(total)}s of wall clock (${path})`);
console.log(
  `  of which launches: ${secs(launchTotal)}s over ${launches.length} scenario(s)`,
);
console.log("\nTOP 25 BY TOTAL TIME (passing waits included):");
for (const [label, e] of [...byFile.entries()].sort((a, b) => b[1].ms - a[1].ms).slice(0, 25)) {
  console.log(
    `${secs(e.ms)}s  n=${String(e.n).padStart(4)}  timedOut=${String(e.timeouts).padStart(3)}  ${label.slice(0, 120)}`,
  );
}

const wasted = [...byFile.entries()]
  .filter(([, e]) => e.timeouts > 0)
  .sort((a, b) => b[1].timeouts - a[1].timeouts);
if (wasted.length > 0) {
  console.log("\nBUDGETS THAT EXPIRED (dead wall clock, biggest first):");
  for (const [label, e] of wasted.slice(0, 15)) {
    // An expired wait costs its whole budget every time, so report the debt.
    console.log(
      `${secs(e.ms)}s  n=${String(e.n).padStart(4)}  expired=${String(e.timeouts).padStart(3)}  ${label.slice(0, 110)}`,
    );
  }
}
