// The agent review takeover, and the rule for when it is on screen
// (myne-md/myne#529).
//
// **Open is DERIVED from the run, not raised as an event, and that is the whole
// reason this file exists.** It used to be an `agentReviewOpen` boolean in
// `Editor.tsx` that the composer set through an `onRunSettled()` callback fired
// after every `agentStart`. Two things were wrong with that, one of them
// user-visible:
//
//   1. A run that stopped to ASK is not a run to review. `awaitingScope` came
//      back through the same callback, so the takeover opened over the scope
//      expansion dialog: the model asked for a folder, and the user was shown a
//      review of a proposal it had not finished making. The dialog renders in
//      the sidebar strip underneath and was unreachable.
//   2. Every future path that settles a run had to remember to call the
//      callback. The resume after a scope approval lives in `AgentProgress`,
//      which never had one, so fixing (1) alone would have left an approved
//      expansion finishing its run with no screen. That is the same shape as
//      `clearAgentForLock`, which was written, documented, and wired to some of
//      its call sites.
//
// A derivation has neither problem: there is one rule, it is stated once, and a
// new way to settle a run inherits it. Closing is not a second piece of state
// either, because `clearAgent()` drops the run, which is what makes the rule
// false again.
//
// It reads the store itself rather than taking `open` as a prop so the
// subscription stays inside this subtree. `Editor.tsx` is the largest component
// in the tree; making it re-render on every rejected-checkbox toggle would be a
// real cost for a fact only this overlay uses.

import { AgentReview } from "../../../screens/AgentReview";
import { clearAgent, useAgent } from "../agentStore";

export function AgentReviewTakeover({
  titleOf,
  onNotesWritten,
}: {
  titleOf: (noteId: string) => string | null;
  onNotesWritten: () => void;
}) {
  const agent = useAgent();
  // A run is reviewable once it has stopped and has NOT stopped to ask. Every
  // other end kind (`finished`, `cancelled`, `exhaustedIterations`) leaves a
  // proposal the user is entitled to see, including a partial one.
  const reviewable =
    agent.view !== null &&
    !agent.running &&
    agent.end !== null &&
    agent.end.kind !== "awaitingScope";
  if (!reviewable) return null;

  return (
    <div
      data-testid="editor.agent-review"
      style={{
        // `fixed`, not `absolute`: this mounts inside the right sidebar, where
        // the composer that opens it lives, so an absolutely positioned overlay
        // would cover only that sidebar.
        position: "fixed",
        inset: 0,
        // The shared modal stacking level, not a bespoke one. The sidebar pane
        // carries `ornamentRole("surface")`, and with an ornament theme active
        // that sets `isolation: isolate`, which creates a stacking context a
        // promoted descendant is trapped in. A bespoke 40 also sat below the
        // editor's own overlays at 50 and 60.
        zIndex: 1000,
        background: "var(--paper)",
      }}
    >
      <AgentReview
        titleOf={titleOf}
        onNotesWritten={onNotesWritten}
        // Closing drops the frontend's copy of the run, mirroring the host,
        // which drops its half on lock: the two going out of step is how a
        // screen ends up rendering a proposal whose run no longer exists. It is
        // also what makes `reviewable` false, so there is no second flag to keep
        // in step with this one.
        onClose={clearAgent}
      />
    </div>
  );
}
