// "Used in N notes" popover (MYND-170). Lists the notes referencing an
// attachment and lets the user jump to one. Powered by the reconcile
// query (`referencingNotes`, SYNC-6 amended — note-ids, not just a count).
//
// Rendered through a PORTAL to document.body with `position: fixed`,
// anchored to the trigger button's rect. This is load-bearing: the grid
// tile (`overflow: hidden`) AND the library scroll container
// (`overflow-y: auto`) would both clip an in-tree absolutely-positioned
// popover, so the list would not display. The portal escapes both. It
// closes on outside-click / Esc / any scroll or resize (a fixed popover
// would desync from the trigger once the grid scrolls).
//
// Titles resolve from the sidebar cache (the boot sweep populates it for
// the whole vault); an id not in the cache falls back to "Untitled".

import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type RefObject,
} from "react";
import { useTranslation } from "react-i18next";
import { createPortal } from "react-dom";
import type { NoteId } from "../../notes/sidebarState";
import type { TitleRecord } from "../../notes/loadNoteBatch";

interface UsedInNotesPopoverProps {
  noteIds: readonly string[];
  cache: ReadonlyMap<NoteId, TitleRecord>;
  onJump: (id: NoteId) => void;
  onClose: () => void;
  /** The trigger element the popover anchors to (positioned just below it). */
  anchorRef: RefObject<HTMLElement | null>;
}

const POPOVER_STYLE: CSSProperties = {
  position: "fixed",
  zIndex: 50,
  minWidth: 220,
  maxWidth: 320,
  maxHeight: 280,
  overflowY: "auto",
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
  const ref = useRef<HTMLDivElement>(null);
  const [coords, setCoords] = useState<{ top: number; left: number } | null>(
    null,
  );

  // Anchor below the trigger (clamped to the viewport's right edge).
  useLayoutEffect(() => {
    const el = anchorRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const left = Math.min(r.left, window.innerWidth - 320 - 8);
    setCoords({ top: r.bottom + 4, left: Math.max(8, left) });
  }, [anchorRef]);

  useEffect(() => {
    const onDocClick = (e: MouseEvent) => {
      const t = e.target as Node;
      if (
        ref.current &&
        !ref.current.contains(t) &&
        anchorRef.current &&
        !anchorRef.current.contains(t)
      ) {
        onClose();
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    // A fixed popover desyncs from the trigger once the grid scrolls — close it.
    const onReflow = () => onClose();
    // Defer the click listener so the opening click doesn't immediately close it.
    const tid = setTimeout(
      () => document.addEventListener("click", onDocClick),
      0,
    );
    document.addEventListener("keydown", onKey);
    window.addEventListener("scroll", onReflow, true);
    window.addEventListener("resize", onReflow);
    return () => {
      clearTimeout(tid);
      document.removeEventListener("click", onDocClick);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("scroll", onReflow, true);
      window.removeEventListener("resize", onReflow);
    };
  }, [onClose, anchorRef]);

  if (coords === null) return null;

  return createPortal(
    <div
      ref={ref}
      style={{ ...POPOVER_STYLE, top: coords.top, left: coords.left }}
      role="menu"
    >
      {noteIds.length === 0 ? (
        <div style={EMPTY_STYLE}>{t("attachments.usedInNotesPopover.empty")}</div>
      ) : (
        noteIds.map((id) => {
          const title = cache.get(id as NoteId)?.title ?? null;
          const label =
            title === null || title.trim() === ""
              ? t("attachments.usedInNotesPopover.untitled")
              : title;
          return (
            <button
              key={id}
              type="button"
              role="menuitem"
              data-testid="attachments.used-in-notes-row"
              data-note-id={id}
              style={ITEM_STYLE}
              onMouseEnter={(e) => {
                e.currentTarget.style.background = "var(--paper-2)";
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.background = "transparent";
              }}
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
    </div>,
    document.body,
  );
}
