// On-demand tag-suggestion pass (auto-tag-link MYND-411 tasks 2 + 3).
//
// Orchestrates a single explicit suggestion pass: gate on `ai_excluded_folders`
// (task 3 — an excluded note yields NO pass and the model is never invoked),
// assemble a RAM-only prompt from the note body + an existing-vocabulary hint,
// call sibling 1's **blocking** `Engine.infer` **once** (never `embed`, no
// sibling-7 dependency), parse the raw output into candidate tags, and rank them
// through the task-1 `rankTagCandidates`.
//
// All state is RAM-only + ephemeral — no artefact is written to disk during or
// after the pass (SYNC-8). The pass is a plain async function with no
// subscription/effect, so it can only fire on an explicit caller (the command/
// button wired in task 4) — never on open/save/background.

import { isNoteAiExcluded } from "../../lib/aiExcludedFolders";
import { rankTagCandidates, type TagSuggestion } from "./tagRanker";

/** Max notes-body characters fed to the tag prompt (a token proxy budget). */
export const TAG_PROMPT_BODY_CHARS = 2000;

/** Max candidate tags surfaced from one pass (sprawl guard on the model). */
export const MAX_TAG_SUGGESTIONS = 8;

/** Hard per-tag length cap (chars). The prompt asks for short topical tags, but
 *  note content is untrusted — a prompt-injected note could make the model emit
 *  pathologically long "tags"; the codec, not the prompt, is the real bound. */
export const MAX_TAG_LEN = 48;

/** Hard cap on raw candidates parsed before ranking — bounds the work a
 *  prompt-injected note (thousands of comma pieces) can force. */
const MAX_RAW_CANDIDATES = 64;

/**
 * Parse raw `Engine.infer` output into a candidate-tag list. Models emit tags
 * in mixed shapes — comma lists, newline lists, `- bullets`, `1.`/`2)`
 * numbering, with or without a leading `#`. Splits on newlines/commas, strips a
 * leading list marker (only when followed by whitespace, so a tag like
 * `3d-printing` keeps its leading digit), trims, and drops empties **and
 * over-length pieces** (untrusted model output — the count + length caps are
 * enforced here, not just requested in the prompt). Bounded to
 * `MAX_RAW_CANDIDATES`. The `#` is left on — `rankTagCandidates`' `cleanTagToken`
 * strips it. Pure.
 */
export function parseTagCandidates(modelOutput: string): string[] {
  return modelOutput
    .split(/[\n,]+/)
    .map((piece) => piece.replace(/^\s*(?:[-*•]\s+|\d+[.)]\s+)/, "").trim())
    .filter((s) => s.length > 0 && s.length <= MAX_TAG_LEN)
    .slice(0, MAX_RAW_CANDIDATES);
}

/**
 * Build the tag-suggestion prompt (note body head window + a reuse-existing
 * hint). RAM-only, never stored. Pure.
 */
export function buildTagPrompt(
  noteBody: string,
  existingTags: readonly string[],
): string {
  const chars = Array.from(noteBody);
  const body =
    chars.length > TAG_PROMPT_BODY_CHARS
      ? chars.slice(0, TAG_PROMPT_BODY_CHARS).join("")
      : noteBody;
  const hint =
    existingTags.length > 0
      ? `Prefer reusing these existing tags when relevant: ${existingTags.join(", ")}.\n\n`
      : "";
  return (
    `Suggest up to ${MAX_TAG_SUGGESTIONS} topical tags for the note below, ` +
    "as a lowercase comma-separated list, no # prefix, no explanation.\n\n" +
    hint +
    "Note:\n\n" +
    body
  );
}

/** Result of one suggestion pass. */
export interface TagSuggestionPass {
  /** Ranked suggestions (existing-vocabulary first). Empty when skipped. */
  suggestions: TagSuggestion[];
  /** True when the note is in an excluded folder — the model was NOT invoked. */
  skipped: boolean;
}

/** Inputs for {@link runTagSuggestionPass}. */
export interface TagSuggestionPassInput {
  /** The open note's decrypted body (already in RAM — no new decrypt/IPC). */
  noteBody: string;
  /** The note's canonical trailing-slash folder (`""` = vault root). */
  noteFolder: string;
  /** The vault's existing tag vocabulary (folded index, RAM cache). */
  existingTags: readonly string[];
  /** `prefs.ai_excluded_folders` (SYNC-14). */
  excludedFolders: readonly string[];
  /** Sibling 1's blocking `Engine.infer` (stubbed in tests). */
  infer: (prompt: string) => Promise<string>;
}

/**
 * Run one explicit tag-suggestion pass. Returns `{ suggestions: [], skipped:
 * true }` **without calling `infer`** when the note is in an excluded folder
 * (task 3); otherwise builds the prompt, calls `infer` exactly once, parses,
 * and ranks. No `embed`, no disk write.
 */
export async function runTagSuggestionPass(
  input: TagSuggestionPassInput,
): Promise<TagSuggestionPass> {
  if (isNoteAiExcluded(input.noteFolder, input.excludedFolders)) {
    return { suggestions: [], skipped: true };
  }
  const prompt = buildTagPrompt(input.noteBody, input.existingTags);
  const raw = await input.infer(prompt);
  const candidates = parseTagCandidates(raw);
  return {
    // Hard-cap the surfaced count here (the prompt only *asks* for ≤ N): an
    // untrusted note must never flood the chip row regardless of model output.
    suggestions: rankTagCandidates(input.existingTags, candidates).slice(
      0,
      MAX_TAG_SUGGESTIONS,
    ),
    skipped: false,
  };
}
