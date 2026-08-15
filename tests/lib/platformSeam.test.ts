// The platform-seam guard, over the bypass that is not a module specifier (#387).
//
// The guard is anchored on `from`/`import`/`require` plus a quoted
// `@tauri-apps/*` specifier. `(window as any).__TAURI_INTERNALS__.invoke(…)`
// reaches the same IPC and matches none of that — and the shape is documented,
// blessed and working one tree over (`e2e/support/flows.ts`'s `pageSeatInvoke`),
// which puts it one copy-paste from a module under `src/`.
//
// What the seam buys, and what such a call site drops out of: on web the seam
// answers a typed `PlatformUnsupportedError` that `tests/platform/seam-contract.ts`
// holds every implementation to. A runtime-global call answers a `TypeError` on
// `undefined.invoke` instead, while `check-web-capabilities.mjs` keeps reporting
// ok — the failure is invisible to the audit built to catch exactly it.
//
// ── why this injects a root roster ──────────────────────────────────────────
//
// A fixture under `tests/` is outside every `GUARDED` root, so `guardFor`
// returns undefined and the file is SKIPPED. Verified: running the script
// against a fixture holding a bare `@tauri-apps/api/core` import prints
// `platform-seam: ok` and exits 0. A spec that shelled out to the script with a
// fixture path would therefore be green with and without the rules under test —
// the wrong-reason pass this repo warns about repeatedly. Injecting the roster
// is what makes these assertions able to fail.

import { describe, expect, it } from "vitest";
// @ts-expect-error — a plain .mjs guard script with no type declarations; it is
// deliberately dependency-free and lives outside `tsconfig`'s `include`.
import { analyse as analyseUntyped } from "../../scripts/check-platform-seam.mjs";

/** The guard's return, named here because the script carries no declarations. */
interface SeamReport {
  violations: { file: string; line: number; spec: string }[];
  globalViolations: { file: string; line: number }[];
  wasmViolations: { file: string; line: number; spec: string }[];
  checked: number;
}
const analyse = analyseUntyped as (
  files?: string[] | null,
  roots?: { root: string; seam: string | null }[],
) => SeamReport;

/** The fixture tree, as its own guarded root with no exempt seam directory. */
const FIXTURE_ROOTS = [{ root: "tests/fixtures/seam", seam: null }];

describe("check-platform-seam", () => {
  it("is green on the real tree, over a non-trivial number of files", () => {
    // Non-vacuity: an empty violation list means nothing if nothing was read.
    // `checked` counts files actually inside a guarded root — the old success
    // line printed the candidate count, which included files it had skipped.
    const r = analyse();
    expect(r.checked).toBeGreaterThan(500);
    expect(r.violations).toEqual([]);
    expect(r.globalViolations).toEqual([]);
    expect(r.wasmViolations).toEqual([]);
  });

  it("sees the Tauri runtime global, which carries no module specifier", () => {
    const r = analyse(["tests/fixtures/seam/tauri-global.ts"], FIXTURE_ROOTS);
    // Both spellings the runtime injects are in the fixture, each on its own
    // lines; what matters is that they are seen at all, and that the
    // module-specifier rule stays silent about them.
    expect(r.globalViolations.length).toBeGreaterThanOrEqual(2);
    for (const v of r.globalViolations) expect(v.file).toContain("tauri-global.ts");
    expect(r.violations).toEqual([]);
  });

  it("leaves the boot probe alone — the one honest use of the global", () => {
    // `src/lib/app-window.ts` asks whether a host EXISTS; it does not call one,
    // and no seam module could answer without itself importing Tauri. Asserted
    // on that single file rather than relying on the whole-tree pass, so it
    // stays a pin on the exemption specifically.
    expect(analyse(["src/lib/app-window.ts"]).globalViolations).toEqual([]);
    // The mobile twin, which carries the same probe plus the call-time
    // `hasTauriHost()` two of its callers need (myne#492).
    expect(analyse(["mobile/src/lib/app-window.ts"]).globalViolations).toEqual([]);
  });

  // ── the roots are IN scope, asserted per root ──────────────────────────────
  //
  // The whole-tree pass above cannot see a missing root: `guardFor` returns
  // undefined for a file outside every `GUARDED` entry, the file is skipped, and
  // the run reports ok. That is precisely how `mobile/src` accumulated 41 direct
  // `@tauri-apps/*` imports with the guard green (myne#492), so each root gets a
  // pin that fails if it silently drops out.
  //
  // `checked` is the assertion, not `violations`: an empty violation list is
  // what BOTH "the file is clean" and "the file was never read" look like.
  it.each([
    ["mobile/src", "mobile/src/lib/vault-status.ts"],
    ["web/src", "web/src/platform/core.ts"],
    ["src", "src/lib/vault-status.ts"],
    ["editor", "editor/src/host.ts"],
  ])("scans %s", (_root, file) => {
    expect(analyse([file]).checked).toBe(1);
  });

  it("exempts the mobile seam directory, and only that directory", () => {
    // `mobile/src/platform/core.ts` IS the seam and imports Tauri by definition,
    // so it must be skipped (`checked === 0`) rather than merely clean. Its
    // sibling tree is not: the same call one directory over is a violation.
    expect(analyse(["mobile/src/platform/core.ts"]).checked).toBe(0);
    expect(analyse(["mobile/src/lib/vault-status.ts"]).checked).toBe(1);
  });

  it("still catches a module-specifier import, and not a mention in prose", () => {
    const r = analyse(["tests/fixtures/seam/tauri-import.ts"], FIXTURE_ROOTS);
    // One import, not two: the rule is quote-anchored, so the package name in
    // the fixture's comment reads as text.
    expect(r.violations).toHaveLength(1);
    expect(r.violations[0].spec).toBe("@tauri-apps/api/core");
    expect(r.globalViolations).toEqual([]);
  });
});
