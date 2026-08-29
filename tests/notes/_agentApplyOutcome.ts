// The clean `AgentApplyResult`, in one place (myne-md/myne#596).
//
// Three test files needed the same six-field literal (one edit applied to
// `n1`, nothing refused, one restore point), and each had written its own copy
// under a different name (`applyOutcome`, `outcome`, `CLEAN`). The `over` slot
// is what the copies lacked: every refusal case in those files spelled out a
// full spread to change two fields.
//
// A `_`-prefixed module rather than an export from a `.test.ts`, per the house
// convention (`tests/components/_clickAndFlush.ts`, `tests/lib/_themeLink.ts`
// and eight more): a helper imported from a spec file drags that spec's
// `describe` blocks into whatever imports it.

import type { AgentApplyResult } from "../../src/lib/agent-run";

/** A clean apply of one edit to `n1`, with the fields worth varying overridable.
 *
 *  Defaults to the shape every caller wanted: `applied: 1`, both refusal lists
 *  empty, one note written, one restore point, nothing created. Pass `over` for
 *  a refusal case rather than spreading the result by hand. The point of the
 *  slot is that the DEFAULT stays the one definition of "clean". */
export function applyOutcome(
  over: Partial<AgentApplyResult> = {},
): AgentApplyResult {
  return {
    applied: 1,
    refused: [],
    refusedNewNotes: [],
    notesWritten: ["n1"],
    notesCreated: [],
    restorePoints: [["n1", "s1"]],
    ...over,
  };
}
