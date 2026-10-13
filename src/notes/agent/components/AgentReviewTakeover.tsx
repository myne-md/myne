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

import { useRef, type CSSProperties } from "react";

import { ornamentRole } from "@myne/ornaments";

import { useFocusTrap } from "../../../hooks/useFocusTrap";
import { createPortal } from "react-dom";
import { AgentReview } from "../../../screens/AgentReview";
import { clearAgent, useAgent } from "../agentStore";

// **A dialog, not a full-window takeover** (myne-md/myne#549). It was the
// second, and `design-notes/ai/0518` point 3 said so; that entry's reasoning
// is kept and only its SIZE claim is superseded. Approving is still meant to be
// a deliberate act, so this dialog deliberately does NOT dismiss on a backdrop
// click and does NOT dismiss on Escape, which is where it parts company with
// `ModalShell` and with Settings: closing discards a proposal the user has not
// applied, and a stray Escape that throws the model's work away would be a
// worse surface than the takeover rather than a smaller one. `ModalShell` also
// renders its own header, and this screen's header carries the running scope
// total, which may not move behind a disclosure.
//
// The 48px top inset is the same one `SettingsModal` uses and the reason the
// takeover needed replacing at all: it clears the macOS overlay traffic lights,
// which the full-window version ran its heading straight into.
const BACKDROP_STYLE: CSSProperties = {
  // `fixed`, not `absolute`: this mounts inside the right sidebar, where the
  // composer that opens it lives, so an absolutely positioned overlay would
  // cover only that sidebar.
  position: "fixed",
  inset: 0,
  background: "var(--scrim)",
  display: "flex",
  alignItems: "stretch",
  justifyContent: "center",
  padding: "48px 24px 24px",
  animation: "settings-backdrop-in var(--duration-fast) var(--ease-standard)",
  // The shared modal stacking level, not a bespoke one. The sidebar pane
  // carries `ornamentRole("surface")`, and with an ornament theme active that
  // sets `isolation: isolate`, which creates a stacking context a promoted
  // descendant is trapped in. A bespoke 40 also sat below the editor's own
  // overlays at 50 and 60.
  zIndex: 1000,
};

const CARD_STYLE: CSSProperties = {
  width: "100%",
  // Wider than Settings' 1080: this card holds a two-column split diff of note
  // text, and keeping both columns readable costs more than a wide card does.
  maxWidth: 1200,
  height: "100%",
  background: "var(--paper)",
  border: "1px solid var(--line-1)",
  borderRadius: "var(--radius-2)",
  boxShadow: "var(--shadow-3)",
  display: "flex",
  flexDirection: "column",
  overflow: "hidden",
  animation: "settings-modal-in var(--duration-base) var(--ease-standard)",
};

export function AgentReviewTakeover({
  titleOf,
  folderOf,
  onNotesWritten,
}: {
  titleOf: (noteId: string) => string | null;
  /** The folder a note sits in, for a move row's starting point. Same resolution
   *  source as `titleOf`, so the two never describe different notes. */
  folderOf: (noteId: string) => string | null;
  /** The ids an apply (or an undo) wrote, so the caller can refresh what it
   *  shows of them. Typed with the ids rather than as `() => void`: it used to
   *  drop them, and a moved note then kept its old folder in the sidebar until
   *  something else re-read it (myne-md/myne#848, on the user's report). */
  onNotesWritten: (noteIds: readonly string[]) => void;
}) {
  const agent = useAgent();
  // A run is reviewable once it has stopped, has NOT stopped to ask, and has
  // something to show. Every end kind other than `awaitingScope` (`finished`,
  // `cancelled`, `exhaustedIterations`, `stalled`) leaves a proposal the user is
  // entitled to see, including a partial one — that rule from
  // `design-notes/ai/0518` is kept exactly.
  const reviewable =
    agent.view !== null &&
    !agent.running &&
    // **A FAILED leg stopped the run too, and `end` stays null when it does**
    // (myne-md/myne#848, on the user's report: "it said proposed changes and
    // nothing came up"). `failRun`, the path a provider refusal, a timeout or a
    // refused scope approval takes, records `error` and leaves `end` alone, so
    // a run whose FIRST leg proposed twenty-one edits and whose second leg
    // failed had a proposal with no route to review it: this gate asked for an
    // `end` that a failure never sets, and the screen the user was told about
    // could not open. The comment below already lists the other partial ends
    // (`cancelled`, `exhaustedIterations`, `stalled`) as reviewable for exactly
    // this reason; a failed leg is the same shape.
    (agent.end !== null || agent.error !== null) &&
    agent.end?.kind !== "awaitingScope" &&
    // **And the run proposed something** (myne-md/myne#568). In the two-mode
    // world every run that reached this screen had set out to produce a
    // proposal, so "it stopped" and "there is something to review" were the same
    // fact. One mode broke that: a question is a run too, so every question
    // opened a review dialog whose whole content was "the agent proposed no
    // changes", over the transcript where the answer belonged. This is the only
    // case that changes — one edit is still enough to open the screen, whatever
    // the end kind.
    (agent.proposal.edits.length > 0 ||
      agent.proposal.newNotes.length > 0 ||
      // A settings-only run is a proposal too (myne-md/myne#850). Leaving it
      // out here is the difference between a change the user can review and one
      // the model made and nobody ever sees.
      (agent.proposal.settings?.length ?? 0) > 0) &&
    // **And the run is not applying itself** (myne-md/myne#551). Without this
    // clause an automatic run opens the screen it exists to skip for the frames
    // between the step settling and the apply returning. The flag is raised
    // before the settle for exactly that reason.
    !agent.autoApplying;
  // **Closing needs nothing here, and the empty space is the fix**
  // (myne-md/myne#596). A clean, complete apply ends the review, and the drop
  // happens inside `settleApply`, the one writer both apply paths pass through.
  // `reviewable` above then goes false on its own, exactly as it does for a
  // manual close, because there is no run left to review.
  //
  // It was written here first, as a `useEffect` on
  // `applyWasCleanAndComplete(agent)`, on the reasoning that OPEN is derived so
  // CLOSE should be too. That is wrong, and the difference is that `reviewable`
  // is a pure read consumed at render while closing is a destructive write.
  // Deriving it reached a state an apply never produces: `keptEdits` counts a
  // REJECTED edit as resolved, so one click on the last outstanding row's
  // Reject button dropped the whole proposal, with no confirmation and no way
  // back, from the control whose other direction is labelled Restore. This file
  // bans backdrop and Escape dismissal 120 lines up to prevent exactly that,
  // and the effect reintroduced it through a button.
  //
  // It also mounted the dialog that myne-md/myne#551 exists to skip:
  // `autoApplyRun` writes `settleApply` and `endAutoApply` in one synchronous
  // continuation, so React commits them together and this component renders,
  // arms its focus trap and paints before any passive effect runs. Measured at
  // one render. `settleApply` owns the argument in full.
  //
  // Declared before the early return, because hooks must be. Enabled on the
  // same condition the render is, so a trap is never armed for a dialog that
  // is not on screen.
  const cardRef = useRef<HTMLDivElement>(null);
  useFocusTrap(cardRef, { enabled: reviewable });
  if (!reviewable) return null;

  // **A portal, and that is the fix for two reports at once** (myne-md/myne#848):
  // the screen did not paint until something ELSE repainted the window (a click
  // in the note list made it appear), and once it was on screen the pointer
  // still went to the note behind it (clicks and the wheel both) so it was
  // visible and untouchable.
  //
  // The cause is where it MOUNTED. This rendered as a child of the right panel,
  // so a `position: fixed` overlay inherited that panel's stacking and
  // containing context: the panel is `ornamentRole("surface")` (which becomes
  // `position: relative; isolation: isolate` under any ornament theme) and sits
  // inside the editor's pane tree, so the overlay was composited inside a
  // subtree rather than over the window it is painted over. `createPortal` to the
  // body puts it in the root stacking context, where `inset: 0` means the
  // viewport and nothing above it can take its input, the same reason `Tooltip`
  // portals its bubble.
  return createPortal(
    <div data-testid="editor.agent-review" style={BACKDROP_STYLE}>
      <div ref={cardRef} {...ornamentRole("surface")} style={CARD_STYLE}>
        <AgentReview
          titleOf={titleOf}
          folderOf={folderOf}
          onNotesWritten={onNotesWritten}
          // Closing drops the frontend's copy of the run, mirroring the host,
          // which drops its half on lock: the two going out of step is how a
          // screen ends up rendering a proposal whose run no longer exists. It
          // is also what makes `reviewable` false, so there is no second flag
          // to keep in step with this one.
          onClose={clearAgent}
        />
      </div>
    </div>,
    document.body,
  );
}
