// Summarize / tag-suggest → chat-transcript orchestration (conversational-ai-chat
// tasks 10 + 11). Folds the two note-scoped AI capabilities into the single
// conversational transcript: each runs as a user turn ("Summarize this note" /
// "Suggest tags for this note") + an assistant turn — a text summary (with an
// "Insert into note" action) or a set of tag accept-chips. Reuses the SAME pure
// pipelines (`runSummarize`, `runTagSuggestionPass`) as the former
// `runSummarizeToStore` / `runTagSuggestToStore` — only the render target moves
// from the standalone `aiOutputStore` / `tagSuggestStore` to the chat transcript.
//
// The transcript is AS1-class RAM, dropped on lock (`clearChat`). No plaintext is
// logged here (the summary / tags are the model's own words).

import type { EditorState } from "@codemirror/state";

import {
  appendChatToken,
  failChatTurn,
  finalizeChatTags,
  finalizeChatTurn,
  sendChatMessage,
} from "./chatStore";
import { runSummarize } from "./summarize";
import { runTagSuggestionPass } from "./suggestTags";

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
    finalizeChatTurn(token, []);
  } catch {
    // Engine error is a closed kind on the Rust side (DENY-list); the turn shows
    // its bounded error state, never the raw failure.
    failChatTurn(token);
  }
}

/**
 * Suggest tags for the open note **as a chat turn** (task 11). Appends a "Suggest
 * tags for this note" user turn + a streaming assistant turn, runs the
 * exclusion-gated `runTagSuggestionPass`, and finalizes the turn carrying the
 * ranked suggestions as accept-chips (each an explicit accept action, SYNC-17).
 * An excluded-folder note yields an empty (chip-less) turn, not an error.
 */
export async function runTagSuggestToChat(args: {
  noteBody: string;
  noteFolder: string;
  existingTags: readonly string[];
  excludedFolders: readonly string[];
  infer: (prompt: string) => Promise<string>;
}): Promise<void> {
  const token = sendChatMessage("Suggest tags for this note");
  try {
    const pass = await runTagSuggestionPass({
      noteBody: args.noteBody,
      noteFolder: args.noteFolder,
      existingTags: args.existingTags,
      excludedFolders: args.excludedFolders,
      infer: args.infer,
    });
    // `skipped` (excluded folder) → finalize with no chips (empty, not an error).
    finalizeChatTags(token, pass.skipped ? [] : pass.suggestions);
  } catch {
    failChatTurn(token);
  }
}
