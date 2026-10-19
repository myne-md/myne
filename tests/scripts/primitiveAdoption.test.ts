// The primitive-adoption ratchet (myne-md/myne#774).
//
// Verifying a guard means BREAKING it. The two cases that matter most here are
// the ones it must NOT flag: a control already migrated onto the shared sheet,
// and an input type no primitive covers. A ratchet that over-reaches gets
// re-recorded reflexively, and a reflexively re-recorded ratchet measures
// nothing.

// ── Why these assert on the fixture NAME, not the exit code ────────────────
// Both guard tests write a fixture into the real source tree and run the real
// script over it, and vitest parallelises across FILES. So while this spec's
// "must not flag" case is running, the sibling tooltip spec may have a raw
// `<button>` fixture on disk — which this guard counts, quite correctly, and
// the run exits 1 for a reason that has nothing to do with the case under test.
// Asserting that the OUTPUT does or does not name THIS fixture is immune to
// that, and is the more precise claim anyway: what is being tested is whether
// the guard flags this input, not whether the tree happens to be clean.

import { afterEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { SHARED_ROOTS } from "../../scripts/lib/shared-roots.mjs";

const ROOT: string = fileURLToPath(new URL("../..", import.meta.url));
const FIXTURE_NAME = "__primitive_fixture__.tsx";
let scratch: string | null = null;

function run(): { code: number; out: string } {
  try {
    const out: string = execFileSync(
      "node",
      ["scripts/check-primitive-adoption.mjs"],
      {
        cwd: ROOT,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        env:
          scratch === null
            ? process.env
            : { ...process.env, MYNE_GUARD_ROOT: scratch },
      },
    );
    return { code: 0, out };
  } catch (e) {
    const err = e as { status?: number; stderr?: string; stdout?: string };
    return { code: err.status ?? 1, out: `${err.stdout ?? ""}${err.stderr ?? ""}` };
  }
}

/**
 * Build a throwaway tree the guard can scan, and put `body` in it as a `.tsx`
 * file under `src/components/`.
 *
 * The guard is pointed at this via `MYNE_GUARD_ROOT` rather than at the real
 * repository, so a fixture is invisible to every OTHER spec scanning `src/` in
 * a parallel worker. Writing into the real tree instead produced intermittent
 * failures in two unrelated guard specs, roughly one run in six.
 *
 * Every shared root has to exist or the guard refuses to walk a partial tree —
 * which is itself correct behaviour, and is why they are all created empty.
 */
function scratchTree(body: string): string {
  const dir: string = mkdtempSync(join(tmpdir(), "guard-fixture-"));
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

afterEach(() => {
  if (scratch !== null) rmSync(scratch, { recursive: true, force: true });
  scratch = null;
});

describe("the ratchet catches a new hand-rolled control", () => {
  it("fails on a raw <button>", () => {
    fixture("export function P() {\n  return <button onClick={() => {}}>hi</button>;\n}\n");
    const { code, out } = run();
    expect(code).toBe(1);
    expect(out).toContain("__primitive_fixture__");
  });

  it("fails on a raw <select>", () => {
    fixture('export function P() {\n  return <select><option value="a">a</option></select>;\n}\n');
    expect(run().out).toContain("__primitive_fixture__");
  });

  it("fails on a text <input>, which `Input` covers", () => {
    fixture('export function P() {\n  return <input type="text" />;\n}\n');
    expect(run().out).toContain("__primitive_fixture__");
  });
});

describe("what it deliberately does not count", () => {
  it("ignores a control already on the shared sheet", () => {
    // `myne-` means migrated. Counting it would make the number go UP as the
    // conversion progresses, which is the opposite of a ratchet.
    fixture(
      'export function P() {\n  return <button className="myne-btn" data-variant="primary">hi</button>;\n}\n',
    );
    expect(run().out).not.toContain("__primitive_fixture__");
  });

  it("ignores input types no primitive covers", () => {
    // `Input` is a text field. Pointing it at a checkbox or a file picker would
    // be the wrong component, so demanding it here would push people to a worse
    // answer than the one they have.
    for (const t of ["checkbox", "radio", "range", "color", "file"]) {
      fixture(`export function P() {\n  return <input type="${t}" />;\n}\n`);
      expect(run().out, `type=${t} must not be counted`).not.toContain(
        "__primitive_fixture__",
      );
    }
  });

  it("ignores a tag SPELLED inside a description, because that is prose about it", () => {
    // The story catalogue describes the switch as "a `<button role=switch
    // aria-checked>`". Counting that fired this ratchet on a CORRECT file
    // (measured 2026-10-19), and a guard that fires on a correct file is a guard
    // people learn to route around.
    fixture(
      'export const s = { description: "It is a `<button role=switch aria-checked>`." };\n',
    );
    expect(run().out).not.toContain("__primitive_fixture__");
  });

  it("still counts a real control on the SAME line as such prose", () => {
    // The non-vacuity belt under the case above: blanking a literal stops at its
    // closing delimiter, so it cannot swallow the element that follows it. Without
    // this, "the scanner stopped reporting" would be indistinguishable from "the
    // scanner stopped looking".
    fixture(
      'export function P() { const d = "a `<button>`"; return <button onClick={() => {}}>{d}</button>; }\n',
    );
    expect(run().out).toContain("__primitive_fixture__");
  });

  it("is brace-aware, so a style expression cannot hide a later attribute", () => {
    // `style={{ ... }}` contains `>` inside the expression. A scanner that
    // stopped at the first `>` would truncate the tag and miss the className
    // that follows — which is most of how this codebase writes a button.
    fixture(
      "export function P() {\n" +
        '  return <button style={{ width: 2 > 1 ? 10 : 20 }} className="myne-btn">hi</button>;\n' +
        "}\n",
    );
    expect(
      run().out,
      "the myne- class after a style expression must still register",
    ).not.toContain("__primitive_fixture__");
  });
});

describe("the tree as it stands", () => {
  it("names no fixture when none is present", () => {
    expect(run().out).not.toContain("__primitive_fixture__");
  });
});
