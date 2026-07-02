// Suggestion chips for the AI panel (auto-tag-link MYND-411 task 4).
//
// Renders the ranked `TagSuggestion[]` (auto-tag-link tasks 1–2) as click-to-
// insert chips inside sibling 3's right-sidebar AI panel (SYNC-15) — reusing
// that surface, not a new column. Existing-vocabulary chips and new-flagged
// chips are visually distinguishable (border weight + a `data-is-new` marker).
// Nothing is auto-inserted: a chip writes only on click (SYNC-17), dispatched
// through `onAccept` (the Editor wires `computeTagsAfterAccept`/`appendInlineTag`
// + the save — task 5). Accepted chips reflect their state and no longer fire.

import type { CSSProperties } from "react";

import { foldSegment } from "../../dialect/folderPath";
import type { TagSuggestion } from "../ai/tagRanker";

export interface TagSuggestionChipsProps {
  /** Ranked suggestions (existing-vocabulary first). */
  suggestions: readonly TagSuggestion[];
  /** Explicit click-to-insert (task 5). Not fired for an already-accepted tag. */
  onAccept: (suggestion: TagSuggestion) => void;
  /** Tags already on the note (folded-compared) — chips for these render as
   *  accepted and are non-interactive. */
  acceptedTags?: readonly string[];
}

const ROW_STYLE: CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  gap: 6,
  margin: "10px 0 0",
};

function chipStyle(isNew: boolean, accepted: boolean): CSSProperties {
  return {
    fontSize: 12,
    fontWeight: 500,
    // New-flagged chips carry a dashed border; existing-vocabulary chips a solid
    // one — the visual "already in your vault" vs "new" distinction.
    border: isNew ? "1px dashed var(--line-1)" : "1px solid var(--line-1)",
    borderRadius: "var(--radius-1)",
    padding: "2px 8px",
    color: accepted ? "var(--fg-3)" : "var(--fg-2)",
    background: accepted ? "var(--bg-2)" : "transparent",
    cursor: accepted ? "default" : "pointer",
    opacity: accepted ? 0.6 : 1,
  };
}

export function TagSuggestionChips({
  suggestions,
  onAccept,
  acceptedTags = [],
}: TagSuggestionChipsProps) {
  if (suggestions.length === 0) return null;
  const acceptedKeys = new Set(acceptedTags.map((t) => foldSegment(t)));

  return (
    <div data-testid="ai.tag-chips" style={ROW_STYLE}>
      {suggestions.map((s) => {
        const accepted = acceptedKeys.has(foldSegment(s.tag));
        return (
          <button
            key={`${s.isNew ? "new" : "vocab"}:${s.tag}`}
            type="button"
            data-testid="ai.tag-chip"
            data-is-new={s.isNew ? "true" : "false"}
            data-accepted={accepted ? "true" : "false"}
            disabled={accepted}
            onClick={() => {
              if (!accepted) onAccept(s);
            }}
            style={chipStyle(s.isNew, accepted)}
          >
            {s.isNew ? `+ ${s.tag}` : s.tag}
          </button>
        );
      })}
    </div>
  );
}
