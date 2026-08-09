// The ratchet's own test (myne#394 task 8).
//
// A guard nobody tests is a guard that can quietly stop guarding — this repo has
// shipped exactly that shape before. What matters here is not that the script
// runs, but that it FAILS when a converted file re-acquires a literal.
//
// The failure case runs against a THROWAWAY directory via `--scan`. An earlier
// version mutated `src/lib/theme.ts` on disk and restored it in `afterEach`: a
// crashed run left a production source file corrupted, and a parallel worker
// could read it mid-write — the cross-file contamination shape this repo has hit
// before.

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

const ROOT = new URL("../../", import.meta.url).pathname;
const SCRIPT = `${ROOT}scripts/check-token-adoption.mjs`;

function run(args: string[] = []): { code: number; out: string } {
  try {
    return { code: 0, out: execFileSync("node", [SCRIPT, ...args], { cwd: ROOT, encoding: "utf8" }) };
  } catch (e) {
    const err = e as { status: number; stdout: string; stderr: string };
    return { code: err.status, out: `${err.stdout}${err.stderr}` };
  }
}

let scratch: string | null = null;

afterEach(() => {
  if (scratch) rmSync(scratch, { recursive: true, force: true });
  scratch = null;
});

/** A scratch tree with one file, scanned in isolation. */
function withFile(contents: string): string {
  scratch = mkdtempSync(join(tmpdir(), "myne-ratchet-"));
  writeFileSync(join(scratch, "probe.tsx"), contents);
  return scratch;
}

describe("check-token-adoption", () => {
  it("passes on the tree as recorded", () => {
    const { code, out } = run();
    expect(out).toContain("token-adoption: ok");
    expect(code).toBe(0);
  });

  it("counts a hardcoded visual value", () => {
    const dir = withFile('const s = { fontSize: 17, color: "#abcdef", padding: 13 };\n');
    const { out } = run(["--scan", dir]);
    // Nothing is recorded for a scratch dir, so every literal reads as growth.
    expect(out).toContain("hardcoded visual values grew");
    expect(out).toContain("probe.tsx");
  });

  it("does not count a var() fallback, a comment, or a token reference", () => {
    // The three measurement corrections this guard needed, pinned so they cannot
    // regress: a fallback is already themable, an issue ref is not a colour, and
    // a token reference is the goal rather than the debt.
    const dir = withFile(
      'const s = { color: "var(--ink-1, #abcdef)", padding: "var(--space-3)" };\n' +
        "// see myne#184 and #250 for context\n",
    );
    const { code, out } = run(["--scan", dir]);
    expect(out).toContain("token-adoption: ok");
    expect(code).toBe(0);
  });

  it("names the token families in its failure message", () => {
    // The message has to teach, not just refuse: the next person needs to know
    // WHICH var to reach for, and why a literal here is permanent.
    const dir = withFile("const s = { padding: 13 };\n");
    const { out } = run(["--scan", dir]);
    expect(out).toContain("var(--space-4)");
    expect(out).toContain("unreachable to every custom theme");
  });
});
