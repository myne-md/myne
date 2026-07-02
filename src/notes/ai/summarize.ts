// Note summarization — pure input helpers (local-ai epic, note-summarization
// MYND-409, tasks 1 + 2). No model call, no IPC, no UI: these are the two
// deterministic seams the summarize command (task 3) composes before it hands
// a prompt to the blocking `Engine.infer` (SYNC-7).
//
// Reads ONLY already-JS-resident plaintext (the live CodeMirror doc / selection)
// — no new decrypt, no new plaintext path (SYNC-9).

import type { EditorState } from "@codemirror/state";

import { selectedRangesText } from "../../editor/selectionText";

export type SummarizeMode = "selection" | "note";

export interface SummarizeInput {
  /** The text to summarize. */
  text: string;
  /** Which source it came from — drives the honest affordance copy. */
  mode: SummarizeMode;
}

/**
 * Resolve what to summarize from the live editor state: a **non-empty
 * selection** wins (summarize just the selection); otherwise the **whole note**
 * (`state.doc`). Pure over `EditorState`; reuses `selectedRangesText`
 * (MYND-339) — no new plaintext seam.
 */
export function resolveSummarizeInput(state: EditorState): SummarizeInput {
  const selection = selectedRangesText(state);
  if (selection.length > 0) return { text: selection, mode: "selection" };
  return { text: state.doc.toString(), mode: "note" };
}

export interface TruncateResult {
  /** The (possibly truncated) text to put in the prompt. */
  promptText: string;
  /** Whether the input exceeded the budget and was cut. */
  truncated: boolean;
  /** How many characters (code points) were actually summarized. */
  summarizedChars: number;
}

/**
 * Truncate `text` to the model's pinned context `budget` (in characters /
 * Unicode code points, so a surrogate pair is never split). Reports whether it
 * was cut so the caller can surface an honest "Summarized the first N
 * characters" notice.
 *
 * **Map-reduce over the whole note is deliberately NOT here** — it is the
 * merge-time path that reuses sibling 7's shared chunker (SYNC-8/18). This is
 * the truncate-with-honest-notice seam; do not grow a second chunker in it.
 */
export function truncateToContext(text: string, budget: number): TruncateResult {
  const codePoints = Array.from(text);
  if (codePoints.length <= budget) {
    return { promptText: text, truncated: false, summarizedChars: codePoints.length };
  }
  const promptText = codePoints.slice(0, budget).join("");
  return { promptText, truncated: true, summarizedChars: budget };
}

/** The fixed instruction prepended to the note text. Assembled in RAM at call
 *  time and never stored (SYNC-8 — no persisted prompt artifact). */
export const SUMMARIZE_INSTRUCTION =
  "Summarize the following note concisely, in a few sentences:\n\n";

/** Context budget (code points) for a summarize pass — a token proxy until the
 *  model tokenizer + pinned context land (SYNC-7/13). Over-budget input is
 *  truncated with the honest "first N characters" notice (task 2). */
export const SUMMARIZE_BUDGET_CHARS = 6000;

/** Assemble the (in-RAM, non-persisted) summarize prompt from note text. */
export function assembleSummarizePrompt(text: string): string {
  return `${SUMMARIZE_INSTRUCTION}${text}`;
}

export interface SummarizeOutcome extends TruncateResult {
  /** The model's summary (blocking `Engine.infer` result). */
  summary: string;
  /** Which source the input came from. */
  mode: SummarizeMode;
}

/**
 * Orchestrate a summarize call: resolve input (task 1) → truncate to budget
 * (task 2) → assemble the fixed prompt → call the **blocking** `infer` (SYNC-7).
 * Pure over its inputs + the injected `infer` (a thin stub in tests, the real
 * feature-gated `local-inference|infer` IPC in production). The
 * `ai_excluded_folders` gate + the ephemeral render (task 4) are the caller's
 * concern — this is the deterministic prompt→result pipe.
 */
export async function runSummarize(args: {
  state: EditorState;
  budget: number;
  infer: (prompt: string) => Promise<string>;
}): Promise<SummarizeOutcome> {
  const { text, mode } = resolveSummarizeInput(args.state);
  const { promptText, truncated, summarizedChars } = truncateToContext(
    text,
    args.budget,
  );
  const summary = await args.infer(assembleSummarizePrompt(promptText));
  return { summary, mode, promptText, truncated, summarizedChars };
}

/** The heading of the appended summary block. Plain markdown — no new format,
 *  no magic (note-summarization task 5, SYNC-17). */
export const SUMMARY_BLOCK_HEADING = "## Summary";

/**
 * Append a `## Summary` block to a note body, byte-identical to the same
 * markdown typed by hand (no new format/magic). Separates the block from the
 * existing body with exactly one blank line — collapsing to the body's existing
 * trailing newlines so the result is clean regardless of how the body ended.
 * The summary is trimmed and the block ends in a single trailing newline. Pure.
 */
export function appendSummaryBlock(body: string, summary: string): string {
  const block = `${SUMMARY_BLOCK_HEADING}\n\n${summary.trim()}\n`;
  if (body.length === 0) return block;
  const sep = body.endsWith("\n\n") ? "" : body.endsWith("\n") ? "\n" : "\n\n";
  return `${body}${sep}${block}`;
}

/**
 * Insert a summary into the open note: append the `## Summary` block (byte-
 * identical, task 5) and persist via the injected `save` — the normal
 * autosave/AEAD path (`note_save`, `MY01`, the note's `item_key`), stubbed in
 * tests. Insertion happens ONLY on this explicit call (the accept button, task
 * 4); there is no auto-insert path. Returns the new body that was persisted.
 */
export async function insertSummary(args: {
  body: string;
  summary: string;
  save: (newBody: string) => Promise<void>;
}): Promise<string> {
  const newBody = appendSummaryBlock(args.body, args.summary);
  await args.save(newBody);
  return newBody;
}
