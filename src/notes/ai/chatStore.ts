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

import { useSyncExternalStore } from "react";

import type { TagSuggestion } from "./tagRanker";

/** A source-note citation backing a grounded assistant answer (mirrors the Rust
 *  `SearchHit`; snake_case → camelCase at the IPC boundary). */
export interface ChatCitation {
  noteId: string;
  byteStart: number;
  byteEnd: number;
  score: number;
}

export type ChatRole = "user" | "assistant";

/** One transcript turn. Assistant turns carry the streaming / error / citation
 *  state; user turns are inert text. */
export interface ChatTurn {
  /** Stable React key (monotonic, store-assigned). */
  id: string;
  role: ChatRole;
  text: string;
  /** Assistant turn still receiving tokens. */
  streaming: boolean;
  /** Assistant turn ended in an error (no/failed generation). */
  error: boolean;
  /** Source notes the grounded answer drew from (assistant turns; may be empty). */
  citations: ChatCitation[];
  /** Auto-tag suggestions on an assistant "suggest tags" turn — each an explicit
   *  accept action (SYNC-17). Empty on ordinary chat/summary turns. (task 11) */
  tagSuggestions: TagSuggestion[];
  /** Whether this assistant turn can be inserted into the open note (summaries +
   *  any answer the user chooses to keep — SYNC-17 explicit action). (task 10) */
  insertable: boolean;
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
  | { type: "FINALIZE"; citations: ChatCitation[] }
  | { type: "FINALIZE_TAGS"; suggestions: TagSuggestion[] }
  | { type: "FAIL" }
  | { type: "STOP" }
  | { type: "CLEARED" };

/** Replace the last turn (assumed the streaming assistant turn) with `next`. */
function replaceLast(turns: ChatTurn[], next: ChatTurn): ChatTurn[] {
  return [...turns.slice(0, -1), next];
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
        role: "user",
        text: action.text,
        streaming: false,
        error: false,
        citations: [],
        tagSuggestions: [],
        insertable: false,
      };
      const assistantTurn: ChatTurn = {
        id: action.assistantId,
        role: "assistant",
        text: "",
        streaming: true,
        error: false,
        citations: [],
        tagSuggestions: [],
        insertable: action.insertable,
      };
      return { turns: [...state.turns, userTurn, assistantTurn], streaming: true };
    }
    case "TOKEN": {
      const last = state.turns[state.turns.length - 1];
      if (!last || last.role !== "assistant" || !last.streaming) return state;
      return {
        ...state,
        turns: replaceLast(state.turns, { ...last, text: last.text + action.text }),
      };
    }
    case "FINALIZE": {
      const last = state.turns[state.turns.length - 1];
      if (!last || last.role !== "assistant") return { ...state, streaming: false };
      return {
        turns: replaceLast(state.turns, {
          ...last,
          streaming: false,
          citations: action.citations,
        }),
        streaming: false,
      };
    }
    case "FINALIZE_TAGS": {
      const last = state.turns[state.turns.length - 1];
      if (!last || last.role !== "assistant") return { ...state, streaming: false };
      return {
        turns: replaceLast(state.turns, {
          ...last,
          streaming: false,
          tagSuggestions: action.suggestions,
        }),
        streaming: false,
      };
    }
    case "FAIL": {
      const last = state.turns[state.turns.length - 1];
      if (!last || last.role !== "assistant") return { ...state, streaming: false };
      return {
        turns: replaceLast(state.turns, { ...last, streaming: false, error: true }),
        streaming: false,
      };
    }
    case "STOP": {
      const last = state.turns[state.turns.length - 1];
      if (!last || last.role !== "assistant") return { ...state, streaming: false };
      // Keep the partial text the user chose to stop at.
      return {
        turns: replaceLast(state.turns, { ...last, streaming: false }),
        streaming: false,
      };
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

/** Close the active assistant turn with its citations, iff `token` is current. */
export function finalizeChatTurn(token: number, citations: ChatCitation[]): void {
  if (!isChatRunCurrent(token)) return;
  dispatchChat({ type: "FINALIZE", citations });
}

/** Close the active assistant turn with auto-tag suggestions (task 11), iff
 *  `token` is current. */
export function finalizeChatTags(token: number, suggestions: TagSuggestion[]): void {
  if (!isChatRunCurrent(token)) return;
  dispatchChat({ type: "FINALIZE_TAGS", suggestions });
}

/** Mark the active assistant turn as errored, iff `token` is current. */
export function failChatTurn(token: number): void {
  if (!isChatRunCurrent(token)) return;
  dispatchChat({ type: "FAIL" });
}

/** User cut the generation short — close the active turn, keep partial text. */
export function stopChatTurn(): void {
  dispatchChat({ type: "STOP" });
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
