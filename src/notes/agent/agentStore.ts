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
  ProposedSetting,
} from "../../lib/agent-protocol";
import { hasRefusals } from "../../lib/agent-protocol";
import { resetConversationBinding } from "../ai/conversationBinding";

/** The client's prefs-changed nonce bump (myne-md/myne#850).
 *
 *  **A binding rather than an import, because the nonce is per client.** This
 *  module is aliased into the mobile tree (`mobile/vite.config.ts`, which states
 *  the invariant this line used to break: "`agentStore.ts` imports only React and
 *  the protocol module"), and the two clients have different nonce modules:
 *  desktop's `usePrefs` subscribes to `src/notes/prefsNonce`, mobile's to
 *  `mobile/src/lib/prefsNonce`. Importing desktop's module here bumped a module
 *  nothing on the phone listens to, so a setting the agent changed would land in
 *  `vault.prefs` while every mounted reader kept rendering the value it replaced.
 *  The undo carries the same binding for the same reason, one file over
 *  (`useUndoLastRun`'s `UndoBindings.bumpPrefsNonce`, whose comment records it).
 *
 *  Installed by each client's agent-run seam (`src/lib/agent-run.ts`,
 *  `mobile/src/lib/agent-run.ts`). Deliberately NOT defaulted to a no-op: an
 *  unwired client must say so at the first setting change rather than render a
 *  stale preference forever, which is the failure this whole line prevents. */
let clientPrefsNonceBump: (() => void) | null = null;

/** Install THIS client's prefs-nonce bump, once, at the client's agent seam. */
export function setAgentPrefsNonceBump(bump: () => void): void {
  clientPrefsNonceBump = bump;
}

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
  /** When the run started, on the wall clock, for the footprint's duration.
   *
   *  A duration is the one part of "what did this run do" the user can see
   *  without reading a number: "40 notes, 12 requests" says nothing about
   *  whether it was a nuisance. Wall clock rather than monotonic because the
   *  settled figure has to survive being persisted onto a turn and read back on
   *  another day; a monotonic reading means nothing outside its own process. */
  startedAtMillis: number | null;
  /** The conversation this run belongs to, or null when it could not be bound
   *  (the persist that creates one failed, and the queue still owes the write).
   *
   *  **Ownership, not bookkeeping** (myne-md/myne#848). The run outlives the
   *  surface that started it, so a user who navigates to another conversation
   *  mid-run has a run still in flight whose result belongs to a conversation
   *  that is no longer on screen. This is the id that result is written to, and
   *  the id the hub marks as running. */
  runConversationId: string | null;
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
  /**
   * Indices into `proposal.newNotes` whose create LANDED (myne-md/myne#913).
   *
   * The per-row answer this store was missing: the type's own comment on
   * `applyWasCleanAndComplete` called it "the honest per-row fix", because
   * without it the only question available was the approved COUNT versus
   * `notesCreated.length`, and counts stay equal while membership diverges. The
   * reported defect was the visible half of that: after a successful apply the
   * card still offered "Approve 1 change" beside "2 changes applied", and
   * pressing it re-sent an index the host had already consumed.
   */
  appliedNewNotes: ReadonlySet<number>;
  /** Indices into `proposal.settings` the user has rejected
   *  (myne-md/myne#850). Same convention as the two above, and it is the reason
   *  a settings-only run can be reviewed at all: without it the dialog has no
   *  per-row state to render. */
  rejectedSettings: ReadonlySet<number>;
  /** Indices into `proposal.edits` already written by a previous apply. Kept so
   *  an applied row renders as applied rather than staying pressable: a second
   *  apply would fail its anchor and report `anchorNotFound` for an edit that in
   *  fact succeeded, which is the inverse of the confusion this screen exists to
   *  prevent. */
  appliedEdits: ReadonlySet<number>;
  /** Indices into `proposal.settings` already written by a previous apply
   *  (myne-md/myne#850). The settings half of `appliedEdits`, for the same
   *  reason: an applied row must render as applied rather than staying
   *  pressable, and the completeness rule below reads it. */
  appliedSettings: ReadonlySet<number>;
  /** The result of the last apply, or null. */
  applied: AgentApplyResult | null;
  /** How many applies this session has settled. Monotonic, and it SURVIVES
   *  `clearAgent` (myne-md/myne#596).
   *
   *  **The one thing that still moves when a run is applied and dropped in the
   *  same write.** `useUndoLastRun` (mounted by the chat surfaces for the turn
   *  revert affordance) re-reads the host's undo record whenever an apply lands,
   *  and it used to key that on `applied?.applied`. Since a clean,
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
   *  mount and never on a control change (`docs/decisions/ai/0518` point 2,
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
  /**
   * **Conversations with a finished run the user has not looked at**
   * (myne-md/myne#848).
   *
   * ── The failure this closes ─────────────────────────────────────────────
   * A run outlives the view by design: it keeps going while the user reads
   * another note, opens another conversation, or leaves the AI surface
   * entirely. Nothing said so when it landed. The rail's card showed a RUNNING
   * line and nothing else, so a conversation whose run had just finished looked
   * exactly like one that had never run, and the answer, or the proposed
   * edits, sat in a conversation the user had no reason to reopen.
   *
   * ── Why it is HERE rather than derived from `end` ────────────────────────
   * `end` survives until the next run or the vault lock, so a mark derived from
   * it would come back the moment the user switched away from the conversation,
   * however long ago they had read it. The missing fact is the second one:
   * whether the user has SEEN this result. That is a set, and it belongs beside
   * the run that produced it: it is set by a settle and cleared by looking,
   * both of which this store is the record of.
   *
   * It is a SET rather than a single id because the store holds one live run:
   * a second conversation's run replaces the first's `end`, and the first's
   * result is still unread.
   *
   * Cleared by `clearAgentForLock`, NOT by `clearAgent`: closing the review
   * screen is not a vault-leaving event, and the other conversations' results
   * are as unread as they were. */
  unreadConversations: readonly string[];
}

const EMPTY_PROPOSAL: Proposal = { edits: [], newNotes: [], summary: "" };

const INITIAL: AgentState = {
  view: null,
  proposal: EMPTY_PROPOSAL,
  end: null,
  running: false,
  startedAtMillis: null,
  runConversationId: null,
  iterations: 0,
  notesRead: 0,
  charsOffDevice: null,
  excludedCount: 0,
  memoryUpdated: 0,
  rejected: new Set(),
  rejectedNewNotes: new Set(),
  appliedNewNotes: new Set(),
  rejectedSettings: new Set(),
  appliedEdits: new Set(),
  appliedSettings: new Set(),
  applied: null,
  applySeq: 0,
  autoApply: false,
  probeVerdict: null,
  autoApplying: false,
  undoable: null,
  error: null,
  unreadConversations: [],
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
 *  `docs/decisions/ai/0515` promises; merely starting a second run ends
 *  neither. Resetting it here dropped the previous run's offer from the surface
 *  while the host still held it, so the undo the user had been told about
 *  became unreachable by the ordinary act of asking for something else.
 *
 *  `conversationId` is REQUIRED rather than defaulted (myne-md/myne#848). A
 *  default would let a new call site start a run with no owner, and the failure
 *  is silent in the direction that matters: the settle would fall back to
 *  "whatever is on screen", which is the bug this parameter exists to remove.
 *  Pass `null` deliberately when the conversation could not be created, the
 *  caller that knows is `startAgentRun`, and it says so in words. */
export function beginRun(conversationId: string | null): void {
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
  legBase = { iterations: 0, notesRead: 0, charsOffDevice: null };
  set({
    ...INITIAL,
    runConversationId: conversationId,
    startedAtMillis: Date.now(),
    undoable: state.undoable,
    // Kept for the same reason `undoable` is: a new run is not a vault-leaving
    // event, and the user chose this mode for the session rather than for one
    // message.
    autoApply: state.autoApply,
    // Same: the backend has not changed because a second run started, and
    // re-probing would spend the provider requests again for every message.
    probeVerdict: state.probeVerdict,
    // Same, and this is the call site `clearAgent`'s note is about: starting a
    // run says nothing about whether the OTHER conversations' results have been
    // read, and `INITIAL` carries the empty set, so a run start used to wipe
    // every mark on every message.
    unreadConversations: state.unreadConversations,
    running: true,
    rejected: new Set(),
    rejectedNewNotes: new Set(),
  appliedNewNotes: new Set(),
    rejectedSettings: new Set(),
    appliedEdits: new Set(),
    appliedSettings: new Set(),
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

/** A run settled for this conversation and the user has not looked at it yet.
 *
 *  Called for EVERY settled run, including one that lands while its own
 *  conversation is open: `ConversationSurface` clears the mark whenever it is
 *  displaying the conversation, so "is the user looking at it" is answered by
 *  the surface that would know rather than guessed at here from an id
 *  comparison. Guessing was wrong in the case this field exists for, the run
 *  completing while the AI surface is closed but that conversation is still the
 *  active one. */
export function markConversationUnread(conversationId: string): void {
  if (state.unreadConversations.includes(conversationId)) return;
  set({
    unreadConversations: [...state.unreadConversations, conversationId],
  });
}

/** The user is looking at this conversation: the result has been seen.
 *
 *  Called by `ConversationSurface` while it displays the conversation, so the
 *  rule is "a mark exists only while nothing is showing it". **Not by the rail**
 *  (review finding): the doc claimed a rail call that does not exist, and the
 *  difference is visible in one case, opening the conversation that is ALREADY
 *  the bound one, where the surface never mounts and the mark would stay. */
export function markConversationRead(conversationId: string): void {
  if (!state.unreadConversations.includes(conversationId)) return;
  set({
    unreadConversations: state.unreadConversations.filter(
      (id) => id !== conversationId,
    ),
  });
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

/** Toggle one proposed setting change's rejection (myne-md/myne#850). */
export function toggleSetting(index: number): void {
  const next = new Set(state.rejectedSettings);
  if (next.has(index)) next.delete(index);
  else next.add(index);
  set({ rejectedSettings: next });
}

/** The setting changes the user has NOT rejected and that no apply has landed,
 *  in proposal order. This is what the apply sends.
 *
 *  `appliedSettings` is filtered for the same reason `keptEdits` filters
 *  `appliedEdits`: a row that landed must not be sent again, or the second apply
 *  reports a write that in fact succeeded. */
export function keptSettings(s: AgentState = state): ProposedSetting[] {
  return (s.proposal.settings ?? []).filter(
    (_, i) => !s.rejectedSettings.has(i) && !s.appliedSettings.has(i),
  );
}

/** The run the user still has to review, or `null` (myne-md/myne#529,
 *  myne-md/myne#894).
 *
 *  **Moved here verbatim from the review takeover this replaced rather than copied**,
 *  because
 *  there is now one thing that decides it and it is not a mount: the review moved
 *  out of a full-screen dialog and into the conversation, so the surface that
 *  shows it is an ordinary transcript turn and the rule has to be readable from
 *  wherever the transcript renders. Two copies is how the turn and the card come
 *  to disagree about whether a run is still open.
 *
 *  A run is reviewable once it has STOPPED, has not stopped to ASK, has something
 *  to show and is not applying itself:
 *
 *  - `end !== null || error !== null`: a settled run leaves a proposal its user is
 *    entitled to see, whatever the end kind (`finished`, `cancelled`,
 *    `exhaustedIterations`, `stalled`), and a FAILED leg is the same shape, it
 *    records `error` and leaves `end` alone (myne-md/myne#848).
 *  - `awaitingScope` excluded: a run paused on a question is not a run to review,
 *    and the scope dialog must not be buried under a review of a proposal the
 *    model has not finished making.
 *  - something proposed: a question is a run too, so "it stopped" is not the same
 *    fact as "there is something to review" (myne-md/myne#568). One edit, one new
 *    note or one setting change is enough; a settings-only run is a proposal
 *    (myne-md/myne#850).
 *  - `!autoApplying`: an automatic run would otherwise show the surface it exists
 *    to skip for the frames between the step settling and the apply returning
 *    (myne-md/myne#551). */
export function reviewableRun(s: AgentState = state): { runId: string } | null {
  if (s.view === null || s.running || s.autoApplying) return null;
  if (s.end === null && s.error === null) return null;
  if (s.end?.kind === "awaitingScope") return null;
  const proposed =
    s.proposal.edits.length > 0 ||
    s.proposal.newNotes.length > 0 ||
    (s.proposal.settings?.length ?? 0) > 0;
  if (!proposed) return null;
  return { runId: s.view.runId };
}

/** The indices of new notes the user has NOT rejected and that have not already
 *  been created. This is what the apply sends; a note that is not in it is not
 *  created. */
export function approvedNewNoteIndices(s: AgentState = state): number[] {
  return s.proposal.newNotes
    .map((_, i) => i)
    .filter((i) => !s.rejectedNewNotes.has(i) && !s.appliedNewNotes.has(i));
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
 *  that is the caller, and not an effect in the card, is argued
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
  // fire and the run is not dropped. Mirrors `reviewableRun` above, which needs
  // a proposal for the same reason (myne-md/myne#568). **A settings-only run
  // counts** (myne-md/myne#850): it is a proposal, and the card renders for it,
  // so leaving it out here would make the card stick open on a run that has
  // nothing left to do.
  if (
    s.proposal.edits.length === 0 &&
    s.proposal.newNotes.length === 0 &&
    (s.proposal.settings?.length ?? 0) === 0
  ) {
    return false;
  }
  if (s.error !== null) return false;
  if (hasRefusals(applied)) return false;
  if (keptEdits(s).length > 0) return false;
  // The settings half of the completeness rule, and it reads the same
  // subtraction `keptEdits` does: a setting is resolved when the user rejected it
  // or an apply landed it.
  if (keptSettings(s).length > 0) return false;
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

/**
 * Which of the SENT new-note indices actually landed.
 *
 * **The new-note twin of `landedEditIndices`, and it was missing for the same
 * reason that one exists.** `settleApply` was handed the SENT list, so a create
 * the host refused at apply time (an unsafe title, an excluded folder, a write
 * failure) was recorded as `applied`: the row rendered "Created" and
 * `approvedNewNoteIndices` filtered it out, so that note could never be
 * re-approved for the life of the run. Found in the review of myne-md/myne#913,
 * one round after the fix that introduced it.
 *
 * `apply.rs` defines `RefusedNewNote::index` as the position in the run's
 * PROPOSAL new-note list, which is the same space `sent` is expressed in, so the
 * subtraction is direct rather than positional (unlike `landedEditIndices`,
 * whose refusals are indexed against the approved list).
 */
export function landedNewNoteIndices(
  sent: number[],
  outcome: Pick<AgentApplyResult, "refusedNewNotes">,
): number[] {
  const refused = new Set(outcome.refusedNewNotes.map((r) => r.index));
  return sent.filter((i) => !refused.has(i));
}

/**
 * The setting rows that actually LANDED, as indices into the PROPOSAL.
 *
 * **The twin of `landedEditIndices`, added because the settings half shipped
 * without it and reproduced the defect that function was extracted for**
 * (myne-md/myne#850, found by review). The screen passed the indices it SENT, so
 * a setting the host refused landed in `appliedSettings`, its row rendered
 * disabled as "Already applied", and `keptSettings` filtered it out: the user
 * could see a refusal they could never retry, on the screen whose whole premise
 * is informed approval.
 *
 * **Three index spaces meet here and only one pairing is right.** `sent` is the
 * approved list in the order it went to the host, and `refusedSettings[].index`
 * numbers THAT list, so `sent[index]` is the refused row. `appliedSettings`
 * holds indices into the PROPOSAL, because that is what the row components key
 * on, so the return value is proposal indices too. Matching the refusal by
 * `intentId` as well as by index is belt and braces: two rows naming the same
 * intent in one proposal is degenerate, and if it happened BOTH would be treated
 * as not landed (both stay retryable), which is the safe direction: the user
 * sees a row they can retry rather than one they cannot.
 */
export function landedSettingIndices(
  proposalSettings: readonly ProposedSetting[],
  sent: readonly ProposedSetting[],
  outcome: Pick<AgentApplyResult, "refusedSettings">,
): number[] {
  const refusedIntentIds = new Set(
    (outcome.refusedSettings ?? [])
      .map((r) => sent[r.index]?.intentId)
      .filter((id): id is string => id !== undefined),
  );
  return sent
    .map((setting) => proposalSettings.indexOf(setting))
    .filter(
      (index) =>
        index >= 0 && !refusedIntentIds.has(proposalSettings[index].intentId),
    );
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
 *  the card first, deriving from state the way that surface derives
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
  appliedSettingIndices: number[] = [],
  /**
   * The new-note indices the caller SENT (myne-md/myne#913). A landed create is
   * RESOLVED, not pending: excluding it is what stops the card offering an
   * approval for a note the host has already written.
   *
   * Required in practice at BOTH call sites. It carries a default because the
   * signature predates the automatic path's creates, and the first version of
   * this comment claimed that path "sends no new notes" while
   * `autoApplyRun` sends `approvedNewNoteIndices(agent)`, a comment that made a
   * forgotten call site look wired. Both sites pass it now.
   */
  appliedNewNoteIndices: number[] = [],
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
        // Settings accumulate like everything else here: a run can apply twice,
        // and the report the user reads is the whole run's (myne-md/myne#850).
        settingsChanged: [
          ...(state.applied.settingsChanged ?? []),
          ...(result.settingsChanged ?? []),
        ],
        refusedSettings: [
          ...(state.applied.refusedSettings ?? []),
          ...(result.refusedSettings ?? []),
        ],
      }
    : result;
  const nextApplied = new Set(state.appliedEdits);
  for (const i of appliedIndices) nextApplied.add(i);
  const nextAppliedSettings = new Set(state.appliedSettings);
  for (const i of appliedSettingIndices) nextAppliedSettings.add(i);
  const nextAppliedNewNotes = new Set(state.appliedNewNotes);
  for (const i of appliedNewNoteIndices) nextAppliedNewNotes.add(i);
  set({
    appliedNewNotes: nextAppliedNewNotes,
    applied: merged,
    appliedEdits: nextApplied,
    appliedSettings: nextAppliedSettings,
    applySeq: state.applySeq + 1,
  });
  // **The prefs nonce, bumped here because a setting write happens HOST-side**
  // (myne-md/myne#850). Every other `vault.prefs` writer goes through the TS
  // `writePref`, which is the one path that bumps the nonce every mounted
  // `usePrefs` subscribes to. The agent's settings write goes through the Rust
  // setter, so nothing on this side would know a preference moved: Settings
  // would keep rendering the old value and the open editor would keep the old
  // format until some unrelated event re-read. Same rule as any out-of-band
  // writer (`notes/flushBeforeFrontmatterWrite.ts` states it for note bodies),
  // and here rather than at the call site because `settleApply` is the one
  // writer every apply path passes through.
  //
  // **Through the client's own binding, not an import**: the nonce module is
  // per client (see `setAgentPrefsNonceBump`). A client that never installed one
  // fails here rather than silently keeping the stale value.
  if ((result.settingsChanged?.length ?? 0) > 0) {
    if (clientPrefsNonceBump === null) {
      throw new Error(
        "agentStore: no prefs-nonce bump is installed, so a setting change would " +
          "leave every mounted prefs reader on the value it replaced. Call " +
          "setAgentPrefsNonceBump from this client's agent-run seam.",
      );
    }
    clientPrefsNonceBump();
  }
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
  // `reviewableRun` true, opening the card
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
    // value by the time React looked, and `useUndoLastRun` would never re-read
    // the host. That is the defect this field was added to fix; resetting it here
    // would reintroduce it at the one call site that matters.
    applySeq: state.applySeq,
    // Kept, and this is the call site that would quietly break it: letting go
    // of a run happens when the review screen closes and when a new
    // conversation starts, and neither means the OTHER conversations' results
    // have been read. Clearing here would make a mark disappear because the
    // user read something else.
    unreadConversations: state.unreadConversations,
    rejected: new Set(),
    rejectedNewNotes: new Set(),
  appliedNewNotes: new Set(),
    rejectedSettings: new Set(),
    appliedEdits: new Set(),
    appliedSettings: new Set(),
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
  // **And the conversation binding** (myne-md/myne#913): the pin and the
  // deferred switch are session state, and a lock ends the session. Dropped here
  // rather than in the panel because the panel is unmounted on most tabs and a
  // lock is the one event that must not depend on it being mounted.
  resetConversationBinding();
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
  // **And the unread marks.** They name conversations of the vault being left:
  // the next vault's ids are different ones, so a mark that survived would
  // describe a conversation that does not exist and could never be cleared by
  // reading it.
  set({
    undoable: null,
    autoApply: false,
    autoApplying: false,
    probeVerdict: null,
    unreadConversations: [],
  });
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
