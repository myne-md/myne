// The submenu half of `scripts/check-e2e-menu-testids.mjs`, verified the way
// this repo says a guard is verified: by injecting the exact defect it claims
// to catch, and by proving it still catches what it caught BEFORE.
//
// The asymmetry this closes was a review finding on the change that added the
// rule. `check-frontend-lock-teardown.mjs` was edited in the same commit and got
// a per-call, per-path injection suite; this guard got a new rule and nothing,
// so it rested on nobody having watched it fire.

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const ROOT = new URL("../..", import.meta.url).pathname;
const GUARD = join(ROOT, "scripts", "check-e2e-menu-testids.mjs");

let probe: string | null = null;
let scratch: string | null = null;
afterEach(() => {
  if (probe !== null) rmSync(probe, { force: true });
  probe = null;
  if (scratch !== null) rmSync(scratch, { recursive: true, force: true });
  scratch = null;
});

/** Write one scenario file into a THROWAWAY tree and run the guard over it.
 *
 *  This used to write into the real `e2e/` directory, arguing that the guard
 *  walks that tree by construction so a fixture directory would test a walk it
 *  never performs. The argument was right about the walk and wrong about the
 *  cost: a `e2e/*.e2e.ts` file is one of `scripts/check-manual-test-roster.mjs`'s
 *  six denominators, so for as long as the probe existed, any concurrently
 *  scheduled test running THAT guard saw a scenario no roster entry claims and
 *  failed. Vitest runs files in parallel workers, so `pnpm test` went red on a
 *  pairing nobody chose (myne-md/myne#242).
 *
 *  `--scan <dir>` resolves it without weakening anything: the walk is the same
 *  code over the same shape, it just starts in a directory only this test can
 *  see. Same seam as `check-twin-inventory.mjs --roots`. */
function runWith(
  body: string,
  extraArgs: readonly string[] = [],
): { code: number; out: string } {
  scratch = mkdtempSync(join(tmpdir(), "e2e-menu-testids-"));
  mkdirSync(join(scratch, "e2e"), { recursive: true });
  probe = join(scratch, "e2e", "_guard-probe.e2e.ts");
  writeFileSync(probe, body, "utf8");
  try {
    const out = execFileSync("node", [GUARD, "--scan", scratch, ...extraArgs], {
      encoding: "utf8",
      cwd: ROOT,
    });
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
    //
    // Driven through `--menu-only`, because the production roster is EMPTY: the
    // three create actions are direct icon buttons again, so rule 1 has no
    // subjects. Asserting against the empty roster would test that nothing
    // happens and the injection would PASS — the vacuous shape this repo keeps
    // finding in its own tests. The seam keeps the rule's logic under test for
    // the whole period it has no subjects, so when the actions go behind a menu
    // a third time the machinery is known to work rather than hoped to.
    const r = runWith('const X = testIdSelector("notes.create");\n', [
      "--menu-only",
      "notes.create",
    ]);
    expect(r.code).not.toBe(0);
    expect(r.out).toContain("clickNewItem");
  });

  it("is clean on the tree as it stands", () => {
    const out = execFileSync("node", [GUARD], { encoding: "utf8", cwd: ROOT });
    expect(out).toContain("ok");
  });
});
