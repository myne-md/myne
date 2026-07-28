// The command-surface completeness assertion (phase3-web-client task 28).
//
// # What this stops
//
// A desktop-only command added to `src/` that is neither implemented for web nor
// declared unsupported. Nothing in either compiler relates a TypeScript string
// literal to a Rust `match` arm, so such a command produces no diagnostic — it
// simply arrives at the dispatcher and falls to `NotPorted`. Loud at runtime,
// silent at build time, and invisible until someone opens a browser.
//
// # Why this imports the guard instead of reimplementing it
//
// `scripts/check-web-command-coverage.mjs` already performs exactly this
// analysis, as a pre-commit hook and a CI step. This spec exists because the
// task asks the property to run **in both lanes**, and the script runs only in
// the desktop lane's `pnpm-build` step — whereas `pnpm test` runs wherever
// vitest does.
//
// It imports `analyse()` rather than restating the rule. Two statements of one
// rule is the drift this project keeps finding (the capability descriptor vs the
// refusal table; the `.d.ts` vs `entry.rs`), and a test that reimplemented the
// scan could pass while the script failed, or worse, agree with a bug.

import { describe, expect, it } from "vitest";
// @ts-expect-error — a plain .mjs guard script with no type declarations; it is
// deliberately dependency-free and lives outside `tsconfig`'s `include`.
import { analyse } from "../../scripts/check-web-command-coverage.mjs";

interface Analysis {
  problems: string[];
  unclassified: Array<[string, string]>;
  stalePlugins: string[];
  staleCommands: string[];
  counts: { inventory: number; dispatched: number; pending: number };
}

describe("web command surface", () => {
  const result = analyse() as Analysis;

  it("scanned something — the analysis is not vacuous", () => {
    // Every assertion below is "found nothing wrong", which a broken scan also
    // satisfies. This is the one that distinguishes them.
    expect(result.counts.inventory).toBeGreaterThan(100);
    expect(result.counts.dispatched).toBeGreaterThan(0);
  });

  it("every IPC command in the shared tree is classified for web", () => {
    // The failure message names the command AND the file it was first seen in —
    // the task's criterion is that the failure names the command and the fix,
    // and the script's own error text carries the four-way fix instruction.
    expect(
      result.unclassified.map(([name, file]) => `${name}  (first seen: ${file})`),
      "commands with no entry in web/wasm/src/capability.rs",
    ).toEqual([]);
  });

  it("no classification outlives the command it classified", () => {
    // The other direction. A stale entry makes the remaining-work count
    // meaningless, and a decision nobody can find the subject of.
    expect([...result.stalePlugins, ...result.staleCommands]).toEqual([]);
  });

  it("reports no problems at all", () => {
    // Belt-and-braces: `problems` also carries the parse-failure guards, which
    // the two structural assertions above cannot express.
    expect(result.problems).toEqual([]);
  });
});
