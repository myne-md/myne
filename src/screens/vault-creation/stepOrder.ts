// The numbered steps of vault creation, in order, in ONE place.
//
// Why this file exists rather than a number in each step's catalog string
// (myne-md/myne#468): the eyebrows used to read `"Step 1 of 4: master password"`
// as a single translated string, so inserting the vault-name step renumbered
// four strings in thirty-two catalogs, and nothing in the tree compares a
// number against the flow. A locale left behind would say "Step 1 of 4" on the
// second of five screens — plausible, wrong, and invisible to every gate here,
// since `check-i18n.mjs` proves a key EXISTS and says nothing about what it
// claims. The number now comes from this array and the label is a separate key,
// so adding a step renumbers every locale at once and cannot drift.
//
// Only steps the user always walks are numbered. `briefing` is first-run only
// and `encrypting` / `provisioning` / `committing` are waits, not steps: a
// counter that includes a screen the user may never see is a promise about a
// length the flow does not have.

import type { Step } from "./reducer";

export const NUMBERED_STEPS = ["name", "password", "kit", "confirm"] as const;

export type NumberedStep = (typeof NUMBERED_STEPS)[number];

/**
 * One-based position and total for a numbered step.
 *
 * The parameter is `NumberedStep`, not `Step`, so passing `"briefing"` is a
 * compile error rather than an `indexOf` of -1 rendering "Step 0 of 4".
 */
export function stepPosition(step: NumberedStep): { n: number; total: number } {
  return {
    n: NUMBERED_STEPS.indexOf(step) + 1,
    total: NUMBERED_STEPS.length,
  };
}

/** Whether a reducer step carries a number. Widening guard for callers holding a `Step`. */
export function isNumberedStep(step: Step): step is NumberedStep {
  return (NUMBERED_STEPS as readonly string[]).includes(step);
}
