// `<NewTabChooser>` — the empty-tab landing surface (MYND-166 behavioral
// pass). Shown when a pane has no active tab, or when the user opens a new
// tab via the strip's "+". Instead of the "+" force-creating a note, this
// lets the user search/pick an existing note or create a fresh one — the
// "empty state window" from the design decision.
//
// Presented as ONE clean card (search → recent list → action rows) rather than
// loose floating controls, so the empty tab reads as a deliberate command
// surface (à la a command palette) instead of a bare page.
//
// Notes come from the in-memory sidebar cache (already loaded for the
// vault), filtered to live notes (no trash, no templates) and ranked by
// recency, so picking is instant with no extra IPC.

import { useMemo, useState, type CSSProperties, type KeyboardEvent } from "react";
import { useTranslation } from "react-i18next";
import { Icon } from "../../components/primitives/Icon";
import {
  hoverSurface,
  HOVER_TRANSITION,
} from "../../components/primitives/hoverSurface";
import { usePrefs } from "../../hooks/usePrefs";
import { archivedFolderKeys } from "../archivedFolders";
import { liveCache, useSelectedNote, type NoteId } from "../sidebarState";

type NewTabChooserProps = {
  /** Open an existing note into the new tab. */
  onPick: (id: NoteId) => void;
  /** Create a fresh note into the new tab (then inline-rename it). */
  onCreate: () => void;
  /** Create a fresh drawing (kind: drawing) into the new tab, then inline-rename. */
  onCreateDrawing: () => void;
  /** When true (the pane still has other tabs), Esc returns to the
   *  previously-active tab. A tabless pane has nowhere to fall back to. */
  cancellable: boolean;
  onCancel: () => void;
};

const WRAP: CSSProperties = {
  maxWidth: 480,
  width: "100%",
  margin: "10vh auto 0",
  padding: "0 16px",
  boxSizing: "border-box",
  fontFamily: "var(--font-sans)",
};

// The card — one bordered, elevated surface the whole chooser lives inside.
const CARD: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  background: "var(--bg-2)",
  border: "1px solid var(--line-1)",
  borderRadius: "var(--radius-2)",
  boxShadow: "var(--shadow-2)",
  overflow: "hidden",
};

const SEARCH_ROW: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 8,
  padding: "11px 14px",
  borderBottom: "1px solid var(--line-1)",
  color: "var(--fg-3)",
};

const INPUT: CSSProperties = {
  flex: 1,
  border: 0,
  outline: "none",
  // Suppress the global `input:focus-visible` ring (tokens.css) — the field is
  // the card's header, not a standalone control.
  boxShadow: "none",
  background: "transparent",
  color: "var(--fg-1)",
  fontFamily: "var(--font-sans)",
  fontSize: 14,
};

const SECTION_LABEL: CSSProperties = {
  padding: "10px 14px 4px",
  fontFamily: "var(--font-sans)",
  fontSize: 11,
  fontWeight: 600,
  letterSpacing: "0.06em",
  textTransform: "uppercase",
  color: "var(--fg-3)",
};

const LIST: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 1,
  maxHeight: "38vh",
  overflowY: "auto",
  padding: "0 6px 6px",
};

const ROW: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 8,
  width: "100%",
  padding: "8px 8px",
  border: 0,
  borderRadius: "var(--radius-1)",
  background: "transparent",
  color: "var(--fg-1)",
  cursor: "pointer",
  textAlign: "left",
  fontFamily: "var(--font-sans)",
  fontSize: 13,
  transition: HOVER_TRANSITION,
};

const EMPTY: CSSProperties = {
  padding: "16px 14px",
  color: "var(--fg-3)",
  fontSize: 13,
  textAlign: "center",
};

// The action rows at the card's foot — Create / New drawing, presented like
// menu entries (icon + label) rather than floating buttons.
const ACTIONS: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  borderTop: "1px solid var(--line-1)",
  padding: 6,
  gap: 1,
};

const ACTION_ROW: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 10,
  width: "100%",
  padding: "9px 10px",
  border: 0,
  borderRadius: "var(--radius-1)",
  background: "transparent",
  color: "var(--fg-1)",
  cursor: "pointer",
  textAlign: "left",
  fontFamily: "var(--font-sans)",
  fontSize: 13,
  fontWeight: 500,
  transition: HOVER_TRANSITION,
};

export function NewTabChooser({
  onPick,
  onCreate,
  onCreateDrawing,
  cancellable,
  onCancel,
}: NewTabChooserProps) {
  const { t } = useTranslation();
  const ctx = useSelectedNote();
  const { prefs } = usePrefs();
  const [query, setQuery] = useState("");
  // Focus the whole search pill (not the bare input) — inline styles can't
  // express `:focus-within`, so track it.
  const [searchFocused, setSearchFocused] = useState(false);

  const archivedKeys = useMemo(
    () => archivedFolderKeys(prefs.archived_folders),
    [prefs.archived_folders],
  );

  const rows = useMemo(() => {
    // `liveCache` is the canonical trash/template/archive visibility predicate
    // (sidebarState) — reuse it (with the folder-archive keys) so this picker
    // can't silently diverge.
    const all = [...liveCache(ctx.cache, archivedKeys).values()];
    const q = query.trim().toLowerCase();
    const matched =
      q === ""
        ? all
        : all.filter((r) => (r.title ?? "").toLowerCase().includes(q));
    return matched
      .sort(
        (a, b) => (b.updatedAt?.getTime() ?? 0) - (a.updatedAt?.getTime() ?? 0),
      )
      .slice(0, 100);
  }, [ctx.cache, query, archivedKeys]);

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (cancellable && e.key === "Escape") {
      e.preventDefault();
      onCancel();
      return;
    }
    // Enter opens the top result — the search doubles as go-to-file.
    if (e.key === "Enter" && rows.length > 0) {
      e.preventDefault();
      onPick(rows[0]!.noteUuid);
    }
  };

  return (
    <div style={WRAP} onKeyDown={onKeyDown}>
      <div style={CARD}>
        <div
          style={{
            ...SEARCH_ROW,
            ...(searchFocused ? { color: "var(--accent)" } : {}),
          }}
        >
          <Icon name="search" size={15} />
          {/* eslint-disable-next-line jsx-a11y/no-autofocus */}
          <input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onFocus={() => setSearchFocused(true)}
            onBlur={() => setSearchFocused(false)}
            placeholder={t("notes.newTab.searchPlaceholder")}
            spellCheck={false}
            autoComplete="off"
            aria-label={t("notes.newTab.searchAriaLabel")}
            style={INPUT}
          />
        </div>

        {rows.length > 0 && (
          <div style={SECTION_LABEL}>{t("notes.newTab.recent")}</div>
        )}
        <div style={LIST}>
          {rows.length === 0 ? (
            <div style={EMPTY}>
              {query.trim() === ""
                ? t("notes.newTab.noNotesYet")
                : t("notes.newTab.noNotesMatch")}
            </div>
          ) : (
            rows.map((r) => (
              <button
                key={r.noteUuid}
                type="button"
                onClick={() => onPick(r.noteUuid)}
                {...hoverSurface()}
                style={ROW}
              >
                <Icon name="file-text" size={14} />
                <span
                  style={{
                    flex: 1,
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                    fontStyle: r.title === null ? "italic" : "normal",
                    color: r.title === null ? "var(--fg-3)" : undefined,
                  }}
                >
                  {r.title ?? t("notes.newTab.untitled")}
                </span>
              </button>
            ))
          )}
        </div>

        <div style={ACTIONS}>
          <button
            type="button"
            onClick={onCreate}
            {...hoverSurface()}
            style={ACTION_ROW}
          >
            <span style={{ display: "flex", flexShrink: 0, color: "var(--accent)" }}>
              <Icon name="plus" size={15} />
            </span>
            <span>{t("notes.newTab.createNote")}</span>
          </button>
          <button
            type="button"
            onClick={onCreateDrawing}
            data-testid="notes.newTab.create-drawing"
            {...hoverSurface()}
            style={ACTION_ROW}
          >
            <span style={{ display: "flex", flexShrink: 0, color: "var(--fg-3)" }}>
              <Icon name="pencil" size={15} />
            </span>
            <span>{t("notes.newTab.createDrawing")}</span>
          </button>
        </div>
      </div>
    </div>
  );
}
