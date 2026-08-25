// Summarize → chat-transcript orchestration (conversational-ai-chat task 10).
// Folds the note-scoped summarize capability into the single conversational
// transcript: a user turn ("Summarize this note") + an assistant turn carrying
// the text summary and its "Insert into note" action. Reuses the SAME pure
// `runSummarize` pipeline as the former `runSummarizeToStore` — only the render
// target moves from the standalone `aiOutputStore` to the chat transcript.
//
// Tag suggestion used to live here too, as a second chat turn carrying accept
// chips. MYND-651 retired that surface: tags now render in the inline
// suggestion band at the frontmatter boundary, which is the single tag surface.
//
// The transcript is AS1-class RAM, dropped on lock (`clearChat`). No plaintext is
// logged here (the summary is the model's own words).

import type { EditorState } from "@codemirror/state";

import {
  appendChatToken,
  failChatTurn,
  finalizeChatTurn,
  sendChatMessage,
} from "./chatStore";
import { runSummarize } from "./summarize";

/**
 * Summarize the open note **as a chat turn** (task 10). Appends a "Summarize
 * this note" user turn + a streaming assistant turn, runs the blocking
 * `runSummarize` pipeline, and finalizes the turn with the summary (marked
 * insertable, so the per-turn "Insert into note" action appears — SYNC-17). The
 * chat store's run-epoch guard drops the result if the vault locked mid-run.
 */
export async function runSummarizeToChat(args: {
  state: EditorState;
  budget: number;
  infer: (prompt: string) => Promise<string>;
}): Promise<void> {
  const token = sendChatMessage("Summarize this note", { insertable: true });
  try {
    const outcome = await runSummarize({
      state: args.state,
      budget: args.budget,
      infer: args.infer,
    });
    appendChatToken(token, outcome.summary);
    finalizeChatTurn(token);
  } catch {
    // Engine error is a closed kind on the Rust side (DENY-list); the turn shows
    // its bounded error state, never the raw failure.
    failChatTurn(token);
  }
}
