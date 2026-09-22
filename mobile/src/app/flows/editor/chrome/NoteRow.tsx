import { type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type { NoteEntry } from "../types";
import { ColorDot } from "../decorations/ColorDot";
import { useHold } from "./useHold";
import { tappable } from "../../../a11y/tappable";

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
  color,
}: {
  entry: NoteEntry;
  last: boolean;
  onOpen: () => void;
  /** Long-press / right-click handler — opens the row action sheet. */
  onHold?: () => void;
  favorited?: boolean;
  onToggleFavorite?: () => void;
  actions?: ReactNode;
  /** Color-label slot (`prefs.item_colors[id]`) → a leading dot, else none
   *  (MYND-516). */
  color?: string;
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
  // Long-press (touch) / right-click reveals the row action sheet (shared hook).
  const { handlers, consumeHeldClick } = useHold(onHold);
  return (
    <div
      data-testid="notes.row"
      data-note-id={entry.id}
      data-selected={selected || undefined}
      // NOT a control, and that is the second answer rather than the first
      // (myne#728, review of task 16). Making the whole row a `role="button"`
      // is the obvious fix and it is wrong here: the row CONTAINS controls
      // (the unstar button, and whatever `actions` renders, which on the
      // trash and archive lists is Restore / Delete), so a button role
      // produces the same `nested-interactive` shape the desktop tab strip
      // went out of its way to remove, and it swallows those buttons' labels
      // into the row's own name.
      //
      // The text block below carries the control instead. The row keeps its
      // click as a touch convenience, which costs nothing because the real
      // control is inside it.
      onClick={() => {
        if (consumeHeldClick()) return; // this click was the long-press tail
        onOpen();
      }}
      {...handlers}
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
      {/* THIS is the control (myne#728): the row's text, named by its own
          contents (title, snippet, date), with the row's action buttons as
          siblings rather than descendants. Same shape `AttachmentsSheet`
          uses. */}
      <div
        {...tappable({
          onActivate: () => {
            if (consumeHeldClick()) return; // this click was the long-press tail
            onOpen();
          },
        })}
        style={{ flex: 1, minWidth: 0 }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 7, minWidth: 0 }}>
          <ColorDot slot={color} />
          <div style={{ flex: 1, minWidth: 0, fontSize: 16, fontWeight: 600, color: "var(--fg-1)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{entry.title}</div>
        </div>
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
