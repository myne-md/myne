// Tag browser modal (tag-system #2 / MYND-46). A palette-style modal carve-out
// (ModalShell + an Editor-local boolean), per the design canon — NOT a 4th pane.
// One column: a search input + an All/Any (AND/OR) toggle on top, the existing
// tags as clickable chips (the WHOLE chip toggles selection), and the filtered
// note list directly below. Renders the shipped `tagTree()`/`tagBrowser.ts`
// view-model + the #1 `tagFilter` contract. Launched from a command-palette
// action AND a persistent BottomBar affordance (SYNC-7); the editor `#tag` chip
// (#3) opens it seeded to one tag.
//
// Crypto-light: read-only over the in-RAM, plaintext-derived index
// (zeroize-on-lock). Selection + search state are ephemeral (TS-3 — no
// vault.workspace write). Tag identity/display via the view-model (SYNC-2:
// render `display`, never the folded `key`); single `byTag` path (SYNC-10);
// `ctx.open` navigation (SYNC-6); reader-surface card conventions (SYNC-4).

import { useEffect, useMemo, useState, type CSSProperties } from "react";
import { useTranslation } from "react-i18next";
import { ModalShell } from "../../components/primitives/ModalShell";
import { foldSegment } from "../../dialect/folderPath";
import { useIndexNonce } from "../indexNonce";
import { useResolverNotes } from "../resolverNotes";
import { liveIdSet } from "../resolveWikilink";
import { SECTION_HEADING_STYLE, SIDEBAR_CARD_STYLE } from "./sharedStyles";
import {
  HOVER_TRANSITION,
} from "../../components/primitives/hoverSurface";
import { interactiveSurface } from "../../components/primitives/interactiveSurface";
import { useSelectedNote } from "../sidebarState";
import { tagRows } from "../tagBrowser";
import {
  DEFAULT_FILTER_MODE,
  stabilizeResult,
  tagFilter,
  type FilterMode,
  type TagFilterResult,
} from "../tagFilter";
import { tagTree, type TagTreeNode } from "../vaultIndices";
import { tagPillStyle } from "../tagPillToken";
import { upsertSavedView } from "../../lib/prefs";
import {
  buildViewFromTags,
  defaultFilterViewName,
} from "../savedViewFromFilter";

const MESSAGE_STYLE: CSSProperties = {
  flex: 1,
  display: "grid",
  placeItems: "center",
  color: "var(--fg-3)",
  fontSize: "var(--text-sm)",
  padding: "var(--space-5)",
  textAlign: "center",
};

export function TagBrowser({
  open,
  onClose,
  seedTagKey = null,
}: {
  open: boolean;
  onClose: () => void;
  /** When set (and `open`), the initial selection is this one tag — the editor
   *  `#tag` chip's entry point (#3). Raw tag string; folded here. */
  seedTagKey?: string | null;
}) {
  const { t } = useTranslation();
  const notes = useResolverNotes();
  const ctx = useSelectedNote();
  const indexNonce = useIndexNonce();
  const [tags, setTags] = useState<TagTreeNode[]>([]);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [mode, setMode] = useState<FilterMode>(DEFAULT_FILTER_MODE);
  const [query, setQuery] = useState("");
  const [result, setResult] = useState<TagFilterResult | null>(null);
  // "Save current filter as view" (MYND-274 task 5): null = not saving; a
  // string = the in-progress view-name input.
  const [savingName, setSavingName] = useState<string | null>(null);

  // On open: fetch the tag list, reset ephemeral state, seed the selection.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    void tagTree().then(
      (t) => {
        if (!cancelled) setTags(t);
      },
      () => {},
    );
    setSelected(seedTagKey ? new Set([foldSegment(seedTagKey)]) : new Set());
    setMode(DEFAULT_FILTER_MODE);
    setQuery("");
    setResult(null);
    setSavingName(null);
    return () => {
      cancelled = true;
    };
  }, [open, seedTagKey]);

  // Re-run the filter whenever the selection/mode/live-set/index change. Cheap
  // in-RAM re-query (SYNC-5/14, cheap-RAM consumer); `stabilizeResult` keeps the
  // previous reference on a no-op so a vault-wide reindex burst bails the render.
  useEffect(() => {
    if (!open) return;
    const keys = [...selected];
    if (keys.length === 0) {
      setResult({ rows: [], count: 0 });
      return;
    }
    let cancelled = false;
    void tagFilter(keys, mode, liveIdSet(notes), ctx.cache).then(
      (fresh) => {
        if (!cancelled) setResult((prev) => stabilizeResult(prev, fresh));
      },
      () => {
        if (!cancelled) setResult({ rows: [], count: 0 });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [open, selected, mode, notes, indexNonce, ctx.cache]);

  const allRows = useMemo(() => tagRows(tags), [tags]);
  const displayByKey = useMemo(
    () => new Map(allRows.map((r) => [r.key, r.display])),
    [allRows],
  );
  // Search-filtered chips (flat — substring match on the folded query so it's
  // accent/case-insensitive, matching the tag identity rule).
  const chips = useMemo(() => {
    const q = foldSegment(query.trim());
    return q === "" ? allRows : allRows.filter((r) => r.key.includes(q));
  }, [allRows, query]);

  if (!open) return null;

  const toggleSelected = (key: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  const onOpenNote = (id: string) => {
    onClose();
    void ctx.open(id).catch(() => {});
  };

  // Persist the active tag filter as a saved view (MYND-274 task 5). Reads the
  // local `selected` + `mode`, builds the canonical filter AST via the pure
  // dispatch seam, and upserts via #3's API. Closes on success.
  const onSaveAsView = () => {
    const name = savingName ?? "";
    void (async () => {
      try {
        await upsertSavedView(
          buildViewFromTags(crypto.randomUUID(), [...selected], mode, name),
        );
        setSavingName(null);
        onClose();
      } catch {
        // Save failure surfaces via backend tracing; the prompt stays open.
      }
    })();
  };

  const hasSelection = selected.size > 0;
  const width = Math.min(640, Math.max(520, window.innerWidth - 96));
  const height = Math.min(620, Math.max(420, window.innerHeight - 96));

  return (
    <ModalShell
      open={open}
      title={t("notes.tagBrowser.title")}
      labelId="tag-browser-title"
      onClose={onClose}
      width={width}
      height={height}
      bodyBleed
    >
      <div
        data-testid="tags.modal"
        style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}
      >
        {/* Search + All/Any toggle */}
        <div
          style={{
            flex: "0 0 auto",
            display: "flex",
            alignItems: "center",
            gap: "var(--space-2)",
            padding: "10px 16px",
            borderBottom: "1px solid var(--line-1)",
          }}
        >
          <input
            type="text"
            data-testid="tags.search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t("notes.tagBrowser.searchPlaceholder")}
            autoFocus
            style={{
              flex: 1,
              minWidth: 0,
              fontSize: "var(--text-sm)",
              fontFamily: "var(--font-sans)",
              padding: "6px 10px",
              background: "var(--bg-1)",
              color: "var(--fg-1)",
              border: "1px solid var(--line-1)",
              borderRadius: "var(--radius-1)",
              outline: "none",
            }}
          />
          <ModeToggle mode={mode} onChange={setMode} />
        </div>

        {/* Tag chips — click the whole chip to toggle it into the filter */}
        <div
          style={{
            flex: "0 0 auto",
            maxHeight: 180,
            overflowY: "auto",
            display: "flex",
            flexWrap: "wrap",
            gap: 6,
            padding: "12px 16px",
            borderBottom: "1px solid var(--line-1)",
          }}
        >
          {allRows.length === 0 ? (
            <span style={{ fontSize: "var(--text-sm)", color: "var(--fg-3)" }}>
              {t("notes.tagBrowser.noTagsYet")}
            </span>
          ) : chips.length === 0 ? (
            <span style={{ fontSize: "var(--text-sm)", color: "var(--fg-3)" }}>
              {t("notes.tagBrowser.noTagsMatch", { query })}
            </span>
          ) : (
            chips.map((r) => (
              <button
                key={r.key}
                type="button"
                data-testid="tags.chip"
                data-tag-key={r.key}
                aria-pressed={selected.has(r.key)}
                onClick={() => toggleSelected(r.key)}
                {...interactiveSurface({
                  restBg: "var(--paper-2)",
                  hoverBg: "var(--paper-3)",
                  disabled: selected.has(r.key),
                })}
                style={{
                  ...tagPillStyle(selected.has(r.key)),
                  cursor: "pointer",
                  transition: HOVER_TRANSITION,
                }}
                title={t("notes.tagBrowser.noteCount", { count: r.subtreeCount })}
              >
                {`#${r.display}`}
                <span
                  style={{
                    fontFamily: "var(--font-mono)",
                    fontSize: 10,
                    opacity: 0.65,
                  }}
                >
                  {r.subtreeCount}
                </span>
              </button>
            ))
          )}
        </div>

        {/* Results header: count + Clear (only when a filter is active) */}
        <div
          style={{
            flex: "0 0 auto",
            display: "flex",
            alignItems: "center",
            gap: "var(--space-2)",
            padding: "10px 16px 6px",
          }}
        >
          <span style={SECTION_HEADING_STYLE}>{t("notes.tagBrowser.notes")}</span>
          {hasSelection && (
            <>
              <span data-testid="tags.count" style={{ fontSize: 12, color: "var(--fg-3)" }}>
                {result ? result.count : "…"}
              </span>
              <span style={{ flex: 1 }} />
              {savingName === null && (
                <button
                  type="button"
                  data-testid="views.save-current"
                  onClick={() =>
                    setSavingName(defaultFilterViewName([...selected]))
                  }
                  {...interactiveSurface()}
                  style={{
                    fontSize: 12,
                    padding: "3px 8px",
                    background: "transparent",
                    color: "var(--accent)",
                    border: 0,
                    borderRadius: "var(--radius-1)",
                    cursor: "pointer",
                    transition: HOVER_TRANSITION,
                  }}
                >
                  {t("notes.tagBrowser.saveAsView")}
                </button>
              )}
              <button
                type="button"
                onClick={() => setSelected(new Set())}
                {...interactiveSurface()}
                style={{
                  fontSize: 12,
                  padding: "3px 8px",
                  background: "transparent",
                  color: "var(--accent)",
                  border: 0,
                  borderRadius: "var(--radius-1)",
                  cursor: "pointer",
                  transition: HOVER_TRANSITION,
                }}
              >
                {t("notes.tagBrowser.clear")}
              </button>
            </>
          )}
        </div>

        {/* "Save current filter as view" name prompt (MYND-274 task 5) */}
        {savingName !== null && (
          <div
            style={{
              flex: "0 0 auto",
              display: "flex",
              alignItems: "center",
              gap: "var(--space-2)",
              padding: "0 16px 8px",
            }}
          >
            <input
              type="text"
              data-testid="views.save-name"
              value={savingName}
              autoFocus
              onChange={(e) => setSavingName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") onSaveAsView();
                else if (e.key === "Escape") setSavingName(null);
              }}
              placeholder={t("notes.tagBrowser.viewNamePlaceholder")}
              style={{
                flex: 1,
                minWidth: 0,
                fontSize: "var(--text-sm)",
                fontFamily: "var(--font-sans)",
                padding: "6px 10px",
                background: "var(--bg-1)",
                color: "var(--fg-1)",
                border: "1px solid var(--line-1)",
                borderRadius: "var(--radius-1)",
                outline: "none",
              }}
            />
            <button
              type="button"
              data-testid="views.save-confirm"
              onClick={onSaveAsView}
              style={{
                fontSize: 12,
                padding: "6px 12px",
                background: "var(--accent)",
                color: "var(--accent-on)",
                border: 0,
                borderRadius: "var(--radius-1)",
                cursor: "pointer",
              }}
            >
              {t("notes.tagBrowser.save")}
            </button>
            <button
              type="button"
              onClick={() => setSavingName(null)}
              {...interactiveSurface()}
              style={{
                fontSize: 12,
                padding: "6px 10px",
                background: "transparent",
                color: "var(--fg-3)",
                border: 0,
                cursor: "pointer",
                transition: HOVER_TRANSITION,
              }}
            >
              {t("notes.tagBrowser.cancel")}
            </button>
          </div>
        )}

        {/* Filtered note list (directly under the chips, single column) */}
        <div
          style={{
            flex: 1,
            minHeight: 0,
            overflowY: "auto",
            padding: "0 16px 14px",
            display: "flex",
            flexDirection: "column",
            gap: "var(--space-2)",
          }}
        >
          {!hasSelection ? (
            <div style={MESSAGE_STYLE}>{t("notes.tagBrowser.pickTag")}</div>
          ) : result === null ? (
            <div style={MESSAGE_STYLE}>{t("notes.tagBrowser.filtering")}</div>
          ) : result.count === 0 ? (
            <div style={MESSAGE_STYLE}>{t("notes.tagBrowser.noNotesForFilter")}</div>
          ) : (
            result.rows.map((r) => (
              <button
                key={r.noteId}
                type="button"
                data-testid="tags.result-row"
                onClick={() => onOpenNote(r.noteId)}
                {...interactiveSurface({ restBg: "var(--bg-1)" })}
                style={{ ...SIDEBAR_CARD_STYLE, transition: HOVER_TRANSITION }}
              >
                <span style={{ fontSize: "var(--text-sm)", fontWeight: "var(--weight-medium)", color: "var(--accent)" }}>
                  {r.title ?? t("notes.tagBrowser.untitled")}
                </span>
                {mode === "or" && r.matchedKeys.length > 0 && (
                  <span style={{ display: "inline-flex", gap: "var(--space-1)", marginInlineStart: 8 }}>
                    {r.matchedKeys.map((k) => (
                      <span
                        key={k}
                        style={{
                          fontSize: "var(--text-xs)",
                          color: "var(--accent)",
                          background: "var(--accent-soft)",
                          borderRadius: "var(--radius-pill)",
                          padding: "1px 6px",
                        }}
                      >
                        {`#${displayByKey.get(k) ?? k}`}
                      </span>
                    ))}
                  </span>
                )}
              </button>
            ))
          )}
        </div>
      </div>
    </ModalShell>
  );
}

function ModeToggle({
  mode,
  onChange,
}: {
  mode: FilterMode;
  onChange: (m: FilterMode) => void;
}) {
  const { t } = useTranslation();
  const seg = (m: FilterMode): CSSProperties => ({
    fontSize: 12,
    fontWeight: mode === m ? 600 : 500,
    padding: "3px 10px",
    background: mode === m ? "var(--paper)" : "transparent",
    color: mode === m ? "var(--accent)" : "var(--fg-3)",
    border: 0,
    borderRadius: "var(--radius-1)",
    cursor: "pointer",
    transition: HOVER_TRANSITION,
  });
  return (
    <div
      role="group"
      aria-label={t("notes.tagBrowser.combineTagsWith")}
      style={{
        display: "inline-flex",
        padding: 2,
        gap: 2,
        background: "var(--paper-3)",
        borderRadius: "var(--radius-2)",
        border: "1px solid var(--line-1)",
      }}
    >
      <button
        type="button"
        data-testid="tags.mode-and"
        aria-pressed={mode === "and"}
        onClick={() => onChange("and")}
        {...interactiveSurface({ disabled: mode === "and" })}
        style={seg("and")}
      >
        {t("notes.tagBrowser.modeAll")}
      </button>
      <button
        type="button"
        data-testid="tags.mode-or"
        aria-pressed={mode === "or"}
        onClick={() => onChange("or")}
        {...interactiveSurface({ disabled: mode === "or" })}
        style={seg("or")}
      >
        {t("notes.tagBrowser.modeAny")}
      </button>
    </div>
  );
}
