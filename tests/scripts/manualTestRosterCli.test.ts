// Process-level tests for `scripts/check-manual-test-roster.mjs` (myne-md/myne#548).
//
// `analyse(io)` takes its whole world as an argument and is injected in
// `manualTestRoster.test.ts`. `main()` is not: it reads fixed paths, decides
// exit codes, and holds every FAIL-CLOSED arm in the file. Review found that
// none of those arms was reachable from a test, which matters more here than
// usual because two of them are recorded REGRESSIONS the source documents in its
// own comments:
//
//   1. `--record` used to return before the failure gate, so a ceiling could be
//      locked in from a roster the guard had just rejected, at exit 0.
//   2. A deleted `totalMinutesCeiling` made Rule 5 a silent no-op, because both
//      `N > undefined` and `N < undefined` are false, and `--record` then wrote
//      `null` over it.
//
// A recorded regression with no regression test is a fix that can be undone in
// silence, which is the thing the root CLAUDE.md calls the same non-evidence as
// running a guard green. So these spawn the real script against the real tree
// and mutate one input at a time, restoring in `finally` whatever they touched.

import { execFileSync } from "node:child_process";
import { copyFileSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const ROOT = new URL("../../", import.meta.url).pathname;
const SCRIPT = join(ROOT, "scripts/check-manual-test-roster.mjs");
const RATCHET = join(ROOT, "scripts/manual-test-ratchet.json");
const PROJECTION = join(ROOT, "docs/dev/manual-test-roster.md");

function run(args: string[] = []): { code: number; out: string } {
  try {
    return { code: 0, out: execFileSync("node", [SCRIPT, ...args], { cwd: ROOT, encoding: "utf8" }) };
  } catch (e) {
    const err = e as { status: number; stdout: string; stderr: string };
    return { code: err.status, out: `${err.stdout}${err.stderr}` };
  }
}

/** Mutate a checked-in file for one assertion and put the bytes back. */
function withMutation(path: string, mutate: (before: string) => string, body: () => void): void {
  const before = readFileSync(path, "utf8");
  try {
    writeFileSync(path, mutate(before));
    body();
  } finally {
    writeFileSync(path, before);
  }
}

describe("the tree as it stands", () => {
  it("passes --check at exit 0", () => {
    const { code, out } = run(["--check"]);
    expect(out).toContain("check-manual-test-roster: ok.");
    expect(code).toBe(0);
  });
});

describe("the ratchet file is validated before it is used", () => {
  it("refuses a DELETED totalMinutesCeiling by name rather than skipping the rule", () => {
    withMutation(
      RATCHET,
      (s) => {
        const d = JSON.parse(s) as Record<string, unknown>;
        delete d.totalMinutesCeiling;
        return `${JSON.stringify(d, null, 2)}\n`;
      },
      () => {
        const { code, out } = run(["--check"]);
        expect(out).toContain("no finite totalMinutesCeiling");
        expect(code).toBe(1);
      },
    );
  });

  it("refuses the same deletion on --record, so the null can never be written", () => {
    withMutation(
      RATCHET,
      (s) => {
        const d = JSON.parse(s) as Record<string, unknown>;
        delete d.totalMinutesCeiling;
        return `${JSON.stringify(d, null, 2)}\n`;
      },
      () => {
        const { code, out } = run(["--record"]);
        expect(out).toContain("no finite totalMinutesCeiling");
        expect(code).toBe(1);
        // And the file is untouched: `Math.min(undefined, N)` is NaN, which
        // `JSON.stringify` writes as `null`, and a null bound is worse than an
        // absent one because absent exits 1 while null reports ok.
        expect(readFileSync(RATCHET, "utf8")).not.toContain("null");
      },
    );
  });

  it("refuses an EMPTY gatedClients, which would gate nothing while reading as a policy", () => {
    withMutation(
      RATCHET,
      (s) => s.replace(/"gatedClients": \[[^\]]*\]/, '"gatedClients": []'),
      () => {
        const { code, out } = run(["--check"]);
        expect(out).toContain("needs a non-empty gatedClients array");
        expect(code).toBe(1);
      },
    );
  });
});

describe("--record refuses a roster the guard has just rejected", () => {
  // This is recorded regression 1 from the header, and until the myne-bot review
  // of PR #576 it had no test: both --record cases above inject a deleted ceiling,
  // which exits at the ratchet validation long before the failure gate. So
  // deleting the failures-first block at the top of the --record branch left the
  // entire suite green, and a ceiling could be locked in from a rejected roster
  // with no legitimate way back down.

  it("exits 1, prints the failures, and leaves the ratchet bytes untouched", () => {
    const injected = join(ROOT, "src/screens/ZzRecordProbe.tsx");
    const ratchetBefore = readFileSync(RATCHET, "utf8");
    try {
      writeFileSync(injected, "export const ZzRecordProbe = () => null;\n");
      const { code, out } = run(["--record"]);
      expect(out).toContain("--record refused");
      expect(out).toContain("no roster entry claims src/screens/ZzRecordProbe.tsx");
      expect(code).toBe(1);
      expect(readFileSync(RATCHET, "utf8")).toBe(ratchetBefore);
    } finally {
      rmSync(injected, { force: true });
      writeFileSync(RATCHET, ratchetBefore);
    }
  });

  it("says there is nothing to lock in when the record already describes the roster", () => {
    // The other direction: on a clean tree at the recorded numbers, --record is a
    // no-op rather than a rewrite. A test that only proves the refusal would pass
    // against a --record that refuses everything.
    const before = readFileSync(RATCHET, "utf8");
    const { code, out } = run(["--record"]);
    expect(out).toContain("nothing to lock in");
    expect(code).toBe(0);
    expect(readFileSync(RATCHET, "utf8")).toBe(before);
  });
});

describe("a surface entering the tree fails by name", () => {
  it("names an unclaimed screen, and --emit refuses to publish a projection of a rejected roster", () => {
    const injected = join(ROOT, "src/screens/ZzGuardProbe.tsx");
    const projectionBefore = readFileSync(PROJECTION, "utf8");
    try {
      writeFileSync(injected, "export const ZzGuardProbe = () => null;\n");

      const checked = run(["--check"]);
      expect(checked.out).toContain("no roster entry claims src/screens/ZzGuardProbe.tsx");
      expect(checked.code).toBe(1);

      // The `--emit` half is the one review found: it used to write the CC-BY
      // projection and THEN exit 1, publishing a document describing a state
      // nobody accepted. `--record` refuses for the same reason with the
      // opposite sign, so the principle was already in the file and applied in
      // one of the two places it holds.
      const emitted = run(["--emit"]);
      expect(emitted.out).toContain("was NOT written");
      expect(emitted.code).toBe(1);
      expect(readFileSync(PROJECTION, "utf8")).toBe(projectionBefore);
    } finally {
      rmSync(injected, { force: true });
      writeFileSync(PROJECTION, projectionBefore);
    }
  });
});

describe("the generated projection is gated, not merely generated", () => {
  it("names a hand edit to docs/dev/manual-test-roster.md", () => {
    withMutation(
      PROJECTION,
      (s) => `${s}\nA line somebody added by hand.\n`,
      () => {
        const { code, out } = run(["--check"]);
        expect(out).toContain("is stale");
        expect(code).toBe(1);
      },
    );
  });

  it("regenerates byte-identically, so --emit and --check agree", () => {
    const before = readFileSync(PROJECTION, "utf8");
    const copy = join(ROOT, "docs/dev/.manual-test-roster.probe");
    try {
      copyFileSync(PROJECTION, copy);
      expect(run(["--emit"]).code).toBe(0);
      expect(readFileSync(PROJECTION, "utf8")).toBe(before);
    } finally {
      rmSync(copy, { force: true });
      writeFileSync(PROJECTION, before);
    }
  });
});
