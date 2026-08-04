// The no-test-hooks guard, over this project's OWN global namespace (#387).
//
// The guard is the repo's only artefact-level control on the TB11 delivery
// channel — it reads the bytes that will actually be served. Its pattern for
// this project's globals was `window.__myne`, a spelling that appears nowhere in
// the tree except that line, while three `globalThis.__myne*` Worker↔wasm
// bridges ship. In a page context `globalThis === window`, so the host object
// was never the discriminator; what the pattern actually required was the
// literal text `window.` and no suffix. A diagnostic hook written in the
// codebase's own idiom would have passed.
//
// Drives the SCRIPT rather than importing it, in the shape `tests/lib/twinDrift.test.ts`
// uses and for its stated reason: a spec that reads only stdout passes against a
// script that stopped reporting. Both merged output AND exit status are asserted.

import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";

/** Run the guard over a fixture directory; return its merged output + status. */
function run(root: string): { out: string; status: number } {
  try {
    const out = execFileSync(
      "bash",
      ["-c", `node scripts/check-web-no-test-hooks.mjs ${root} 2>&1`],
      { encoding: "utf8" },
    );
    return { out, status: 0 };
  } catch (e) {
    const err = e as { stdout?: string; status?: number };
    return { out: err.stdout ?? "", status: err.status ?? -1 };
  }
}

describe("check-web-no-test-hooks", () => {
  it("passes the three real Worker host bridges", () => {
    // They are IO seams the wasm module resolves by exact namespace — and each
    // is exactly the shape a hook would take, which is why they are NAMED in
    // the guard's allowlist rather than inferred from a shape.
    const { out, status } = run("tests/fixtures/web-hooks/allowed");
    expect(status).toBe(0);
    expect(out).toContain("ok");
  });

  it("refuses an unnamed __myne* global, and says which name", () => {
    const { out, status } = run("tests/fixtures/web-hooks/forbidden");
    expect(status).toBe(1);
    // Assert on the IDENTIFIERS, not merely on the status: four other patterns
    // can also exit 1, so a status-only assertion could pass for the wrong
    // reason. The fixture is kept free of those four for the same purpose.
    expect(out).toContain("__myneDebug");
    expect(out).toContain("__myneOpfsDebug");
  });

  it("still passes the real bundle", () => {
    // Non-vacuity, and the thing that would break if the allowlist drifted from
    // the bridges the wasm module actually installs. Skipped when the bundle is
    // absent — this needs `pnpm web:build`, which is why the guard lives in the
    // CI web lane rather than in a pre-commit hook.
    if (!existsSync("web/dist")) return;
    const { out, status } = run("web/dist");
    expect(status).toBe(0);
    expect(out).toContain("ok");
  });
});
