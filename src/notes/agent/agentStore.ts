// The agent run's frontend state (myne-md/myne#529).
//
// RAM-only, by construction rather than by omission. The host drops the run
// table and the transcript on vault lock, so a proposal the user never approved
// ceases to exist; persisting it here would reintroduce exactly what that
// decision avoided, note-derived plaintext outliving the unlocked session.
//
// This store holds no policy. Scope arithmetic, the excluded-folder clamp and
// every refusal are host-side; what is here is which run is open, what it has
// proposed, and which of those the user has ticked.

import { useSyncExternalStore } from "react";

import type {
  AgentApplyResult,
  AgentRunView,
  AppliedRun,
  LoopEnd,
  Proposal,
  ProposedEdit,
} from "../../lib/agent-run";

/** The whole of what a screen needs to render a run. */
export interface AgentState {
  /** The open run, or null when none is. */
  view: AgentRunView | null;
  /** What it has proposed so far. */
  proposal: Proposal;
  /** Why the loop stopped, or null while it is running. */
  end: LoopEnd | null;
  /** True between sending and the loop coming back. */
  running: boolean;
  /** Model round-trips so far, for the post-run summary. */
  iterations: number;
  /** Notes read in full, same purpose. */
  notesRead: number;
  /** Characters that left the device, or null when the run stayed local.
   *
   *  Accumulates like `iterations` does. Null stays null until some step reports
   *  a figure, so "the run was local" and "the run was remote and sent nothing"
   *  never collapse into the same rendering. */
  charsOffDevice: number | null;
  /** Notes the excluded-folder clamp removed from the most recent grant. */
  excludedCount: number;
  /** Indices into `proposal.edits` the user has rejected. Rejection is tracked
   *  rather than approval so a newly arrived edit defaults to shown-and-kept,
   *  which is what a reviewer expects after a resume. */
  rejected: ReadonlySet<number>;
  /** Indices into `proposal.newNotes` the user has rejected. Same convention. */
  rejectedNewNotes: ReadonlySet<number>;
  /** Indices into `proposal.edits` already written by a previous apply. Kept so
   *  an applied row renders as applied rather than staying pressable: a second
   *  apply would fail its anchor and report `anchorNotFound` for an edit that in
   *  fact succeeded, which is the inverse of the confusion this screen exists to
   *  prevent. */
  appliedEdits: ReadonlySet<number>;
  /** The result of the last apply, or null. */
  applied: AgentApplyResult | null;
  /** The run the host says is still undoable, or null.
   *
   *  Read from the host rather than derived from `applied`, and that is the
   *  whole point: `applied` dies with this store when the review screen closes,
   *  while the host's record survives until the next apply or the vault lock.
   *  This is what makes the undo affordance reachable afterwards. */
  undoable: AppliedRun | null;
  /** A failure to report, as an already-localized string. */
  error: string | null;
}

const EMPTY_PROPOSAL: Proposal = { edits: [], newNotes: [], summary: "" };

const INITIAL: AgentState = {
  view: null,
  proposal: EMPTY_PROPOSAL,
  end: null,
  running: false,
  iterations: 0,
  notesRead: 0,
  charsOffDevice: null,
  excludedCount: 0,
  rejected: new Set(),
  rejectedNewNotes: new Set(),
  appliedEdits: new Set(),
  applied: null,
  undoable: null,
  error: null,
};

let state: AgentState = INITIAL;
const listeners = new Set<() => void>();

function set(next: Partial<AgentState>): void {
  state = { ...state, ...next };
  for (const l of listeners) l();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Read the run state outside React.
 *
 *  For the orchestration that has to look at a run right after settling it.
 *  `settleStep` accumulates, so the totals a settled step reports are the
 *  store's, not the step's. */
export function getAgent(): AgentState {
  return state;
}

/** Read the run state. */
export function useAgent(): AgentState {
  return useSyncExternalStore(
    subscribe,
    () => state,
    () => state,
  );
}

/** A run is starting.
 *
 *  **`undoable` is carried over, and that is not tidiness.** The host's record
 *  is ended by the next APPLY or by the vault lock, which is what
 *  `docs/decisions/ai/0515` promises; merely starting a second run ends
 *  neither. Resetting it here dropped the previous run's offer from the surface
 *  while the host still held it, so the undo the user had been told about
 *  became unreachable by the ordinary act of asking for something else. */
export function beginRun(): void {
  // **Starting a run is a vault-leaving event for the PREVIOUS run's step.**
  // The epoch's own note below `clearAgentForLock` names a lock, a vault switch
  // and a new conversation; a new RUN is the same class and was not covered,
  // because the only other guard is `ChatComposer`'s `busy`, which is component
  // state. `AiChatTab` mounts conditionally on the right panel's active tab, so
  // switching that tab away and back remounts the composer with `busy` false
  // while run one is still in flight. Run one's reply then passed the epoch
  // check and `settleStep` wrote its view, proposal and end over run two while
  // ACCUMULATING its iterations, notesRead and charsOffDevice onto run two's
  // freshly zeroed counters, after which `settleRunIntoChat` froze the merged
  // totals onto run two's turn. `charsOffDevice` is the disclosure figure
  // `docs/decisions/ai/0515` names as the compensating control for the uncapped
  // remote arm, so a merged total is a false statement about how much left the
  // device rather than a mislabel.
  runEpoch += 1;
  set({
    ...INITIAL,
    undoable: state.undoable,
    running: true,
    rejected: new Set(),
    rejectedNewNotes: new Set(),
    appliedEdits: new Set(),
  });
}

/** A step came back.
 *
 *  `epoch` is what the caller captured before it awaited the host. A step whose
 *  epoch has moved was let go of while it was in flight: the vault was left, or
 *  the user started a new conversation. It is dropped. See the epoch note below
 *  `clearAgentForLock`.
 *
 *  **Required, not defaulted to the current epoch.** A default would make the
 *  guard opt-in: a later call site that omitted the argument would compare the
 *  epoch to itself, always pass, and nothing would say so. Returns whether it
 *  was applied, so a caller that mirrors the result elsewhere drops its half
 *  too. */
export function settleStep(
  result: {
    view: AgentRunView;
    proposal: Proposal;
    end: LoopEnd;
    iterations: number;
    notesRead: number;
    charsOffDevice: number | null;
    excludedCount: number;
  },
  epoch: number,
): boolean {
  if (epoch !== runEpoch) return false;
  set({
    view: result.view,
    proposal: result.proposal,
    end: result.end,
    iterations: state.iterations + result.iterations,
    notesRead: state.notesRead + result.notesRead,
    // Null plus a figure is that figure, not null: a run that resumes onto a
    // remote provider after a local first leg did send something, and reporting
    // nothing would be the wrong half of the truth.
    charsOffDevice:
      result.charsOffDevice === null
        ? state.charsOffDevice
        : (state.charsOffDevice ?? 0) + result.charsOffDevice,
    excludedCount: result.excludedCount,
    running: false,
  });
  return true;
}

/** A step failed. */
export function failRun(message: string): void {
  set({ running: false, error: message });
}

/** The run is resuming after a scope approval. */
export function resumeRun(): void {
  set({ running: true, error: null });
}

/** Toggle one edit's rejection. */
export function toggleEdit(index: number): void {
  const next = new Set(state.rejected);
  if (next.has(index)) next.delete(index);
  else next.add(index);
  set({ rejected: next });
}

/** Toggle one proposed new note's rejection. */
export function toggleNewNote(index: number): void {
  const next = new Set(state.rejectedNewNotes);
  if (next.has(index)) next.delete(index);
  else next.add(index);
  set({ rejectedNewNotes: next });
}

/** The indices of new notes the user has NOT rejected. This is what the apply
 *  sends; a note that is not in it is not created. */
export function approvedNewNoteIndices(s: AgentState = state): number[] {
  return s.proposal.newNotes
    .map((_, i) => i)
    .filter((i) => !s.rejectedNewNotes.has(i));
}

/** Reject every edit in a set of indices. */
export function rejectAll(indices: number[]): void {
  const next = new Set(state.rejected);
  for (const i of indices) next.add(i);
  set({ rejected: next });
}

/** The edits the user has NOT rejected and has not already applied, in proposal
 *  order. */
export function keptEdits(s: AgentState = state): ProposedEdit[] {
  return s.proposal.edits.filter(
    (_, i) => !s.rejected.has(i) && !s.appliedEdits.has(i),
  );
}

/** Which of the SENT edit indices actually landed.
 *
 *  **The subtraction, as a function, because the bug was at the call site and a
 *  call site is not testable.** `AgentReview` used to hand `settleApply` the
 *  indices it had SENT, so an edit the host refused at apply time (a moved
 *  anchor, a folder excluded while the review was open) was marked applied. That
 *  is worse than a cosmetic mislabel: `keptEdits` filters `appliedEdits` out, so
 *  the refused edit left the actionable list and the user could no longer
 *  re-approve it. Found in the review of myne-md/myne#531.
 *
 *  `apply.rs` defines a refusal's `index` as its position in the APPROVED list,
 *  which is exactly what `sent` is, so this maps by position rather than by
 *  content. Refused NEW NOTES are not subtracted here: they are indexed against
 *  the proposal's new-note list, a different space, and `appliedEdits` does not
 *  track them. */
export function landedEditIndices(
  sent: number[],
  outcome: Pick<AgentApplyResult, "refused">,
): number[] {
  const refused = new Set(outcome.refused.map((r) => sent[r.index]));
  return sent.filter((i) => !refused.has(i));
}

/** An apply finished.
 *
 *  `applied` accumulates rather than replaces: a second apply that overwrote the
 *  first would erase the earlier refusals from the screen, which is the one
 *  outcome the user most needs to keep reading. */
export function settleApply(
  result: AgentApplyResult,
  appliedIndices: number[],
  epoch: number,
): boolean {
  // **The same guard `setUndoable` takes, and for the same data.**
  // `AgentApplyResult` carries `notesWritten`, `notesCreated` and
  // `restorePoints`, which are note ids of the vault it describes, and
  // `agentApply` is awaited. Without this, `clearAgentForLock`'s claim that "a
  // reply that lands after the teardown cannot repopulate the store" was false
  // through this call site: it was the one awaited writer that had been left
  // out when `setUndoable` was given an epoch for precisely this reason.
  //
  // Required rather than defaulted, per `settleStep`: a default would let a
  // later call site compare the epoch to itself and pass, and nothing would say
  // so. Returns whether it was applied, so a caller mirroring the result
  // elsewhere drops its half too.
  if (epoch !== runEpoch) return false;
  const merged: AgentApplyResult = state.applied
    ? {
        applied: state.applied.applied + result.applied,
        refused: [...state.applied.refused, ...result.refused],
        refusedNewNotes: [
          ...state.applied.refusedNewNotes,
          ...result.refusedNewNotes,
        ],
        notesWritten: [...state.applied.notesWritten, ...result.notesWritten],
        notesCreated: [...state.applied.notesCreated, ...result.notesCreated],
        restorePoints: [...state.applied.restorePoints, ...result.restorePoints],
      }
    : result;
  const nextApplied = new Set(state.appliedEdits);
  for (const i of appliedIndices) nextApplied.add(i);
  set({ applied: merged, appliedEdits: nextApplied });
  return true;
}

/** The host's answer to "is there a run I could still undo?".
 *
 *  Set from `agentLastRun()`, never inferred. Deliberately survives
 *  `clearAgent()`: closing the review screen ends the PROPOSAL, and the applied
 *  notes are still applied. What ends it is the host clearing its own record,
 *  which happens on the next apply and on vault lock.
 *
 *  **`epoch` is the same guard `settleStep` takes, and this writer needs it for
 *  the same reason.** `AppliedRun.restorePoints` carries note ids of the vault
 *  it describes, and `agentLastRun()` is awaited: without it, a reply arriving
 *  after the lock re-seeded the offer with the previous vault's ids, protected
 *  only by the strip's unmount, which is the "rendering fact rather than a
 *  guarantee" this branch's own `vault-unlock.ts` comment argues against.
 *  Clearing it (`null`) is always allowed, because dropping the offer is never
 *  the unsafe direction. */
export function setUndoable(run: AppliedRun | null, epoch: number): void {
  if (run !== null && epoch !== runEpoch) return;
  set({ undoable: run });
}

/** Drop everything.
 *
 *  Called on vault lock, on vault switch, and when the user leaves the review
 *  screen. Mirrors the host, which drops its half on the same events.
 *
 *  **The lock call sites are the load-bearing ones**, and this store shipped
 *  without them once: the store is module-scope, the manual lock path does not
 *  reload the WebView, and `proposal.edits` holds the anchors and replacements
 *  the model copied out of notes. Without a lock call site that plaintext
 *  outlives the lock and is still resident during the next session, including a
 *  different vault's. */
export function clearAgent(): void {
  // **Letting go of a run invalidates its in-flight step, and this is the case
  // that needs it most.** `beginRun()` nulls `view`, and only a settled step
  // sets it, so for the whole first leg a run is `running` with no id: nothing
  // can cancel it host-side, and without this bump the reply landed afterwards,
  // repopulated `proposal.edits` with its verbatim anchors, and made
  // `AgentReviewTakeover`'s derived `reviewable` true, opening a full-screen
  // review of a conversation the user had just deleted.
  runEpoch += 1;
  state = {
    ...INITIAL,
    // Kept, for the reason `setUndoable` states and `beginRun` repeats: closing
    // the review screen un-applies nothing. This used to spread `INITIAL`
    // wholesale, so it nulled the offer and made `clearAgentForLock`, whose
    // entire purpose is to null it, behave identically to this function. The
    // strip papered over it by re-reading the host whenever `applied` changed
    // identity, which is a different event and not always this one.
    undoable: state.undoable,
    rejected: new Set(),
    rejectedNewNotes: new Set(),
    appliedEdits: new Set(),
  };
  for (const l of listeners) l();
}

/** Drop everything INCLUDING the undo offer.
 *
 *  The lock and vault-switch variant. `clearAgent` deliberately keeps
 *  `undoable`, because closing the review screen does not un-apply anything; a
 *  lock is the case where keeping it would be wrong, since the record names note
 *  ids of a vault that is no longer open and the host has cleared its own copy
 *  by the same event. Separating the two is what stops "closing a screen" and
 *  "locking the vault" from being the same call. */
export function clearAgentForLock(): void {
  // The epoch bump comes from `clearAgent`, which every leaving path goes
  // through: a reply that lands after the teardown cannot repopulate the store.
  clearAgent();
  set({ undoable: null });
}

// ---- the vault-leaving epoch ------------------------------------------------
//
// **A step in flight outlives the lock that was supposed to end the run.**
// `agentStart` and `agentApproveScope` are awaited, and their replies carry a
// `Proposal` whose `edits` hold anchors and replacements copied verbatim out of
// note bodies. Nothing stopped that reply from landing after
// `clearAgentForLock()` had run, which would leave note-derived plaintext
// resident in a module-scope store past the event `docs/decisions/ai/0515` and
// `threat-model.md` §7 both say drops it.
//
// The chat store has carried exactly this guard since it shipped, for the same
// reason and under the same name. This is the agent half of it: a caller
// captures the epoch when it starts a leg and hands it back on settle, and a
// settle whose epoch has moved is dropped.

let runEpoch = 0;

/** The epoch to hand back to {@link settleStep}. Captured when a leg starts. */
export function currentRunEpoch(): number {
  return runEpoch;
}
