// Writing-assistant suggestion engine wiring + prompt-context cores
// (writing-assistant MYND-410 task 1). Mirrors `src/lib/spell.ts`: a thin
// blocking-IPC wrapper over sibling 1's on-device `Engine.infer` plus the pure
// prompt/range cores that the ghost-text widget, the debounced auto-trigger,
// and the `/devam` · `/yeniden-yaz` · `/başlık` slash commands all reuse.
//
// - NO streaming, NO network capability (egress is sibling 2's gate; SYNC-2/7).
// - The prompt cores are pure and RAM-only — a prompt is assembled per call and
//   never stored (SYNC-3), same discipline as `notes/ai/summarize.ts`.
// - Every entry point is gated on `ai_enabled` (MYP1) + `ai_excluded_folders`
//   (SYNC-14) via `aiEntryAllowed` before any model call.

import { invoke } from "../platform/core";
import type { EditorState } from "@codemirror/state";

import { isNoteAiExcluded } from "./aiExcludedFolders";
import { selectedRangesText } from "../editor/selectionText";

/**
 * Max characters of preceding text fed as cursor context to a completion. A
 * bounded window keeps the blocking `infer` cheap and fits the pinned model
 * context (SYNC-7/13) — a proxy budget until sibling 1's tokenizer lands. The
 * window is the tail (nearest the cursor), never the head.
 */
export const COMPLETION_CONTEXT_CHARS = 800;

/** Per-call knobs for {@link infer}. */
export interface InferOptions {
  /** Generation ceiling for THIS call (issue #193). Omitted, the engine's own
   *  budget applies. The host clamps it — this is a request, not a grant. */
  maxNewTokens?: number;
}

/**
 * Blocking one-shot completion via sibling 1's `local-inference` plugin
 * (`Engine.infer`, SYNC-7). Thin IPC wrapper — no streaming, no fetch, no new
 * capability. Rejects if the engine errors (closed `EngineError` on the Rust
 * side); callers surface a non-blocking notice, never the raw error.
 *
 * The payload stays `{ prompt }` exactly when no ceiling is asked for, so the
 * chat / `/devam` / summarize calls are byte-identical to their pre-#193 shape.
 */
export async function infer(prompt: string, opts?: InferOptions): Promise<string> {
  const payload =
    opts?.maxNewTokens === undefined
      ? { prompt }
      : { prompt, maxNewTokens: opts.maxNewTokens };
  return await invoke<string>("plugin:local-inference|infer", payload);
}

/** Per-call shape knobs for {@link buildCompletionPrompt}. */
export interface CompletionPromptOptions {
  /** Ask for a few words / one short sentence on a single line (issue #193).
   *  The PASSIVE inline ghost-text sets this; the explicit `/devam` command
   *  does not, because a deliberate "continue" is allowed to be long. */
  brief?: boolean;
}

/**
 * Build the cursor-context completion prompt from the preceding text (the ghost
 * + `/devam` shared core). Takes the tail window (`COMPLETION_CONTEXT_CHARS`,
 * code-point-aware so a surrogate pair is never split), wraps it in a fixed
 * continue-from-here instruction. Pure; the result is RAM-only, never stored.
 *
 * The length ask is per-call rather than baked in, because both surfaces share
 * this one builder: shortening it outright would shorten `/devam` too, which is
 * the surface long continuations are supposed to live on.
 */
export function buildCompletionPrompt(
  precedingText: string,
  opts?: CompletionPromptOptions,
): string {
  const chars = Array.from(precedingText);
  const window =
    chars.length > COMPLETION_CONTEXT_CHARS
      ? chars.slice(-COMPLETION_CONTEXT_CHARS).join("")
      : precedingText;
  const length = opts?.brief
    ? "Reply with at most a few words or one short sentence, on a single line, "
    : "Reply with only the continuation text, ";
  return (
    "Continue the following note naturally from where it stops. " +
    length +
    "in the same language and style, no preamble.\n\n" +
    window
  );
}

/** A resolved rewrite target: an inclusive-exclusive `[from, to)` document span. */
export interface RewriteRange {
  from: number;
  to: number;
}

/**
 * Resolve the rewrite target from the editor selection. Uses the primary
 * selection range; an empty selection (nothing selected) returns `null` so the
 * caller no-ops (`/yeniden-yaz` is disabled on an empty selection). Pure over
 * `EditorState` — no view, no DOM.
 */
export function resolveRewriteRange(state: EditorState): RewriteRange | null {
  const main = state.selection.main;
  if (main.empty) return null;
  return { from: main.from, to: main.to };
}

/**
 * Build the rewrite prompt for a selected span (the `/yeniden-yaz` core). The
 * selected text is the `selectedRangesText(state)` projection; an empty string
 * is a no-op the caller guards via {@link resolveRewriteRange}. Pure, RAM-only.
 */
export function buildRewritePrompt(selectedText: string): string {
  return (
    "Rewrite the following text to read more clearly, keeping its meaning, " +
    "language, and markdown formatting. Reply with only the rewritten text, " +
    "no preamble.\n\n" +
    selectedText
  );
}

/**
 * Build the title-suggestion prompt from a note body (the `/başlık` core). Pure,
 * RAM-only; the caller writes the result to frontmatter `title:` on accept only.
 */
export function buildTitlePrompt(noteBody: string): string {
  const chars = Array.from(noteBody);
  const window =
    chars.length > COMPLETION_CONTEXT_CHARS
      ? chars.slice(0, COMPLETION_CONTEXT_CHARS).join("")
      : noteBody;
  return (
    "Suggest a concise, specific title for this note, in the note's own " +
    "language. Reply with only the title text, no quotes, no preamble.\n\n" +
    window
  );
}

/** Inputs gating whether an AI writing-assistant entry point may fire. */
export interface AiEntryGate {
  /** The `prefs.ai_enabled` master switch (MYP1). */
  aiEnabled: boolean;
  /** The open note's canonical trailing-slash folder (`""` = vault root). */
  noteFolder: string;
  /** `prefs.ai_excluded_folders` (SYNC-14). */
  excludedFolders: readonly string[];
}

/**
 * Whether an AI writing-assistant entry point may fire for the open note.
 * Short-circuits (returns `false`, model never invoked) when AI is disabled or
 * the note lives in an excluded folder. The single gate every surface
 * (ghost-text, auto-trigger, slash commands) checks first.
 */
export function aiEntryAllowed(gate: AiEntryGate): boolean {
  if (!gate.aiEnabled) return false;
  if (isNoteAiExcluded(gate.noteFolder, gate.excludedFolders)) return false;
  return true;
}

/** The concatenated selection text for a rewrite prompt (re-export of the
 *  shared projection so the slash command imports one module). */
export { selectedRangesText };

// ---- command orchestration cores (writing-assistant task 5) ----------------
//
// Testable async orchestrations composing the pure cores above + the injected
// blocking `infer` (stub in tests, the real IPC in production). The slash-menu /
// palette trigger wiring (`/devam` · `/yeniden-yaz` · `/başlık`) dispatches the
// returned transaction spec; that editor-dispatch layer is the remaining
// integration. All return the model text verbatim as **plain markdown**
// (`ai.insert`/`ai.rewrite`/`ai.title` userEvents), never a new format.

/**
 * `/devam` core: continue from the cursor. Builds the completion prompt from the
 * text preceding the primary cursor and returns the model's continuation. Pure
 * over `(EditorState, infer)`.
 */
export async function computeContinuation(args: {
  state: EditorState;
  infer: (prompt: string) => Promise<string>;
}): Promise<string> {
  const cursor = args.state.selection.main.head;
  const preceding = args.state.sliceDoc(0, cursor);
  return args.infer(buildCompletionPrompt(preceding));
}

/**
 * `/yeniden-yaz` core: rewrite the current selection in place. Returns the
 * `[from, to)` span + the rewritten text, or `null` on an empty selection (the
 * caller no-ops). Pure over `(EditorState, infer)`.
 */
export async function computeRewrite(args: {
  state: EditorState;
  infer: (prompt: string) => Promise<string>;
}): Promise<{ from: number; to: number; text: string } | null> {
  const range = resolveRewriteRange(args.state);
  if (range === null) return null;
  const selected = selectedRangesText(args.state);
  const text = await args.infer(buildRewritePrompt(selected));
  return { from: range.from, to: range.to, text };
}

/**
 * `/başlık` core: suggest a title for the note body. Returns the model's title
 * text (the caller writes it to frontmatter `title:` via `patchTitleField`).
 * Pure over `(docText, infer)`.
 */
export async function computeTitle(args: {
  docText: string;
  infer: (prompt: string) => Promise<string>;
}): Promise<string> {
  return args.infer(buildTitlePrompt(args.docText));
}
