// `<NewTabChooser>` — the empty-tab landing surface (MYND-166 behavioral
// pass). Shown when a pane has no active tab, or when the user opens a new
// tab via the strip's "+". Instead of the "+" force-creating a note, this
// lets the user search/pick an existing note or create a fresh one — the
// "empty state window" from the design decision.
//
// Notes come from the in-memory sidebar cache (already loaded for the
// vault), filtered to live notes (no trash, no templates) and ranked by
// recency, so picking is instant with no extra IPC.

import { useMemo, useState, type CSSProperties, type KeyboardEvent } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "../../components/primitives/Button";
import { Icon } from "../../components/primitives/Icon";
import { usePrefs } from "../../hooks/usePrefs";
import { archivedFolderKeys } from "../archivedFolders";
import { liveCache, useSelectedNote, type NoteId } from "../sidebarState";

type NewTabChooserProps = {
  /** Open an existing note into the new tab. */
  onPick: (id: NoteId) => void;
  /** Create a fresh note into the new tab (then inline-rename it). */
  onCreate: () => void;
  /** When true (the pane still has other tabs), Esc returns to the
   *  previously-active tab. A tabless pane has nowhere to fall back to. */
  cancellable: boolean;
  onCancel: () => void;
};

const WRAP: CSSProperties = {
  maxWidth: 440,
  width: "100%",
  margin: "8vh auto 0",
  display: "flex",
  flexDirection: "column",
  gap: 12,
  fontFamily: "var(--font-sans)",
};

const SEARCH_ROW: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 8,
  padding: "8px 10px",
  border: "1px solid var(--line-1)",
  borderRadius: "var(--radius-2)",
  background: "var(--paper-2)",
  color: "var(--fg-3)",
};

const INPUT: CSSProperties = {
  flex: 1,
  border: 0,
  outline: "none",
  // Suppress the global `input:focus-visible` ring (tokens.css) — the focus
  // ring belongs on the whole search pill, not around the bare input.
  boxShadow: "none",
  background: "transparent",
  color: "var(--fg-1)",
  fontFamily: "var(--font-sans)",
  fontSize: 14,
};

const LIST: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 2,
  maxHeight: "40vh",
  overflowY: "auto",
};

const ROW: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 8,
  width: "100%",
  padding: "8px 10px",
  border: 0,
  borderRadius: "var(--radius-1)",
  background: "transparent",
  color: "var(--fg-1)",
  cursor: "pointer",
  textAlign: "left",
  fontFamily: "var(--font-sans)",
  fontSize: 13,
};

const EMPTY: CSSProperties = {
  padding: "10px",
  color: "var(--fg-3)",
  fontSize: 13,
};

export function NewTabChooser({
  onPick,
  onCreate,
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
    }
  };

  return (
    <div style={WRAP} onKeyDown={onKeyDown}>
      <div
        style={{
          ...SEARCH_ROW,
          ...(searchFocused
            ? { borderColor: "var(--accent)", boxShadow: "var(--ring)" }
            : {}),
        }}
      >
        <Icon name="search" size={14} />
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
              style={ROW}
              onMouseEnter={(e) => {
                e.currentTarget.style.background = "var(--paper-3)";
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.background = "transparent";
              }}
            >
              <Icon name="file-text" size={13} />
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
      <Button
        variant="primary"
        icon="plus"
        onClick={onCreate}
        style={{ alignSelf: "center", marginTop: 4 }}
      >
        {t("notes.newTab.createNote")}
      </Button>
    </div>
  );
}
