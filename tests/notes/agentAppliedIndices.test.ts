// A refused edit must not be marked applied (myne-md/myne#531 review round four).
//
// `AgentReview` sends a batch and then records what happened. It used to record
// the indices it SENT, and the host can refuse an edit at apply time: a moved
// anchor, an unreadable note, or a folder the user excluded while the review was
// open. Every one of those came back as a refusal AND was written into
// `appliedEdits`.
//
// That is not a cosmetic mislabel. `keptEdits` filters `appliedEdits` out of the
// actionable list, so a refused edit LEFT the screen and the user could not
// re-approve it, while the refusal list beside it said the edit had not landed.
// The two readings of the same row disagreed and the recoverable one lost.
//
// The subtraction is tested here rather than in the component because that is
// where it was missing: the store's contract was always "these landed", and the
// call site handed it the wrong list.

import { describe, expect, it } from "vitest";

import {
  landedEditIndices,
  landedSettingIndices,
} from "../../src/notes/agent/agentStore";
import type { ProposedSetting } from "../../src/lib/agent-protocol";

/** `apply.rs` defines a refusal's `index` as its position in the APPROVED list,
 *  so these are indices into `sent`, not into the proposal. */
function refusal(index: number) {
  return { noteId: "n", index, reason: "anchorNotFound" as const };
}

describe("landedEditIndices", () => {
  it("drops the edits the host refused, keeping their proposal positions straight", () => {
    // Proposal indices 4, 7 and 9 were approved. The host refused the SECOND of
    // them, which is `sent[1]` = 7. Mapping by position rather than by value is
    // the whole point: a refusal carries 1, not 7.
    const landed = landedEditIndices([4, 7, 9], { refused: [refusal(1)] });
    expect(landed).toEqual([4, 9]);
  });

  it("keeps every index when nothing was refused", () => {
    // The other direction, and the one an over-eager filter would break: a
    // healthy apply must still mark all of its edits applied, or they stay in
    // the kept list forever and the screen offers to apply them again.
    expect(landedEditIndices([4, 7, 9], { refused: [] })).toEqual([4, 7, 9]);
  });

  it("drops everything when the host refused everything", () => {
    const landed = landedEditIndices([4, 7], {
      refused: [refusal(0), refusal(1)],
    });
    expect(
      landed,
      "an apply whose every edit was refused applied nothing, so nothing may be marked applied",
    ).toEqual([]);
  });

  it("is not confused by a refusal index that collides with a proposal index", () => {
    // The failure the by-value version would have: sent = [0, 1] and a refusal
    // at index 1 means proposal index 1 was refused, which by coincidence equals
    // the refusal's own index. A version that filtered on `r.index` directly
    // rather than on `sent[r.index]` passes this case and fails the first test,
    // so both are needed to pin the mapping.
    expect(landedEditIndices([0, 1], { refused: [refusal(1)] })).toEqual([0]);
    expect(landedEditIndices([5, 3], { refused: [refusal(1)] })).toEqual([5]);
  });
});

// **The settings half of the same subtraction, which shipped without it**
// (myne-md/myne#850, from the 2026-10-13 review). The first pass exported
// `landedSettingIndices` and wired it, and this file is the regression test the
// reviewer's deletion test demanded: with the helper's body replaced by `return []`
// everything else in the tree stays green, because nothing else reads
// `appliedSettings` in a way an assertion notices. The row that would mis-render is
// the refused setting's, and only this test looks at it.
describe("landedSettingIndices", () => {
  function setting(intentId: string): ProposedSetting {
    return { intentId, value: "V", folder: null };
  }
  function settingRefusal(index: number, intentId: string) {
    return { intentId, index, reason: "notWritable" as const };
  }

  it("drops the refused setting and keeps the proposal position of the landed one", () => {
    // The proposal holds three settings; the first two were sent for approval, and
    // the host refused the FIRST of those. `sent[0]` is proposal index 0, so the
    // landed set must be the proposal index of the SECOND sent row, which is 1.
    const proposal = [
      setting("editor.weekly-notes-folder"),
      setting("editor.weekly-notes-template"),
      setting("editor.date-format"),
    ];
    const sent = [proposal[0], proposal[1]];
    const landed = landedSettingIndices(proposal, sent, {
      refusedSettings: [
        settingRefusal(0, "editor.weekly-notes-folder"),
      ],
    });
    expect(landed).toEqual([1]);
  });

  it("is not confused when the sent order differs from the proposal order", () => {
    // **The case that makes a sent-index result distinguishable from a proposal
    // one**, which the reviewer asked for specifically: sent reversed, refusal on
    // the first SENT row. A helper returning `sent` positions would answer 0 here
    // (wrong: it must be a proposal index) and one returning proposal indices
    // answers 2.
    const proposal = [
      setting("editor.weekly-notes-folder"),
      setting("editor.weekly-notes-template"),
      setting("editor.date-format"),
    ];
    const sent = [proposal[2], proposal[0]];
    const landed = landedSettingIndices(proposal, sent, {
      refusedSettings: [settingRefusal(0, "editor.date-format")],
    });
    expect(landed).toEqual([0]);
  });

  it("keeps every setting when nothing was refused", () => {
    const proposal = [setting("a"), setting("b")];
    const landed = landedSettingIndices(proposal, proposal, { refusedSettings: [] });
    expect(landed).toEqual([0, 1]);
  });

  it("drops everything when the host refused everything", () => {
    const proposal = [setting("a"), setting("b")];
    const landed = landedSettingIndices(proposal, proposal, {
      refusedSettings: [settingRefusal(0, "a"), settingRefusal(1, "b")],
    });
    expect(landed).toEqual([]);
  });

  it("treats a refusal index past the end of the sent list as refusing nothing", () => {
    // Defensive, and the direction is deliberate: an index the client cannot
    // resolve leaves the row retryable rather than marking it applied.
    const proposal = [setting("a")];
    const landed = landedSettingIndices(proposal, proposal, {
      refusedSettings: [settingRefusal(7, "a")],
    });
    expect(landed).toEqual([0]);
  });
});
