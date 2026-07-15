import { type ReactNode, useRef } from "react";
import { useTranslation } from "react-i18next";
import type { NoteEntry, PressEvt } from "../types";

/** A chronological note row (mirror notes/05 ChronoRow geometry). */
const STAR_PATH = "M12 3l2.9 5.9 6.5.9-4.7 4.6 1.1 6.5L12 18.4 6.2 21.4l1.1-6.5L2.6 9.8l6.5-.9z";

export function NoteRow({
  entry,
  last,
  onOpen,
  onHold,
  favorited = false,
  onToggleFavorite,
  actions,
  indent = 0,
  subtitle,
  divider = true,
  selected = false,
}: {
  entry: NoteEntry;
  last: boolean;
  onOpen: () => void;
  /** Long-press / right-click handler — opens the row action sheet. */
  onHold?: () => void;
  favorited?: boolean;
  onToggleFavorite?: () => void;
  actions?: ReactNode;
  /** Extra left padding (px) for the folder-tree hierarchy. */
  indent?: number;
  /** Overrides the second line. `undefined` → fall back to the body snippet
   *  (search results); a string (incl. "") → show it verbatim (the list's
   *  last-edited relative time). */
  subtitle?: string;
  /** Draw the top/last hairline. Off in the tree view (a tree-line separates). */
  divider?: boolean;
  /** Highlight as the note open in the detail pane (regular size classes; the
   *  compact list never coexists with an open editor). */
  selected?: boolean;
}) {
  const { t } = useTranslation();
  const sub = subtitle !== undefined ? subtitle : entry.snippet;
  // Long-press (touch) / right-click reveals the row action sheet. A hold that
  // survives ~480ms without the finger drifting (which would be a scroll) fires
  // onHold; the ensuing click is then swallowed so the note doesn't also open.
  const holdTimer = useRef<number | null>(null);
  const holdAt = useRef<{ x: number; y: number } | null>(null);
  const held = useRef(false);
  const clearHold = () => {
    if (holdTimer.current != null) window.clearTimeout(holdTimer.current);
    holdTimer.current = null;
    holdAt.current = null;
  };
  const startHold = (e: PressEvt) => {
    if (!onHold) return;
    held.current = false;
    holdAt.current = { x: e.clientX, y: e.clientY };
    holdTimer.current = window.setTimeout(() => {
      held.current = true;
      holdTimer.current = null;
      onHold();
    }, 480);
  };
  const moveHold = (e: PressEvt) => {
    const s = holdAt.current;
    if (s && (Math.abs(e.clientX - s.x) > 10 || Math.abs(e.clientY - s.y) > 10)) clearHold();
  };
  return (
    <div
      data-testid="notes.row"
      data-note-id={entry.id}
      data-selected={selected || undefined}
      onClick={() => {
        if (held.current) { held.current = false; return; } // consumed by the long-press
        onOpen();
      }}
      onPointerDown={startHold}
      onPointerMove={moveHold}
      onPointerUp={clearHold}
      onPointerLeave={clearHold}
      onPointerCancel={clearHold}
      onContextMenu={(e) => { if (onHold) e.preventDefault(); }}
      style={{
        borderTop: divider ? "1px solid var(--line-1)" : undefined,
        borderBottom: divider && last ? "1px solid var(--line-1)" : undefined,
        cursor: "pointer",
        WebkitUserSelect: "none",
        userSelect: "none",
        WebkitTouchCallout: "none",
      }}
    >
      {/* The selected highlight is a rounded block INSET to the content x (after
          the folder-tree rail), so an indented note never paints its background
          over the indent rail — parity with the desktop rounded-pill rows. */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 10,
          margin: `3px 8px 3px ${8 + indent}px`,
          padding: "8px 12px",
          borderRadius: 8,
          background: selected ? "var(--accent-soft)" : undefined,
        }}
      >
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 16, fontWeight: 600, color: "var(--fg-1)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{entry.title}</div>
        {sub && (
          <div
            style={{
              marginTop: 2,
              fontSize: 13,
              color: "var(--fg-3)",
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {sub}
          </div>
        )}
      </div>
      {actions
        ? actions
        : // Inline star shows ONLY for favorited notes (filled) as a quick-unstar
          // affordance. Non-favorited rows show nothing here — "Add to favorites"
          // lives in the long-press action sheet instead.
          favorited &&
          onToggleFavorite && (
            <button
              onClick={(e) => {
                e.stopPropagation();
                onToggleFavorite();
              }}
              aria-label={t("notes.row.removeFromFavorites")}
              style={{ border: "none", background: "transparent", padding: 0, width: 30, height: 30, cursor: "pointer", flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "center" }}
            >
              <svg width="17" height="17" viewBox="0 0 24 24">
                <path d={STAR_PATH} fill="var(--accent)" stroke="var(--accent)" strokeWidth="1.5" strokeLinejoin="round" />
              </svg>
            </button>
          )}
      </div>
    </div>
  );
}
