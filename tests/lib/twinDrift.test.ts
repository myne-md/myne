// The twin-drift warner (#261).
//
// A fix that lands on one client and never reaches its counterpart persists for
// months because BOTH trees stay green — `src/App.tsx`'s post-delete routing vs
// `mobile/src/lib/stage.ts` went seven months out of step. Nothing said the
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

// The mobile tree is IN-REPO (decisions.md 2026-08-13), so this is an assertion
// rather than a condition. It used to be `existsSync("myne-mobile/src")` guarding
// three `if (!HAS_COMPANION) return` early exits — which on the runner, where the
// companion was never cloned, silently reduced this file to one trivial test
// while reporting four green. That is the same silent-skip shape the guard under
// test exists to catch.

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
    const { out } = run(["src/notes/sidebarState.tsx"]);
    expect(out).toContain("mobile/src/app/flows/EditorFlow.tsx");
    expect(out).toContain("Twin:");
  });

  it("says nothing when BOTH sides of a pair changed", () => {
    const { out } = run([
      "src-tauri/src/hooks.rs",
      "mobile/src-tauri/src/hooks.rs",
    ]);
    expect(out).not.toContain("⚠ twin: src-tauri/src/hooks.rs");
  });

  it("reads the working tree's changed files and still exits 0", () => {
    // With no arguments it asks git what changed. Whatever it finds, the answer
    // is a report and never a failure.
    const { status } = run([]);
    expect(status).toBe(0);
  });

  it("fails loudly if the mobile tree is missing, rather than finding no twins", () => {
    // The in-repo replacement for the old skip: an absent `mobile/` is a broken
    // checkout now, and the one answer that must never come back is a quiet
    // "no twins found".
    expect(existsSync("mobile/src")).toBe(true);
  });
});
