// Process-level tests for `scripts/check-duplication.mjs` (myne-md/myne#48).
//
// `duplication.test.ts` imports the pure exports (`buildRecord`, `checkGroups`, …)
// and never spawns the script, so the clean-checkout skip arm and the missing/
// stale report fall-through are never exercised by a test. This file spawns the
// real script in a sandboxed copy of the tree instead.
//
// The script derives ROOT from its own location and reads `docs/` and the source
// roots relative to that root, so copying the script, its `lib/` helper, the
// real `duplication-groups.json` record and the source roots into a temp tree
// gives a self-contained checkout whose `docs/dev/` we can add or omit at will.
// The real sources are what make the closure-name staleness check pass on a
// green tree; an empty tree would fail it for the wrong reason.

import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const ROOT = new URL("../../", import.meta.url).pathname;
const SCRIPTS = join(ROOT, "scripts");
const ROOTS = [
  "src", "core/src", "protocol/src", "editor/src", "dialect/src",
  "client-core/src", "web/src", "mobile/src", "src-tauri/src", "cli/src", "mcp/src",
];

interface Sandbox {
  dir: string;
}

function makeSandbox(opts: { docsDev: boolean; report: boolean; reportBody?: string }): Sandbox {
  const dir = mkdtempSync(join(tmpdir(), "dup-cli-"));
  // scripts/ (includes check-duplication.mjs, lib/, duplication-groups.json)
  cpSync(SCRIPTS, join(dir, "scripts"), { recursive: true });
  // source roots, so the closure-name check sees the same names as the real tree
  for (const sub of ROOTS) {
    const src = join(ROOT, sub);
    if (existsSync(src)) cpSync(src, join(dir, sub), { recursive: true });
  }
  if (opts.docsDev) {
    mkdirSync(join(dir, "docs", "dev"), { recursive: true });
    if (opts.report) {
      writeFileSync(
        join(dir, "docs", "dev", "duplication.md"),
        opts.reportBody ?? "stale content that does not match\n",
      );
    }
  }
  return { dir };
}

function run(dir: string): { code: number; out: string } {
  try {
    return {
      code: 0,
      out: execFileSync("node", [join(dir, "scripts", "check-duplication.mjs")], {
        cwd: dir,
        encoding: "utf8",
      }),
    };
  } catch (e) {
    const err = e as { status: number; stdout: string; stderr: string };
    return { code: err.status, out: `${err.stdout}${err.stderr}` };
  }
}

function cleanup(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
}

describe("check-duplication.mjs process-level (clean-checkout arms)", () => {
  it("exits 0 and prints the skip note when docs/dev is absent", () => {
    const { dir } = makeSandbox({ docsDev: false, report: false });
    try {
      const r = run(dir);
      expect(r.code).toBe(0);
      expect(r.out).toContain("the report this gate compares against is not in this checkout");
    } finally {
      cleanup(dir);
    }
  });

  it("exits non-zero when docs/dev exists but duplication.md is missing", () => {
    const { dir } = makeSandbox({ docsDev: true, report: false });
    try {
      const r = run(dir);
      expect(r.code).not.toBe(0);
      expect(r.out).toContain("duplication.md is stale");
    } finally {
      cleanup(dir);
    }
  });

  it("exits non-zero when docs/dev/duplication.md is stale", () => {
    const { dir } = makeSandbox({ docsDev: true, report: true, reportBody: "stale content\n" });
    try {
      const r = run(dir);
      expect(r.code).not.toBe(0);
      expect(r.out).toContain("duplication.md is stale");
    } finally {
      cleanup(dir);
    }
  });
});
