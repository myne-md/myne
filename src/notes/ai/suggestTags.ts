// One tag-suggestion pass (auto-tag-link MYND-411 tasks 2 + 3; retargeted at the
// dedicated tag model by on-device-tag-suggestion MYND-651 task 5).
//
// Orchestrates a single pass: gate on `ai_excluded_folders` (an excluded note
// yields NO pass and the model is never invoked), assemble a RAM-only prompt
// from the note body + an existing-vocabulary hint, call the **dedicated bundled
// tag model** once through the injected seam (`lib/ai-tags.suggestTagsForNote`
// in production — never the side-loaded generation model, never `embed`), parse
// the raw output into candidate tags, and rank them through `rankTagCandidates`.
//
// The frontend exclusion gate is now DEFENCE IN DEPTH, not the enforcement
// point: the host re-reads `ai_enabled` + `auto_tag_enabled` and the note's own
// folder before it touches the model (task 4), so a compromised WebView cannot
// reach an excluded note by lying here.
//
// All state is RAM-only + ephemeral — no artefact is written to disk during or
// after the pass (SYNC-8). The pass is a plain async function with no
// subscription/effect; the idle trigger that drives it lives in
// `tagSuggestionTrigger.ts`, so this core stays callable and testable alone.

import { isDeferredTagSuggestion } from "../../lib/ai-tags";
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
 * The note-body head window the prompt actually carries (code-point-aware, so a
 * surrogate pair is never split). Exported because it is also what the trigger's
 * content hash covers: an edit BEYOND this window cannot change the model's
 * answer, so it must not invalidate the cache. Pure.
 */
export function tagPromptBody(noteBody: string): string {
  const chars = Array.from(noteBody);
  return chars.length > TAG_PROMPT_BODY_CHARS
    ? chars.slice(0, TAG_PROMPT_BODY_CHARS).join("")
    : noteBody;
}

/**
 * Build the tag-suggestion prompt (note body head window + a reuse-existing
 * hint). RAM-only, never stored. Pure.
 */
export function buildTagPrompt(
  noteBody: string,
  existingTags: readonly string[],
): string {
  const body = tagPromptBody(noteBody);
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
  /** True when the host stood the pass down so user-initiated work could have
   *  the compute lock (task 4). NOT an answer: the note was never looked at, so
   *  a caller retries later and must not cache this as "no suggestions". */
  deferred: boolean;
}

/** The dedicated-tag-model call seam: prompt in, raw tag text out. Production
 *  wiring is `lib/ai-tags.suggestTagsForNote`; tests inject a stub. */
export type SuggestTagsSeam = (args: {
  noteId: string;
  prompt: string;
}) => Promise<string>;

/** Inputs for {@link runTagSuggestionPass}. */
export interface TagSuggestionPassInput {
  /** The note the pass is for. Travels to the host, which resolves the note's
   *  real folder from its own blob rather than trusting `noteFolder`. */
  noteId: string;
  /** The open note's decrypted body (already in RAM — no new decrypt/IPC). */
  noteBody: string;
  /** The note's canonical trailing-slash folder (`""` = vault root). */
  noteFolder: string;
  /** The vault's existing tag vocabulary (folded index, RAM cache). */
  existingTags: readonly string[];
  /** `prefs.ai_excluded_folders` (SYNC-14). */
  excludedFolders: readonly string[];
  /** The dedicated tag model (stubbed in tests). */
  suggest: SuggestTagsSeam;
}

/**
 * Run one tag-suggestion pass. Returns `{ skipped: true }` **without calling the
 * model** when the note is in an excluded folder; returns `{ deferred: true }`
 * when the host stood the pass down; otherwise builds the prompt, calls the tag
 * model exactly once, parses, and ranks. A genuine engine failure propagates —
 * only the deferral is folded into the result, because it is not a failure. No
 * `embed`, no disk write.
 */
export async function runTagSuggestionPass(
  input: TagSuggestionPassInput,
): Promise<TagSuggestionPass> {
  if (isNoteAiExcluded(input.noteFolder, input.excludedFolders)) {
    return { suggestions: [], skipped: true, deferred: false };
  }
  const prompt = buildTagPrompt(input.noteBody, input.existingTags);
  let raw: string;
  try {
    raw = await input.suggest({ noteId: input.noteId, prompt });
  } catch (err) {
    if (isDeferredTagSuggestion(err)) {
      return { suggestions: [], skipped: false, deferred: true };
    }
    throw err;
  }
  const candidates = parseTagCandidates(raw);
  return {
    // Hard-cap the surfaced count here (the prompt only *asks* for ≤ N): an
    // untrusted note must never flood the chip row regardless of model output.
    suggestions: rankTagCandidates(input.existingTags, candidates).slice(
      0,
      MAX_TAG_SUGGESTIONS,
    ),
    skipped: false,
    deferred: false,
  };
}
