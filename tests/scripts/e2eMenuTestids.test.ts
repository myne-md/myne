// The submenu half of `scripts/check-e2e-menu-testids.mjs`, verified the way
// this repo says a guard is verified: by injecting the exact defect it claims
// to catch, and by proving it still catches what it caught BEFORE.
//
// The asymmetry this closes was a review finding on the change that added the
// rule. `check-frontend-lock-teardown.mjs` was edited in the same commit and got
// a per-call, per-path injection suite; this guard got a new rule and nothing,
// so it rested on nobody having watched it fire.

import { execFileSync } from "node:child_process";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const ROOT = new URL("../..", import.meta.url).pathname;
const GUARD = join(ROOT, "scripts", "check-e2e-menu-testids.mjs");

let probe: string | null = null;
afterEach(() => {
  if (probe !== null) rmSync(probe, { force: true });
  probe = null;
});

/** Write one scenario file into the real `e2e/` tree and run the guard over it.
 *  The guard walks that tree by construction, so a fixture directory would test
 *  a walk the guard never performs. */
function runWith(body: string): { code: number; out: string } {
  probe = join(ROOT, "e2e", "_guard-probe.e2e.ts");
  writeFileSync(probe, body, "utf8");
  try {
    const out = execFileSync("node", [GUARD], { encoding: "utf8", cwd: ROOT });
    return { code: 0, out };
  } catch (e) {
    const err = e as { status: number; stdout: string; stderr: string };
    return { code: err.status, out: `${err.stdout}${err.stderr}` };
  }
}

describe("check-e2e-menu-testids, the submenu rule", () => {
  it("names a scenario reaching an export leaf by data-item-id", () => {
    const r = runWith(
      'const X = testIdSelector("notes.context-menu-item", { "data-item-id": "export-markdown" });\n',
    );
    expect(r.code).not.toBe(0);
    expect(r.out).toContain("export-markdown");
    expect(r.out).toContain("openExportSubmenuItem");
  });

  it("names one reaching it by data-action, which is the other menu's discriminator", () => {
    const r = runWith(
      'const X = testIdSelector("editor.note-actions-menu-item", { "data-action": "export-pdf" });\n',
    );
    expect(r.code).not.toBe(0);
    expect(r.out).toContain("export-pdf");
  });

  it("passes once the file knows about the helper", () => {
    // The rule is FILE-scoped, and this is the half that makes that safe: a file
    // that mentions the helper is sanctioned, so the five rewritten scenarios
    // and the helper's own definition do not trip it.
    const r = runWith(
      'import { openExportSubmenuItem } from "./support/flows";\n' +
        'const X = testIdSelector("notes.context-menu-item", { "data-item-id": "export-markdown" });\n' +
        "void openExportSubmenuItem;\n",
    );
    expect(r.code).toBe(0);
  });

  it("still catches what it caught before, the `+` menu rule", () => {
    // The other direction, which myne-md/myne#411 records as the one nobody
    // thinks to try: closing one blind spot while opening another.
    const r = runWith('const X = testIdSelector("notes.create");\n');
    expect(r.code).not.toBe(0);
    expect(r.out).toContain("clickNewMenuItem");
  });

  it("is clean on the tree as it stands", () => {
    const out = execFileSync("node", [GUARD], { encoding: "utf8", cwd: ROOT });
    expect(out).toContain("ok");
  });
});
