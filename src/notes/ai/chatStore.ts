// Conversational AI chat transcript store (conversational-ai-chat task 6).
//
// The RAM home for the multi-turn chat transcript the AI Chat tab renders. Like
// `aiOutputStore`, this is an **AS1-class RAM artifact**: held only here, never
// persisted, and dropped on lock / vault teardown via `clearChat()` (a module
// store survives an Editor unmount on its own, so teardown is EXPLICIT — task 12
// wires the lock path). No plaintext is ever logged; the turns hold the user's
// own questions + the model's own words, same drop-on-lock discipline as the
// summarize output.
//
// Streaming (task 7): tokens arriving over the Tauri `Channel` append to the
// last (streaming) assistant turn via `appendChatToken`. A monotonic run epoch
// guards every terminal/append apply — a stream whose vault locked (or that was
// superseded) can never mutate the transcript after `clearChat()`.
//
// **Two kinds of turn, one transcript** (myne-md/myne#533). A `text` turn is the
// ask flow's: the user's question and the model's streamed words. An `agent`
// turn is an agentic edit run, which is not a stream at all: the host drives a
// whole loop and answers once, so what the turn holds is the run's identity and
// its COUNTS, never the proposal. The anchors and replacements are text copied
// verbatim out of note bodies, they live in `agentStore`, and they are dropped
// by `clearAgentForLock` on every vault-leaving path. Mirroring them here would
// put note plaintext behind a second teardown that would have to be remembered
// separately, which is the exact shape myne-md/myne#529 already shipped once.

import { useSyncExternalStore } from "react";
import type { ProviderErrorCause } from "../../lib/engine-error";
import type { AnsweredBy } from "../../components/AnsweredByIndicator";

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

/** What an agent turn keeps once its run is no longer the open one.
 *
 *  **Counts, plus the model's own closing sentence.** `agentStore` holds exactly
 *  one run, so a turn that is not the newest has no live state to read; this is
 *  what it says instead. Every field but `summary` is a number or a closed tag.
 *
 *  `summary` is the run's `finish` text, and it is here because in one mode it
 *  is the ANSWER (myne-md/myne#568, superseding the counts-only clause of
 *  `docs/decisions/ai/0518`). It is model output, so it can quote note text —
 *  and that is the same class this store already holds, since a `text` turn is
 *  the model's words about the open note. What is still excluded is the
 *  PROPOSAL: anchors and replacements are text copied verbatim out of note
 *  bodies, they stay in `agentStore`, and they are dropped by
 *  `clearAgentForLock`. This store's own teardown is `clearChat`, on the same
 *  roster and on the same paths, so nothing here outlives the unlocked
 *  session. */
export interface AgentTurnSummary {
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
  /** Notes the run read in full. */
  notesRead: number;
  /** Model round-trips. */
  iterations: number;
  /** Characters that left the device, or null when the run stayed local. The
   *  two are kept distinguishable all the way to the surface: "local" and
   *  "remote but nothing was sent" are different statements. */
  charsOffDevice: number | null;
  end: AgentTurnEnd;
}

/** One transcript turn. Assistant turns carry the streaming / error / citation
 *  state; user turns are inert text. */
export interface ChatTurn {
  /** Stable React key (monotonic, store-assigned). */
  id: string;
  /** Which flow produced it. Required rather than optional, so every
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
  | { type: "AGENT_FAIL"; message: string }
  | { type: "CLEARED" };

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
      next[i] = { ...turn, agentSummary: action.summary };
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
    default:
      return state;
  }
}

// ---- module-level store (drives Channel → render, cleared explicitly) --------

let current: ChatState = CHAT_INITIAL;
const listeners = new Set<() => void>();

// Monotonic id counter for turn keys — deterministic, no Date.now/random.
let turnSeq = 0;
function nextTurnId(): string {
  turnSeq += 1;
  return `t${turnSeq}`;
}

// Monotonic run epoch: a streaming run captures the epoch on SEND and only its
// TOKEN/FINALIZE/FAIL applies while the epoch is unchanged — so a run whose
// vault locked (clearChat bumps the epoch) can never mutate the transcript, and
// two overlapping runs can never interleave.
let runEpoch = 0;

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
}

/** Mark the active assistant turn as errored, iff `token` is current. */
export function failChatTurn(token: number, cause?: ProviderErrorCause): void {
  if (!isChatRunCurrent(token)) return;
  dispatchChat({ type: "FAIL", cause });
}

/** User cut the generation short — close the active turn, keep partial text. */
export function stopChatTurn(): void {
  dispatchChat({ type: "STOP" });
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
}

/** An agent run never started. `message` is already localized. */
export function failAgentTurn(message: string): void {
  dispatchChat({ type: "AGENT_FAIL", message });
}

/** Drop the whole transcript — the lock / vault-teardown wipe (task 12). Bumps
 *  the run epoch so any in-flight stream can no longer mutate the transcript. */
export function clearChat(): void {
  runEpoch += 1;
  dispatchChat({ type: "CLEARED" });
}

/** Test-only reset so the module store doesn't leak across tests. */
export function __resetChatForTest(): void {
  current = CHAT_INITIAL;
  listeners.clear();
  turnSeq = 0;
  runEpoch = 0;
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
