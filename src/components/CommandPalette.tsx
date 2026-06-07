// Global command palette modal — MYND-86 + MYND-40.
//
// Keyboard-first entry point. `Cmd/Ctrl+K` or `Cmd/Ctrl+P` opens it (both toggle
// the same palette). As you type, results appear in two fixed sections:
// COMMANDS (the typed action registry, frontend fuzzy — instant) and NOTES
// (backend full-text `note_search`, BM25, debounced). Arrow keys navigate across
// both sections, Enter runs the highlighted row (run a command / open a note),
// Esc dismisses, backdrop click dismisses. An empty query shows the command
// list; note results appear once you type.
//
// A note hit that matched only in the body carries a "↳ matched in body"
// marker (from the backend `matched_in` field) so a title that doesn't contain
// the query is never a mystery. Per-keystroke note search is debounced +
// generation-guarded (a stale response never overwrites a fresher one).

import {
  Fragment,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type MouseEvent as ReactMouseEvent,
} from "react";
import { COMMAND_ACTIONS, fuzzyFilter } from "../commands";
import type {
  ActionVisibility,
  CommandAction,
  CommandContext,
} from "../commands";
import type { NoteId } from "../notes/sidebarState";
import { searchNotes, shouldApplyNoteSearchResult } from "../notes/searchNotes";
import type { NoteMatchedIn, NoteSearchResult } from "../types/note-search-result";

const BACKDROP_STYLE: CSSProperties = {
  position: "fixed",
  inset: 0,
  background: "rgba(0, 0, 0, 0.32)",
  display: "flex",
  alignItems: "flex-start",
  justifyContent: "center",
  paddingTop: "12vh",
  zIndex: 1500,
};

const MODAL_STYLE: CSSProperties = {
  width: 520,
  maxHeight: "60vh",
  background: "var(--paper, #faf8f3)",
  border: "1px solid var(--line-2)",
  borderRadius: "var(--radius-3, 8px)",
  boxShadow: "var(--shadow-3, 0 16px 48px rgba(0,0,0,0.18))",
  display: "flex",
  flexDirection: "column",
  fontFamily: "var(--font-sans)",
  overflow: "hidden",
};

const INPUT_STYLE: CSSProperties = {
  width: "100%",
  // Reset WebKit's default text-input focus underline (which renders as
  // a thick accent-blue line below the field). `outline: none` alone is
  // not enough on macOS WebKit; `appearance: none` removes the platform
  // styling layer too.
  appearance: "none",
  WebkitAppearance: "none",
  border: 0,
  borderBottom: "1px solid var(--line-1, #e3e2dd)",
  background: "transparent",
  outline: "none",
  boxShadow: "none",
  fontFamily: "var(--font-sans)",
  fontSize: 15,
  color: "var(--fg-1)",
  padding: "14px 16px",
};

const LIST_STYLE: CSSProperties = {
  flex: 1,
  overflowY: "auto",
  padding: 6,
};

const ROW_STYLE: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 8,
  padding: "8px 10px",
  borderRadius: "var(--radius-1, 3px)",
  cursor: "pointer",
  fontSize: 13,
  color: "var(--fg-1)",
};

const ROW_SELECTED_STYLE: CSSProperties = {
  ...ROW_STYLE,
  background: "var(--paper-2)",
};

const ROW_DISABLED_STYLE: CSSProperties = {
  ...ROW_STYLE,
  color: "var(--fg-3)",
  cursor: "not-allowed",
};

const CATEGORY_STYLE: CSSProperties = {
  fontSize: 11,
  color: "var(--fg-3)",
  fontWeight: 500,
  marginRight: "auto",
};

const HINT_STYLE: CSSProperties = {
  fontSize: 11,
  color: "var(--fg-3)",
  fontFamily: "var(--font-mono)",
};

// Section divider label ("Commands" / "Notes"). Shown only when BOTH sections
// have rows, so a single-section list stays unlabeled.
const SECTION_LABEL_STYLE: CSSProperties = {
  fontSize: 10,
  fontWeight: 600,
  letterSpacing: "0.06em",
  textTransform: "uppercase",
  color: "var(--fg-3)",
  padding: "8px 10px 4px",
};

const EMPTY_STYLE: CSSProperties = {
  padding: "20px 16px",
  fontSize: 13,
  color: "var(--fg-3)",
  textAlign: "center",
};

export type CommandPaletteProps = {
  open: boolean;
  onClose: () => void;
  ctx: CommandContext;
  /**
   * Predicate identifying notes in the vault trash (MYND-133). When provided,
   * trashed note IDs are dropped from the NOTES search section — the BM25 index
   * still matches a trashed note's body, so this is the exclusion gate. Omitted
   * (e.g. in isolation tests) → no filtering. Wired by `CommandPaletteHost`
   * from the sidebar cache's value-strict `trashed:` marker.
   */
  isTrashed?: (noteId: string) => boolean;
  /**
   * Predicate identifying notes that are templates (MYND-186). When provided,
   * template note IDs are dropped from the NOTES search section — the BM25 index
   * still matches a template's body, so this is the exclusion gate (the inverse-
   * visibility twin of `isTrashed`). Omitted → no template filtering. Wired by
   * the Editor from the sidebar cache's value-strict `template:` flag.
   */
  isTemplate?: (noteId: string) => boolean;
};

type Row =
  | { kind: "action"; action: CommandAction; visibility: ActionVisibility }
  | { kind: "note"; id: NoteId; title: string; matchedIn: NoteMatchedIn };

/**
 * Trailing debounce for the note-search dispatch (MYND-40): coalesces a
 * keystroke burst into one IPC per typing pause. ~120ms sits below the
 * ~100-150ms "instant" perception band, so the NOTES section still feels live
 * while cutting per-keystroke IPC. Flushed immediately on Enter.
 */
const NOTE_SEARCH_DEBOUNCE_MS = 120;

export function CommandPalette({
  open,
  onClose,
  ctx,
  isTrashed,
  isTemplate,
}: CommandPaletteProps) {
  const [query, setQuery] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(0);
  // Backend full-text results for the NOTES section (MYND-40). Populated by the
  // search effect below; empty while the query is empty.
  const [noteHits, setNoteHits] = useState<NoteSearchResult[]>([]);
  const inputRef = useRef<HTMLInputElement | null>(null);
  // Monotonic dispatch counter for the note-search generation-guard (MYND-40):
  // each query dispatch claims the next value; only the latest-dispatched
  // response is applied (see `shouldApplyNoteSearchResult`).
  const latestSearchSeq = useRef(0);
  // Pending trailing-debounce timer for the note-search dispatch; cleared on
  // each query change and flushed on Enter.
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Reset state every time the palette opens.
  useEffect(() => {
    if (open) {
      setQuery("");
      setSelectedIndex(0);
      setNoteHits([]);
      // Focus input on next tick (after mount + portal append).
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [open]);

  // Dispatch one backend full-text search for `q`, applying its result ONLY if
  // it is still the latest (generation-guard, MYND-40) — Tauri invoke is not
  // cancelable, so an earlier query's late response is dropped rather than
  // overwriting fresher results.
  const runNoteSearch = useCallback((q: string) => {
    const seq = (latestSearchSeq.current += 1);
    void searchNotes(q)
      .then((hits) => {
        if (shouldApplyNoteSearchResult(seq, latestSearchSeq.current)) {
          setNoteHits(hits);
        }
      })
      .catch(() => {
        if (shouldApplyNoteSearchResult(seq, latestSearchSeq.current)) {
          setNoteHits([]);
        }
      });
  }, []);

  // Debounced NOTES-section search. A ~120ms trailing timer coalesces a
  // keystroke burst into one IPC per typing pause; the cleanup clears the
  // pending timer on every query change so only the last keystroke's timer
  // survives. An empty query searches nothing (the NOTES section is empty until
  // you type; COMMANDS still show). Composes with the generation-guard in
  // `runNoteSearch`. Enter flushes the timer (see `flushNoteSearch`).
  useEffect(() => {
    if (!open) return;
    if (query.trim() === "") {
      setNoteHits([]);
      return;
    }
    const timer = setTimeout(() => {
      searchTimer.current = null;
      runNoteSearch(query);
    }, NOTE_SEARCH_DEBOUNCE_MS);
    searchTimer.current = timer;
    return () => {
      clearTimeout(timer);
      searchTimer.current = null;
    };
  }, [open, query, runNoteSearch]);

  // Flush a pending debounced search immediately — the Enter handler calls this
  // so a fast "type then Enter" fires the search now instead of waiting out the
  // remaining debounce window.
  const flushNoteSearch = useCallback(() => {
    if (searchTimer.current !== null) {
      clearTimeout(searchTimer.current);
      searchTimer.current = null;
      runNoteSearch(query);
    }
  }, [query, runNoteSearch]);

  // Unified row list (MYND-40): COMMANDS (frontend fuzzy over the visible action
  // registry) followed by NOTES (backend full-text hits, only while the query is
  // non-empty). Scores are NOT mixed across sections — each is sorted by its own
  // engine and the sections render in a fixed order, so a command never competes
  // with a BM25 note score. Arrow nav iterates this flat list across both
  // sections; section labels are injected at render time and are not selectable.
  const { rows, commandCount } = useMemo(() => {
    const visibleActions: Array<{
      action: CommandAction;
      visibility: ActionVisibility;
    }> = [];
    for (const action of COMMAND_ACTIONS) {
      const v = action.visibility(ctx);
      if (v === "hidden") continue;
      visibleActions.push({ action, visibility: v });
    }
    const candidates = visibleActions.map((e) => ({
      item: e,
      haystacks: [e.action.label, e.action.id, e.action.category ?? ""],
    }));
    const commandRows: Row[] = fuzzyFilter(candidates, query).map(
      (m): Row => ({
        kind: "action",
        action: m.item.action,
        visibility: m.item.visibility,
      }),
    );

    const noteRows: Row[] =
      query.trim() === ""
        ? []
        : noteHits
            // Exclude trashed notes (MYND-133) and templates (MYND-186) from
            // search results. The Rust BM25 index still matches their bodies
            // (trashing / templating is a content edit), so the sidebar's
            // value-strict `trashed:` / `template:` markers — surfaced via the
            // `isTrashed` / `isTemplate` predicates — are the filter; restore /
            // convert-to-note re-includes the note.
            .filter(
              (h) =>
                !(isTrashed?.(h.note_id) ?? false) &&
                !(isTemplate?.(h.note_id) ?? false),
            )
            .map(
              (h): Row => ({
                kind: "note",
                id: h.note_id,
                title: h.title === "" ? "Untitled" : h.title,
                matchedIn: h.matched_in,
              }),
            );

    // `commandCount` is the fixed boundary between the COMMANDS and NOTES
    // sections in the flat list (commands always lead) — used for section
    // labels without re-scanning `rows`.
    return { rows: [...commandRows, ...noteRows], commandCount: commandRows.length };
  }, [query, ctx, noteHits, isTrashed, isTemplate]);

  // Clamp selected index when row count changes.
  useEffect(() => {
    if (selectedIndex >= rows.length) {
      setSelectedIndex(Math.max(0, rows.length - 1));
    }
  }, [rows.length, selectedIndex]);

  const close = useCallback(() => {
    setQuery("");
    setSelectedIndex(0);
    onClose();
  }, [onClose]);

  const runRow = useCallback(
    async (row: Row) => {
      if (row.kind === "action") {
        if (row.visibility === "disabled") return;
        close();
        try {
          await row.action.run(ctx);
        } catch {
          /* action failure surfaces via the action's own UX (toast / banner) */
        }
      } else {
        close();
        try {
          await ctx.onSelectNote(row.id);
        } catch {
          /* selection failure surfaces via sidebar UX */
        }
      }
    },
    [ctx, close],
  );

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === "Escape") {
        e.preventDefault();
        close();
        return;
      }
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setSelectedIndex((i) => (rows.length === 0 ? 0 : (i + 1) % rows.length));
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setSelectedIndex((i) =>
          rows.length === 0 ? 0 : (i - 1 + rows.length) % rows.length,
        );
        return;
      }
      if (e.key === "Enter") {
        e.preventDefault();
        // Fire any pending debounced search now (don't make selection wait the
        // remaining window); then act on the current selection.
        flushNoteSearch();
        const row = rows[selectedIndex];
        if (row !== undefined) void runRow(row);
        return;
      }
    },
    [rows, selectedIndex, runRow, close, flushNoteSearch],
  );

  const onBackdropClick = useCallback(
    (e: ReactMouseEvent<HTMLDivElement>) => {
      if (e.target === e.currentTarget) close();
    },
    [close],
  );

  if (!open) return null;

  // Label the sections only when both are present — a single-section list reads
  // cleaner unlabeled. The flat `rows` list is `[...commands, ...notes]`, so the
  // NOTES section starts at index `commandCount`.
  const showSectionLabels = commandCount > 0 && rows.length > commandCount;

  return (
    <div style={BACKDROP_STYLE} onClick={onBackdropClick} role="presentation">
      <div style={MODAL_STYLE} role="dialog" aria-label="Command palette">
        <input
          ref={inputRef}
          type="text"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setSelectedIndex(0);
          }}
          onKeyDown={onKeyDown}
          placeholder="Search notes or run a command — Esc to dismiss"
          style={INPUT_STYLE}
          autoComplete="off"
          autoCorrect="off"
          spellCheck={false}
        />
        <div style={LIST_STYLE} role="listbox">
          {rows.length === 0 ? (
            <div style={EMPTY_STYLE}>No matches</div>
          ) : (
            rows.map((row, i) => {
              // Inject a section label before the first command row and before
              // the first note row (only when both sections are present).
              const label = !showSectionLabels
                ? null
                : i === 0
                  ? "Commands"
                  : i === commandCount
                    ? "Notes"
                    : null;
              const key =
                row.kind === "action" ? row.action.id : `note:${row.id}`;
              return (
                <Fragment key={key}>
                  {label !== null && (
                    <div style={SECTION_LABEL_STYLE}>{label}</div>
                  )}
                  {renderRow(row, i, i === selectedIndex, runRow)}
                </Fragment>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
}

function renderRow(
  row: Row,
  index: number,
  selected: boolean,
  runRow: (row: Row) => void | Promise<void>,
) {
  const isDisabled = row.kind === "action" && row.visibility === "disabled";
  const style = isDisabled
    ? ROW_DISABLED_STYLE
    : selected
      ? ROW_SELECTED_STYLE
      : ROW_STYLE;
  return (
    <div
      style={style}
      role="option"
      aria-selected={selected}
      aria-disabled={isDisabled}
      data-row-index={index}
      onMouseDown={(e) => {
        e.preventDefault();
        if (!isDisabled) void runRow(row);
      }}
    >
      {row.kind === "action" ? (
        <>
          <span style={{ flex: 1 }}>{row.action.label}</span>
          {row.action.category !== undefined && (
            <span style={CATEGORY_STYLE}>{row.action.category}</span>
          )}
          {isDisabled && row.action.disabledHint !== undefined && (
            <span style={HINT_STYLE}>{row.action.disabledHint}</span>
          )}
          {!isDisabled && row.action.kbd !== undefined && (
            <span style={HINT_STYLE}>{row.action.kbd}</span>
          )}
        </>
      ) : (
        <>
          <span style={{ flex: 1 }}>{row.title}</span>
          {/* Body-only match (MYND-40): the query matched in the note body but
              not its title, so the title here does not contain the query — a
              quiet right-aligned marker (reusing the palette's hint slot) tells
              the user why the row appeared. Title matches need no marker (the
              term is in the visible title). Drives off the precise backend
              `matched_in`, so it is correct even for stemmed/Turkish-cased hits. */}
          {row.matchedIn.body && !row.matchedIn.title && (
            <span style={HINT_STYLE}>↳ matched in body</span>
          )}
        </>
      )}
    </div>
  );
}
