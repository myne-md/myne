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

/** Read the run state. */
export function useAgent(): AgentState {
  return useSyncExternalStore(
    subscribe,
    () => state,
    () => state,
  );
}

/** Non-hook read, for callers outside a component. */
export function getAgent(): AgentState {
  return state;
}

/** A run is starting. */
export function beginRun(): void {
  set({
    ...INITIAL,
    running: true,
    rejected: new Set(),
    rejectedNewNotes: new Set(),
    appliedEdits: new Set(),
  });
}

/** A step came back. */
export function settleStep(result: {
  view: AgentRunView;
  proposal: Proposal;
  end: LoopEnd;
  iterations: number;
  notesRead: number;
  charsOffDevice: number | null;
  excludedCount: number;
}): void {
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

/** An apply finished.
 *
 *  `applied` accumulates rather than replaces: a second apply that overwrote the
 *  first would erase the earlier refusals from the screen, which is the one
 *  outcome the user most needs to keep reading. */
export function settleApply(
  result: AgentApplyResult,
  appliedIndices: number[],
): void {
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
}

/** The host's answer to "is there a run I could still undo?".
 *
 *  Set from `agentLastRun()`, never inferred. Deliberately survives
 *  `clearAgent()`: closing the review screen ends the PROPOSAL, and the applied
 *  notes are still applied. What ends it is the host clearing its own record,
 *  which happens on the next apply and on vault lock. */
export function setUndoable(run: AppliedRun | null): void {
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
  state = {
    ...INITIAL,
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
  clearAgent();
  set({ undoable: null });
}
