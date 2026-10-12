// Local-only conversation titles (myne-md/myne#848).
//
// ── Why this is a separate module ───────────────────────────────────────────
// The host derives a truncation title when the conversation is created, and that
// derivation is synchronous and model-free on purpose: `chats_create` is on the
// first-message path, and making it wait on a model would make "send a message"
// and "start generating" the same act. So the improvement rides BEHIND the
// write, asynchronously, and the derived title is the shipped answer rather than
// a placeholder: with no local model, nothing here runs at all.
//
// ── The egress posture, and why it is not a promise in this file ────────────
// `inferAmbient` is the **ambient** request class (`INFER_AMBIENT_CLASS`), and
// the host refuses a remote-class backend for an ambient request with
// `EngineError::RemoteBarred`, the same bar that keeps auto-tagging off a
// provider, pinned host-side by
// `core/src/inference/state.rs::ambient_requests_are_refused_a_remote_backend`.
// A title is not a chat the user is waiting on; it is housekeeping the app
// decided to do. So "a remote provider is never consulted for a title"
// holds by construction rather than by this module choosing not to call one,
// which is the property worth having: the choice is not expressible here.
//
// ── What is NOT here ────────────────────────────────────────────────────────
// Nothing writes to the transcript. The `title_derived_from` snapshot (§9.24.2
// of `docs/spec/protocol.md`) is the derivation INPUT and is produced by
// `serializeTranscript` from the first turn; a generated title renames the
// catalog row and leaves that snapshot byte-identical, which is what keeps a
// later manual rename detectable as a divergence from the input.

import { loadModelPath } from "../../lib/ai-model-store";
import { chatsList, chatsRename } from "../../lib/chats";
import { inferAmbient } from "../../lib/writing-assistant";
import { TITLE_DERIVATION_MAX_USVS } from "./chatPersist";

/** Generation ceiling for one title. Small on purpose: a title is a handful of
 *  words, and the ceiling is the only cost bound this feature has. The host
 *  clamps it, this is a request, not a grant. */
export const TITLE_MAX_NEW_TOKENS = 24;

/** How much of the first turn the prompt carries. The user's own words, capped
 *  so a pasted essay does not become the prompt. */
export const TITLE_PROMPT_INPUT_MAX_USVS = 600;

/** First `max` Unicode scalar values of `text`, newlines stripped. Iterates code
 *  points, so a surrogate pair is never split; mirrors the host's `chars()`
 *  derivation in `core/src/plugins/chats/commands.rs`. */
export function capUsvs(text: string, max: number): string {
  let out = "";
  let count = 0;
  for (const ch of text) {
    if (ch === "\n" || ch === "\r") continue;
    if (count >= max) break;
    out += ch;
    count += 1;
  }
  return out;
}

/**
 * The prompt. One instruction, one input, no framing the model could continue.
 *
 * The user's text is embedded as data, not as instructions, and that is a
 * prompt-hygiene choice rather than a security boundary: the worst outcome of a
 * note that says "ignore the above" is a bad title, which is why this path needs
 * no injection analysis. The title is capped, stripped and never interpreted.
 */
export function buildTitlePrompt(firstTurn: string): string {
  const input = capUsvs(firstTurn, TITLE_PROMPT_INPUT_MAX_USVS).trim();
  return [
    "Write a short title for the request below, in the language of that request.",
    "At most six words. Reply with the title only: no quotes, no full stop, no explanation.",
    "",
    input,
  ].join("\n");
}

/**
 * Shape the model's reply into a title, or `""` when there is nothing usable.
 *
 * A model asked for "the title only" answers with the title or with a line of
 * commentary, and the difference is not worth another round trip: the first
 * non-empty line is taken, surrounding quotes are stripped (models add them
 * despite the instruction), the run of whitespace is collapsed so the title
 * renders on one line, and the result is capped to the same 48 scalar values the
 * derivation uses, a generated title and a derived one must fit the same budget
 * or the catalog row's width would depend on which path produced it.
 */
export function capGeneratedTitle(raw: string): string {
  const firstLine =
    raw
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => line.length > 0) ?? "";
  const unquoted = firstLine.replace(/^["'“”‘’]+|["'“”‘’]+$/g, "");
  const collapsed = unquoted.replace(/\s+/g, " ").trim();
  return capUsvs(collapsed, TITLE_DERIVATION_MAX_USVS).trim();
}

/**
 * Ask the local model for a title. `null` means "nothing to rename with", the
 * reply was empty, unusable, or refused.
 *
 * Every failure is `null` rather than a throw, because the caller has nothing to
 * say about it: the derived title is already in the catalog and is the answer
 * this feature improves on, not a fallback it replaces.
 */
export async function generateConversationTitle(
  firstTurn: string,
): Promise<string | null> {
  try {
    const raw = await inferAmbient(buildTitlePrompt(firstTurn), {
      maxNewTokens: TITLE_MAX_NEW_TOKENS,
    });
    const title = capGeneratedTitle(raw);
    return title.length === 0 ? null : title;
  } catch {
    return null;
  }
}

/**
 * Improve a just-created conversation's title, if this device can and the user
 * has not been asked to wait.
 *
 * Three gates, in order, and the first one is the acceptance criterion:
 *
 *  1. **No local generation model means no model call at all**: not a call that
 *     fails, not a call to a provider, an absent call. `loadModelPath` answers
 *     `null` when the user has not installed one, and the derived title stands.
 *     The read itself is guarded because `plugin:local-inference` does not exist
 *     on every client (the web bundle has no local engine), and a missing
 *     command is not a title failure.
 *  2. **The ambient class** (inside `generateConversationTitle`) is what makes a
 *     provider unreachable, whatever this device has configured.
 *  3. **A conversation the caller could not create is skipped**: `null` id means
 *     the persist that would have named it failed, and there is nothing to
 *     rename.
 *
 * `chatsRename` bumps the conversation roster, so a hub that is open updates in
 * place, no reload, which is the difference between a title landing and a title
 * existing.
 */
export async function maybeGenerateConversationTitle(
  conversationId: string | null,
  firstTurn: string,
): Promise<void> {
  if (conversationId === null || firstTurn.trim().length === 0) return;
  let modelPath: string | null;
  try {
    modelPath = await loadModelPath("generation");
  } catch {
    return;
  }
  if (modelPath === null) return;
  // **Never over a title a human wrote** (myne-md/myne#848). `chatsRename` has no
  // divergence check of its own, and this runs on EVERY message, so without this
  // guard a second message in a conversation the user had renamed replaced their
  // title with a freshly generated one. The row still holds the DERIVED title
  // when nobody has renamed it, so the comparison is against exactly that value.
  const derived = capUsvs(firstTurn, TITLE_DERIVATION_MAX_USVS).trim();
  try {
    const rows = await chatsList();
    const row = rows.find((r) => r.id === conversationId);
    if (row !== undefined && row.title !== derived) return;
  } catch {
    // A roster that cannot be read is not a reason to rename blind: the whole
    // point of the guard is not to overwrite something we did not check.
    return;
  }
  const title = await generateConversationTitle(firstTurn);
  if (title === null) return;
  try {
    await chatsRename(conversationId, title);
  } catch {
    // The catalog keeps the derived title. Nothing is owed and nothing is
    // surfaced: the user did not ask for this.
  }
}
