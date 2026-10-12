// @vitest-environment jsdom
//
// Component tests for `src/notes/agent/components/AgentReviewTakeover.tsx`
// (myne-md/myne#529): WHEN the review screen is on top of the editor.
//
// **The property under test is the `awaitingScope` case, and it is the one that
// shipped wrong.** The takeover used to be an `Editor.tsx` boolean set by an
// `onRunSettled()` callback the composer fired after every `agentStart`, so a
// run that stopped to ASK for a folder opened a review of a proposal the model
// had not finished making, on top of the expansion dialog that was waiting for
// an answer. `ag5` caught it against the real binary; these run everywhere.
//
// Keyed on what is RENDERED for a given store state rather than on a prop,
// because the whole point of the fix is that no caller decides this any more.

import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";

// The screen itself is not under test here and mounting it would pull in the
// whole apply path. What matters is whether it is asked for at all.
//
// It COUNTS its renders, because one test needs a fact a post-hoc query cannot
// give: "never mounted" and "mounted, painted, then unmounted" look identical
// to `queryByTestId` afterwards, and that difference is the whole of what
// myne-md/myne#551's automatic mode promises.
const review = vi.hoisted(() => ({ renders: 0 }));
vi.mock("../../src/screens/AgentReview", () => ({
  AgentReview: () => {
    review.renders += 1;
    return <div data-testid="stub-review" />;
  },
}));

import type { LoopEnd, Proposal } from "../../src/lib/agent-run";
import { applyOutcome } from "../notes/_agentApplyOutcome";
import { AgentReviewTakeover } from "../../src/notes/agent/components/AgentReviewTakeover";
import {
  beginAutoApply,
  beginRun,
  clearAgentForLock,
  currentRunEpoch,
  endAutoApply,
  failRun,
  getAgent,
  resumeRun,
  settleApply,
  settleStep,
  toggleEdit,
} from "../../src/notes/agent/agentStore";

const VIEW = {
  runId: "run-1",
  scopeTotal: 3,
  userGrants: 1,
  modelGrants: 0,
  cancelled: false,
};

/** One proposed edit, which is what makes a settled run reviewable at all.
 *
 *  The default rather than an empty proposal (myne-md/myne#568): the end-kind
 *  cases below are about the END, and giving them nothing to review would make
 *  them pass or fail on the other rule. */
const ONE_EDIT: Proposal = {
  edits: [{ noteId: "n1", anchor: "before", replacement: "after" }],
  newNotes: [],
  summary: "",
};

const NOTHING: Proposal = { edits: [], newNotes: [], summary: "" };

/** Two edits, so one can be applied and the other resolved separately. */
const TWO_EDITS: Proposal = {
  edits: [
    { noteId: "n1", anchor: "before-1", replacement: "after-1" },
    { noteId: "n2", anchor: "before-2", replacement: "after-2" },
  ],
  newNotes: [],
  summary: "",
};

function settle(end: LoopEnd, proposal: Proposal = ONE_EDIT) {
  settleStep({
    view: VIEW,
    proposal,
    end,
    iterations: 1,
    notesRead: 1,
    charsOffDevice: null,
    excludedCount: 0,
  memoryUpdated: 0,}, currentRunEpoch());
}

function mount() {
  render(
    <AgentReviewTakeover
      titleOf={() => null}
      folderOf={() => null}
      onNotesWritten={() => {}}
    />,
  );
}

afterEach(() => {
  cleanup();
  clearAgentForLock();
});

describe("AgentReviewTakeover", () => {
  it("renders into the BODY, not inside the pane that mounts it", () => {
    // **The fix for two reports at once** (myne-md/myne#848): the screen did not
    // paint until something else repainted the window, and once it was on screen
    // the pointer still went to the note behind it, clicks and the wheel both.
    // The cause was where it mounted: as a child of the right panel, a
    // `position: fixed` overlay inherits that panel's stacking and containing
    // context (the panel is `ornamentRole("surface")`, which becomes
    // `isolation: isolate` under an ornament theme), so it was composited inside
    // a subtree rather than over the window it is painted over.
    //
    // Asserted on the parent, which is the property: a portal is what puts it in
    // the root stacking context, and a revert to a plain child fails here.
    beginRun(null);
    settle({ kind: "finished" });
    mount();
    const overlay = screen.getByTestId("editor.agent-review");
    expect(overlay.parentElement).toBe(document.body);
  });

  it("opens for a FAILED leg that left a proposal", () => {
    // **The hole the user hit** (myne-md/myne#848: "it said proposed changes and
    // nothing came up"). A run is driven in legs, and `failRun`, what a
    // provider refusal, a timeout or a refused scope approval takes, records
    // `error` and leaves `end` alone. So a first leg that proposed twenty-one
    // edits and a second that failed produced a proposal with no route to
    // review it: the gate asked for an `end` a failure never sets.
    // The state that produces it: leg 1 proposes and asks to widen the scope,
    // the user approves (`resumeRun` clears `end`, because the dialog derives
    // its own visibility from an `awaitingScope` end), and the approved leg
    // FAILS. `failRun` records `error` and sets no `end`, so the gate asked for
    // one a failure never writes while twenty-one edits sat in the store.
    beginRun(null);
    settle(
      { kind: "awaitingScope", folder: "Projects", reason: "to find the notes" },
      ONE_EDIT,
    );
    resumeRun();
    failRun("the provider refused the request");
    mount();
    expect(screen.queryByTestId("editor.agent-review")).not.toBeNull();
  });

  it("stays closed when a failed leg left NOTHING to review", () => {
    // The other direction, so the clause above cannot open the screen over an
    // empty proposal, which is what every failed QUESTION leaves.
    beginRun(null);
    settle(
      { kind: "awaitingScope", folder: "Projects", reason: "to find the notes" },
      NOTHING,
    );
    resumeRun();
    failRun("the provider refused the request");
    mount();
    expect(screen.queryByTestId("editor.agent-review")).toBeNull();
  });

  it("renders nothing before a run has started", () => {
    mount();
    expect(screen.queryByTestId("editor.agent-review")).toBeNull();
  });

  it("renders nothing while the run is still working", () => {
    beginRun(null);
    mount();
    expect(screen.queryByTestId("editor.agent-review")).toBeNull();
  });

  it("does NOT take over when the run stopped to ask for scope", () => {
    // The regression. An `awaitingScope` end is a question, not a proposal, and
    // the dialog that asks it lives underneath this overlay.
    beginRun(null);
    settle({ kind: "awaitingScope", folder: "Projects", reason: "why" });
    mount();
    expect(screen.queryByTestId("editor.agent-review")).toBeNull();
  });

  // The other direction, so the gate cannot pass by refusing everything. Each
  // of these leaves a proposal the user is entitled to see, including a partial
  // one, which is why `cancelled`, `exhaustedIterations` and `stalled` are here
  // too. A stalled run in particular can carry edits: it proposed something and
  // then went round in circles, and hiding those would throw away work the user
  // paid a provider for.
  for (const end of [
    { kind: "finished" } as const,
    { kind: "cancelled" } as const,
    { kind: "exhaustedIterations" } as const,
    { kind: "stalled", barrenIterations: 3 } as const,
  ]) {
    it(`takes over when the run ended ${end.kind}`, () => {
      beginRun(null);
      settle(end);
      mount();
      expect(screen.queryByTestId("editor.agent-review")).not.toBeNull();
      expect(screen.queryByTestId("stub-review")).not.toBeNull();
    });
  }

  // myne-md/myne#568. The dimension the end-kind loop above cannot see: it is
  // not only WHY a run stopped that decides this, it is whether it left
  // anything to look at.
  //
  // **This is not the `awaitingScope` rule again.** That one is about a run
  // that has not finished proposing; this one is about a run that finished and
  // proposed nothing, which in one mode is what every QUESTION does. Before the
  // fix, asking "how many tasks are in this note" opened a full review dialog
  // whose entire content was "the agent proposed no changes", over the
  // transcript where the answer belonged.
  for (const end of [
    { kind: "finished" } as const,
    { kind: "cancelled" } as const,
    { kind: "exhaustedIterations" } as const,
    { kind: "stalled", barrenIterations: 3 } as const,
  ]) {
    it(`does NOT take over when a ${end.kind} run proposed nothing`, () => {
      beginRun(null);
      settle(end, NOTHING);
      mount();
      expect(screen.queryByTestId("editor.agent-review")).toBeNull();
    });
  }

  it("takes over for a proposal that is only new notes", () => {
    // The other half of the emptiness test, so it cannot be satisfied by
    // looking at `edits` alone: a run that proposed only new notes has as much
    // to review as one that proposed only edits.
    beginRun(null);
    settle(
      { kind: "finished" },
      {
        edits: [],
        newNotes: [{ title: "New", body: "body", folder: null }],
        summary: "",
      },
    );
    mount();
    expect(screen.queryByTestId("editor.agent-review")).not.toBeNull();
  });

  it("does NOT take over for a summary alone, however long", () => {
    // A summary is an ANSWER, and the answer's home is the transcript. Pinned
    // separately because "there is text in the proposal" is the tempting wrong
    // condition: it would reopen this screen for every question that got a
    // wordy reply.
    beginRun(null);
    settle(
      { kind: "finished" },
      { edits: [], newNotes: [], summary: "You have 16 personal tasks." },
    );
    mount();
    expect(screen.queryByTestId("editor.agent-review")).toBeNull();
  });

  it("stops taking over once the run is dropped", () => {
    // Closing calls `clearAgent()`, which drops the run. That is what makes the
    // rule false again; there is no second flag to unset.
    beginRun(null);
    settle({ kind: "finished" });
    mount();
    expect(screen.queryByTestId("editor.agent-review")).not.toBeNull();
    cleanup();
    clearAgentForLock();
    mount();
    expect(screen.queryByTestId("editor.agent-review")).toBeNull();
  });
});

// myne-md/myne#549. The review became a dialog rather than a full-window
// takeover, and these two are the properties `docs/decisions/ai/0518` point 3
// rests on: approving is a deliberate act, so the two dismissals every other
// dialog in the tree offers are deliberately absent here. Closing discards a
// proposal the user has not applied, and neither Escape nor a misplaced click
// is a decision to throw the model's work away.
describe("dismissal stays deliberate", () => {
  it("does not close on Escape", () => {
    beginRun(null);
    settle({ kind: "finished" });
    mount();
    expect(screen.queryByTestId("editor.agent-review")).not.toBeNull();

    fireEvent.keyDown(window, { key: "Escape" });

    expect(screen.queryByTestId("editor.agent-review")).not.toBeNull();
    expect(screen.queryByTestId("stub-review")).not.toBeNull();
  });

  it("does not close on a backdrop click", () => {
    beginRun(null);
    settle({ kind: "finished" });
    mount();
    const backdrop = screen.getByTestId("editor.agent-review");

    fireEvent.click(backdrop);

    expect(screen.queryByTestId("editor.agent-review")).not.toBeNull();
    expect(screen.queryByTestId("stub-review")).not.toBeNull();
  });

  it("is a centred card rather than the whole window", () => {
    // The size claim itself, since it is what the entry supersedes: the
    // backdrop covers the window and the card inside it does not. Asserted on
    // the inset that clears the macOS traffic lights, which is the collision
    // that prompted the change.
    beginRun(null);
    settle({ kind: "finished" });
    mount();
    const backdrop = screen.getByTestId("editor.agent-review");
    expect(backdrop.style.position).toBe("fixed");
    expect(backdrop.style.padding).not.toBe("");
    expect(backdrop.style.padding).not.toBe("0px");
  });
});

// myne-md/myne#596. Closing is derived from the run the same way opening is: an
// apply that refused nothing and left no row to act on has nothing the user can
// decide, so the dialog dismisses itself. The rule itself is
// `applyWasCleanAndComplete`, unit-tested in
// `tests/notes/agentReviewAutoClose.test.ts`; what is pinned here is that this
// component acts on it, and that acting on it DROPS the run rather than merely
// hiding the screen.
describe("a clean apply closes the dialog", () => {
  /** A clean outcome for the single edit `ONE_EDIT` carries. */
  const CLEAN = applyOutcome();

  it("closes once the apply is clean and complete", () => {
    beginRun(null);
    settle({ kind: "finished" });
    mount();
    expect(screen.queryByTestId("editor.agent-review")).not.toBeNull();

    act(() => {
      settleApply(CLEAN, [0], currentRunEpoch());
    });

    expect(screen.queryByTestId("editor.agent-review")).toBeNull();
  });

  it("drops the run rather than hiding the screen", () => {
    // The half a visibility assertion cannot see, and the reason the close goes
    // through `clearAgent` rather than through a flag. `proposal.edits` holds
    // anchors and replacements copied verbatim out of note bodies; a hidden
    // dialog over a live proposal would leave that plaintext resident with no
    // surface accounting for it, which is what this store's header exists to
    // prevent.
    beginRun(null);
    settle({ kind: "finished" });
    mount();

    act(() => {
      settleApply(CLEAN, [0], currentRunEpoch());
    });

    expect(getAgent().view).toBeNull();
    expect(getAgent().proposal.edits).toHaveLength(0);
  });

  it("stays open when the host refused an edit, even once that row is resolved", () => {
    // **The refused row is REJECTED before asserting, and that is the whole
    // point.** A refused edit is not in `appliedEdits`, so it stays in
    // `keptEdits` and the completeness clause already answers: without the
    // rejection this test stays green with `hasRefusals` deleted from the
    // predicate, which was measured. Rejecting it resolves the row and leaves
    // the accumulated refusal as the only thing holding the screen.
    beginRun(null);
    settle({ kind: "finished" }, TWO_EDITS);
    mount();

    act(() => {
      settleApply(
        applyOutcome({
          applied: 1,
          refused: [{ noteId: "n2", index: 1, reason: "anchorNotFound" }],
        }),
        [0],
        currentRunEpoch(),
      );
      toggleEdit(1);
      // A second apply is what re-asks the rule: only an apply may close the
      // review, so the rejection above cannot be the trigger.
      settleApply(applyOutcome({ applied: 0, notesWritten: [], restorePoints: [] }), [], currentRunEpoch());
    });

    expect(screen.queryByTestId("editor.agent-review")).not.toBeNull();
  });

  it("never renders at all on the automatic path", () => {
    // **The sequence production actually produces, in ONE `act`.**
    // `agentToChat.ts::autoApplyRun` calls `settleApply(...)` and then
    // `endAutoApply()` in one synchronous continuation, so React commits them
    // together. Splitting them across two `act()` calls, which this test used
    // to do, hides the only commit that matters: with `applied` set and
    // `autoApplying` already false, `reviewable` is true, and a rule that ran
    // in a passive effect let this dialog mount, arm its focus trap and paint
    // before tearing itself down. Measured at one render under the real
    // ordering, zero under the split one, so the split test passed for an
    // interleaving that never happens.
    //
    // Asserted on the RENDER COUNT rather than on a post-hoc query, because a
    // query after the fact cannot tell "never mounted" from "mounted and
    // unmounted", which is exactly the distinction myne-md/myne#551 is about.
    review.renders = 0;
    beginRun(null);
    beginAutoApply();
    settle({ kind: "finished" });
    mount();
    expect(review.renders).toBe(0);

    act(() => {
      settleApply(CLEAN, [0], currentRunEpoch());
      endAutoApply();
    });

    expect(review.renders, "the skipped screen must never paint").toBe(0);
    expect(screen.queryByTestId("editor.agent-review")).toBeNull();
    expect(getAgent().view).toBeNull();
  });
});
