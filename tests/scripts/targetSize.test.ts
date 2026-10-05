// The pointer-target floor guard (myne-md/myne#775, WCAG 2.2 AA SC 2.5.8).
//
// The cases that matter most are the three it must NOT flag. A target-size
// rule that over-reaches gets exemptions written reflexively, and a reflexive
// exemption list measures nothing — so the criterion's own carve-outs are
// tested as carefully as the violation is.

import { afterEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { SHARED_ROOTS } from "../../scripts/lib/shared-roots.mjs";

const ROOT: string = fileURLToPath(new URL("../..", import.meta.url));
const FIXTURE_NAME = "__target_fixture__.tsx";
let scratch: string | null = null;

/** A throwaway tree, so a fixture is invisible to every other spec. */
function fixture(body: string): void {
  if (scratch !== null) rmSync(scratch, { recursive: true, force: true });
  scratch = mkdtempSync(join(tmpdir(), "target-fixture-"));
  for (const root of SHARED_ROOTS) {
    mkdirSync(join(scratch, root), { recursive: true });
  }
  mkdirSync(join(scratch, "src", "components"), { recursive: true });
  writeFileSync(join(scratch, "src", "components", FIXTURE_NAME), body, "utf8");
}

function run(): { code: number; out: string } {
  try {
    const out: string = execFileSync("node", ["scripts/check-target-size.mjs"], {
      cwd: ROOT,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env: scratch === null ? process.env : { ...process.env, MYNE_GUARD_ROOT: scratch },
    });
    return { code: 0, out };
  } catch (e) {
    const err = e as { status?: number; stderr?: string; stdout?: string };
    return { code: err.status ?? 1, out: `${err.stdout ?? ""}${err.stderr ?? ""}` };
  }
}

afterEach(() => {
  if (scratch !== null) rmSync(scratch, { recursive: true, force: true });
  scratch = null;
});

describe("a control under the floor fails", () => {
  it("flags an 18px button", () => {
    fixture("export function T() { return <button style={{ width: 18, height: 18 }}>x</button>; }\n");
    const { code, out } = run();
    expect(code).toBe(1);
    expect(out).toContain(FIXTURE_NAME);
  });

  it("flags a control that follows a CLOSED label", () => {
    // The label-wrap carve-out is a BALANCE, not "a label appears earlier in
    // the file". Getting this wrong would exempt every control below the first
    // label on a screen — which is most of a settings panel.
    fixture(
      "export function T() {\n" +
        "  return (\n    <div>\n      <label><span>x</span></label>\n" +
        '      <input type="checkbox" style={{ width: 18, height: 18 }} />\n' +
        "    </div>\n  );\n}\n",
    );
    expect(run().code).toBe(1);
  });
});

describe("the criterion's own carve-outs are respected", () => {
  it("accepts a control spreading MIN_TARGET", () => {
    fixture(
      'import { MIN_TARGET } from "./primitives/targetSize";\n' +
        "export function T() { return <button style={{ ...MIN_TARGET, width: 18 }}>x</button>; }\n",
    );
    expect(run().code).toBe(0);
  });

  it("accepts a small checkbox WRAPPED in a label", () => {
    // The effective pointer target is the label row, which is what activates
    // the control. This is the criterion's text rather than a loophole — and it
    // is the one real instance in the tree, on mobile's recovery-phrase
    // acknowledgement.
    fixture(
      "export function T() {\n  return (\n    <label>\n" +
        '      <input type="checkbox" style={{ width: 18, height: 18 }} />\n' +
        "      <span>Agree</span>\n    </label>\n  );\n}\n",
    );
    expect(run().code).toBe(0);
  });

  it("accepts an inline sentence link", () => {
    // SC 2.5.8 exempts an inline target: enlarging it would break the line it
    // sits in.
    fixture('export function T() { return <p>see <a href="#x">this</a> please</p>; }\n');
    expect(run().code).toBe(0);
  });
});

describe("the tree as it stands", () => {
  it("is clean — #728's remediation held", () => {
    expect(run().code).toBe(0);
  });
});
