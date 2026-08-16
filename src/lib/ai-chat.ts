// Streaming chat IPC wrapper (conversational-ai-chat tasks 5/7). The thin TS
// binding for the local-inference `chat_stream` / `chat_stop` commands: it opens
// a Tauri `Channel<string>`, appends each streamed token to the active transcript
// turn, and finalizes with the citation set when generation ends. Mirrors the
// `ai-qa.ts` binding; adds no new capability or CSP origin.
//
// The question + streamed tokens are AS1-class RAM (the user's own words + the
// model's) — never logged here, dropped on lock by the chat store's teardown
// (`clearChat`).
//
// This used to say the Rust side runs the model locally, with "no provider
// call, no network". That has been false since the remote arm shipped (#414 /
// #415): `engine_for(RequestClass::UserInitiated)` can resolve to a named
// provider, and then this very call sends the framed question — grounded on
// note text — off the device. The guarantee is the narrower, true one: no byte
// leaves the device unless the user has named a provider, consented, and stored
// a key, which the host re-reads on every call (`RemoteEngine::ready`).

import { Channel, invoke } from "../platform/core";
import { normalizeProviderError } from "./engine-error";

import {
  appendChatToken,
  failChatTurn,
  finalizeChatTurn,
  getChat,
  sendChatMessage,
  type ChatCitation,
} from "../notes/ai/chatStore";
import { answeredByFromResponse } from "./ai-capability";

/** One prior-turn message sent to the backend as conversation history. Mirrors
 *  the Rust `ChatMessageDto` (role + content). */
export interface ChatHistoryMessage {
  role: "user" | "assistant";
  content: string;
}

/** Mirrors the Rust `SearchHit` (snake_case serde fields). */
interface RawSearchHit {
  note_id: string;
  byte_start: number;
  byte_end: number;
  score: number;
}

/** Mirrors the Rust `AskResult`. */
interface RawAskResult {
  answer: string;
  sources: RawSearchHit[];
  /** Which backend served THIS turn, reported by the request (myne#440). */
  served_by: { class: string; name: string | null };
}

/** Default number of grounding chunks to retrieve per turn (the Rust side is the
 *  binding authority; this is only the request hint). Mirrors `ASK_DEFAULT_K`. */
export const CHAT_DEFAULT_K = 10;

/**
 * Send a chat message over the resident (embedded) vault. Appends the user turn
 * + a streaming assistant turn to the transcript, opens a token `Channel`, and
 * streams the grounded answer into the active turn. Resolves when generation
 * completes; on error the turn flips to its error state; a Stop (or vault-lock)
 * mid-stream is handled by the store's run-epoch guard.
 *
 * This used to end "Local-only; never transmits the message anywhere". See the
 * module header: that has been false since the remote arm shipped, and the
 * true guarantee is narrower. No byte leaves the device unless the user has
 * named a provider, consented and stored a key, which the host re-reads on
 * every call.
 */
export async function sendChat(
  message: string,
  k: number = CHAT_DEFAULT_K,
  /** Unused since myne-md/myne#440: the attribution now comes from the response
   *  rather than from the caller's view of `vault.prefs`, which could not name
   *  the loopback runtime and could go stale between send and answer. Kept in
   *  the signature so the one call site does not have to change in the same
   *  commit; remove it when that site does. */
  _providerWire?: string | null,
): Promise<void> {
  // Snapshot the PRIOR turns as history before appending the new turn; drop any
  // empty turn so a blank assistant slot never enters the conversation.
  const history: ChatHistoryMessage[] = getChat()
    .turns.filter((turn) => turn.text.trim().length > 0)
    .map((turn) => ({ role: turn.role, content: turn.text }));

  const runToken = sendChatMessage(message);
  const channel = new Channel<string>();
  channel.onmessage = (token) => appendChatToken(runToken, token);

  try {
    const result = await invoke<RawAskResult>("plugin:local-inference|chat_stream", {
      question: message,
      history,
      k,
      onToken: channel,
    });
    const citations: ChatCitation[] = result.sources.map((s) => ({
      noteId: s.note_id,
      byteStart: s.byte_start,
      byteEnd: s.byte_end,
      score: s.score,
    }));
    // Reported BY the response (myne-md/myne#440). This used to fetch a fresh
    // capability report after the answer arrived and label the turn from the
    // CURRENT selection — so a backend switch mid-session relabelled turns a
    // different backend had produced, and the loopback arm rendered an empty
    // name because every name was derived from the remote provider's wire value.
    // Attribution of where a note's text went is a trust surface; it comes from
    // the request that actually sent it.
    finalizeChatTurn(runToken, citations, answeredByFromResponse(result.served_by));
  } catch (e) {
    // The backend error is a closed, DENY-safe KIND, and the kind is exactly
    // what the user needs (myne-md/myne#440). This used to discard it and render
    // one sentence, so "your API key is wrong" and "the provider is down" were
    // indistinguishable and neither suggested an action. `normalizeProviderError`
    // maps the closed tag; no detail string ever crosses.
    const cause = normalizeProviderError(e);
    // An empty completion is a RESULT, not a fault: the model was reached, it
    // answered, and the answer was nothing. It takes the same route a local
    // engine's empty finalization already takes, so the turn carries
    // `error: false` and the existing empty-answer placeholder renders it.
    //
    // Classified here rather than in the component, because the alternative is
    // to push it through the store as a failure and then un-fail it at render
    // time: two JSX conditions that have to stay exact complements, a boolean
    // whose meaning depends on a sibling string, and a third such cause needing
    // the same two-place edit.
    if (cause === "empty_completion") finalizeChatTurn(runToken, []);
    else failChatTurn(runToken, cause);
  }
}

/** Signal the active streaming generation to stop (composer "Stop", task 9).
 *  Best-effort; the store's `stopChatTurn` handles the UI-side transition. */
export async function stopChat(): Promise<void> {
  try {
    await invoke("plugin:local-inference|chat_stop");
  } catch {
    // Best-effort — nothing to surface if the stop signal fails to send.
  }
}
