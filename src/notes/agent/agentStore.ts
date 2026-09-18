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
  ProbeVerdict,
  Proposal,
  ProposedEdit,
} from "../../lib/agent-protocol";
import { hasRefusals } from "../../lib/agent-protocol";

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
  /** Memory entries this run wrote (0 or 1 per step, summed across resumes). */
  memoryUpdated: number;
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
  /** How many applies this session has settled. Monotonic, and it SURVIVES
   *  `clearAgent` (myne-md/myne#596).
   *
   *  **The one thing that still moves when a run is applied and dropped in the
   *  same write.** `UndoLastRun` re-reads the host's undo record whenever an
   *  apply lands, and it used to key that on `applied?.applied`. Since a clean,
   *  complete apply now settles and calls `clearAgent` inside one
   *  {@link settleApply} call, React's store subscription only ever sees the
   *  final state: `applied` is back to null and the count reads 0 to 0, so the
   *  effect never fired, `agentLastRun()` was never called, and the undo strip
   *  did not appear at all. Caught by `agent-run.e2e.ts` ag1 and ag4, which is
   *  what running that suite is for.
   *
   *  It is also strictly better than the count it replaces, which could not
   *  tell "no apply yet" from "an apply that landed nothing because every edit
   *  was refused": both read 0. */
  applySeq: number;
  /** Whether a finished run applies itself (myne-md/myne#551).
   *
   *  **Session-scoped on purpose, and reset on lock and on vault switch.** A
   *  persisted "write without asking" setting is one that gets turned on once
   *  and forgotten, and persisting it would mean a `PrefsView` field: the
   *  encoder, the parser, the sync classification table, the merge passthrough
   *  and `protocol.md` §9.5.2, i.e. a protocol spec change for a UI
   *  preference. `beginRun` and `clearAgent` keep it, like `undoable`, because
   *  neither is a vault-leaving event. */
  autoApply: boolean;
  /** Whether the configured backend can hold the anchored edit format,
   *  `"failed"` when the probe itself could not be answered, or null when it has
   *  not been asked yet (myne-md/myne#568).
   *
   *  **Here rather than in `ChatComposer`'s own state, and the reason is what
   *  asking costs.** With a remote provider the probe issues
   *  `threshold.attempts` requests to that provider, measured at 8 seconds in
   *  the session that found this. Component state dies with the component, and
   *  `AiChatTab` mounts conditionally on the right panel's active tab, so
   *  switching that tab away and back paid for the whole probe again, as did
   *  every restart. The verdict is a fact about the backend, not about a run.
   *
   *  It does NOT change WHEN the probe fires: still on the first Send, never on
   *  mount and never on a control change (`design-notes/ai/0518` point 2,
   *  TB13). What changes is only how long one answer lives.
   *
   *  Kept by `beginRun` and `clearAgent` for the reason `autoApply` is, and
   *  dropped by `clearAgentForLock`: the AI provider settings live in
   *  `vault.prefs`, so the next vault can be configured against a different
   *  backend and this verdict would be a claim about the previous one. */
  probeVerdict: ProbeVerdict | "failed" | null;
  /** True from the moment a run's automatic apply is decided until it settles.
   *
   *  It exists so the review dialog never flashes: without it a finished run is
   *  `reviewable` for the frames between the step settling and the apply
   *  returning, so an automatic run would open the full screen it exists to
   *  skip and then close it. */
  autoApplying: boolean;
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
  memoryUpdated: 0,
  rejected: new Set(),
  rejectedNewNotes: new Set(),
  appliedEdits: new Set(),
  applied: null,
  applySeq: 0,
  autoApply: false,
  probeVerdict: null,
  autoApplying: false,
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

/** What LEGS THAT HAVE ALREADY SETTLED contributed to the three cost figures.
 *
 *  A run is driven in legs, `agent_start`, then one `agent_approve_scope` per
 *  scope expansion, and each leg's host-side counters start at zero. The live
 *  report carries the CURRENT leg's running totals, so the displayed figure is
 *  this base plus that report. Without the split, a second leg's first report
 *  would replace the first leg's total rather than continue it, and the
 *  disclosure figure would fall as the run progressed. That is the one
 *  direction it must never move in.
 *
 *  Module-scope rather than a store field because nothing renders it, and a
 *  public field that is not a fact about the surface is a field somebody
 *  renders by mistake. It is reset wherever the counters are. */
let legBase = { iterations: 0, notesRead: 0, charsOffDevice: null as number | null };

/** A run is starting.
 *
 *  **`undoable` is carried over, and that is not tidiness.** The host's record
 *  is ended by the next APPLY or by the vault lock, which is what
 *  `design-notes/ai/0515` promises; merely starting a second run ends
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
  // `design-notes/ai/0515` names as the compensating control for the uncapped
  // remote arm, so a merged total is a false statement about how much left the
  // device rather than a mislabel.
  runEpoch += 1;
  legBase = { iterations: 0, notesRead: 0, charsOffDevice: null };
  set({
    ...INITIAL,
    undoable: state.undoable,
    // Kept for the same reason `undoable` is: a new run is not a vault-leaving
    // event, and the user chose this mode for the session rather than for one
    // message.
    autoApply: state.autoApply,
    // Same: the backend has not changed because a second run started, and
    // re-probing would spend the provider requests again for every message.
    probeVerdict: state.probeVerdict,
    running: true,
    rejected: new Set(),
    rejectedNewNotes: new Set(),
    appliedEdits: new Set(),
  });
}

/** The host created the run, and said so while it is still working.
 *
 *  `beginRun()` nulls `view`, and before myne-md/myne#544 only a settled step
 *  set it — so for the whole first leg the run was `running` with no id, which
 *  is the state `clearAgent`'s note below describes and the state
 *  `AgentProgress` cannot render at all. This is that gap closed: the strip
 *  mounts, the running scope total is shown (which its own module note says is
 *  continuous), and Stop has an id to send.
 *
 *  `running` deliberately stays true: this is not a step settling, it is the
 *  same step reporting that it started. Returns whether it was applied, and
 *  takes the epoch for the reason `settleStep` states in full — a run the user
 *  let go of mid-flight must not repopulate the store behind them.
 *
 *  **Required epoch, never defaulted.** A default would compare the current
 *  epoch to itself and pass unconditionally, which is the opt-in-guard shape
 *  the root `AGENTS.md` records. */
export function openRun(view: AgentRunView, epoch: number): boolean {
  if (epoch !== runEpoch) return false;
  set({ view });
  return true;
}



/** The host reports what the current leg has cost so far (myne-md/myne#456).
 *
 *  Called once per model round-trip, from the channel `agentStart` and
 *  `agentApproveScope` open. Epoch-checked for the reason `settleStep` states:
 *  a run the user let go of mid-flight must not write figures over the one that
 *  replaced it, and the disclosure figure is exactly the number where a merged
 *  total would be a false statement rather than a cosmetic one.
 *
 *  Does NOT touch `running`, `view`, `proposal` or `end`. This is a report
 *  about a run in flight, not a step settling. */
export function reportRunProgress(
  progress: { iterations: number; notesRead: number; charsOffDevice: number | null },
  epoch: number,
): boolean {
  if (epoch !== runEpoch) return false;
  set({
    iterations: legBase.iterations + progress.iterations,
    notesRead: legBase.notesRead + progress.notesRead,
    // Null plus a figure is that figure, and null plus null stays null, the
    // same rule `settleStep` applies, for the same reason: "the run stayed on
    // this device" and "the run is remote and has sent nothing" are different
    // statements.
    charsOffDevice:
      progress.charsOffDevice === null
        ? legBase.charsOffDevice
        : (legBase.charsOffDevice ?? 0) + progress.charsOffDevice,
  });
  return true;
}

/** Choose whether a finished run applies itself.
 *
 *  Session-scoped: see the field's own note for why this is not a preference. */
export function setAutoApply(on: boolean): void {
  set({ autoApply: on });
}

/** Record what the edit-format probe answered.
 *
 *  Session-scoped: the field's own note says where it is kept and where it is
 *  dropped. There is deliberately no way to clear it to `null` from here — the
 *  only thing that unasks the question is leaving the vault. */
export function setProbeVerdict(verdict: ProbeVerdict | "failed"): void {
  set({ probeVerdict: verdict });
}

/** Mark that this run's automatic apply has been decided.
 *
 *  Set BEFORE the step settles, which is the whole point: the review dialog
 *  derives `reviewable` from a settled run, so a flag raised afterwards would
 *  let the screen open for the frames before the apply returns. */
export function beginAutoApply(): void {
  set({ autoApplying: true });
}

/** The automatic apply is over, whether it wrote anything or not. */
export function endAutoApply(): void {
  set({ autoApplying: false });
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
    memoryUpdated: number;
  },
  epoch: number,
): boolean {
  if (epoch !== runEpoch) return false;
  // **Accumulated onto the LEG BASE, not onto the displayed value**
  // (myne-md/myne#456). The live report has already advanced the displayed
  // figures to `legBase + this leg's running total`, and `result` carries that
  // same leg total, so adding it to the display would count the whole leg
  // twice. Folding it into the base instead leaves the displayed figure exactly
  // where the last report put it and leaves the next leg somewhere correct to
  // start from. With no reports at all, a host that passes no channel, or a
  // leg that stopped before its first round-trip: the base is still zero and
  // this reduces to the accumulation it replaced.
  legBase = {
    iterations: legBase.iterations + result.iterations,
    notesRead: legBase.notesRead + result.notesRead,
    // Null plus a figure is that figure, not null: a run that resumes onto a
    // remote provider after a local first leg did send something, and reporting
    // nothing would be the wrong half of the truth.
    charsOffDevice:
      result.charsOffDevice === null
        ? legBase.charsOffDevice
        : (legBase.charsOffDevice ?? 0) + result.charsOffDevice,
  };
  set({
    view: result.view,
    proposal: result.proposal,
    end: result.end,
    iterations: legBase.iterations,
    notesRead: legBase.notesRead,
    charsOffDevice: legBase.charsOffDevice,
    excludedCount: result.excludedCount,
    memoryUpdated: (getAgent().memoryUpdated ?? 0) + (result.memoryUpdated ?? 0),
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
  // **`end` goes too, and that is the whole fix** (myne-md/myne#559). The
  // scope-expansion dialog derives its visibility from
  // `end?.kind === "awaitingScope"`, so leaving `end` alone kept it mounted
  // while the approval was in flight: the user pressed Allow, nothing appeared
  // to happen, and the second press raced the first. The run is no longer
  // awaiting anything the moment the approval is sent, which is exactly what
  // `running: true` beside it says.
  set({ running: true, error: null, end: null });
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

/** Whether the applies so far left nothing to read and nothing to do
 *  (myne-md/myne#596).
 *
 *  The predicate the review dialog closes itself on. Two halves, and both are
 *  required, because each alone closes over something the user needed.
 *
 *  **Clean**: no refusal, of either kind. A refused edit is precisely what the
 *  review screen exists to show. `anchorNotFound` and `anchorAmbiguous` mean a
 *  change the user approved did NOT land, so a rule that closed over one would
 *  be the inverse of the confusion this screen prevents.
 *
 *  **Nothing failed**: `error` is null. A whole-call apply failure is strictly
 *  worse than a per-edit refusal, it is the only signal the user has that a
 *  write they asked for did not happen, and both surfaces that render it
 *  (`agentReview.error` and `agentProgress.error`) go with the run.
 *
 *  **Complete**: every proposal row is resolved. For edits that is
 *  {@link keptEdits} being empty, which is the same filter the actionable list
 *  uses: an edit is resolved when the user rejected it or an apply landed it.
 *
 *  A run with no apply yet is not complete, whatever else is true of it. That is
 *  the `applied === null` arm, and it is what stops an empty proposal or a
 *  freshly settled run from being read as finished.
 *
 *  **A new note holds the review while it still matters**: while one is
 *  approved and not yet written, and while any note was created. A new note the
 *  user rejected and nothing created leaves neither a pending write nor an
 *  unreversible one, so it holds nothing. That is blunter than the edit half,
 *  which answers per row.
 *
 *  Two reasons, and the second is the load-bearing one. The store tracks
 *  `appliedEdits` but has no `appliedNewNotes`, so a per-row answer is not
 *  available here: an earlier version compared the approved COUNT against
 *  `notesCreated.length`, and counts can stay equal while membership diverges
 *  (reject one, restore another), which closes over a note the user approved
 *  and nothing wrote. And `agentReview.createdCount` is the only surface in the
 *  whole client that says the agent created notes: the undo strip counts
 *  `restorePoints`, which a create has none of. Closing over a create therefore
 *  destroys the one report of the least reversible thing an agent run does.
 *
 *  The honest per-row fix is `created_new_note_indices`, which the host already
 *  computes in `core/src/plugins/agent/apply.rs` and `#[serde(skip)]`s. Bringing
 *  it across IPC is a change to a shared crate for a case this clause already
 *  answers safely, so it is not done here and the narrowing is recorded on
 *  myne-md/myne#596 rather than left to be inferred from this comment.
 *
 *  One more limit, stated because it is a decision: `applied.refused`
 *  ACCUMULATES across applies, by {@link settleApply}'s own design, so a
 *  refusal anywhere in a run's history holds the dialog even after the user
 *  re-applies that row successfully. That is the safe direction, and also the
 *  one that misses the users with the most rows to work through.
 *
 *  A selector, not a writer. Its one caller is {@link settleApply}; the reason
 *  that is the caller, and not an effect in `AgentReviewTakeover`, is argued
 *  there. It lives beside {@link landedEditIndices} for the reason that
 *  function states about its own subtraction: a call site is not testable, and
 *  each of the five checks below is worth failing by name.
 *
 *  All four were verified the way `AGENTS.md` requires, by deletion rather than
 *  by a green run, and the refusal check is why that matters. A refused edit is
 *  not in `appliedEdits`, so it is still in `keptEdits`: the obvious test for a
 *  refusal therefore answers on the completeness check instead, and the FIRST
 *  draft of these specs stayed green with the refusal check deleted. They now
 *  reject the refused row before asserting, which resolves it and leaves the
 *  refusal as the only thing answering, so deleting that check reddens two of
 *  them by name (`tests/notes/agentReviewAutoClose.test.ts`). */
export function applyWasCleanAndComplete(s: AgentState = state): boolean {
  const applied = s.applied;
  if (applied === null) return false;
  // Nothing to review means there is no review to close, so the rule does not
  // fire and the run is not dropped. Mirrors `AgentReviewTakeover`'s own
  // `reviewable`, which needs a proposal for the same reason (myne-md/myne#568).
  if (s.proposal.edits.length === 0 && s.proposal.newNotes.length === 0) {
    return false;
  }
  if (s.error !== null) return false;
  if (hasRefusals(applied)) return false;
  if (keptEdits(s).length > 0) return false;
  return approvedNewNoteIndices(s).length === 0 && applied.notesCreated.length === 0;
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
 *  outcome the user most needs to keep reading.
 *
 *  **And it DROPS THE RUN when the apply left nothing to decide**
 *  (myne-md/myne#596). Surprising for a function called `settle`, so it is said
 *  here rather than left to be discovered: a clean, complete apply ends the
 *  review, and this write is where that happens.
 *
 *  **An APPLY is the only thing that may close the review, and that is the
 *  whole reason this lives here.** The rule was written as a `useEffect` in
 *  `AgentReviewTakeover` first, deriving from state the way that file derives
 *  OPEN, and it reached one state too many. `keptEdits` counts a REJECTED edit
 *  as resolved, so after any clean apply had left one row outstanding, a single
 *  click on that row's Reject button satisfied the rule and the effect dropped
 *  the whole proposal: no confirmation, no undo, and the control the user
 *  pressed is the one whose other direction is labelled Restore. That is the
 *  same "stray Escape that throws the model's work away" the takeover's own
 *  header bans backdrop and Escape dismissal to prevent. Reaching a rejection
 *  had looked like the derivation's advantage; it was the defect.
 *
 *  Three more things follow from being here rather than in a passive effect,
 *  each of which was a real finding against the effect version:
 *
 *   1. **No frame of `ApplyReport`.** `autoApplyRun` calls `settleApply` and
 *      `endAutoApply` in one synchronous continuation, so React commits them
 *      together: `applied` set, `autoApplying` already false, and the dialog
 *      myne-md/myne#551 exists to skip mounts, arms its focus trap and paints
 *      before a passive effect can tear it down. Measured at one render. The
 *      drop being part of this write means that commit never exists.
 *   2. **No epoch bump from a stale read.** `clearAgent` bumps `runEpoch`, and
 *      an effect acts on a value computed a commit earlier, so a `beginRun`
 *      landing in that window was wiped by the previous run's teardown. Here
 *      the guard above has already run.
 *   3. **No StrictMode double-invoke**, which doubled that bump in dev.
 *
 *  Both apply paths pass through this one writer, `AgentReview.apply` and
 *  `agentToChat.ts::autoApplyRun`, so the rule is still inherited by any future
 *  path that applies, which is the property the derivation was reaching for. */
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
  set({ applied: merged, appliedEdits: nextApplied, applySeq: state.applySeq + 1 });
  // Asked of the state this write just produced, not of `merged` alone: the
  // rule reads `rejected`, `appliedEdits` and `error` too. Every caller's
  // remaining work reads locals rather than the store, so the epoch bump
  // `clearAgent` makes here races nothing.
  if (applyWasCleanAndComplete()) clearAgent();
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
  // that needs it most.** `beginRun()` nulls `view`, and until myne-md/myne#544
  // only a settled step set it, so for the whole first leg a run was `running`
  // with no id: nothing could cancel it host-side. `openRun` closes that window
  // to the first channel message, and the epoch bump is still what covers the
  // rest — without it the reply landed afterwards,
  // repopulated `proposal.edits` with its verbatim anchors, and made
  // `AgentReviewTakeover`'s derived `reviewable` true, opening a full-screen
  // review of a conversation the user had just deleted.
  runEpoch += 1;
  // Reset with the counters it accompanies. A base that outlived a cleared
  // store would make the NEXT run's first live report start from the previous
  // run's total, which is the merged-figure defect `beginRun`'s note above
  // describes, arriving by a different door.
  legBase = { iterations: 0, notesRead: 0, charsOffDevice: null };
  state = {
    ...INITIAL,
    // Kept for the reason `beginRun` states: closing the review screen is not
    // a vault-leaving event either.
    autoApply: state.autoApply,
    // Same, and this is the call site that matters most for it: closing the
    // review screen comes through here, so dropping the verdict would make
    // every review cost the next message a fresh probe.
    probeVerdict: state.probeVerdict,
    // Kept, for the reason `setUndoable` states and `beginRun` repeats: closing
    // the review screen un-applies nothing. This used to spread `INITIAL`
    // wholesale, so it nulled the offer and made `clearAgentForLock`, whose
    // entire purpose is to null it, behave identically to this function. The
    // strip papered over it by re-reading the host whenever `applied` changed
    // identity, which is a different event and not always this one.
    undoable: state.undoable,
    // Kept because it is a SESSION counter, not run state, and because this is
    // the call site that would break it: a clean, complete apply settles and
    // clears in one write, so a counter reset here would be back to its old
    // value by the time React looked, and `UndoLastRun` would never re-read the
    // host. That is the defect this field was added to fix; resetting it here
    // would reintroduce it at the one call site that matters.
    applySeq: state.applySeq,
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
  // **And the automatic-apply mode**, which `clearAgent` deliberately keeps.
  // The mode says a finished run may write without a second act, and the act
  // that granted it was the user choosing it while this vault was open. A lock
  // ends that session, so carrying the choice into the next unlock would let a
  // run write into a vault the user has not chosen it for (myne-md/myne#551).
  // **And the probe verdict**, for a different reason than the mode's: it is a
  // claim about the CONFIGURED BACKEND, the AI provider settings live in
  // `vault.prefs`, and the next vault opened can be configured against another
  // provider entirely. Carrying it over would gate agent mode on a measurement
  // of a backend that is no longer the one in use, in either direction: a
  // refusal earned by the previous vault's model would block a capable one, and
  // a pass would let the composer skip the check on a model nobody measured.
  set({
    undoable: null,
    autoApply: false,
    autoApplying: false,
    probeVerdict: null,
  });
}

// ---- the vault-leaving epoch ------------------------------------------------
//
// **A step in flight outlives the lock that was supposed to end the run.**
// `agentStart` and `agentApproveScope` are awaited, and their replies carry a
// `Proposal` whose `edits` hold anchors and replacements copied verbatim out of
// note bodies. Nothing stopped that reply from landing after
// `clearAgentForLock()` had run, which would leave note-derived plaintext
// resident in a module-scope store past the event `design-notes/ai/0515` and
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
