// Streaming chat IPC wrapper (conversational-ai-chat tasks 5/7). The thin TS
// binding for the local-inference `chat_stream` / `chat_stop` commands: it opens
// a Tauri `Channel<string>`, appends each streamed token to the active transcript
// turn, and finalizes with the citation set when generation ends. Mirrors the
// `ai-qa.ts` binding; adds no new capability or CSP origin.
//
// The question + streamed tokens are AS1-class RAM (the user's own words + the
// model's) — never logged here, dropped on lock by the chat store's teardown
// (`clearChat`). The Rust side runs the model locally: no provider call, no
// network (the no-egress gate is the structural guarantee).

import { Channel, invoke } from "../platform/core";

import {
  appendChatToken,
  failChatTurn,
  finalizeChatTurn,
  getChat,
  sendChatMessage,
  type ChatCitation,
} from "../notes/ai/chatStore";

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
}

/** Default number of grounding chunks to retrieve per turn (the Rust side is the
 *  binding authority; this is only the request hint). Mirrors `ASK_DEFAULT_K`. */
export const CHAT_DEFAULT_K = 10;

/**
 * Send a chat message over the resident (embedded) vault. Appends the user turn
 * + a streaming assistant turn to the transcript, opens a token `Channel`, and
 * streams the grounded answer into the active turn. Resolves when generation
 * completes; on error the turn flips to its error state; a Stop (or vault-lock)
 * mid-stream is handled by the store's run-epoch guard. Local-only; never
 * transmits the message anywhere (the no-egress gate is structural).
 */
export async function sendChat(message: string, k: number = CHAT_DEFAULT_K): Promise<void> {
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
    finalizeChatTurn(runToken, citations);
  } catch {
    // The backend error is a closed, DENY-safe kind — we surface only the error
    // turn state, never a detail string.
    failChatTurn(runToken);
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
