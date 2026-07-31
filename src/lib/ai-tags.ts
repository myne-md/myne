// Auto-tag IPC seam — the single call path to the dedicated on-device tag model
// (on-device-tag-suggestion MYND-651 task 5).
//
// `plugin:local-inference|suggest_tags` is deliberately NOT `infer`: it runs the
// bundled task-model (task 3) behind the host-side `ai_enabled` +
// `auto_tag_enabled` gate and the `ai_excluded_folders` short-circuit (task 4).
// That is also why the note id travels with the prompt — the host re-reads the
// note's own folder from the `MY01` blob the id names, rather than trusting a
// folder the (untrusted, TB6) WebView supplies.
//
// The reply is raw tag TEXT; `parseTagCandidates` + `rankTagCandidates` shape it.
// Rejections are the closed Rust `EngineError` taxonomy, normalized here to a
// bounded kind — the same discipline as `transcribe.ts`, and for the same
// reason: the raw value is content-free by construction and must stay that way.
//
// `deferred` is the one rejection that is NOT a failure. The pass stood down so
// user-initiated work could have the single compute lock, so a caller retries
// later and must NOT cache the empty answer — see the trigger's cache rule in
// `notes/ai/tagSuggestionTrigger.ts`.

import { engineErrorTag } from "./engine-error";
import { invoke } from "../platform/core";

/** Bounded failure kinds of one tag-suggestion pass. `deferred` = stood down for
 *  user-initiated work (retry later); `not_ready` = AI off / no bundled weights;
 *  `failed` = any other engine failure. */
export type TagSuggestErrorKind = "deferred" | "not_ready" | "failed";

/** A normalized tag-suggestion failure. Content-free — never carries the prompt,
 *  the note body, or the model's output. */
export interface TagSuggestError {
  readonly kind: TagSuggestErrorKind;
}

const KINDS: readonly string[] = ["deferred", "not_ready", "failed"];

/** Whether a caught value is a normalized {@link TagSuggestError}. */
export function isTagSuggestError(value: unknown): value is TagSuggestError {
  return (
    typeof value === "object" &&
    value !== null &&
    "kind" in value &&
    KINDS.includes(String((value as { kind: unknown }).kind))
  );
}

/** Whether a caught value is the host's "stood down, ask again later" signal.
 *  The single predicate the pipeline uses to keep a deferral out of the cache. */
export function isDeferredTagSuggestion(value: unknown): boolean {
  return isTagSuggestError(value) && value.kind === "deferred";
}

/**
 * Run one tag-suggestion pass against the dedicated bundled tag model. Resolves
 * with the model's raw tag text (possibly empty — a real answer), rejects with a
 * {@link TagSuggestError}.
 */
export async function suggestTagsForNote(args: {
  noteId: string;
  prompt: string;
}): Promise<string> {
  return await invoke<string>("plugin:local-inference|suggest_tags", {
    noteId: args.noteId,
    prompt: args.prompt,
  }).catch((raw: unknown) => {
    throw normalizeTagSuggestError(raw);
  });
}

/**
 * Whether this build ships an auto-tag model at all.
 *
 * The tag role is bundled-only — there is no picker (`threat-model.md` §7) — so
 * `false` is a permanent property of the build, not something the user can fix
 * by side-loading. Settings uses it to say so instead of offering a switch that
 * would persist `true` against a host answering `not_ready` forever.
 *
 * Degrades to `false` on any rejection: an AI-free `--no-default-features`
 * build has no such command, and "the command is missing" and "no blob shipped"
 * are the same fact from the panel's side.
 */
export async function tagModelAvailable(): Promise<boolean> {
  return await invoke<boolean>("plugin:local-inference|tag_model_available").catch(
    () => false,
  );
}

/** Map the raw IPC rejection (a serialized `EngineError` — see
 *  {@link engineErrorTag}) to a normalized kind. Anything unrecognized degrades
 *  to `"failed"`. */
function normalizeTagSuggestError(raw: unknown): TagSuggestError {
  const tag = engineErrorTag(raw);
  if (tag === "Deferred" || tag === "deferred") return { kind: "deferred" };
  if (tag === "NotReady" || tag === "not_ready") return { kind: "not_ready" };
  return { kind: "failed" };
}
