// "Used in N notes" popover (MYND-170). Lists the notes referencing an
// attachment and lets the user jump to one. Powered by the reconcile
// query (`referencingNotes`, SYNC-6 amended — note-ids, not just a count).
//
// Placement, the portal to `document.body` and dismissal all belong to
// `<AnchoredPanel>`. That is a de-duplication rather than a fix for a defect
// this file had: the popover was already portaled, and it hand-rolled its own
// measurement, viewport clamp, outside-press listener and scroll/resize close
// (the same four things `AttachmentActionMenu` hand-rolled beside it). What the
// primitive adds on top is the vertical half the hand-written version did not
// have: it flips above the trigger and bounds its own height when there is no
// room below, where "below the tile footer" is often the bottom of the window.
//
// Titles resolve from the sidebar cache (the boot sweep populates it for
// the whole vault); an id not in the cache falls back to "Untitled".

import type { CSSProperties, RefObject } from "react";
import { useTranslation } from "react-i18next";
import type { NoteId } from "../../notes/sidebarState";
import { HOVER_TRANSITION } from "../primitives/hoverSurface";
import { interactiveSurface } from "../primitives/interactiveSurface";
import { AnchoredPanel } from "../primitives/AnchoredPanel";
import type { TitleRecord } from "../../notes/loadNoteBatch";

interface UsedInNotesPopoverProps {
  noteIds: readonly string[];
  cache: ReadonlyMap<NoteId, TitleRecord>;
  onJump: (id: NoteId) => void;
  onClose: () => void;
  /** The trigger element the popover anchors to (positioned just below it). */
  anchorRef: RefObject<HTMLElement | null>;
}

/** The popover's own look. Position, size bounds and dismissal are the panel's. */
const POPOVER_STYLE: CSSProperties = {
  background: "var(--bg-1)",
  border: "1px solid var(--line-1)",
  borderRadius: "var(--radius-2)",
  boxShadow: "var(--shadow-2, 0 4px 16px rgba(0,0,0,0.18))",
  padding: "var(--space-1) 0",
};

const ITEM_STYLE: CSSProperties = {
  display: "block",
  width: "100%",
  textAlign: "start",
  padding: "var(--space-2) var(--space-3)",
  background: "transparent",
  border: 0,
  cursor: "pointer",
  fontFamily: "var(--font-sans)",
  // The menu row deepens on hover and on press through `interactiveSurface`, and
  // without this the mutation lands as a single-frame jump rather than a settle.
  transition: HOVER_TRANSITION,
  fontSize: "var(--text-sm)",
  color: "var(--fg-1)",
  whiteSpace: "nowrap",
  overflow: "hidden",
  textOverflow: "ellipsis",
};

const EMPTY_STYLE: CSSProperties = {
  padding: "var(--space-2) var(--space-3)",
  fontFamily: "var(--font-sans)",
  fontSize: "var(--text-sm)",
  color: "var(--fg-3)",
};

export function UsedInNotesPopover({
  noteIds,
  cache,
  onJump,
  onClose,
  anchorRef,
}: UsedInNotesPopoverProps) {
  const { t } = useTranslation();

  return (
    <AnchoredPanel
      open
      onClose={onClose}
      anchorRef={anchorRef}
      // Left-aligned to the trigger (which sits at the tile's left edge), not
      // right-aligned: the note list opens away from the tile, into the grid.
      align="start"
      minWidth={220}
      maxWidth={320}
      style={POPOVER_STYLE}
    >
      {/* The role stays on the LIST, not on the panel: the popover IS the menu
          the user reads, and the single-open test asserts there is exactly one
          `role="menu"` in the document. */}
      <div role="menu">
        {noteIds.length === 0 ? (
          <div style={EMPTY_STYLE}>
            {t("attachments.usedInNotesPopover.empty")}
          </div>
        ) : (
          noteIds.map((id) => {
            const title = cache.get(id as NoteId)?.title ?? null;
            const label =
              title === null || title.trim() === ""
                ? t("common.untitled")
                : title;
            return (
              <button
                key={id}
                type="button"
                role="menuitem"
                data-testid="attachments.used-in-notes-row"
                data-note-id={id}
                style={ITEM_STYLE}
                {...interactiveSurface({ hoverBg: "var(--paper-2)" })}
                onClick={() => {
                  onJump(id as NoteId);
                  onClose();
                }}
              >
                {label}
              </button>
            );
          })
        )}
      </div>
    </AnchoredPanel>
  );
}
