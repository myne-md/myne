// The tooltip-convention guard (myne-md/myne#775).
//
// Verifying a guard means BREAKING it. Each case below writes a fixture into
// the real tree, runs the real script as a subprocess, and asserts the verdict —
// including the two cases it must NOT flag, which are where a guard like this
// usually goes wrong: over-reaching onto non-interactive `title`, and onto
// icon-only controls that ARE properly named.

// ── Why these assert on the fixture NAME, not the exit code ────────────────
// Both guard tests write a fixture into the real source tree and run the real
// script over it, and vitest parallelises across FILES. So while this spec's
// "must not flag" case is running, the sibling tooltip spec may have a raw
// `<button>` fixture on disk — which the sibling guard counts, quite correctly, and
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

const ROOT: string = fileURLToPath(new URL("../..", import.meta.url));
const FIXTURE_NAME = "__tooltip_fixture__.tsx";
let scratch: string | null = null;

/** Run the guard; return `{ code, out }`. */
function run(): { code: number; out: string } {
  try {
    const out: string = execFileSync(
      "node",
      ["scripts/check-tooltip-convention.mjs"],
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
  for (const root of [
    "src",
    "editor/src",
    "dialect/src",
    "copy/src",
    "client-core/src",
    "ornaments/src",
    "web/src",
    "mobile/src",
  ]) {
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

describe("the ratchet on native title", () => {
  it("fails when a new `title=` lands on a button", () => {
    fixture(
      'export function T() {\n  return <button title="hi" aria-label="hi">x</button>;\n}\n',
    );
    const out = run().out;
    expect(out).toContain("__tooltip_fixture__");
    expect(out).toContain("grew");
  });

  it("does NOT fire on a non-interactive element", () => {
    // The one thing `title` is still good for: the full value of truncated
    // text. Rule 1 is scoped to interactivity precisely so this survives, and a
    // guard that took it away would push people to delete useful information.
    fixture(
      'export function T() {\n  return <span title="the full value">short</span>;\n}\n',
    );
    expect(run().out).not.toContain("__tooltip_fixture__");
  });
});

describe("the hard rule on an unnamed icon-only control", () => {
  it("fails when a glyph-only button carries no accessible name", () => {
    // Announced as "button" and nothing else. WCAG 2.2 AA 4.1.2, which
    // PRODUCT.md commits to — a failure, not a ratchet.
    fixture(
      'import { Icon } from "./primitives/Icon";\n' +
        "export function T() {\n  return <button onClick={() => {}}><Icon name=\"x\" size={12} /></button>;\n}\n",
    );
    const out = run().out;
    expect(out).toContain("no-accessible-name");
    expect(out).toContain("__tooltip_fixture__");
  });

  it("passes when the same control carries aria-label", () => {
    fixture(
      'import { Icon } from "./primitives/Icon";\n' +
        'export function T() {\n  return <button aria-label="Close" onClick={() => {}}><Icon name="x" size={12} /></button>;\n}\n',
    );
    expect(run().out).not.toContain("__tooltip_fixture__");
  });

  it("passes when the button has TEXT beside the glyph", () => {
    // Not icon-only: the text node is the accessible name. Flagging this would
    // make the rule a nuisance on every labelled button in the app.
    fixture(
      'import { Icon } from "./primitives/Icon";\n' +
        'export function T() {\n  return <button onClick={() => {}}><Icon name="x" size={12} />Close</button>;\n}\n',
    );
    expect(run().out).not.toContain("__tooltip_fixture__");
  });
});

describe("the tree as it stands", () => {
  it("names no fixture when none is present", () => {
    expect(run().out).not.toContain("__tooltip_fixture__");
  });
});
