// Agent run → chat-transcript orchestration.
//
// The sibling of `aiToChat.ts`, and it exists for the same reason: a capability
// that used to render into a surface of its own now renders into the one
// transcript. `design-notes/ai/0515` already said the entry point was chat
// ("A run starts from chat with the open note as the default scope"); what
// shipped put a second composer beside the chat one instead, so the tab offered
// two places to type. This module is the half of closing that which does not
// belong in a component: appending the run's turns, starting it, and mirroring
// each settled step onto its turn.
//
// **`settleRunIntoChat` is the ONE place a step settles**, and that is the point
// rather than a convenience. The mirror used to live in a render effect on the
// turn, which meant a cross-store write whose correctness rested on an
// over-broad dependency array being absorbed by an equality check. It also had
// to be written where it could see BOTH callers of `settleStep`: this module's
// own start, and the scope-approval resume in `AgentProgress`. Putting the
// mirror in the settle function covers both by construction, which is what the
// effect was approximating.
//
// **It deliberately does not own the capability probe.** The verdict gates
// whether Send is offered at all, and it must not fire until the user actually
// sends, because on a remote provider the probe issues `threshold.attempts`
// third-party requests (TB13, `design-notes/ai/0515`). Firing it here would
// make "start a run" and "find out whether a run is possible" the same call,
// which is how a mount effect grows back. That the verdict now LIVES in
// `agentStore` rather than in the composer's own state (myne-md/myne#568)
// changes nothing about this: where an answer is kept and who is allowed to ask
// the question are separate decisions, and only the second one is this
// paragraph's.
//
// Both stores are AS1-class RAM, dropped on lock: the transcript through
// `clearChat`, the proposal through `clearAgentForLock`. Nothing here writes to
// disk and nothing here logs the task, which is the user's own words.

import {
  agentApply,
  agentStart,
  splitForBulkApproval,
  type AgentStepResult,
  type ScopeGrant,
} from "../../lib/agent-run";
import { engineErrorTag } from "../../lib/engine-error";
import {
  approvedNewNoteIndices,
  beginAutoApply,
  beginRun,
  currentRunEpoch,
  endAutoApply,
  failRun,
  getAgent,
  landedEditIndices,
  openRun,
  settleApply,
  settleStep,
} from "../agent/agentStore";
import { failAgentTurn, sendAgentTurn, settleAgentTurn } from "./chatStore";

/** The already-localized strings the run's turns render.
 *
 *  Passed in rather than resolved here: this module is not a component, and
 *  `src/CLAUDE.md` bans freezing a resolved string at module scope (it would
 *  capture the boot language). The caller has a `t` in hand. */
export interface AgentRunCopy {
  /** What the user turn's scope chip says: "This note", or the folder name. */
  scopeLabel: string;
  /** The sentence for a start that never landed. */
  startFailed: string;
  /** The sentence for an automatic apply that failed outright. */
  autoApplyFailed: string;
  /** The sentence for a start the PROVIDER refused (HTTP 400).
   *
   *  Separate because the two send the user to different places, and the
   *  generic one used to be shown for both: a rejected request is a fault in
   *  what Myne sent, so telling the user to check their setup is telling them
   *  to fix something that is not broken (myne-md/myne#547). */
  providerRejected: string;
}

/**
 * Settle a step into the run store AND onto its transcript turn.
 *
 * Every path that settles a step goes through here. A run that stopped to ASK
 * has not settled in the sense the turn cares about: its step returned, so
 * `running` is false, but the loop is paused on a question the scope dialog is
 * putting to the user, and freezing there would print "the agent proposed no
 * changes" underneath a dialog about to make it propose some.
 *
 * The turn takes the counts AND the model's closing summary. It does not take
 * the proposal: anchors and replacements are text copied verbatim out of note
 * bodies, and they stay in `agentStore`, which every vault-leaving path clears
 * (`design-notes/ai/0518`).
 *
 * **The summary has to come here, and that is the half one mode was missing**
 * (myne-md/myne#568). The agent answers a question through `finish`, so in one
 * mode the summary IS the answer; the only surface rendering it was the review
 * screen, so asking "how many tasks are in this note" put the answer inside a
 * "Review changes" dialog next to the words "the agent proposed no changes".
 * Ask used to write its answer into the transcript, and when Ask was removed
 * nothing took that over.
 */
export function settleRunIntoChat(result: AgentStepResult, epoch: number): void {
  // A step that landed after the vault was left is dropped by the run store,
  // and its counts must not reach the transcript either.
  if (!settleStep(result, epoch)) return;
  const agent = getAgent();
  if (agent.view === null || agent.end?.kind === "awaitingScope") return;
  settleAgentTurn({
    runId: agent.view.runId,
    summary: agent.proposal.summary,
    edits: agent.proposal.edits.length,
    newNotes: agent.proposal.newNotes.length,
    notesRead: agent.notesRead,
    iterations: agent.iterations,
    charsOffDevice: agent.charsOffDevice,
    end: agent.end?.kind ?? "finished",
  });
}

/**
 * Start an agent run **as a chat turn**: append the user's task (carrying the
 * scope it was sent under) plus the agent turn the run renders into, then drive
 * the first step.
 *
 * Resolves once that step settles. A run that stops to ask for more scope is a
 * settled step like any other. `AgentProgress` owns the dialog and the resume,
 * and the turn keeps rendering it, so there is no second entry point here.
 */
export async function startAgentRun(
  task: string,
  grant: ScopeGrant,
  copy: AgentRunCopy,
  /** Called with the ids of notes an automatic apply wrote, so the open pane
   *  re-reads them. Absent when the caller has nothing to tell. */
  onNotesWritten?: (noteIds: readonly string[]) => void,
): Promise<void> {
  sendAgentTurn(task, copy.scopeLabel);
  beginRun();
  // Captured BEFORE the await, so a vault lock during the call invalidates what
  // comes back rather than being raced by it.
  const epoch = currentRunEpoch();
  try {
    const result = await agentStart(task, grant, (view) => {
      // The run has an id now, minutes before this call resolves. Same epoch
      // as the settle below, so a run the user let go of mid-flight cannot
      // mount a progress strip for itself behind them.
      openRun(view, epoch);
    });
    // **Raised BEFORE the step settles**, which is the ordering the flag exists
    // for: the review dialog derives its open state from a settled run, so a
    // flag set afterwards lets the screen it is meant to skip open for a few
    // frames and then close. Read from the store rather than from a parameter,
    // so the mode in force is the one at the moment the run ends.
    const auto = getAgent().autoApply;
    if (auto) beginAutoApply();
    settleRunIntoChat(result, epoch);
    if (auto) await autoApplyRun(epoch, copy, onNotesWritten);
  } catch (failure) {
    // **The same epoch check the success path gets, spelled out.** On the
    // success path it is transitive: `settleRunIntoChat` returns early when
    // `settleStep` rejects the epoch, so the transcript write never happens.
    // The failure path had no equivalent, and `failAgentTurn` writes onto
    // whatever `lastAgentIndex` finds, so run one's "the agent could not start"
    // was stamped as an error onto run two's live turn while run two was still
    // working, and `failRun` cleared the newer run's `running` with it.
    //
    // Guarded here rather than by giving `failRun` a required epoch: its other
    // two call sites are the apply and undo failures in `AgentReview`, which are
    // user-initiated after the run settled and would have to pass
    // `currentRunEpoch()`, comparing the epoch to itself. That is the shape
    // `settleStep`'s own doc warns about, so the guard belongs at the leg that
    // actually captured an epoch.
    if (epoch !== currentRunEpoch()) return;
    // Two stores, one failure, and both need it. `failRun` clears `running` and
    // records the message for a run that HAS a view; a start that never landed
    // has none, because `beginRun()` nulled it, so the progress strip does not
    // mount and `failAgentTurn` is what the user actually reads.
    // Which sentence, from the host's own tag. `AgentError` serializes with a
    // `kind` field, and the two failures a user can tell apart are "the
    // provider would not take this request" and everything else.
    const sentence =
      engineErrorTag(failure) === "ProviderRejected"
        ? copy.providerRejected
        : copy.startFailed;
    failRun(sentence);
    failAgentTurn(sentence);
  }
}

/** Apply a finished run without a second act (myne-md/myne#551).
 *
 *  **Three bounds, and two of them are mechanisms that already existed.**
 *
 *  The scope is the one the user approved when the run started; nothing here
 *  widens it. The approval label is `"bulk"`, which is not cosmetic: the host
 *  re-derives, from the note as it will actually be, whether an edit takes the
 *  note out of the working set — `trashed:`, `deleted:`, `archived:`,
 *  `template:`, `conflict:` — and refuses one inside a bulk approval whatever
 *  the caller sent. So a removal still needs its own act, in automatic mode as
 *  in manual, and the refusals come back to be shown rather than dropped. And
 *  the mode itself is session-scoped, dropped on lock and on vault switch.
 *
 *  The proposal is read from the store rather than passed in, because
 *  `settleStep` is what put it there and the epoch guard on that call is what
 *  decides whether this run is still the one the surface is showing.
 */
async function autoApplyRun(
  epoch: number,
  copy: AgentRunCopy,
  onNotesWritten?: (noteIds: readonly string[]) => void,
): Promise<void> {
  try {
    const agent = getAgent();
    // A step the epoch guard dropped leaves no view, and a run that stopped to
    // ask has one but is not finished. Neither is a run to apply.
    if (agent.view === null || agent.end?.kind === "awaitingScope") return;
    const { bulkApprovable } = splitForBulkApproval(agent.proposal.edits);
    const newNotes = approvedNewNoteIndices(agent);
    if (bulkApprovable.length === 0 && newNotes.length === 0) return;
    // Positions in the FULL proposal, which is what `landedEditIndices` and the
    // applied-row bookkeeping are keyed on.
    const indices = bulkApprovable.map((e) => agent.proposal.edits.indexOf(e));
    const outcome = await agentApply(agent.view.runId, bulkApprovable, newNotes, "bulk");
    if (!settleApply(outcome, landedEditIndices(indices, outcome), epoch)) return;
    const changed = [...outcome.notesWritten, ...outcome.notesCreated];
    if (changed.length > 0) onNotesWritten?.(changed);
  } catch {
    // Same epoch check the success path gets. A failure here leaves the run in
    // the store, so the review screen still opens and the user can apply by
    // hand: an automatic apply that fails degrades to the manual path rather
    // than losing the proposal.
    if (epoch !== currentRunEpoch()) return;
    failRun(copy.autoApplyFailed);
  } finally {
    endAutoApply();
  }
}
