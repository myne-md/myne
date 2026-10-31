#!/usr/bin/env node
// Guard: type errors in the TEST trees may shrink, never grow.
//
// THE HOLE THIS FILLS. `tsconfig.json` is `include: ["src"]` — it typechecks
// what SHIPS, which is the right scope for it. The consequence nobody had
// accounted for is that `tests/`, `e2e/` and `e2e-web/` were then typechecked
// by NOTHING. Vitest transpiles without checking. `pnpm build` never looks at
// them. No CI step ran `tsc` over them. An editor's language server does check
// them, which is exactly why this went unnoticed for so long: it looks checked
// while you are writing it, and is unchecked from the moment you close the file.
//
// So a test file could call a helper with the wrong arity, the wrong argument
// types, or a name that does not exist, and the only report was a runtime
// failure inside a scenario — where it does not read like a typo. It reads
// like a product bug, or like flake.
//
// Not hypothetical. `runPaletteAction(session, actionId, query)` was called
// with TWO arguments in two specs. `query` arrived as `undefined`,
// `sendKeys(undefined)` reached the driver, and both specs failed with
//
//     WebDriverError: [invalid argument] Missing text parameter
//
// which names the driver, not the missing argument and not the call site. Both
// had been red long enough to be counted among the suite's "chronic failures" —
// i.e. the cost was not just the two specs, it was the credibility of every
// other red line next to them.
//
// A RATCHET, not a hard gate, and deliberately so. The trees carry a real
// backlog of loose typing (partial mocks, implicit `any` in fixture callbacks)
// that is mostly harmless and would take a dedicated pass to clear. Blocking on
// zero would mean either that pass lands first or this check never lands. A
// ratchet gets the property that actually matters now: a file's count may FALL
// freely, and may not RISE, so the next bad call fails the pipeline that
// introduced it. A file absent from the budget starts at zero — new code is
// held to the standard the tree is moving toward, not to its current average.
//
// TS2591 IS FILTERED, and it is the one filter here. It is "cannot find name
// 'process' / 'require' / 'node:fs'" — a missing `@types/node`, which is a
// config gap rather than anything a test author did. It accounts for ~390 of
// the ~620 raw errors and would bury every real finding. Removing the filter is
// a one-line change once `@types/node` is a devDependency; adding a dependency
// is a security decision here (AGENTS.md), so it is a decision to take
// deliberately rather than a side effect of landing this guard.
//
// RUN IT FROM A TOP-LEVEL CHECKOUT, NOT FROM A WORKTREE, and the reason is
// measured rather than tidiness. TypeScript resolves module specifiers by
// walking UP the directory chain, so a checkout at `.opencode/worktrees/<name>/`
// finds `.opencode/node_modules/@types/node`, a dependency of the agent
// tooling, not of this project, and `@types/node` is the one package whose
// PRESENCE changes these counts. With it visible, the three `Buffer` shape
// errors in `tests/scripts/fdroidMetadata.test.ts`'s fixtures resolve (TS2345)
// and are reported; from the repository root the same file yields TS2591, which
// the filter above deliberately drops, so the budget reads clean. Nothing is
// wrong with the branch in that state: the guard is answering a question about
// the directory it was run in. `compilerOptions.types: []` does NOT fix it, and
// that is worth knowing before trying: that option governs AMBIENT inclusion,
// while `import ... from "node:fs"` resolves through node_modules regardless.
// CI clones to a top-level path, so the lane is unaffected.
//
// Usage:
//   node scripts/check-test-typecheck.mjs            # check against the budget
//   node scripts/check-test-typecheck.mjs --record   # re-record the budget
//
// Runs `tsc` over `tsconfig.tests.json` (~40 s), so this is a CI-lane check
// rather than a pre-commit one — the fast local net is the editor's own
// language server, which sees these files already.

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const BUDGET = join(ROOT, "scripts", "test-typecheck-budget.json");
const PROJECT = "tsconfig.tests.json";

/** Errors emitted only because `@types/node` is absent. See the header. */
const IGNORED_CODES = new Set(["TS2591"]);

/** Only these roots are ratcheted. `src` is in the tsconfig because the test
 *  trees import it (without it every import is `any` and the check is worth
 *  nothing), but `src` has its own typecheck in `pnpm build` and must not be
 *  double-reported here. */
const TRACKED = ["tests/", "e2e/", "e2e-web/"];

function runTsc() {
  try {
    execFileSync("npx", ["tsc", "-p", PROJECT, "--pretty", "false"], {
      cwd: ROOT,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return ""; // clean
  } catch (e) {
    // tsc exits non-zero WITH the diagnostics on stdout — that is the normal
    // path here, not a failure to run. A genuine failure to run (missing
    // project file, tsc not installed) produces no parseable diagnostics, and
    // the caller treats that as fatal rather than as "zero errors".
    const out = `${e.stdout ?? ""}${e.stderr ?? ""}`;
    if (out.trim() === "") {
      console.error("test-typecheck: tsc produced no output at all — cannot run?");
      process.exit(1);
    }
    return out;
  }
}

/** `path(line,col): error TSxxxx: message` -> {file, code} */
function parse(output) {
  const counts = new Map();
  let total = 0;
  for (const line of output.split("\n")) {
    const m = /^(.+?)\((\d+),(\d+)\): error (TS\d+):/.exec(line);
    if (!m) continue;
    const [, file, , , code] = m;
    if (IGNORED_CODES.has(code)) continue;
    if (!TRACKED.some((r) => file.startsWith(r))) continue;
    counts.set(file, (counts.get(file) ?? 0) + 1);
    total += 1;
  }
  return { counts, total };
}

const output = runTsc();
const { counts, total } = parse(output);

if (process.argv.includes("--record")) {
  const recorded = Object.fromEntries([...counts].sort(([a], [b]) => a.localeCompare(b)));
  writeFileSync(BUDGET, `${JSON.stringify({ files: recorded, total }, null, 2)}\n`);
  console.log(`test-typecheck: recorded ${total} error(s) across ${counts.size} file(s)`);
  process.exit(0);
}

let budget;
try {
  budget = JSON.parse(readFileSync(BUDGET, "utf8"));
} catch {
  console.error(`test-typecheck: no budget at ${BUDGET} — run with --record`);
  process.exit(1);
}

const grew = [];
for (const [file, n] of counts) {
  const allowed = budget.files[file] ?? 0;
  if (n > allowed) grew.push({ file, n, allowed });
}

if (grew.length > 0) {
  console.error("test-typecheck: type errors GREW in the test trees.\n");
  for (const { file, n, allowed } of grew.sort((a, b) => b.n - a.n)) {
    console.error(`  ${file}: ${allowed} -> ${n}`);
  }
  console.error(
    "\nThese trees are not covered by `pnpm build` (`tsconfig.json` is include:[\"src\"]),\n" +
      "so this is the only place a wrong-arity or wrong-type call in a test is reported.\n" +
      "Run:  npx tsc -p tsconfig.tests.json --pretty false | grep <file>\n" +
      "A count may only fall. If it fell elsewhere, re-record with --record.",
  );
  process.exit(1);
}

const shrunk = [...Object.entries(budget.files)].filter(
  ([file, n]) => (counts.get(file) ?? 0) < n,
).length;
console.log(
  `test-typecheck: ok (${total} error(s) across ${counts.size} file(s); ` +
    `budget ${budget.total}${shrunk > 0 ? `; ${shrunk} file(s) improved — re-record to bank it` : ""})`,
);
