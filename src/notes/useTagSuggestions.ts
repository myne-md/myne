// Host-side state for one pane's inline tag-suggestion band (MYND-651 task 7).
//
// The last wire in the auto-tag chain. Everything either side of it already
// exists and is tested alone: `createTagSuggestionTrigger` (task 5) decides
// WHEN a pass runs and caches its answer, `acceptTagIntoView` (task 6) decides
// what accepting does to the note, and the editor's band widget renders what it
// is handed. This hook is the part that could not be unit-tested from either
// side — it owns the pane's suggestion state and the per-note dismissals.
//
// Three rules the band cannot get from the trigger alone:
//
//   1. **A tag the note already carries is not a suggestion.** After an accept
//      the content changes, the cache entry is invalidated by construction, and
//      the next pass legitimately proposes the same tag again — now as existing
//      vocabulary. Filtering on `computeTagAcceptEdit(...) === null` reuses the
//      one authority on "is this tag already here" (the §3.7.8 fold, frontmatter
//      `tags:`/`tag:` AND inline `#tag`) rather than adding a second answer.
//      It also hides the band on frontmatter the writer refuses to touch, which
//      is the honest reading: a chip there would offer a write that cannot land.
//   2. **A dismissal is per note and per session.** Nothing is persisted — a
//      dismissed tag is a RAM-only, note-scoped judgement, dropped on note
//      switch. Persisting it would be a second on-disk artefact for a feature
//      whose whole result set is deliberately ephemeral (SYNC-8).
//   3. **Off means gone, immediately.** With `ai_enabled` or `auto_tag_enabled`
//      off (or on a host with no local AI at all) the trigger is cancelled and
//      the chips clear in the same render — not "stops proposing new ones".

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { TagSuggestionChip } from "@myne/editor/decorations/tag-suggestion-band";

import { foldSegment } from "../dialect/folderPath";
import { computeTagAcceptEdit } from "./ai/acceptTag";
import {
  createTagSuggestionTrigger,
  type TagSuggestionTrigger,
} from "./ai/tagSuggestionTrigger";
import { tagTree } from "./vaultIndices";

const NO_CHIPS: readonly TagSuggestionChip[] = [];

/** What the pane knows about the note the band is for. */
export interface TagSuggestionInput {
  /** The open note, or `null` when the pane shows no note. */
  noteId: string | null;
  /** The pane's mirrored note body — also the trigger's recompute signal. */
  body: string;
  /** The note's canonical trailing-slash folder (`""` = vault root). */
  folder: string;
  /** `ai_enabled && auto_tag_enabled`, ANDed with the host's local-AI
   *  capability. False switches the whole surface off. */
  enabled: boolean;
  /** `prefs.ai_excluded_folders` (SYNC-14). */
  excludedFolders: readonly string[];
  /** Debounce override — the E2E lane shortens it. */
  debounceMs?: number;
}

/**
 * The chips for the open note, plus the one thing a chip activation needs.
 *
 * `dismiss` drops one tag for this note — and it is what an ACCEPT calls too:
 * the accepted tag is about to be filtered out by rule 1 anyway once the body
 * mirror comes back around, and hiding it in the same tick means the chip does
 * not linger for a render after the click.
 */
export interface TagSuggestionBandState {
  suggestions: readonly TagSuggestionChip[];
  dismiss: (tag: string) => void;
}

export function useTagSuggestions(input: TagSuggestionInput): TagSuggestionBandState {
  const { noteId, body, folder, enabled, excludedFolders, debounceMs } = input;

  const [raw, setRaw] = useState<readonly TagSuggestionChip[]>(NO_CHIPS);
  const [hidden, setHidden] = useState<ReadonlySet<string>>(() => new Set());

  // The trigger is created once and driven imperatively, so every input it reads
  // at fire time rides a ref. A trigger rebuilt on a prefs change would drop its
  // content-hash cache and re-run inference for notes it had already answered.
  const noteIdRef = useRef(noteId);
  noteIdRef.current = noteId;
  const excludedRef = useRef(excludedFolders);
  excludedRef.current = excludedFolders;

  const trigger: TagSuggestionTrigger = useMemo(
    () =>
      createTagSuggestionTrigger({
        // The vault's existing vocabulary, read at fire time — it grows as the
        // user accepts, and an existing tag ranks ahead of a new one.
        existingTags: async () => (await tagTree()).map((n) => n.display),
        excludedFolders: () => excludedRef.current,
        onResult: (result) => {
          // A result that landed after the pane moved on belongs to a note that
          // is no longer open. The trigger's own epoch guard covers the passes it
          // started, but a cache hit answers synchronously from `schedule`, so
          // check here too.
          if (result.noteId !== noteIdRef.current) return;
          setRaw(result.suggestions.map((s) => ({ tag: s.tag, isNew: s.isNew })));
        },
        ...(debounceMs === undefined ? {} : { debounceMs }),
      }),
    [debounceMs],
  );

  // Dispose on unmount: a pane closing mid-pass must not deliver into a
  // React state setter that no longer has a component behind it.
  useEffect(() => () => trigger.cancel(), [trigger]);

  // A note switch resets everything visible. The trigger's cache survives (it is
  // keyed by note + content, and returning to this note should be instant).
  useEffect(() => {
    setRaw(NO_CHIPS);
    setHidden(new Set());
  }, [noteId]);

  // Arm the trigger. `body` in the dep list is what makes this an edit-driven
  // debounce: `schedule` is self-coalescing and cheap, so calling it on every
  // keystroke is the intended usage.
  useEffect(() => {
    if (!enabled || noteId === null) {
      trigger.cancel();
      setRaw(NO_CHIPS);
      return;
    }
    trigger.schedule({ noteId, noteBody: body, noteFolder: folder });
  }, [trigger, enabled, noteId, body, folder]);

  const dismiss = useCallback((tag: string) => {
    const key = foldSegment(tag);
    setHidden((prev) => {
      if (prev.has(key)) return prev;
      const next = new Set(prev);
      next.add(key);
      return next;
    });
  }, []);

  const suggestions = useMemo(() => {
    if (raw.length === 0) return NO_CHIPS;
    return raw.filter(
      (chip) =>
        !hidden.has(foldSegment(chip.tag)) && computeTagAcceptEdit(body, chip.tag) !== null,
    );
  }, [raw, hidden, body]);

  return useMemo(() => ({ suggestions, dismiss }), [suggestions, dismiss]);
}
