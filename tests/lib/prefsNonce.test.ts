// The prefs-nonce guard's MATCHER, over the shapes TypeScript accepts (#387).
//
// The rule the guard states is "a `plugin:prefs|` write literal must sit as
// `writePref`'s first argument". The rule it enforced was narrower: it required
// `invoke<T>("…")` — a mandatory generic and a double quote. `invoke`'s type
// parameter defaults to `unknown`, so four of the five shapes a developer
// actually types passed silently:
//
//   invoke("plugin:prefs|set_ai_enabled", …)       ← no generic
//   invoke(`plugin:prefs|set_ai_enabled`, …)       ← backticks
//   invoke('plugin:prefs|set_ai_enabled', …)       ← single quotes
//   const cmd = "plugin:prefs|set_ai_enabled";     ← hoisted
//
// What the user loses when one gets through is not abstract: the nonce bump is
// the ONLY mechanism by which sibling `usePrefs` instances re-read, so a setting
// they just toggled keeps its old value in the open editor for the rest of the
// session — and `setFavorites` additionally writes and SYNCS the stale
// optimistic state.
//
// This imports the guard's own `analyse()` rather than restating the rule, for
// the reason `tests/web/command-coverage.test.ts` gives: a spec that
// reimplemented the scan could pass while the script failed, or agree with a bug.

import { describe, expect, it } from "vitest";
// A .mjs guard script with no type declarations; the import is the point (see
// the header), not the typing, so every symbol is re-typed below.
import {
  analyse as analyseUntyped,
  PREFS_MODULES as PREFS_MODULES_UNTYPED,
  SCANNED_TREES as SCANNED_TREES_UNTYPED,
  WRITE_PREF_BINDING as WRITE_PREF_BINDING_UNTYPED,
} from "../../scripts/check-prefs-nonce.mjs";

const PREFS_MODULES = PREFS_MODULES_UNTYPED as string[];
const SCANNED_TREES = SCANNED_TREES_UNTYPED as string[];
const WRITE_PREF_BINDING = WRITE_PREF_BINDING_UNTYPED as RegExp;

/** Does rule 3's matcher see a binding in this source? */
function bindsWritePref(src: string): boolean {
  WRITE_PREF_BINDING.lastIndex = 0;
  return WRITE_PREF_BINDING.test(src);
}

/** The guard's return, named here because the script carries no declarations. */
interface PrefsReport {
  failures: { file: string; line: number; command: string; why: string }[];
  writes: number;
}
const analyse = analyseUntyped as (opts?: {
  prefsSource?: string;
  missingTrees?: string[];
}) => PrefsReport;

/** The five shapes, all of which type-check and all of which are violations. */
const EVASIONS = [
  'await invoke("plugin:prefs|set_ai_enabled", { enabled });',
  "await invoke(`plugin:prefs|set_ai_enabled`, { enabled });",
  "await invoke('plugin:prefs|set_ai_enabled', { enabled });",
  'const cmd = "plugin:prefs|set_ai_enabled";',
  'await invoke<void>("plugin:prefs|set_ai_enabled", { enabled });',
].join("\n");

/** A source the rule must accept, including the multi-line call shape. */
const LEGITIMATE = [
  'async function writePref() {}',
  'await writePref("plugin:prefs|set_ai_enabled", { enabled });',
  'await writePref(',
  '  "plugin:prefs|set_auto_lock_timeout",',
  "  { seconds },",
  ");",
  'return await invoke<PrefsView>("plugin:prefs|prefs_read");',
].join("\n");

describe("the prefs-nonce guard", () => {
  it("is green on the real tree, over a non-trivial number of writes", () => {
    // Non-vacuity first: an empty failure list means nothing if the scan found
    // no writes to begin with.
    const { failures, writes } = analyse();
    expect(writes).toBeGreaterThan(50);
    expect(failures).toEqual([]);
  });

  it("catches a prefs write in every shape TypeScript accepts", () => {
    const { failures } = analyse({ prefsSource: `async function writePref() {}\n${EVASIONS}` });
    expect(failures).toHaveLength(5);
    for (const f of failures) expect(f.command).toBe("set_ai_enabled");
  });

  it("accepts the GENERIC chokepoint and the generic call (myne-md/myne#613)", () => {
    // `writePref` became `writePref<T = void>` so the five set mutators can
    // return the budget refusal count. Both of this guard's `writePref`
    // matchers required a bare `(`, so the chokepoint read as MISSING and all
    // five set writes read as direct invokes: six failures, none of them real.
    // The fixture above declares the OLD shape, so it exercises neither arm.
    const generic = [
      "async function writePref<T = void>(",
      "  command: string,",
      ") {}",
      'await writePref<number>("plugin:prefs|set_deliberate_folders", { mutation });',
      'await writePref("plugin:prefs|set_ai_enabled", { enabled });',
    ].join("\n");
    expect(analyse({ prefsSource: generic }).failures).toEqual([]);
  });

  it("still catches a raw invoke beside a GENERIC chokepoint", () => {
    // The other direction, and the one nobody thinks to try: widening a matcher
    // must not stop it catching what it caught before. A guard that has stopped
    // checking is green by definition.
    const generic = [
      "async function writePref<T = void>(",
      "  command: string,",
      ") {}",
      ...EVASIONS.split("\n"),
    ].join("\n");
    const { failures } = analyse({ prefsSource: generic });
    expect(failures).toHaveLength(5);
    for (const f of failures) expect(f.command).toBe("set_ai_enabled");
  });

  it("accepts the chokepoint, including when the call spans lines", () => {
    // The multi-line arm is what pins the whole-file scan: a same-line-only
    // implementation of the fix reports the second literal as a violation.
    expect(analyse({ prefsSource: LEGITIMATE }).failures).toEqual([]);
  });

  it("has BOTH client trees in scope, in both of its rules", () => {
    // From the day mobile moved in-repo (2026-08-13) the guard was blind to a
    // whole client (myne-md/myne#486): `mobile/src` was in neither roster, so
    // `writes` counted the desktop module alone and every non-vacuity assertion
    // above passed anyway. Scope is therefore asserted directly rather than
    // inferred from a count, and BOTH rosters are named. Rule 1 reads
    // `PREFS_MODULES`, rule 2 reads `SCANNED_TREES`, and restoring only one
    // leaves the other silently blind: that one-line-away second blind spot is
    // the myne#411 lesson, where a guard fix closed one and opened another with
    // the tree green throughout.
    expect(PREFS_MODULES).toContain("src/lib/prefs.ts");
    expect(PREFS_MODULES).toContain("mobile/src/lib/prefs.ts");
    expect(SCANNED_TREES).toContain("src");
    expect(SCANNED_TREES).toContain("mobile/src");

    // Nothing here re-checks that each listed module HAS a chokepoint, on
    // purpose. `analyse()` already answers that per module (a missing one is a
    // `(none)` failure, a typo'd path throws ENOENT), and the first test above
    // asserts an empty failure list over the real tree. A second copy of
    // `/async function writePref\(/` living here is the "spec that reimplemented
    // the scan" shape this file's header opens by warning against.
  });

  it("still demands the chokepoint exist at all", () => {
    // Deleting `writePref` would make every rule above vacuously satisfiable.
    const { failures } = analyse({ prefsSource: "// no chokepoint here\n" });
    expect(failures).toHaveLength(1);
    expect(failures[0].command).toBe("(none)");
  });

  it("fails on a shared tree that is on the roster and not on disk", () => {
    // The narrowing this rule exists to catch: rule 2 walks `SCANNED_TREES`, so
    // a root that vanishes makes the scan cover less while the success line
    // still reads `ok`. Every shared root IS on disk, so the only way to watch
    // this fire is to inject the absent list, which is why `analyse` takes it.
    const { failures } = analyse({ missingTrees: ["ghost/src"] });
    const missing = failures.filter((f) => f.command === "(missing tree)");
    expect(missing).toHaveLength(1);
    expect(missing[0].file).toBe("ghost/src");
    expect(missing[0].why).toContain("scan one tree fewer");
  });


  // ---- rule 3: the chokepoint's name is not reused --------------------------
  //
  // Driven over the MATCHER rather than through `analyse`, for the reason the
  // guard's own docstring gives about rule 1: rule 3 reads real files off disk,
  // and the tree is clean, so the only way to watch it fire would be to write a
  // colliding declaration into the repo and delete it again. Both directions are
  // asserted, because a matcher that catches everything is as useless as one
  // that catches nothing.

  describe("rule 3's binding matcher", () => {
    it.each([
      ["const writePref = useCallback(", "the exact pre-myne#507 shape in usePrefs.ts"],
      ["async function writePref(", "the chokepoint's own spelling, in the wrong file"],
      ["function writePref(", "a plain declaration"],
      ["let writePref = (", "a reassignable binding"],
      ["var writePref = function (", "the old spelling"],
      ["const o = { writePref: async (", "a method on an object literal"],
      ["const o = { writePref: function (", "the same, spelled out"],
    ])("catches %s", (src) => {
      expect(bindsWritePref(src)).toBe(true);
    });

    it.each([
      ["const writeOptimisticPref = useCallback(", "myne#507's rename"],
      ["const writeDraftPref = useCallback(", "myne#496's rename on the mobile side"],
      ["const writePrefs = useCallback(", "a different name that merely starts the same"],
      ["await writePref({ a: 1 });", "a CALL, which is what a legitimate consumer does"],
      ["import { writePref } from './prefs';", "an import, which declares nothing new"],
    ])("does not catch %s", (src) => {
      expect(bindsWritePref(src)).toBe(false);
    });

  });
});
