// When an automatic tag write may happen (myne-md/myne#908).
//
// The pass re-fires on every content change, so the eligibility rule is what
// keeps automatic tagging from turning a note into tag confetti. Extracted as a
// pure function because the rule is the whole safety story: a version inlined in
// the pane could drop a term and every other test would stay green while notes
// grew tags on their own.

export interface AutoApplyInput {
  /** The device-local automatic-writing flag. */
  readonly enabled: boolean;
  /** The suggestion switch and the host capability, already ANDed. */
  readonly passEnabled: boolean;
  /** The pass has at least one candidate to write. */
  readonly hasSuggestions: boolean;
  /** The user edited THIS note in this session. Opening a note to read it is
   *  not an edit, and must never rewrite it. */
  readonly editedThisSession: boolean;
  /** This note has already had its one automatic write this session. */
  readonly alreadyApplied: boolean;
  /** A read-only view offers a write it cannot perform. */
  readonly readOnly: boolean;
}

/** True when the pass may write into the open note. */
export function shouldAutoApply(input: AutoApplyInput): boolean {
  if (!input.enabled || !input.passEnabled) return false;
  if (!input.hasSuggestions) return false;
  if (input.readOnly) return false;
  if (input.alreadyApplied) return false;
  return input.editedThisSession;
}
