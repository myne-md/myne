import { useTranslation } from "react-i18next";
import type { NoteEntry } from "../types";
import { useHold } from "./useHold";

/** One favorites-strip tile: the note's initial over its title. A short tap
 *  opens it; a long-press (MYND-597) opens the row action sheet via `onHold` —
 *  the only way to un-favorite from this view, since a favorited note is pulled
 *  out of the list below. Its own component so the `useHold` hook runs at a
 *  stable top level (a hook cannot be called inside the strip's `.map`). */
function FavoriteTile({
  note,
  onOpen,
  onHold,
}: {
  note: NoteEntry;
  onOpen: (id: string) => void;
  onHold?: (note: NoteEntry) => void;
}) {
  const { handlers, consumeHeldClick } = useHold(
    onHold ? () => onHold(note) : undefined,
  );
  return (
    <button
      onClick={() => {
        if (consumeHeldClick()) return; // this click was the long-press tail
        onOpen(note.id);
      }}
      {...handlers}
      aria-label={note.title}
      data-testid="notes.favorite-tile"
      data-note-id={note.id}
      style={{ flex: "none", width: 64, border: "none", background: "transparent", padding: 0, cursor: "pointer", display: "flex", flexDirection: "column", alignItems: "center", gap: 6, WebkitUserSelect: "none", userSelect: "none", WebkitTouchCallout: "none" }}
    >
      <div style={{ width: 60, height: 60, borderRadius: 16, background: "var(--accent-soft)", border: "1px solid var(--line-1)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 24, fontWeight: 700, color: "var(--accent)", fontFamily: "var(--font-sans)" }}>
        {(note.title.trim()[0] ?? "•").toUpperCase()}
      </div>
      <span style={{ width: "100%", fontSize: 11, lineHeight: 1.25, color: "var(--fg-2)", textAlign: "center", display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden" }}>
        {note.title}
      </span>
    </button>
  );
}

/** Beeper-style favorites strip — a horizontal row of square tiles for the
 *  starred notes, shown at the top of the notes list (above the tree). Tap a
 *  tile to open; long-press to reach the row action sheet (un-favorite etc.,
 *  MYND-597). Scrolls with the list. */
export function FavoritesStrip({
  notes,
  onOpen,
  onHold,
}: {
  notes: NoteEntry[];
  onOpen: (id: string) => void;
  /** Long-press a tile → open the row action sheet for that note. */
  onHold?: (note: NoteEntry) => void;
}) {
  const { t } = useTranslation();
  return (
    <div style={{ padding: "6px 0 10px" }}>
      <div style={{ padding: "0 20px 8px", fontSize: 11, fontWeight: 700, letterSpacing: "0.06em", textTransform: "uppercase", color: "var(--fg-3)" }}>
        {t("notes.list.favoritesHeading")}
      </div>
      <div style={{ display: "flex", gap: 12, overflowX: "auto", padding: "0 20px", scrollbarWidth: "none", WebkitOverflowScrolling: "touch", touchAction: "pan-x" }}>
        {notes.map((n) => (
          <FavoriteTile key={n.id} note={n} onOpen={onOpen} onHold={onHold} />
        ))}
      </div>
    </div>
  );
}
