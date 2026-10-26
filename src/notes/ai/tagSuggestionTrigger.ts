// Idle-debounce trigger + content-hash cache for auto-tag
// (on-device-tag-suggestion MYND-651 task 5).
//
// The pass itself (`suggestTags.ts`) is a plain async function with no notion of
// *when*. This module is the *when*: it fires one pass a debounce interval after
// the open note's content settles, coalesces a burst of keystrokes into that
// single pass, and refuses to recompute an answer it already has.
//
// Three properties are load-bearing, and each has a reason beyond tidiness:
//
//   1. **Debounce, not per-keystroke.** The tag model shares the one `compute`
//      mutex with every other on-device AI call. A pass per keystroke would
//      queue background work in front of the user's own (the host defers it —
//      task 4 — but a deferral still costs a round trip).
//   2. **Content-hash cache, RAM-only.** Re-opening an unchanged note must not
//      re-run inference. The key is a digest of the PROMPT WINDOW, not of the
//      whole body: text past `TAG_PROMPT_BODY_CHARS` never reaches the model, so
//      an edit down there cannot change the answer and must not invalidate it.
//      The digest, not the text, is what is retained — the cache holds no note
//      plaintext for a note that is no longer open (AS1).
//   3. **A deferral is never cached.** `Deferred` means the host stood the pass
//      down for user-initiated work; the note was never looked at. Caching that
//      as "no suggestions" would make one unlucky yield permanent for the
//      session. It re-arms instead, bounded so a permanently busy engine cannot
//      make this spin forever.
//
// No React, no CodeMirror: task 7's band mounts this, and the unit specs shorten
// `debounceMs` rather than waiting out a real idle interval.

import { suggestTagsForNote } from "../../lib/ai-tags";
import { isNoteAiExcluded } from "../../lib/aiExcludedFolders";
import type { TagSuggestion } from "./tagRanker";
import {
  type SuggestTagsSeam,
  type TagSuggestionPass,
  runTagSuggestionPass,
  tagPromptBody,
} from "./suggestTags";

/** Idle interval after the last edit before a pass fires. Long enough that a
 *  normal typing burst produces one pass, short enough that the band appears
 *  while the note is still the one being read. */
export const TAG_SUGGESTION_DEBOUNCE_MS = 1500;

/** How many times one (note, content) pair may be re-armed after the host
 *  deferred it, before the trigger gives up until the content changes again. */
export const MAX_DEFERRED_RETRIES = 3;

/** Session cache size, in distinct (note, content) pairs. A bound, not a tuning
 *  knob: the cache exists to skip re-work within a session, not to be a store. */
export const TAG_SUGGESTION_CACHE_ENTRIES = 32;

/** The open note, as the trigger needs it. */
export interface TagSuggestionNote {
  noteId: string;
  /** The note's current decrypted body (already in RAM). */
  noteBody: string;
  /** The note's canonical trailing-slash folder (`""` = vault root). */
  noteFolder: string;
}

/** One settled answer for one note. Emitted for an excluded note too (with no
 *  suggestions), so a consumer can render "the current note has none" without a
 *  second signal. */
export interface TagSuggestionResult {
  noteId: string;
  suggestions: TagSuggestion[];
}

/** Everything the trigger needs from its host. */
export interface TagSuggestionTriggerDeps {
  /** The dedicated tag model. Defaults to the real seam
   *  (`lib/ai-tags.suggestTagsForNote`) so a mounting surface cannot wire the
   *  pipeline to the wrong model by omission; tests inject a stub. */
  suggest?: SuggestTagsSeam;
  /** The vault's existing tag vocabulary, read at fire time (it changes as the
   *  user accepts tags). */
  existingTags: () => Promise<readonly string[]>;
  /** Tags offered to the PROMPT as reusable vocabulary, scoped to a folder
   *  (myne-md/myne#908 item 8). Optional: when absent the prompt gets the whole
   *  vocabulary, which is the pre-feature behaviour. It is read at fire time,
   *  like the vocabulary itself, because a folder's tags change as the user
   *  accepts. */
  folderTags?: (folder: string) => Promise<readonly string[]>;
  /** `prefs.ai_excluded_folders`, read at fire time (SYNC-14). */
  excludedFolders: () => readonly string[];
  /** Called with each settled answer. */
  onResult: (result: TagSuggestionResult) => void;
  /** Debounce override — the unit specs shorten it (default
   *  {@link TAG_SUGGESTION_DEBOUNCE_MS}). */
  debounceMs?: number;
}

/** A mounted trigger. */
export interface TagSuggestionTrigger {
  /** (Re)arm for the open note. Cheap — call on open and on every edit. Serves
   *  the cache SYNCHRONOUSLY on a hit (no timer, no model call). */
  schedule: (note: TagSuggestionNote) => void;
  /** Cancel any pending or in-flight pass (note closed, feature switched off).
   *  An in-flight result that lands afterwards is dropped. The cache dies with
   *  the trigger — it is per mount, so disposal is all a vault lock needs. */
  cancel: () => void;
}

/**
 * A 64-bit FNV-1a digest (hex) of the note's PROMPT WINDOW — the cache key's
 * content half. Not a cryptographic hash and not used as one: this keys a
 * RAM-only, session-scoped cache whose worst case is a stale chip row. It is a
 * digest rather than the text itself so the cache retains no note plaintext.
 *
 * Content beyond {@link TAG_PROMPT_BODY_CHARS} is deliberately outside the
 * digest — it never reaches the model, so it cannot change the answer.
 */
export function hashTagPromptInput(noteBody: string): string {
  return hashPromptWindow(tagPromptBody(noteBody));
}

/** {@link hashTagPromptInput} over an already-windowed body — the form the
 *  scheduler uses, so the window is computed once per edit rather than once for
 *  the digest and again for the prompt. */
function hashPromptWindow(window: string): string {
  // 64-bit FNV-1a over UTF-16 code units, carried as two 32-bit halves (no
  // BigInt on a per-keystroke path). Offset basis 0xcbf29ce484222325, prime
  // 0x100000001b3 = 2^40 + 0x1b3 — so the multiply is `(v << 40) + v * 0x1b3`
  // mod 2^64, and `v << 40` only ever reaches the high half as `lo << 8`.
  const P = 0x1b3;
  let hi = 0xcbf2_9ce4;
  let lo = 0x8422_2325;
  for (let i = 0; i < window.length; i++) {
    lo = (lo ^ window.charCodeAt(i)) >>> 0;
    const l0 = lo & 0xffff;
    const l1 = lo >>> 16;
    const p0 = l0 * P;
    const p1 = l1 * P + (p0 >>> 16);
    const nextLo = (((p1 & 0xffff) << 16) | (p0 & 0xffff)) >>> 0;
    // Every term is an exact double below 2^42; `>>> 0` reduces mod 2^32.
    const nextHi = (hi * P + (p1 >>> 16) + lo * 0x100) >>> 0;
    lo = nextLo;
    hi = nextHi;
  }
  return `${hi.toString(16).padStart(8, "0")}${lo.toString(16).padStart(8, "0")}`;
}

/** The cache key: a note identity plus its prompt-window digest, separated by a
 *  character no note id can contain. */
function cacheKey(noteId: string, promptBody: string): string {
  return `${noteId}\u0000${hashPromptWindow(promptBody)}`;
}

/**
 * Create an idle-debounce tag-suggestion trigger. Framework-free: the caller
 * drives it from wherever it observes the open note, and disposes it with
 * {@link TagSuggestionTrigger.cancel}.
 */
export function createTagSuggestionTrigger(
  deps: TagSuggestionTriggerDeps,
): TagSuggestionTrigger {
  const debounceMs = deps.debounceMs ?? TAG_SUGGESTION_DEBOUNCE_MS;
  const suggest = deps.suggest ?? suggestTagsForNote;
  // A Map iterates in insertion order, so its first key is the oldest entry —
  // which is the one the bound evicts (FIFO, not LRU: a hit does not refresh a
  // position, because the point is a ceiling on retention, not a hit rate).
  const cache = new Map<string, TagSuggestion[]>();
  let timer: ReturnType<typeof setTimeout> | null = null;
  // Bumped by every schedule/cancel. A pass captures it and drops its result if
  // it changed — the note switched, the content moved on, or the trigger was
  // disposed while the (multi-second) model call was in flight.
  let epoch = 0;
  // Deferral budget for the CURRENT (note, content) pair only.
  let deferredKey: string | null = null;
  let deferredRetries = 0;

  function disarm(): void {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  }

  function remember(key: string, suggestions: TagSuggestion[]): void {
    if (cache.size >= TAG_SUGGESTION_CACHE_ENTRIES) {
      const oldest = cache.keys().next();
      if (!oldest.done) cache.delete(oldest.value);
    }
    cache.set(key, suggestions);
  }

  async function fire(note: TagSuggestionNote, key: string): Promise<void> {
    timer = null;
    const mine = epoch;
    let pass: TagSuggestionPass;
    try {
      const existingTags = await deps.existingTags();
      const hintTags =
        deps.folderTags === undefined ? undefined : await deps.folderTags(note.noteFolder);
      if (epoch !== mine) return;
      pass = await runTagSuggestionPass({
        noteId: note.noteId,
        noteBody: note.noteBody,
        noteFolder: note.noteFolder,
        existingTags,
        ...(hintTags === undefined ? {} : { hintTags }),
        excludedFolders: deps.excludedFolders(),
        suggest,
      });
    } catch {
      // A genuine engine failure (the closed `EngineError` kinds — AI off, no
      // weights, inference died). Nothing is cached and nothing is emitted: the
      // band simply shows no suggestions, and the next content change retries.
      // A deferral never reaches here — the pass folds it into its result.
      return;
    }
    if (epoch !== mine) return;

    if (pass.deferred) {
      // The host stood down for user-initiated work. Ask again, bounded — a
      // permanently busy engine must not turn this into a spin.
      if (deferredRetries < MAX_DEFERRED_RETRIES) {
        deferredRetries += 1;
        timer = setTimeout(() => void fire(note, key), debounceMs);
      }
      return;
    }

    // `skipped` (excluded folder) is a real answer — no suggestions — but it is
    // not the model's, so it is not cached: the exclusion set can change without
    // the note's content changing.
    if (!pass.skipped) remember(key, pass.suggestions);
    deps.onResult({ noteId: note.noteId, suggestions: pass.suggestions });
  }

  return {
    schedule(note: TagSuggestionNote): void {
      disarm();
      epoch += 1;

      // Defence in depth (the host refuses regardless — task 4): an excluded
      // note never arms a timer, so no prompt carrying its body is ever built.
      // Not cached — the exclusion set can change while the note does not.
      if (isNoteAiExcluded(note.noteFolder, deps.excludedFolders())) {
        deps.onResult({ noteId: note.noteId, suggestions: [] });
        return;
      }

      // The prompt window, computed once: it is both the digest's input and the
      // only text a pass can ever send.
      const promptBody = tagPromptBody(note.noteBody);
      const key = cacheKey(note.noteId, promptBody);
      if (key !== deferredKey) {
        deferredKey = key;
        deferredRetries = 0;
      }

      const cached = cache.get(key);
      if (cached !== undefined) {
        deps.onResult({ noteId: note.noteId, suggestions: cached });
        return;
      }

      // Carry the WINDOW, not the body. A pending pass outlives the debounce
      // interval and then a multi-second model call, and pinning the whole note
      // plaintext in that closure is exactly what property 2 above rules out.
      const captured: TagSuggestionNote = {
        noteId: note.noteId,
        noteBody: promptBody,
        noteFolder: note.noteFolder,
      };
      timer = setTimeout(() => void fire(captured, key), debounceMs);
    },

    cancel(): void {
      disarm();
      epoch += 1;
      deferredKey = null;
      deferredRetries = 0;
    },
  };
}
