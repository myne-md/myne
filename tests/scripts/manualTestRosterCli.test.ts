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
// silence, which is the thing the root AGENTS.md calls the same non-evidence as
// running a guard green. So these spawn the real script and mutate one input at a
// time.
//
// THE MUTATIONS GO INTO A SANDBOX, and that is a correctness fix rather than
// tidiness. They used to land in the real tree (`src/screens/Zz*.tsx`,
// `dev-notes/.manual-test-roster.probe`, the ratchet, the projection) and be
// restored in a `finally`. Vitest runs files in parallel workers, so for as long
// as a probe existed, a sibling test reading the real tree failed on a pairing
// nobody chose. Measured by creating the probe by hand: `webScreens.test.ts` went
// red with `expected 1 to be +0` (it copies the real `src/screens` and asks
// whether every screen has a web verdict), and `privatePathRefs.test.ts` with
// `dev-notes/.manual-test-roster.probe` named as an unclassified extension.
// `check-e2e-menu-testids.mjs` records the same failure as myne-md/myne#242 and
// fixes it with a `--scan <dir>` seam; this file uses the three seams `main()`
// now takes (`--scan`, `--ratchet`, `--projection`).
//
// The ONE assertion that still reads the real tree is "the tree as it stands",
// and that is its whole point: a guard that only ever runs over a sandbox says
// nothing about the tree that ships.

import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const ROOT = new URL("../../", import.meta.url).pathname;
const SCRIPT = join(ROOT, "scripts/check-manual-test-roster.mjs");
const RATCHET = join(ROOT, "scripts/manual-test-ratchet.json");
const PROJECTION = join(ROOT, "docs/dev/manual-test-roster.md");
const PROJECTION_PRESENT = existsSync(PROJECTION);
const describeProjection = PROJECTION_PRESENT ? describe : describe.skip;

function run(args: string[] = []): { code: number; out: string } {
  try {
    return { code: 0, out: execFileSync("node", [SCRIPT, ...args], { cwd: ROOT, encoding: "utf8" }) };
  } catch (e) {
    const err = e as { status: number; stdout: string; stderr: string };
    return { code: err.status, out: `${err.stdout}${err.stderr}` };
  }
}

interface Sandbox {
  dir: string;
  ratchet: string;
  projection: string;
}

/**
 * A throwaway tree the CLI can be pointed at, seeded from the real records.
 *
 * Seeded rather than invented, because two of the assertions below are about the
 * CHECKED-IN document: the projection's bytes have to be the real generated ones
 * or "regenerates byte-identically" would be a sandbox agreeing with itself, and
 * the ratchet's numbers have to be the real ones or "nothing to lock in" would be
 * true of an empty record for the wrong reason.
 */
function sandbox(): Sandbox {
  const dir = mkdtempSync(join(tmpdir(), "roster-cli-"));
  const ratchet = join(dir, "manual-test-ratchet.json");
  const projection = join(dir, "manual-test-roster.md");
  copyFileSync(RATCHET, ratchet);
  copyFileSync(PROJECTION, projection);
  return { dir, ratchet, projection };
}

/** Every input `main()` reads, pointed at the sandbox. */
function args(s: Sandbox, ...rest: string[]): string[] {
  return ["--scan", s.dir, "--ratchet", s.ratchet, "--projection", s.projection, ...rest];
}

/** The sandbox plus one unclaimed screen, which is what the forward rule measures. */
function sandboxWithScreen(name: string): Sandbox {
  const s = sandbox();
  mkdirSync(join(s.dir, "src", "screens"), { recursive: true });
  writeFileSync(
    join(s.dir, "src", "screens", name),
    `export const ${name.replace(/\.tsx$/, "")} = () => null;\n`,
  );
  return s;
}

function withSandbox(body: (s: Sandbox) => void, make: () => Sandbox = sandbox): void {
  const s = make();
  try {
    body(s);
  } finally {
    rmSync(s.dir, { recursive: true, force: true });
  }
}

/** Mutate a sandbox file for one assertion and put the bytes back. */
function withMutation(path: string, mutate: (before: string) => string, body: () => void): void {
  const before = readFileSync(path, "utf8");
  try {
    writeFileSync(path, mutate(before));
    body();
  } finally {
    writeFileSync(path, before);
  }
}

describeProjection("the tree as it stands", () => {
  it("passes --check at exit 0", () => {
    const { code, out } = run(["--check"]);
    expect(out).toContain("check-manual-test-roster: ok.");
    expect(code).toBe(0);
  });
});

describeProjection("the ratchet file is validated before it is used", () => {
  it("refuses a DELETED totalMinutesCeiling by name rather than skipping the rule", () => {
    withSandbox((s) => {
      withMutation(
        s.ratchet,
        (text) => {
          const d = JSON.parse(text) as Record<string, unknown>;
          delete d.totalMinutesCeiling;
          return `${JSON.stringify(d, null, 2)}\n`;
        },
        () => {
          const { code, out } = run(args(s, "--check"));
          expect(out).toContain("no finite totalMinutesCeiling");
          expect(code).toBe(1);
        },
      );
    });
  });

  it("refuses the same deletion on --record, so the null can never be written", () => {
    withSandbox((s) => {
      withMutation(
        s.ratchet,
        (text) => {
          const d = JSON.parse(text) as Record<string, unknown>;
          delete d.totalMinutesCeiling;
          return `${JSON.stringify(d, null, 2)}\n`;
        },
        () => {
          const { code, out } = run(args(s, "--record"));
          expect(out).toContain("no finite totalMinutesCeiling");
          expect(code).toBe(1);
          // And the file is untouched: `Math.min(undefined, N)` is NaN, which
          // `JSON.stringify` writes as `null`, and a null bound is worse than an
          // absent one because absent exits 1 while null reports ok.
          expect(readFileSync(s.ratchet, "utf8")).not.toContain("null");
        },
      );
    });
  });

  it("refuses an EMPTY gatedClients, which would gate nothing while reading as a policy", () => {
    withSandbox((s) => {
      withMutation(
        s.ratchet,
        (text) => text.replace(/"gatedClients": \[[^\]]*\]/, '"gatedClients": []'),
        () => {
          const { code, out } = run(args(s, "--check"));
          expect(out).toContain("needs a non-empty gatedClients array");
          expect(code).toBe(1);
        },
      );
    });
  });
});

describeProjection("--record refuses a roster the guard has just rejected", () => {
  // This is recorded regression 1 from the header, and until the myne-bot review
  // of PR #576 it had no test: both --record cases above inject a deleted ceiling,
  // which exits at the ratchet validation long before the failure gate. So
  // deleting the failures-first block at the top of the --record branch left the
  // entire suite green, and a ceiling could be locked in from a rejected roster
  // with no legitimate way back down.

  it("exits 1, prints the failures, and leaves the ratchet bytes untouched", () => {
    withSandbox(
      (s) => {
        const sandboxBefore = readFileSync(s.ratchet, "utf8");
        const realBefore = readFileSync(RATCHET, "utf8");
        const { code, out } = run(args(s, "--record"));
        expect(out).toContain("--record refused");
        expect(out).toContain("no roster entry claims src/screens/ZzRecordProbe.tsx");
        expect(code).toBe(1);
        expect(readFileSync(s.ratchet, "utf8")).toBe(sandboxBefore);
        // And the real record was never in reach of the write at all, which is what
        // moving this test off the real tree bought.
        expect(readFileSync(RATCHET, "utf8")).toBe(realBefore);
      },
      () => sandboxWithScreen("ZzRecordProbe.tsx"),
    );
  });

  it("says there is nothing to lock in when the record already describes the roster", () => {
    // The other direction: on a clean tree at the recorded numbers, --record is a
    // no-op rather than a rewrite. A test that only proves the refusal would pass
    // against a --record that refuses everything.
    withSandbox((s) => {
      const before = readFileSync(s.ratchet, "utf8");
      const { code, out } = run(args(s, "--record"));
      expect(out).toContain("nothing to lock in");
      expect(code).toBe(0);
      expect(readFileSync(s.ratchet, "utf8")).toBe(before);
    });
  });
});

describeProjection("a surface entering the tree fails by name", () => {
  it("names an unclaimed screen, and --emit refuses to publish a projection of a rejected roster", () => {
    withSandbox(
      (s) => {
        const projectionBefore = readFileSync(s.projection, "utf8");

        const checked = run(args(s, "--check"));
        expect(checked.out).toContain("no roster entry claims src/screens/ZzGuardProbe.tsx");
        expect(checked.code).toBe(1);

        // The `--emit` half is the one review found: it used to write the CC-BY
        // projection and THEN exit 1, publishing a document describing a state
        // nobody accepted. `--record` refuses for the same reason with the
        // opposite sign, so the principle was already in the file and applied in
        // one of the two places it holds.
        const emitted = run(args(s, "--emit"));
        expect(emitted.out).toContain("was NOT written");
        expect(emitted.code).toBe(1);
        expect(readFileSync(s.projection, "utf8")).toBe(projectionBefore);
      },
      () => sandboxWithScreen("ZzGuardProbe.tsx"),
    );
  });
});

describeProjection("the generated projection is gated, not merely generated", () => {
  it("names a hand edit to the projection", () => {
    withSandbox((s) => {
      withMutation(
        s.projection,
        (text) => `${text}\nA line somebody added by hand.\n`,
        () => {
          const { code, out } = run(args(s, "--check"));
          expect(out).toContain("is stale");
          expect(code).toBe(1);
        },
      );
    });
  });

  it("regenerates byte-identically, so --emit and --check agree", () => {
    withSandbox((s) => {
      const before = readFileSync(s.projection, "utf8");
      expect(run(args(s, "--emit")).code).toBe(0);
      expect(readFileSync(s.projection, "utf8")).toBe(before);
      // The bytes are the real projection's, so this reproduces the checked-in
      // document rather than a sandbox agreeing with itself.
      expect(before).toBe(readFileSync(PROJECTION, "utf8"));
    });
  });
});
