// The accessibility level of a story, and the verdict the level produces
// (myne-md/myne#845).
//
// The panel in the catalogue is a VIEW; this module is the half that decides
// whether something FAILS. Keeping the decision here rather than inside the
// spec is what makes it testable without mounting anything: the spec drives
// `a11yVerdict` directly to prove the `error` arm rejects a violation, and then
// runs the real axe pass over every story.
//
// The three levels and the reason the default is `error` rather than `todo` are
// in `A11yLevel` (`./types.ts`). The short version: the gate starts WIDE because
// the tree could meet it (197 of 206 measured stories were clean on the first
// run), and a default of `error` is what keeps a story added tomorrow from
// silently inheriting debt.

import type { A11yLevel } from "./types";

/** Every level, in the order the panel shows them. */
export const A11Y_LEVELS = ["error", "todo", "off"] as const satisfies readonly A11yLevel[];

/**
 * The level a story that declares none gets.
 *
 * `error`, not `todo`, because the tree can meet it: 197 of 206 measured stories
 * were axe-clean the first time this gate ran, so the gate starts WIDE and the
 * nine that were not are recorded by name. That is the opposite trade from
 * `manual-test-ratchet`'s (which starts small and grows) and for a stated
 * reason: there the gate was 163 hours against one maintainer, here it is nine
 * one-line records. A default of `error` is also what makes this SUSTAINABLE:
 * a story added tomorrow is gated from birth rather than silently inheriting
 * debt nobody has to look at.
 */
export const DEFAULT_A11Y_LEVEL: A11yLevel = "error";

/** The minimum length of an `off` reason: enough to name a mechanism. */
export const A11Y_REASON_MIN = 12;

/** A story's declared level, or the default when it declares none. */
export function a11yLevelOf(story: { a11y?: A11yLevel }): A11yLevel {
  return story.a11y ?? DEFAULT_A11Y_LEVEL;
}

/** What the level plus axe's findings add up to. */
export type A11yVerdict = "pass" | "debt" | "fail";

/**
 * The one decision: given a level and the rule ids axe reported, does this story
 * pass, sit in recorded debt, or fail the build?
 *
 * `off` passes by construction. It means "do not measure here", and the reason
 * is checked separately. A story with no findings passes at every level. The
 * asymmetry that matters is the last line: only `error` fails.
 */
export function a11yVerdict(
  level: A11yLevel,
  violationRules: readonly string[],
): A11yVerdict {
  if (level === "off") return "pass";
  if (violationRules.length === 0) return "pass";
  return level === "error" ? "fail" : "debt";
}

/** An `off` story with no usable reason: the one invalid shape. */
export function invalidOffReason(story: {
  id: string;
  a11y?: A11yLevel;
  a11yReason?: string;
}): boolean {
  if (a11yLevelOf(story) !== "off") return false;
  return (story.a11yReason ?? "").trim().length < A11Y_REASON_MIN;
}
