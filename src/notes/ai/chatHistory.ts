// The visible chat transcript, as the shape a run is seeded with.
//
// **What is on screen is what is sent, and that is the whole rule.** A run used
// to start with an empty transcript, so a follow-up message could not refer to
// the previous answer: the model produced a list, the user said "add that list
// to the note", and the run had no idea what "that list" was. The bubbles were a
// display record and nothing more.
//
// This module turns those bubbles into the seed. It does NOT decide how much of
// them travels: the character budget is applied host-side, in
// `core/src/plugins/agent/history.rs`, because what reaches the model is policy
// and a WebView that pre-trimmed would be deciding it. The rule this repo states
// as "'the caller behaved' is not a property of a seam"
// (`design-notes/ai/0462`) is the same rule.
//
// What it deliberately leaves out is the other half of the contract: tool
// results, note bodies, anchors and replacements never appear here, because they
// are not on screen. They live in `agentStore`, which every vault-leaving path
// clears (`design-notes/ai/0518`).

import type { ChatTurn } from "./chatStore";

/** One visible turn, in the shape the host's `HistoryTurn` deserializes. */
export interface HistoryTurn {
  role: "user" | "assistant";
  text: string;
}

/**
 * The visible text of a transcript, oldest first.
 *
 * A user turn contributes what the user typed. An agent turn contributes the
 * model's own summary, which is the text rendered above the counts, and nothing
 * else: the counts themselves are a rendering of the run, not something the user
 * said or the model wrote.
 *
 * A turn still streaming, one that errored, and one with nothing to show are all
 * skipped. A streaming turn's text is a partial the next dispatch replaces, and
 * seeding a half-sentence teaches the model a fact that was never true.
 */
export function visibleHistory(turns: readonly ChatTurn[]): HistoryTurn[] {
  const out: HistoryTurn[] = [];
  for (const turn of turns) {
    if (turn.streaming || turn.error) continue;
    if (turn.role === "user") {
      const text = turn.text.trim();
      if (text.length > 0) out.push({ role: "user", text });
      continue;
    }
    // An assistant turn: the agent flow carries its answer on the summary, the
    // text flow in `text`. Reading only one of the two would drop half the
    // conversation depending on which flow produced it.
    const text = (turn.agentSummary?.summary ?? turn.text).trim();
    if (text.length > 0) out.push({ role: "assistant", text });
  }
  return out;
}
