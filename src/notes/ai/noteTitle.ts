// Local-only note titles, generated from a note's own content (myne-md/myne#848).
//
// ── What this is ────────────────────────────────────────────────────────────
// A note's title lives in its frontmatter (`title:`) and is what the sidebar,
// the wikilink resolver and every list shows. Writing it by hand means reading
// the note and deciding what it is about; a local model can do that from the
// text, which is what this module asks it for.
//
// ── The egress posture, and it is the reason this is ambient ────────────────
// `inferAmbient` is the **ambient** request class (`INFER_AMBIENT_CLASS`), and
// the host refuses a remote-class backend for it with `EngineError::RemoteBarred`.
// That is the same bar that keeps auto-tagging and conversation titles off a
// provider, and it is pinned host-side by
// `core/src/inference/state.rs::ambient_requests_are_refused_a_remote_backend`.
//
// That bar matters MORE here than for a conversation title, not less. A note's
// whole body is the prompt: one press would put a user's note in front of
// whichever provider they had configured, on a one-click action, with no
// per-action egress disclosure and no scope review. The ambient class makes that
// **not expressible** rather than merely unchosen, there is no code path here
// that could reach a provider, whatever the device has set up. The cost is that
// this action needs a local generation model, and the surface says so.
//
// ── What is NOT here ────────────────────────────────────────────────────────
// **No write, and no body carried out of this module** (myne-md/myne#848
// review). The caller owns the note and its rename path
// (`SidebarState.commitRename`), because a rename is not a title edit: it is
// §8.3's transactional batch, which also rewrites every inbound `[[Old Title]]`
// and flushes open panes first. This function returned the body it had read, so
// the caller wrote back bytes that were by then OLD: the read happens before a
// model generation that takes seconds, and anything landing in between (an
// autosave, a sync pull, an agent apply) was overwritten by the rename. The
// caller now flushes and re-reads at the moment of the write, which is the
// order `executeRenameCommit` already used, and the type no longer makes the
// stale-body mistake expressible.

import { loadModelPath } from "../../lib/ai-model-store";
import { inferAmbient } from "../../lib/writing-assistant";
import { bodyWithoutFrontmatter } from "../copyNoteMarkdown";
import { noteRead } from "../readNote";
import {
  TITLE_MAX_NEW_TOKENS,
  capGeneratedTitle,
  capUsvs,
} from "./conversationTitle";

/** How much of the note the prompt carries.
 *
 *  Larger than the conversation-title window (600), because a conversation title
 *  is derived from one message and a note title has to describe a whole note.
 *  It is smaller than the engine's context, because the opening of a note carries
 *  its topic and a longer window costs the local model's attention without
 *  improving the title. The host clamps the generation ceiling; this is a
 *  request, not a grant. */
export const NOTE_TITLE_PROMPT_INPUT_MAX_USVS = 1200;

/**
 * The prompt. One instruction, one input, no framing the model could continue.
 *
 * The note's text is embedded as data, not as instructions, the same
 * prompt-hygiene choice the conversation-title prompt makes, and for the same
 * reason: the worst outcome of a note that says "ignore the above" is a bad
 * title, which is why this path needs no injection analysis. The reply is
 * capped, stripped and never interpreted.
 */
export function buildNoteTitlePrompt(body: string): string {
  const input = capUsvs(body, NOTE_TITLE_PROMPT_INPUT_MAX_USVS).trim();
  return [
    "Write a short title for the note below, in the language of that note.",
    "At most six words. Reply with the title only: no quotes, no full stop, no explanation.",
    "",
    input,
  ].join("\n");
}

/** What one press produced, as a closed set the surface can render. */
export type NoteTitleOutcome =
  /** A usable title. The caller writes it, and reads the body itself. */
  | { kind: "ready"; title: string }
  /** No local generation model on this device. Not a failure of the model. */
  | { kind: "unavailable" }
  /** The note is in a folder the user excluded from AI (SYNC-14). */
  | { kind: "excluded" }
  /** The model answered with nothing usable. */
  | { kind: "no-title" }
  /** The note could not be read, or the engine refused. */
  | { kind: "failed" };

/**
 * Read a note, ask the local model what it is about, and return the title to
 * write, or why there is none.
 *
 * Every failure is a value rather than a throw: the caller is a menu item that
 * has to say WHICH way it did not work (a missing model is a different sentence
 * from a model that answered with nothing), and a rejection would flatten the
 * three into one.
 *
 * The frontmatter is stripped before the prompt. Two reasons, and the second is
 * the one that matters: the block is bookkeeping rather than content, and the
 * CURRENT title is in it, a prompt carrying the old title gets the old title
 * back, which is the one answer this action must not produce.
 */
export async function generateNoteTitle(
  noteId: string,
  /**
   * Whether this note's folder allows an AI read. The CALLER owns the prefs, so
   * it owns the verdict; this module owns the "not even asked" half of it, so an
   * excluded note produces no read and no model call at all rather than a gate
   * the next caller could forget. That is the SYNC-14 shape: the entry point
   * refuses, it does not merely decline to offer.
   */
  readAllowed: boolean,
): Promise<NoteTitleOutcome> {
  if (!readAllowed) return { kind: "excluded" };
  // **No local model means no model call at all**: not a call that fails, and
  // not a call to a provider. The read is guarded because
  // `plugin:local-inference` does not exist on every client (the web bundle has
  // no local engine), and a missing command is not a title failure.
  let modelPath: string | null;
  try {
    modelPath = await loadModelPath("generation");
  } catch {
    return { kind: "unavailable" };
  }
  if (modelPath === null) return { kind: "unavailable" };

  let bytes: string;
  try {
    bytes = await noteRead(noteId);
  } catch {
    return { kind: "failed" };
  }

  let raw: string;
  try {
    raw = await inferAmbient(buildNoteTitlePrompt(bodyWithoutFrontmatter(bytes)), {
      maxNewTokens: TITLE_MAX_NEW_TOKENS,
    });
  } catch {
    return { kind: "failed" };
  }

  const title = capGeneratedTitle(raw);
  if (title.length === 0) return { kind: "no-title" };
  return { kind: "ready", title };
}
