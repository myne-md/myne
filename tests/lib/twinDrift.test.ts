// The twin-drift warner (#261).
//
// A fix that lands on one client and never reaches its counterpart persists for
// months because BOTH trees stay green — `src/App.tsx`'s post-delete routing vs
// `myne-mobile/src/lib/stage.ts` went seven months out of step. Nothing said the
// module had a twin.
//
// The two properties worth pinning are what the script IS and what it is NOT: it
// names the untouched counterpart, and it never fails the build. A gate here
// would be wrong — most one-sided changes are legitimate (a desktop-only feature
// has no mobile twin) — and a gate that is wrong gets bypassed rather than
// heeded, which is how the tree ends up with a check nobody reads.

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";

const SCRIPT = "scripts/check-twin-drift.mjs";
const HAS_COMPANION = existsSync("myne-mobile/src");

function run(args: string[]): { status: number; out: string } {
  // The warnings go to STDERR (they are warnings), so both streams are merged
  // here — a test that read only stdout would pass against a script that had
  // stopped reporting anything at all.
  try {
    const out = execFileSync(
      "bash",
      ["-c", `node ${SCRIPT} ${args.map((a) => `'${a}'`).join(" ")} 2>&1`],
      { encoding: "utf8" },
    );
    return { status: 0, out };
  } catch (e) {
    const err = e as { status?: number; stdout?: string; stderr?: string };
    return { status: err.status ?? 1, out: `${err.stdout ?? ""}${err.stderr ?? ""}` };
  }
}

describe("check-twin-drift", () => {
  it("exits 0 even when it has something to say", () => {
    // The whole design: it reports, it never blocks. If this ever turns into a
    // gate, the one-sided changes it is meant to surface start getting
    // `--no-verify`d past it instead.
    const { status } = run(["src/notes/sidebarState.tsx"]);
    expect(status).toBe(0);
  });

  it("names the untouched counterpart of a curated pair", () => {
    if (!HAS_COMPANION) return; // the companion is not cloned in CI
    const { out } = run(["src/notes/sidebarState.tsx"]);
    expect(out).toContain("myne-mobile/src/app/flows/EditorFlow.tsx");
    expect(out).toContain("Twin:");
  });

  it("says nothing when BOTH sides of a pair changed", () => {
    if (!HAS_COMPANION) return;
    const { out } = run([
      "src-tauri/src/hooks.rs",
      "myne-mobile/src-tauri/src/hooks.rs",
    ]);
    expect(out).not.toContain("⚠ twin: src-tauri/src/hooks.rs");
  });

  it("skips itself rather than failing where the companion is absent", () => {
    // CI does not clone `myne-mobile`, so the honest answer there is "not
    // checked" — never a false all-clear and never a hard error.
    const { status } = run([]);
    expect(status).toBe(0);
  });
});
