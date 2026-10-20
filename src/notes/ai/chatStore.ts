// Conversational AI chat transcript store.
//
// The RAM home for the multi-turn chat transcript the AI Chat tab renders. The
// transcript is ALSO persisted: every settled turn is written through to the
// `vault.chats` conversation store (myne-md/myne#675) at finalize time, and an
// unlock re-hydrates the active conversation back into this store. The RAM copy
// is still dropped on lock / vault teardown via `clearChat()` (a module store
// survives an Editor unmount on its own, so teardown is EXPLICIT), and the
// lock-teardown guards hold that wipe. What changed is that a second,
// encrypted, on-disk copy exists under the vault's key hierarchy. No plaintext
// is ever logged; the turns hold the user's own questions + the model's own
// words.
//
// Streaming: tokens arriving over the Tauri `Channel` append to the
// last (streaming) assistant turn via `appendChatToken`. A monotonic run epoch
// guards every terminal/append apply — a stream whose vault locked (or that was
// superseded) can never mutate the transcript after `clearChat()`.
//
// Persistence is a fire-and-forget listener, never inline IPC: terminal action
// creators call `notifySettled()` after dispatching, and the installed
// persister (wired by the AI tab mount, `chatPersist.ts`) serializes the
// transcript and writes it. A persist failure never breaks the chat. The
// persister deduplicates by payload, so a STOP followed by its late FINALIZE
// writes once.
//
// **Two kinds of turn, one transcript** (myne-md/myne#533). A `text` turn is the
// ask flow's: the user's question and the model's streamed words. An `agent`
// turn is an agentic edit run, which is not a stream at all: the host drives a
// whole loop and answers once, so what the turn holds is the run's identity and
// its COUNTS, never the proposal. The anchors and replacements are text copied
// verbatim out of note bodies, they live in `agentStore`, and they are dropped
// by `clearAgentForLock` on every vault-leaving path. The persisted
// conversation carries the turn list (including frozen agent summaries);
// proposals persist inside historical agent turns as read-only records and are
// never re-applied from history (myne-md/myne#675).

import { useSyncExternalStore } from "react";
import type { ProviderErrorCause } from "../../lib/engine-error";
import type { AnsweredBy } from "../../components/AnsweredByIndicator";
import type { Proposal } from "../../lib/agent-protocol";

/** A source-note citation backing a grounded assistant answer (mirrors the Rust
 *  `SearchHit`; snake_case → camelCase at the IPC boundary). */

export type ChatRole = "user" | "assistant";

/** Which flow produced a turn. See the module note for why the two are not the
 *  same shape. */
export type ChatTurnKind = "text" | "agent";

/** How an agent run ended, mirroring `LoopEnd`'s tag. A closed set of
 *  identifiers, so nothing here can carry model output. */
export type AgentTurnEnd =
  | "finished"
  | "awaitingScope"
  | "cancelled"
  | "exhaustedIterations"
  | "stalled";

/**
 * How the reader resolved a run's proposal (`AgentTurnSummary.outcome`).
 *
 * Two arms, because the card has exactly two ways out (myne-md/myne#894): it was
 * applied, or the reader rejected everything and the proposal was dropped. A
 * partial apply is `applied`, the rows that landed are the ones the count
 * reports, and the card stays open with its refusal block when some were refused.
 */
export type AgentRunOutcome = "applied" | "rejected";

/** What an agent turn keeps once its run is no longer the open one.
 *
 *  **Counts, plus the model's own closing sentence, plus the frozen proposal.**
 *  `agentStore` holds exactly one run, so a turn that is not the newest has no
 *  live state to read; this is what it says instead. Every field but `summary`
 *  is a number or a closed tag.
 *
 *  `summary` is the run's `finish` text, and it is here because in one mode it
 *  is the ANSWER (myne-md/myne#568, superseding the counts-only clause of
 *  `docs/decisions/ai/0518`). It is model output, so it can quote note text —
 *  and that is the same class this store already holds, since a `text` turn is
 *  the model's words about the open note.
 *
 *  `proposal` is the run's frozen proposal (edits + new notes, verbatim note
 *  text), copied at settle time and never touched again. The LIVE proposal
 *  stays in `agentStore` and is dropped by `clearAgentForLock`; the frozen
 *  copy persists inside the conversation and renders read-only in history.
 *  What is still excluded from the transcript is anything that would let a
 *  historical turn WRITE: there is no re-apply affordance anywhere, because a
 *  frozen proposal may quote a note that has since changed, been trashed, or
 *  moved folders (myne-md/myne#675). */
export interface AgentTurnSummary {
  /** How long the run took, in milliseconds, or absent when it cannot be known
   *  (a summary persisted before this field existed, or a run whose start was
   *  not recorded). Optional rather than defaulted to zero: "instant" and
   *  "unknown" are different statements, and the footprint renders them
   *  differently, the same discipline `charsOffDevice` keeps for null. */
  durationMillis?: number;
  runId: string;
  /** The model's closing summary, or "" when it finished without one.
   *
   *  In one mode this is what a question gets answered with, so an empty string
   *  and a sentence are genuinely different renderings rather than a presence
   *  check on decoration. */
  summary: string;
  /** Proposed edits to existing notes. */
  edits: number;
  /** Proposed new notes. */
  newNotes: number;
  /** Setting changes the run proposed (myne-md/myne#850, from the 2026-10-14
   *  review).
   *
   *  **Its own count, because the two surfaces that ask "did this run produce
   *  anything" were asking it of `edits + newNotes` alone**: a settings-only run
   *  rendered "The agent proposed no changes." on the chat strip and showed no
   *  count on the hub card, which is the exact "the change the model made is
   *  never shown" failure the review screen exists to prevent.
   *
   *  Optional so a turn persisted before this field existed reads as 0 rather
   *  than as `undefined`, which the two readers spell `?? 0`. */
  settings?: number;
  /** Notes the run read in full. */
  notesRead: number;
  /** Model round-trips. */
  iterations: number;
  /** Characters that left the device, or null when the run stayed local. The
   *  two are kept distinguishable all the way to the surface: "local" and
   *  "remote but nothing was sent" are different statements. */
  charsOffDevice: number | null;
  end: AgentTurnEnd;
  /**
   * What the reader decided about this run's proposal, once they have decided.
   *
   * **Absent means "not decided yet", and that is the honest reading of every
   * turn on disk today**: a proposal the user never reached (a lock, a reload, a
   * run they walked away from) leaves no outcome, and the line above the card
   * therefore keeps saying what was PROPOSED. Optional for the same reason
   * `settings` is: a turn persisted before this field existed reads as
   * undecided rather than as `undefined` everywhere.
   *
   * The count line is what reads it (myne-md/myne#894, on the user's read:
   * "after the decision it should say user rejected 3 changes / applied 3
   * changes; 'proposed' is only for the approval stage"), and the reason it has
   * to live HERE rather than in `agentStore` is that rejecting everything drops
   * the run: by the time the transcript shows the outcome there is no run left to
   * ask.
   */
  outcome?: AgentRunOutcome;
  /** Memory entries this run wrote (0 or 1, summed across resumes). Feeds the
   *  turn-end marker (myne-md/myne#697). */
  memoryUpdated?: number;
  /** The frozen proposal, present when the settled run proposed anything.
   *  A verbatim plain-data copy (`Pick` of the live `Proposal`), so later
   *  mutations of the live run cannot rewrite history. */
  proposal?: Pick<Proposal, "edits" | "newNotes">;
}

/** One transcript turn. Assistant turns carry the streaming / error / citation
 *  state; user turns are inert text. */
export interface ChatTurn {
  /** Stable React key (monotonic, store-assigned). */
  id: string;  /** Which flow produced it. Required rather than optional, so every
   *  construction site has to say which, because an `agent` turn that defaulted
   *  to `text` would be fed to the ask model as conversation history. */
  kind: ChatTurnKind;
  role: ChatRole;
  text: string;
  /** Assistant turn still receiving tokens. */
  streaming: boolean;
  /** Assistant turn ended in an error (no/failed generation). */
  error: boolean;
  /**
   * WHICH error (myne-md/myne#440). The Rust layer classifies provider failures
   * — auth, rate limit, model missing, network, cancelled — and `engine-error.ts`
   * already maps them; the chat call site used to discard the error entirely and
   * render one sentence, so "your API key is wrong" and "the provider is down"
   * were indistinguishable and neither suggested an action.
   *
   * Optional because a turn can fail before any cause is known.
   */
  errorCause?: ProviderErrorCause;
  /** Whether this assistant turn can be inserted into the open note (summaries +
   *  any answer the user chooses to keep — SYNC-17 explicit action). (task 10) */
  insertable: boolean;
  /**
   * Which backend produced this answer, captured when the turn CLOSED
   * (myne#191 task 4, SYNC-13).
   *
   * Stored per turn rather than read live at render, and that is the whole
   * requirement: switching provider must not retroactively re-label the answers
   * that came before it. `undefined` on a turn finalized by a path that has no
   * provenance to offer yet — the indicator renders nothing rather than an
   * empty line.
   */
  answeredBy?: AnsweredBy;
  /** The scope an agent-mode message was sent under, on the USER turn: "This
   *  note", or the folder's name. Present only for those. A run reads back as
   *  "I asked this, over that", which is the pairing the approval gate is
   *  about. */
  scopeLabel?: string;
  /** An agent turn's frozen counts. Absent while the run has not settled. */
  agentSummary?: AgentTurnSummary;
  /**
   * Opaque carry-through for turn fields this writer does not know
   * (forward tolerance): a newer writer's field survives a hydrate plus a
   * re-persist by an older frontend instead of being stripped cluster-wide
   * on merge. Never read, only re-emitted by `serializeTranscript`.
   */
  rest?: Record<string, unknown>;
}

export interface ChatState {
  turns: ChatTurn[];
  /** Whether a generation is currently active (drives the composer Stop state). */
  streaming: boolean;
}

export const CHAT_INITIAL: ChatState = { turns: [], streaming: false };

export type ChatAction =
  | {
      type: "SEND";
      userId: string;
      assistantId: string;
      text: string;
      insertable: boolean;
    }
  | { type: "TOKEN"; text: string }
  | { type: "FINALIZE"; answeredBy?: AnsweredBy }
  | { type: "FAIL"; cause?: ProviderErrorCause }
  | { type: "STOP" }
  | {
      type: "AGENT_SEND";
      userId: string;
      agentId: string;
      task: string;
      scopeLabel: string;
    }
  | { type: "AGENT_SETTLE"; summary: AgentTurnSummary }
  | { type: "AGENT_OUTCOME"; runId: string; outcome: AgentRunOutcome }
  | { type: "AGENT_FAIL"; message: string }
  | { type: "CLEARED" }
  | { type: "HYDRATED"; turns: ChatTurn[] };

/** Replace the last turn (assumed the streaming assistant turn) with `next`. */
function replaceLast(turns: ChatTurn[], next: ChatTurn): ChatTurn[] {
  return [...turns.slice(0, -1), next];
}

/** Whether a turn is the one an agent RUN renders into.
 *
 *  Both of a run's turns carry `kind: "agent"`, the task the user sent and the
 *  run itself, so the kind alone does not identify the writable one. */
function isAgentRunTurn(turn: ChatTurn): boolean {
  return turn.kind === "agent" && turn.role === "assistant";
}

/** The index of the newest agent RUN turn, or -1.
 *
 *  **Scanned backwards rather than assumed to be last**, and the case that
 *  needs it is real: a run that stops to ask for more scope has already settled
 *  its step, so the composer is live again and the user can send an ask message
 *  while the dialog is open. Approving the scope then settles the run a second
 *  time, and a `replaceLast` would write its counts onto the assistant turn of
 *  that unrelated question. */
function lastAgentIndex(turns: ChatTurn[]): number {
  for (let i = turns.length - 1; i >= 0; i -= 1) {
    if (isAgentRunTurn(turns[i]!)) return i;
  }
  return -1;
}

/** The turn an ask-stream terminal may close, or `null`.
 *
 *  **One predicate, four call sites.** Three of the arms below hand-wrote
 *  `last.kind !== "text"` and the fourth was covered by accident: `TOKEN` never
 *  touched an agent turn only because agent turns happen to be built with
 *  `streaming: false`. An invariant enforced three times explicitly and once
 *  incidentally is one that breaks silently the first time a turn kind arrives
 *  that can stream. */
function activeTextTurn(state: ChatState): ChatTurn | null {
  const last = state.turns[state.turns.length - 1];
  if (last === undefined || last.kind !== "text" || last.role !== "assistant") {
    return null;
  }
  return last;
}

/**
 * Pure transition. `SEND` appends a user turn + a fresh streaming assistant
 * turn; `TOKEN` appends decoded text to the active assistant turn; `FINALIZE`
 * closes it with its citations; `FAIL`/`STOP` close it (keeping any partial
 * text — `STOP` is the user cutting a rambling generation short); `CLEARED` is
 * the lock/teardown wipe.
 */
export function chatReducer(state: ChatState, action: ChatAction): ChatState {
  switch (action.type) {
    case "SEND": {
      const userTurn: ChatTurn = {
        id: action.userId,
        kind: "text",
        role: "user",
        text: action.text,
        streaming: false,
        error: false,
        insertable: false,
      };
      const assistantTurn: ChatTurn = {
        id: action.assistantId,
        kind: "text",
        role: "assistant",
        text: "",
        streaming: true,
        error: false,
        insertable: action.insertable,
      };
      return { turns: [...state.turns, userTurn, assistantTurn], streaming: true };
    }
    case "TOKEN": {
      const last = activeTextTurn(state);
      if (last === null || !last.streaming) return state;
      return {
        ...state,
        turns: replaceLast(state.turns, { ...last, text: last.text + action.text }),
      };
    }
    case "FINALIZE": {
      // The kind is part of the guard, not decoration: an agent turn is an
      // assistant turn too, and a late terminal from a superseded ask stream
      // would otherwise overwrite the run's turn with that stream's citations.
      const last = activeTextTurn(state);
      if (last === null) return { ...state, streaming: false };
      return {
        turns: replaceLast(state.turns, {
          ...last,
          streaming: false,
          answeredBy: action.answeredBy,
        }),
        streaming: false,
      };
    }
    case "FAIL": {
      const last = activeTextTurn(state);
      if (last === null) return { ...state, streaming: false };
      return {
        turns: replaceLast(state.turns, {
          ...last,
          streaming: false,
          error: true,
          errorCause: action.cause,
        }),
        streaming: false,
      };
    }
    case "STOP": {
      const last = activeTextTurn(state);
      if (last === null) return { ...state, streaming: false };
      // Keep the partial text the user chose to stop at.
      return {
        turns: replaceLast(state.turns, { ...last, streaming: false }),
        streaming: false,
      };
    }
    case "AGENT_SEND": {
      // **`agent`, not `text`, and the difference is what `ai-chat.ts` reads.**
      // This turn renders as an ordinary bubble, so marking it by how it LOOKS
      // was the obvious choice and the wrong one: `kind` says which flow
      // produced a turn, the history filter is keyed on that, and a task
      // addressed to the agent loop under a scope the chat call knows nothing
      // about would then have been sent to the ask model as conversation.
      // Rendering dispatches on the role instead, which is the question it was
      // really asking.
      const userTurn: ChatTurn = {
        id: action.userId,
        kind: "agent",
        role: "user",
        text: action.task,
        streaming: false,
        error: false,
        insertable: false,
        scopeLabel: action.scopeLabel,
      };
      // Not `streaming`, and `state.streaming` is left alone. That flag drives
      // the ask composer's Stop control, and an agent run is stopped through
      // `agentCancel` on the progress strip instead.
      const agentTurn: ChatTurn = {
        id: action.agentId,
        kind: "agent",
        role: "assistant",
        text: "",
        streaming: false,
        error: false,
        insertable: false,
      };
      return { ...state, turns: [...state.turns, userTurn, agentTurn] };
    }
    case "AGENT_SETTLE": {
      const i = lastAgentIndex(state.turns);
      const turn = state.turns[i];
      if (turn === undefined) return state;
      const next = [...state.turns];
      // Frozen on the way in, not by the caller: every settle passes through
      // this arm, including `settleAgentTurn`, so no dispatch site can hand
      // the transcript a live reference into `agentStore` by forgetting.
      const frozen = freezeSummary(action.summary);
      // **And a decision the turn already carries survives it** (myne-md/myne#894,
      // from review). This arm replaces the summary WHOLESALE, which is what a
      // settle means, and the decision marker is the one field on a settled turn
      // that must not be dropped by a later writer: `settleTurnInConversation`
      // (the hydrate path) applies a settle read from the conversation FILE,
      // asynchronously, so a reader who decides a run while that read-to-write is
      // in flight had it overwritten on disk. Same shape as `AGENT_OUTCOME`'s own
      // guard, one arm over, and the spec's "never unset or changed" rests on both.
      const priorOutcome = turn.agentSummary?.outcome;
      next[i] = {
        ...turn,
        agentSummary:
          priorOutcome === undefined ? frozen : { ...frozen, outcome: priorOutcome },
      };
      return { ...state, turns: next };
    }
    case "AGENT_OUTCOME": {
      // Matched by RUN ID rather than by position, unlike the settle arm above.
      // A settle happens once, from the run's own continuation, while the turn it
      // belongs to is the newest; a decision happens when the READER acts, and
      // they may have moved to another conversation in between, so the turn that
      // names this run is the one to write, wherever it is.
      const i = state.turns.findIndex(
        (t) => t.agentSummary?.runId === action.runId,
      );
      if (i === -1) return state;
      const turn = state.turns[i]!;
      // **The FIRST decision wins, and this arm is where that is enforced**
      // (myne-md/myne#894, from review). The field lands on a turn that has
      // already settled, which `docs/spec/protocol.md` §9.24.2 permits only
      // because it is MONOTONE, and the sync merge's decided-wins rule is
      // commutative only while at most one side of a turn is decided
      // (`conflict::merge_turn_content`). Both were false while this overwrote
      // unconditionally: a PARTIAL apply keeps the card open, so its Reject all
      // could write `rejected` over an `applied`, and two devices could then hold
      // different decisions for one turn id with no rule to reconcile them, which
      // is the CAS ping-pong the merge clause exists to close, reached by another
      // door. A decision is not revisable in this surface either: the counts line
      // reports what happened to the run, and the rows the reader turned down are
      // the card's own record of that.
      if (turn.agentSummary?.outcome !== undefined) return state;
      const next = [...state.turns];
      next[i] = {
        ...turn,
        agentSummary: { ...turn.agentSummary!, outcome: action.outcome },
      };
      return { ...state, turns: next };
    }
    case "AGENT_FAIL": {
      const i = lastAgentIndex(state.turns);
      const turn = state.turns[i];
      if (turn === undefined) return state;
      const next = [...state.turns];
      next[i] = { ...turn, text: action.message, error: true };
      return { ...state, turns: next };
    }
    case "CLEARED":
      return CHAT_INITIAL;
    case "HYDRATED":
      // A re-hydrated conversation replaces the empty transcript wholesale.
      // Streaming is forced off on every turn: only settled turns persist,
      // so a stored streaming flag would render a bubble with no run behind
      // it.
      return {
        turns: action.turns.map((t) => ({ ...t, streaming: false })),
        streaming: false,
      };
    default:
      return state;
  }
}

// ---- module-level store (drives Channel → render, cleared explicitly) --------

let current: ChatState = CHAT_INITIAL;
const listeners = new Set<() => void>();

// Turn-id scheme (myne-md/myne#675): `<boot>-<seq>`, where `boot` is 16 hex
// digits minted once per page load and `seq` is a zero-padded monotonic
// counter. The boot part is the client discriminator the sync merge orders
// by: two devices never mint the same id space (64 boot-entropy bits make a
// cross-device collision a non-event), and within one boot the ids sort in
// append order. Lexicographic order across boots is arbitrary but
// deterministic, which is all the merge needs; wall-clock ordering is
// deliberately NOT used (device clocks skew, and the merge layer refuses to
// trust them anywhere else in this codebase).
let turnSeq = 0;
const bootDiscriminator: string = mintBootDiscriminator();

/**
 * Mint the boot discriminator: 8 bytes (64 bits) from the platform CSPRNG,
 * with no fallback. This is not a secret (turn ids are visible in the UI),
 * but the id scheme's uniqueness argument rests on the bits being
 * unpredictable across devices, and `Math.random` does not provide that
 * (a seeded PRNG can collide across boots). Every environment this code
 * ships in (Tauri WebView, evergreen browsers) carries `crypto`; a missing
 * CSPRNG is an environment failure and fails loudly here rather than
 * silently minting collidable ids.
 */
function mintBootDiscriminator(): string {
  const bytes = new Uint8Array(8);
  if (typeof crypto === "undefined" || typeof crypto.getRandomValues !== "function") {
    throw new Error("crypto.getRandomValues unavailable: cannot mint chat turn ids");
  }
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

function nextTurnId(): string {
  turnSeq += 1;
  return `${bootDiscriminator}-${String(turnSeq).padStart(10, "0")}`;
}

// The conversation this transcript is bound to (`vault.chats` catalog id),
// or null when no conversation is open (fresh tab: the next settled turn
// creates one). Reset by `clearChat` together with the turns, so a wiped
// transcript can never keep writing into a conversation it no longer shows.
let activeConversationId: string | null = null;

/** Which persisted conversation the live transcript is bound to, if any. */
export function getActiveConversationId(): string | null {
  return activeConversationId;
}

/** Bind (or unbind) the live transcript to a persisted conversation. */
export function setActiveConversationId(id: string | null): void {
  activeConversationId = id;
}

/**
 * The note the NEXT conversation should be anchored to (myne-md/myne#771).
 *
 * The anchor is part of the conversation's catalog row, written at CREATE time,
 * so the note is captured before the first persist and read by `chatPersist`
 * when it calls `chatsCreate`. Held here rather than passed through the persist
 * queue because the queue's snapshot is captured at notify time from module
 * state, and the anchor must survive a retry exactly as the client id does.
 *
 * Cleared when a conversation binds (`setActiveConversationId`) and on the
 * vault-leaving paths, so an anchor set for a conversation that was never
 * created cannot leak into the next one.
 */
let pendingAnchorNoteId: string | null = null;

/** Set (or clear) the note the next created conversation is anchored to. */
export function setPendingAnchorNoteId(noteId: string | null): void {
  pendingAnchorNoteId = noteId;
}

/** Read the pending anchor without clearing it (the persist path reads it on
 *  every attempt of the same snapshot). */
export function getPendingAnchorNoteId(): string | null {
  return pendingAnchorNoteId;
}

/** Clear the pending anchor once a conversation has been created with it, or on
 *  any vault-leaving path. */
export function clearPendingAnchorNoteId(): void {
  pendingAnchorNoteId = null;
  pendingAnchorFolderId = null;
}

/**
 * The FOLDER a conversation is scoped to, when the run's scope was one
 * (myne-md/myne#848). A third anchor kind beside the note id, held and cleared
 * exactly the same way and for the same reasons: it is written into the catalog
 * row at create time, so it has to survive a retry, and an anchor set for a
 * conversation that was never created must not leak into the next one.
 *
 * A conversation has at most one of the two: a run is anchored to a note, to a
 * folder, or to neither (vault-general).
 */
let pendingAnchorFolderId: string | null = null;

/** Set (or clear) the folder the next created conversation is scoped to. */
export function setPendingAnchorFolderId(folder: string | null): void {
  pendingAnchorFolderId = folder;
}

/** Read the pending folder anchor without clearing it. */
export function getPendingAnchorFolderId(): string | null {
  return pendingAnchorFolderId;
}

/** Clear the pending folder anchor once a conversation has been created with it. */
export function clearPendingAnchorFolderId(): void {
  pendingAnchorFolderId = null;
}

// The persistence listener: called after every terminal reduce (finalize,
// fail, stop, agent settle/fail) and once from `clearChat` after settling a
// cut-off stream. Fire-and-forget by contract: the implementation
// (`chatPersist.ts`, installed by the AI tab mount) serializes the transcript
// and writes it, deduplicates identical payloads, and swallows IPC failures
// so a persist failure never breaks the chat. Null in tests and wherever no
// persister was installed.
let persister: (() => void) | null = null;

/** Install (or remove) the persistence listener. */
export function setChatPersister(p: (() => void) | null): void {
  persister = p;
}

function notifySettled(): void {
  try {
    persister?.();
  } catch {
    // The chat must survive its own persistence layer failing.
  }
}

// Monotonic run epoch: a streaming run captures the epoch on SEND and only its
// TOKEN/FINALIZE/FAIL applies while the epoch is unchanged — so a run whose
// vault locked (clearChat bumps the epoch) can never mutate the transcript, and
// two overlapping runs can never interleave.
let runEpoch = 0;

/**
 * Monotonic CONVERSATION epoch: bumped once per conversation BOUNDARY — the
 * transcript being wiped (`clearChat`, `discardChat`) or replaced with another
 * conversation's turns (`hydrateChatTurns`, which is what `openConversation`
 * calls).
 *
 * **Why it is not `runEpoch`.** That one bumps on those three too, and also on
 * every SEND: a follow-up message inside the same conversation is a new run and
 * not a new conversation. A consumer that reset per-conversation state on it
 * would throw that state away between two messages the user sees as one thread.
 *
 * **What it is for.** The composer's attached scope is per conversation and
 * lives in the composer's own `useState`, which outlives a conversation switch
 * because nothing remounts it — the rail swaps the transcript under a composer
 * that stays exactly where it is. So a folder attached in one conversation was
 * still attached in the next one, and in the one after that: every new chat
 * started scoped to a folder the user picked once, silently, with the previous
 * conversation's grant (myne-md/myne#771). The transcript is what changed, so
 * the transcript is what says so.
 */
let conversationEpoch = 0;

/** The current conversation-boundary count. */
export function getConversationEpoch(): number {
  return conversationEpoch;
}

/** Bump it and tell the store's subscribers.
 *
 *  Notifies DIRECTLY rather than leaning on the dispatch beside every call
 *  site: `dispatchChat` returns early when the reducer hands back the same
 *  state, and CLEARED over an already-empty transcript does exactly that. That
 *  is not a corner — it is "new conversation" pressed twice, or pressed on a
 *  fresh tab — and on that path the boundary would be invisible to everything
 *  watching. A second notify from the dispatch that follows is free:
 *  `useSyncExternalStore` re-renders on the VALUE, not on the call. */
function bumpConversationEpoch(): void {
  conversationEpoch += 1;
  for (const l of listeners) l();
}

/** Current store snapshot (referentially stable until a dispatch). */
export function getChat(): ChatState {
  return current;
}

/** Apply an action + notify subscribers. */
export function dispatchChat(action: ChatAction): void {
  const next = chatReducer(current, action);
  if (next === current) return;
  current = next;
  for (const l of listeners) l();
}

/** Whether `token` is still the active run (no newer run / clear since). */
export function isChatRunCurrent(token: number): boolean {
  return token === runEpoch;
}

/** Start a new turn: append the user message + a streaming assistant turn,
 *  invalidate any in-flight run, and return this run's token. `insertable` marks
 *  the assistant turn as "Insert into note"-able (summaries — task 10). */
export function sendChatMessage(text: string, opts?: { insertable?: boolean }): number {
  runEpoch += 1;
  dispatchChat({
    type: "SEND",
    userId: nextTurnId(),
    assistantId: nextTurnId(),
    text,
    insertable: opts?.insertable ?? false,
  });
  return runEpoch;
}

/** Append a streamed token to the active assistant turn, iff `token` is current. */
export function appendChatToken(token: number, text: string): void {
  if (!isChatRunCurrent(token)) return;
  dispatchChat({ type: "TOKEN", text });
}

/** Close the active assistant turn, iff `token` is current.
 *
 *  It used to take the citation set the Ask flow retrieved. Ask is gone
 *  (myne-md/myne#552) and the one remaining producer of a text turn is the
 *  summarize flow, which grounds on the open note rather than on a retrieval,
 *  so there was nothing left to cite. */
export function finalizeChatTurn(token: number, answeredBy?: AnsweredBy): void {
  if (!isChatRunCurrent(token)) return;
  dispatchChat({ type: "FINALIZE", answeredBy });
  notifySettled();
}

/** Mark the active assistant turn as errored, iff `token` is current. */
export function failChatTurn(token: number, cause?: ProviderErrorCause): void {
  if (!isChatRunCurrent(token)) return;
  dispatchChat({ type: "FAIL", cause });
  notifySettled();
}

/** User cut the generation short — close the active turn, keep partial text. */
export function stopChatTurn(): void {
  dispatchChat({ type: "STOP" });
  notifySettled();
}

/** Append an agent run's turns: the user's task (carrying the scope it was sent
 *  under) and the turn the run renders into.
 *
 *  **The run epoch is deliberately NOT bumped.** It exists so a superseded or
 *  locked-out ask stream cannot mutate the transcript, and an agent run is a
 *  different channel with its own cancellation. Bumping it here would silently
 *  kill an ask generation the user did not stop. */
export function sendAgentTurn(task: string, scopeLabel: string): void {
  dispatchChat({
    type: "AGENT_SEND",
    userId: nextTurnId(),
    agentId: nextTurnId(),
    task,
    scopeLabel,
  });
}

/** Freeze a settled run's counts onto its turn.
 *
 *  Called once per settle, from the two places a step settles, rather than from
 *  a render. Overwrites rather than merging, so a run that resumes after a
 *  scope approval reports the later numbers. */
export function settleAgentTurn(summary: AgentTurnSummary): void {
  dispatchChat({ type: "AGENT_SETTLE", summary });
  notifySettled();
}

/**
 * Record what the reader decided about a settled run's proposal.
 *
 * Called from the surface that owns both stores (`ConversationSurface`) when the
 * card reports a decision, never from a render: the outcome is a fact about an
 * act, and the turn it lands on is found by run id.
 */
export function markAgentTurnOutcome(runId: string, outcome: AgentRunOutcome): boolean {
  // **Returns whether the ACTIVE transcript held the turn**, because the caller
  // may have navigated away while the apply round trip was in flight
  // (myne-md/myne#894 review). The reducer matches by run id inside the active
  // conversation, so a miss used to be a silent `return state`: no dispatch, no
  // persist, and the decision gone while the notes were already written. The
  // caller routes a miss to the conversation the RUN started in, the same way
  // `settleTurnInConversation` routes a settle.
  const present = current.turns.some((t) => t.agentSummary?.runId === runId);
  if (!present) return false;
  dispatchChat({ type: "AGENT_OUTCOME", runId, outcome });
  // **`notifySettled`, because this IS a settle** (myne-md/myne#894, from the
  // review). It is the only path that persists the transcript, and every other
  // terminal writer in this file calls it. Without it the decision reached RAM
  // and nothing else: on the reject path, which drops the run and ends the
  // interaction, no later settle was coming, so the field usually never landed at
  // all, and the reason it lives on the turn rather than in the store was
  // exactly that the store's copy goes with the run.
  notifySettled();
  return true;
}

/**
 * Deep-copy the summary's proposal (if any) into plain data, so the settled
 * turn can never alias the live run: a later mutation of `agentStore`'s
 * proposal (resume, re-run, clear) must not rewrite what history shows. The
 * JSON round trip is the freeze: it keeps every field the protocol defines
 * today and tomorrow with no field list to drift, and rejects nothing (a
 * freeze that throws would break the settle it rides on).
 */
function freezeSummary(summary: AgentTurnSummary): AgentTurnSummary {
  if (summary.proposal === undefined) return summary;
  const frozen = JSON.parse(
    JSON.stringify({ edits: summary.proposal.edits, newNotes: summary.proposal.newNotes }),
  ) as Pick<Proposal, "edits" | "newNotes">;
  return { ...summary, proposal: frozen };
}

/** An agent run never started. `message` is already localized. */
export function failAgentTurn(message: string): void {
  dispatchChat({ type: "AGENT_FAIL", message });
  notifySettled();
}

/** Drop the whole transcript — the lock / vault-teardown wipe (task 12). Bumps
 *  the run epoch so any in-flight stream can no longer mutate the transcript.
 *
 *  Before the wipe, an in-flight stream settles its partial text (the STOP
 *  close, which keeps what arrived) and the persister writes it: a lock that
 *  cuts a generation must not silently discard the words that arrived before
 *  it (myne-md/myne#675). The RAM copy still dies here (the lock-teardown
 *  guards hold the wipe) while the settled turn survives on disk. */
export function clearChat(): void {
  const active = activeTextTurn(current);
  if (active !== null && active.streaming) {
    dispatchChat({ type: "STOP" });
    notifySettled();
  }
  activeConversationId = null;
  // A new chat is a new conversation, so it starts with no anchor. Without
  // this, starting a fresh chat on a different note would keep the previous
  // note's anchor (myne-md/myne#771).
  pendingAnchorNoteId = null;
  pendingAnchorFolderId = null;
  runEpoch += 1;
  bumpConversationEpoch();
  dispatchChat({ type: "CLEARED" });
}

/**
 * Drop the whole transcript WITHOUT persisting: the delete-open path
 * (`ChatHistoryModal` after a successful `chatsDelete`). The transcript is
 * gone by user intent, so a persist of it would write deleted turns back
 * (and fail against the fresh tombstone, stashing stale state and raising a
 * spurious persist warning). Like `clearChat` otherwise: unbinds, bumps the
 * epoch so in-flight streams cannot repopulate, wipes. Callers drop the
 * persist module's state (`clearChatPersistForLock`) alongside.
 */
export function discardChat(): void {
  activeConversationId = null;
  pendingAnchorNoteId = null;
  pendingAnchorFolderId = null;
  runEpoch += 1;
  bumpConversationEpoch();
  dispatchChat({ type: "CLEARED" });
}

/** Replace the transcript with a re-hydrated conversation (unlock path).
 *  Bumps the epoch so anything older than the hydrate cannot mutate it. */
export function hydrateChatTurns(turns: ChatTurn[]): void {
  runEpoch += 1;
  bumpConversationEpoch();
  dispatchChat({ type: "HYDRATED", turns });
}

/** Test-only reset so the module store doesn't leak across tests. */
export function __resetChatForTest(): void {
  activeConversationId = null;
  pendingAnchorNoteId = null;
  pendingAnchorFolderId = null;
  persister = null;
  current = CHAT_INITIAL;
  listeners.clear();
  turnSeq = 0;
  runEpoch = 0;
  conversationEpoch = 0;
}

/** Subscribe to store changes; returns an unsubscribe. */
export function subscribeChat(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** React binding: the live transcript, re-rendering on every dispatch. */
export function useChat(): ChatState {
  return useSyncExternalStore(subscribeChat, getChat, getChat);
}

/** React binding: the conversation-boundary count. A component holding state
 *  that belongs to ONE conversation keys an effect on it. */
export function useConversationEpoch(): number {
  return useSyncExternalStore(
    subscribeChat,
    getConversationEpoch,
    getConversationEpoch,
  );
}
