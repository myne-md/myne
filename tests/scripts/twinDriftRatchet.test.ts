import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { EXAMINED_FLOOR, measure, ratchet } from "../../scripts/check-twin-drift-ratchet.mjs";

// Injection suite for `scripts/check-twin-drift-ratchet.mjs`.
//
// Per `CLAUDE.md`: verifying a guard means BREAKING it. Each verdict is driven
// with synthetic pairs rather than against `src/` and `mobile/src/`, so a
// crashed run cannot leave a production module corrupted.
//
// The half most of these suites skip is the WRITING path. CLAUDE.md records
// `check-ipc-binding-callers.mjs` seeding every entry with a placeholder its own
// reason check accepted, so `--record` produced a file that went green while
// every entry in it said its reason was missing, and injecting the defect the
// guard READS for still passed, because the defect was in the half that writes.
// The question that finds it is the other one: run `--record` on a dirty tree
// and check the guard then FAILS. The last two cases here are that.

const ROOT: string = fileURLToPath(new URL("../..", import.meta.url));
const SCRIPT: string = join(ROOT, "scripts/check-twin-drift-ratchet.mjs");
const RECORD: string = join(ROOT, "scripts/twin-drift-ratchet.json");

function run(args: string[] = []): { code: number; out: string } {
  try {
    return {
      code: 0,
      out: execFileSync("node", [SCRIPT, ...args], { cwd: ROOT, encoding: "utf8" }),
    };
  } catch (e) {
    const err = e as { status: number; stdout: string; stderr: string };
    return { code: err.status, out: `${err.stdout}${err.stderr}` };
  }
}

let savedRecord = "";

afterEach(() => {
  if (savedRecord) {
    writeFileSync(RECORD, savedRecord);
    savedRecord = "";
  }
});

/**
 * Three synthetic pairs: one identical, one differing only in a comment, one
 * really different. Purely in memory, `measure` takes its `read`, so there is
 * nothing to write to a scratch directory and none is made. The first version
 * created one and never used it, copied from a sibling suite that does.
 */
function fixture(): { pairs: { a: string; b: string }[]; read: (p: string) => string | null } {
  const files: Record<string, string> = {
    "same/a.ts": "export const x = 1;\n",
    "same/b.ts": "export const x = 1;\n",
    "cosmetic/a.ts": "// a comment\nexport const y = 2;\n",
    "cosmetic/b.ts": "export const y = 2;\n",
    "real/a.ts": "export const z = 3;\n",
    "real/b.ts": "export const z = 4;\n",
  };
  return {
    pairs: [
      { a: "same/a.ts", b: "same/b.ts" },
      { a: "cosmetic/a.ts", b: "cosmetic/b.ts" },
      { a: "real/a.ts", b: "real/b.ts" },
    ],
    read: (p: string) => files[p] ?? null,
  };
}

describe("check-twin-drift-ratchet, measurement", () => {
  it("counts a real difference and NOT a comment-only one", () => {
    // The whole reason only the semantic field may gate: fourteen of the
    // tree's currently-different pairs differ only in a comment or the seam
    // import, and gating the byte flag would redden pre-commit for adding a
    // comment to either side of a byte-identical pair.
    const { pairs, read } = fixture();
    const m = measure({ pairs, read });
    expect(m.examined).toHaveLength(3);
    expect(m.different).toEqual(["real/a.ts::real/b.ts"]);
  });

  it("reports a pair it cannot read rather than silently dropping it", () => {
    const { pairs } = fixture();
    const m = measure({ pairs, read: (p: string) => (p.startsWith("same/") ? "x" : null) });
    expect(m.unreadable).toContain("real/a.ts::real/b.ts");
    // And a pair it could not read is NOT counted as examined, so it cannot
    // pad the denominator the floor is measured against.
    expect(m.examined).not.toContain("real/a.ts::real/b.ts");
  });
});

describe("check-twin-drift-ratchet, verdicts", () => {
  const base = { examined: ["p1", "p2", "p3"], floor: 3 };

  it("fires when a pair STARTS differing", () => {
    const r = ratchet({ ...base, different: ["p1", "p2"], recorded: ["p1"] });
    expect(r.grew).toEqual(["p2"]);
  });

  it("reports a convergence without failing on it", () => {
    const r = ratchet({ ...base, different: ["p1"], recorded: ["p1", "p2"] });
    expect(r.grew).toEqual([]);
    expect(r.shrank).toEqual(["p2"]);
  });

  it("sees a swap a COUNT would miss", () => {
    // One pair converges while another diverges: the number is unchanged, and
    // this is the case a count-only ratchet is blind to. It is why the record
    // holds the set.
    const r = ratchet({ ...base, different: ["p1", "p3"], recorded: ["p1", "p2"] });
    expect(r.grew).toEqual(["p3"]);
    expect(r.shrank).toEqual(["p2"]);
  });

  it("fires when the DENOMINATOR narrows", () => {
    // Shrinking the roster shrinks the recorded set for free, and reads as
    // progress. The floor is the only thing that sees it.
    const r = ratchet({ different: [], examined: ["p1"], recorded: [], floor: 3 });
    expect(r.underFloor).toEqual({ examined: 1, floor: 3 });
  });

  it("does not fire on a denominator that grew", () => {
    const r = ratchet({ different: [], examined: ["p1", "p2", "p3", "p4"], recorded: [], floor: 3 });
    expect(r.underFloor).toBeNull();
  });
});

describe("check-twin-drift-ratchet, the tree as it stands", () => {
  it("passes, and examines at least the floor", () => {
    const { code, out } = run();
    expect(out).toContain("twin-drift-ratchet: ok");
    expect(code).toBe(0);
    const examined = /of (\d+) twin pair\(s\)/.exec(out);
    expect(examined).not.toBeNull();
    expect(Number(examined![1])).toBeGreaterThanOrEqual(EXAMINED_FLOOR);
  });

  it("fails when a recorded pair is removed from the record", () => {
    // The reader's half: a pair differing in the tree but absent from the
    // record is exactly what "started differing" looks like.
    savedRecord = readFileSync(RECORD, "utf8");
    const rec = JSON.parse(savedRecord) as { semanticallyDifferent: string[] };
    const dropped = rec.semanticallyDifferent[0];
    writeFileSync(
      RECORD,
      JSON.stringify({ ...rec, semanticallyDifferent: rec.semanticallyDifferent.slice(1) }, null, 2),
    );
    const { code, out } = run();
    expect(code).toBe(1);
    expect(out).toContain("started differing");
    expect(out).toContain(dropped.split("::")[0]);
  });

  it("REFUSES --record when the set has grown", () => {
    // The writing half, and the one nobody tests. `--record` exists so a
    // convergence can be locked in; a `--record` that also locked in a
    // REGRESSION would turn the command the failure message suggests into the
    // way to make the failure go away.
    savedRecord = readFileSync(RECORD, "utf8");
    const rec = JSON.parse(savedRecord) as { semanticallyDifferent: string[] };
    writeFileSync(
      RECORD,
      JSON.stringify({ ...rec, semanticallyDifferent: rec.semanticallyDifferent.slice(1) }, null, 2),
    );
    const { code, out } = run(["--record"]);
    expect(code).toBe(1);
    expect(out).toContain("--record refused");
    // And it wrote nothing: the record is byte-identical to the dirty one it
    // was handed, not to the tree.
    const after = JSON.parse(readFileSync(RECORD, "utf8")) as { semanticallyDifferent: string[] };
    expect(after.semanticallyDifferent).toEqual(rec.semanticallyDifferent.slice(1));
  });

  it("says there is nothing to lock in when the record already describes the tree", () => {
    const { code, out } = run(["--record"]);
    expect(code).toBe(0);
    expect(out).toContain("nothing to lock in");
  });
});
