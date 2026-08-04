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
// @ts-expect-error — a .mjs guard script with no type declarations; the import
// is the point (see the header), not the typing.
import { analyse as analyseUntyped } from "../../scripts/check-prefs-nonce.mjs";

/** The guard's return, named here because the script carries no declarations. */
interface PrefsReport {
  failures: { file: string; line: number; command: string; why: string }[];
  writes: number;
}
const analyse = analyseUntyped as (opts?: { prefsSource?: string }) => PrefsReport;

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

  it("accepts the chokepoint, including when the call spans lines", () => {
    // The multi-line arm is what pins the whole-file scan: a same-line-only
    // implementation of the fix reports the second literal as a violation.
    expect(analyse({ prefsSource: LEGITIMATE }).failures).toEqual([]);
  });

  it("still demands the chokepoint exist at all", () => {
    // Deleting `writePref` would make every rule above vacuously satisfiable.
    const { failures } = analyse({ prefsSource: "// no chokepoint here\n" });
    expect(failures).toHaveLength(1);
    expect(failures[0].command).toBe("(none)");
  });
});
