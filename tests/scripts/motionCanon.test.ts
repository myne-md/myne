// The motion-canon guard (epic myne-md/myne#772; normatively PRODUCT.md
// principle 4 + design-notes/ui/0632).
//
// Verifying a guard means BREAKING it. Each case writes a fixture into a
// throwaway tree, points the guard at it with `MYNE_GUARD_ROOT`, runs the real
// script as a subprocess, and asserts the OUTPUT names that fixture. Asserting
// on the name rather than the exit code is deliberate (the tooltip spec's
// header records the same reasoning): the guard always reports its stale
// allowlist entries when scanned against a tree that does not contain the real
// allowlisted animations, so exit 1 is not a usable signal.

import { afterEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { SHARED_ROOTS } from "../../scripts/lib/shared-roots.mjs";

const ROOT: string = fileURLToPath(new URL("../..", import.meta.url));
const FIXTURE_NAME = "__motion_fixture__.tsx";
let scratch: string | null = null;

function run(): { code: number; out: string } {
  try {
    const out: string = execFileSync("node", ["scripts/check-motion-canon.mjs"], {
      cwd: ROOT,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env:
        scratch === null ? process.env : { ...process.env, MYNE_GUARD_ROOT: scratch },
    });
    return { code: 0, out };
  } catch (e) {
    const err = e as { status?: number; stderr?: string; stdout?: string };
    return { code: err.status ?? 1, out: `${err.stdout ?? ""}${err.stderr ?? ""}` };
  }
}

function scratchTree(body: string): string {
  const dir: string = mkdtempSync(join(tmpdir(), "motion-canon-"));
  for (const root of SHARED_ROOTS) {
    mkdirSync(join(dir, root), { recursive: true });
  }
  mkdirSync(join(dir, "src", "components"), { recursive: true });
  writeFileSync(join(dir, "src", "components", FIXTURE_NAME), body, "utf8");
  return dir;
}

function fixture(body: string): void {
  if (scratch !== null) rmSync(scratch, { recursive: true, force: true });
  scratch = scratchTree(body);
}

/** One inline style object, so every rule reads the same shape. */
function style(css: string): string {
  return `export function T() {\n  return <div style={{ ${css} }}>x</div>;\n}\n`;
}

afterEach(() => {
  if (scratch !== null) rmSync(scratch, { recursive: true, force: true });
  scratch = null;
});

describe("rule 2: an infinite animation outside the allowlist", () => {
  it("flags a name-first shorthand", () => {
    fixture(style('animation: "myne-fake-loop 2s linear infinite"'));
    const out = run().out;
    expect(out).toContain(FIXTURE_NAME);
    expect(out).toContain("myne-fake-loop");
  });

  it("flags a DURATION-FIRST shorthand, which the first version never saw", () => {
    // The whole point of the declaration-based rewrite. `1s infinite pulse` puts
    // a number where the old positional regex required a letter, so the loop
    // was invisible.
    fixture(style('animation: "1s infinite myne-fake-loop"'));
    const out = run().out;
    expect(out).toContain(FIXTURE_NAME);
    expect(out).toContain("myne-fake-loop");
  });

  it("does NOT flag an allowlisted infinite animation", () => {
    fixture(style('animation: "myne-spinner-rotate 0.9s linear infinite"'));
    expect(run().out).not.toContain(FIXTURE_NAME);
  });
});

describe("rule 1: ease-in as an entering curve", () => {
  it("flags ease-in but not ease-in-out", () => {
    fixture(style('transition: "opacity 200ms ease-in"'));
    expect(run().out).toContain(FIXTURE_NAME);

    fixture(style('transition: "opacity 200ms ease-in-out"'));
    expect(run().out).not.toContain(FIXTURE_NAME);
  });
});

describe("rule 3: a raw duration over the 300ms ceiling", () => {
  it("flags 620ms and passes 200ms", () => {
    fixture(style('transition: "opacity 620ms ease-out"'));
    expect(run().out).toContain(FIXTURE_NAME);

    fixture(style('transition: "opacity 200ms ease-out"'));
    expect(run().out).not.toContain(FIXTURE_NAME);
  });
});

describe("rule 4: transitioning a layout property", () => {
  it("flags width and passes transform", () => {
    fixture(style('transition: "width 200ms ease-out"'));
    expect(run().out).toContain(FIXTURE_NAME);

    fixture(style('transition: "transform 200ms ease-out"'));
    expect(run().out).not.toContain(FIXTURE_NAME);
  });
});

describe("rule 5: a self-rescheduling requestAnimationFrame loop", () => {
  it("flags a loop but not a one-shot coalescer", () => {
    fixture(
      "export function T() {\n" +
        "  let raf = 0;\n" +
        "  const tick = () => { raf = requestAnimationFrame(tick); };\n" +
        "  return null;\n" +
        "}\n",
    );
    expect(run().out).toContain(FIXTURE_NAME);

    fixture(
      "export function T() {\n" +
        "  let raf = 0;\n" +
        "  const paint = () => { raf = 0; };\n" +
        "  const schedule = () => { raf = requestAnimationFrame(paint); };\n" +
        "  return null;\n" +
        "}\n",
    );
    expect(run().out).not.toContain(FIXTURE_NAME);
  });
});
