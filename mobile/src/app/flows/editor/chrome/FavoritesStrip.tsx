import { useTranslation } from "react-i18next";
import type { NoteEntry } from "../types";

/** Beeper-style favorites strip — a horizontal row of square tiles for the
 *  starred notes, shown at the top of the notes list (above the tree). Each tile
 *  is the note's initial over its title; tap opens it. Scrolls with the list. */
export function FavoritesStrip({ notes, onOpen }: { notes: NoteEntry[]; onOpen: (id: string) => void }) {
  const { t } = useTranslation();
  return (
    <div style={{ padding: "6px 0 10px" }}>
      <div style={{ padding: "0 20px 8px", fontSize: 11, fontWeight: 700, letterSpacing: "0.06em", textTransform: "uppercase", color: "var(--fg-3)" }}>
        {t("notes.list.favoritesHeading")}
      </div>
      <div style={{ display: "flex", gap: 12, overflowX: "auto", padding: "0 20px", scrollbarWidth: "none", WebkitOverflowScrolling: "touch", touchAction: "pan-x" }}>
        {notes.map((n) => (
          <button
            key={n.id}
            onClick={() => onOpen(n.id)}
            aria-label={n.title}
            style={{ flex: "none", width: 64, border: "none", background: "transparent", padding: 0, cursor: "pointer", display: "flex", flexDirection: "column", alignItems: "center", gap: 6 }}
          >
            <div style={{ width: 60, height: 60, borderRadius: 16, background: "var(--accent-soft)", border: "1px solid var(--line-1)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 24, fontWeight: 700, color: "var(--accent)", fontFamily: "var(--font-sans)" }}>
              {(n.title.trim()[0] ?? "•").toUpperCase()}
            </div>
            <span style={{ width: "100%", fontSize: 11, lineHeight: 1.25, color: "var(--fg-2)", textAlign: "center", display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden" }}>
              {n.title}
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}
