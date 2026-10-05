// Drives `scripts/check-story-coverage.mjs` (myne-md/myne#832).
//
// The repo's rule for a guard is to BREAK it, not run it: every defect the
// guard claims to catch is injected here and the guard must name it. Both
// directions are exercised, because a guard that has stopped checking is green
// by definition and the only way to tell is to watch it go red.

import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  compare,
  enumerateSurfaces,
  readStorySurfaces,
  planRecord,
  NON_SURFACE,
} from "../../scripts/check-story-coverage.mjs";

function surfaces(...names: string[]): Map<string, string> {
  return new Map(names.map((n) => [n, `src/components/${n}.tsx`]));
}

/** `compare` with the story-only surface set emptied, so a case is not affected
 *  by the real `AiChatTab` story. A separate case exercises that set. */
function run(args: {
  surfaces: Map<string, string>;
  storySurfaces: Map<string, boolean>;
  roster: { floor?: number; debt?: string[] };
}) {
  return compare({ ...args, storyOnly: {} });
}

describe("check-story-coverage.compare", () => {
  it("passes when every surface is covered", () => {
    const problems = run({
      surfaces: surfaces("Button"),
      storySurfaces: new Map([["Button", true]]),
      roster: { floor: 1, debt: [] },
    });
    expect(problems).toEqual([]);
  });

  it("names a NEW surface with no story", () => {
    const problems = run({
      surfaces: surfaces("Button", "BrandNew"),
      storySurfaces: new Map([["Button", true]]),
      roster: { floor: 2, debt: [] },
    });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("BrandNew");
    expect(problems[0]).toContain("no story");
  });

  it("allows a recorded debt entry", () => {
    const problems = run({
      surfaces: surfaces("Button", "Old"),
      storySurfaces: new Map([["Button", true]]),
      roster: { floor: 2, debt: ["Old"] },
    });
    expect(problems).toEqual([]);
  });

  it("fails a debt entry whose surface now has a story (stale debt)", () => {
    const problems = run({
      surfaces: surfaces("Button"),
      storySurfaces: new Map([["Button", true]]),
      roster: { floor: 1, debt: ["Button"] },
    });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("still recorded as debt");
  });

  it("fails a debt entry whose surface is gone (stale record)", () => {
    const problems = run({
      surfaces: surfaces("Button"),
      storySurfaces: new Map([["Button", true]]),
      roster: { floor: 1, debt: ["Ghost"] },
    });
    expect(problems.some((p) => p.includes("Ghost"))).toBe(true);
  });

  it("fails a story naming a surface that does not exist", () => {
    const problems = run({
      surfaces: surfaces("Button"),
      storySurfaces: new Map([["Buton", true]]),
      roster: { floor: 1, debt: [] },
    });
    expect(problems.some((p) => p.includes("Buton"))).toBe(true);
  });

  it("fails when the scan covers less than the recorded floor", () => {
    const problems = run({
      surfaces: surfaces("Button"),
      storySurfaces: new Map([["Button", true]]),
      roster: { floor: 99, debt: [] },
    });
    expect(problems.some((p) => p.includes("floor"))).toBe(true);
  });
});

describe("check-story-coverage.planRecord", () => {
  it("refuses a record that would GROW the debt set", () => {
    const plan = planRecord({
      surfaces: surfaces("Button", "BrandNew"),
      storySurfaces: new Map([["Button", true]]),
      roster: { debt: ["Button"] },
      priorExists: true,
    });
    expect(plan.refuse).toBe(true);
    expect(plan.grown).toContain("BrandNew");
  });

  it("allows a record that shrinks the debt set", () => {
    const plan = planRecord({
      surfaces: surfaces("Button", "Old"),
      storySurfaces: new Map([["Button", true]]),
      roster: { debt: ["Button", "Old"] },
      priorExists: true,
    });
    expect(plan.refuse).toBe(false);
    expect(plan.uncovered).toEqual(["Old"]);
  });

  it("allows the first record (no prior file)", () => {
    const plan = planRecord({
      surfaces: surfaces("A", "B"),
      storySurfaces: new Map(),
      roster: {},
      priorExists: false,
    });
    expect(plan.refuse).toBe(false);
  });
});

describe("check-story-coverage scan", () => {
  it("enumerates .tsx basenames and skips index and NON_SURFACE helpers", () => {
    const dir = mkdtempSync(join(tmpdir(), "stories-cov-"));
    mkdirSync(join(dir, "src/components"), { recursive: true });
    mkdirSync(join(dir, "src/screens"), { recursive: true });
    writeFileSync(join(dir, "src/components/Button.tsx"), "export function Button(){return null}");
    writeFileSync(join(dir, "src/components/index.tsx"), "export {}");
    writeFileSync(join(dir, "src/screens/Unlock.tsx"), "export function Unlock(){return null}");
    // A NON_SURFACE helper that actually exists must be skipped.
    const helper = Object.keys(NON_SURFACE)[0];
    writeFileSync(join(dir, `src/screens/${helper}.tsx`), "export function H(){return null}");

    const found = enumerateSurfaces(dir, ["src/components", "src/screens"]);
    expect(found.has("Button")).toBe(true);
    expect(found.has("Unlock")).toBe(true);
    expect(found.has("index")).toBe(false);
    expect(found.has(helper)).toBe(false);
  });

  it("reads surface names from story sources", () => {
    const dir = mkdtempSync(join(tmpdir(), "stories-src-"));
    writeFileSync(
      join(dir, "primitives.tsx"),
      "export const S = { surface: \"Button\", state: \"default\" };",
    );
    // A commented-out surface must NOT count (comments are stripped first).
    writeFileSync(join(dir, "other.tsx"), "// surface: \"Ghost\"\nexport const x = 1;");
    const found = readStorySurfaces(dir);
    expect([...found.keys()]).toEqual(["Button"]);
  });
});

describe("check-story-coverage story-only surfaces", () => {
  it("accepts a story for a surface outside the denominator", () => {
    const problems = compare({
      surfaces: surfaces("Button"),
      storySurfaces: new Map([
        ["Button", true],
        ["AiChatTab", true],
      ]),
      roster: { floor: 1, debt: [] },
      storyOnly: { AiChatTab: "outside the roots" },
    });
    expect(problems).toEqual([]);
  });

  it("fails a story-only entry with no story (stale)", () => {
    const problems = compare({
      surfaces: surfaces("Button"),
      storySurfaces: new Map([["Button", true]]),
      roster: { floor: 1, debt: [] },
      storyOnly: { AiChatTab: "outside the roots" },
    });
    expect(problems.some((p) => p.includes("AiChatTab"))).toBe(true);
  });
});
