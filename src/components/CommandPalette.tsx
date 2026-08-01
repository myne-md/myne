// Global command palette modal — MYND-86 + MYND-40.
//
// Keyboard-first entry point. The `palette.toggle` command opens it — default
// `Cmd/Ctrl+K` or `Cmd/Ctrl+P` (both toggle the same palette), rebindable via
// Settings → Hotkeys like any other window command. As you type, results appear
// in two fixed sections:
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
import { useTranslation } from "react-i18next";
import { COMMAND_ACTIONS, fuzzyFilter } from "../commands";
import { Icon } from "./primitives/Icon";
import { useFocusTrap } from "../hooks/useFocusTrap";
import { Keycaps } from "./primitives/Keycaps";
import type {
  ActionVisibility,
  CommandAction,
  CommandContext,
} from "../commands";
import type { NoteId } from "../notes/sidebarState";
import {
  searchNotes,
  shouldApplyNoteSearchResult,
  extractMatchSnippet,
  type MatchSnippet,
} from "../notes/searchNotes";
import { noteRead } from "../notes/readNote";
import { requestRevealMatch } from "../notes/views/revealMatchSignal";
import { parseQuery, queryHasOperators } from "../notes/queryParser";
import { runOperatorSearch } from "../notes/searchQuery";
import {
  completeOperator,
  completeValue,
  searchOperatorSuggestions,
  searchValueSuggestions,
} from "../notes/searchSuggest";
import { tagTree } from "../notes/vaultIndices";
import { tagRows } from "../notes/tagBrowser";
import { listFolderPaths } from "../notes/listFolderPaths";
import { useRunViewContext } from "../notes/views/useRunViewContext";
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

// Operator autocomplete strip (#207/#208 discoverability) — sits between the
// input and the results, shown while a partial operator is being typed. Tab
// completes the first (highlighted) one; a click completes any.
const SUGGEST_LIST_STYLE: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 2,
  padding: "6px 6px 8px",
  borderBottom: "1px solid var(--line-1)",
};
const SUGGEST_ROW_STYLE: CSSProperties = {
  display: "flex",
  alignItems: "baseline",
  gap: 8,
  padding: "6px 10px",
  border: 0,
  borderRadius: "var(--radius-1, 3px)",
  cursor: "pointer",
  textAlign: "left",
  width: "100%",
  fontFamily: "var(--font-sans)",
};
const SUGGEST_OP_STYLE: CSSProperties = {
  fontFamily: "var(--font-mono)",
  fontSize: "var(--text-sm)",
  color: "var(--accent)",
  fontWeight: 600,
};
const SUGGEST_HINT_STYLE: CSSProperties = {
  fontSize: "var(--text-sm)",
  color: "var(--fg-3)",
  flex: 1,
};
const SUGGEST_KEY_STYLE: CSSProperties = {
  fontSize: "var(--text-xs)",
  color: "var(--fg-3)",
  border: "1px solid var(--line-2)",
  borderRadius: "var(--radius-1, 3px)",
  padding: "0 4px",
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
  // The active-row highlight uses the accent-soft tint (the same convention as
  // the sidebar's open-note row) — NOT `--paper-2`, which collapses to the modal
  // background on AMOLED (both are `#000000`), making the keyboard selection
  // invisible. accent-soft stays visible on every theme.
  background: "var(--accent-soft)",
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

// Archived-note badge in the NOTES section (MYND-331) — a quiet right-aligned
// icon + label, distinct from the mono body-match hint.
const ARCHIVED_BADGE_STYLE: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 4,
  fontSize: 11,
  color: "var(--fg-3)",
  flexShrink: 0,
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

// One-line match-context snippet under a note-body result (so the user sees
// WHAT matched, not just "matched in body"). Mono + muted; the matched span
// lifts to full foreground with a soft highlight.
const SNIPPET_STYLE: CSSProperties = {
  fontSize: 11,
  color: "var(--fg-3)",
  fontFamily: "var(--font-mono)",
  whiteSpace: "nowrap",
  overflow: "hidden",
  textOverflow: "ellipsis",
  lineHeight: 1.5,
};
const SNIPPET_MATCH_STYLE: CSSProperties = {
  color: "var(--fg-1)",
  background: "var(--highlight, rgba(240, 220, 120, 0.28))",
  borderRadius: 2,
  padding: "0 1px",
};

/** Cap on how many visible body-hits get a client-side snippet per search — each
 *  is one `note_read` decrypt, so this bounds the per-query cost. */
const SNIPPET_FETCH_CAP = 8;

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
  /**
   * Predicate identifying archived notes (MYND-331). Unlike `isTrashed` /
   * `isTemplate`, this does NOT filter — archived notes stay in search results
   * (archive ≠ soft-trash) — it only flags them so the row renders an archive
   * badge. Omitted → no badge. Wired from the sidebar cache's `archived:` marker.
   */
  isArchived?: (noteId: string) => boolean;
};

type Row =
  | { kind: "action"; action: CommandAction; visibility: ActionVisibility }
  | {
      kind: "note";
      id: NoteId;
      title: string;
      matchedIn: NoteMatchedIn;
      archived: boolean;
      // MYND-448a: set when this row is an EMBEDDED attachment's content hit (its
      // own search doc). `id` is still the embedding note — opening the row opens
      // that note; the badge tells the user the match was inside an attachment.
      attachmentId: string | null;
    };

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
  isArchived,
}: CommandPaletteProps) {
  const { t } = useTranslation();
  const [query, setQuery] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(0);
  // Highlighted autocomplete suggestion (#207/#208). Arrows move it while the
  // suggestion strip is open; Enter/Tab complete it.
  const [suggestIndex, setSuggestIndex] = useState(0);
  // Backend full-text results for the NOTES section (MYND-40). Populated by the
  // search effect below; empty while the query is empty.
  const [noteHits, setNoteHits] = useState<NoteSearchResult[]>([]);
  // Client-side match-context snippets keyed by note id (only for body hits —
  // the index stores no body text, so each snippet is a `note_read` decrypt of a
  // VISIBLE result, generation-guarded by the effect's `cancelled` flag).
  const [snippets, setSnippets] = useState<Map<string, MatchSnippet>>(new Map());
  // Value-suggestion pools for the operator autocomplete (#207/#208): tag names
  // (for `tag:`) and folder paths (for `path:`), fetched once per open.
  const [tagPool, setTagPool] = useState<string[]>([]);
  const [folderPool, setFolderPool] = useState<string[]>([]);
  const inputRef = useRef<HTMLInputElement | null>(null);
  // The scrollable results container — used to keep the keyboard-selected row in
  // view as arrow nav walks past the fold (without it, the highlight can move to
  // a row below the visible area and read as "nothing happening").
  const listRef = useRef<HTMLDivElement>(null);
  // Carve-out modal: trap focus directly (not via ModalShell, which would
  // strip the input + arrow/Enter list navigation). Initial focus is the
  // search input. MYND-93.
  const modalRef = useRef<HTMLDivElement>(null);
  useFocusTrap(modalRef, { enabled: open, initialFocusRef: inputRef });
  // Monotonic dispatch counter for the note-search generation-guard (MYND-40):
  // each query dispatch claims the next value; only the latest-dispatched
  // response is applied (see `shouldApplyNoteSearchResult`).
  const latestSearchSeq = useRef(0);
  // Pending trailing-debounce timer for the note-search dispatch; cleared on
  // each query change and flushed on Enter.
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Operator-query wiring (MYND-303/307). The Saved Views run-context is the
  // single source of the live working set + leaf resolvers (tag/path/file/task/
  // property), reused verbatim so a palette query and a saved view resolve the
  // SAME way. An operator-free query never touches this — it keeps the exact
  // BM25 `note_search` path below.
  const viewCtx = useRunViewContext();
  const operatorDeps = useMemo(
    () => ({
      liveIds: viewCtx.liveIds,
      resolvers: viewCtx.resolvers,
      search: searchNotes,
      titleFor: (id: string) => viewCtx.rowFor(id).title,
      recencyFallback: viewCtx.recencyFallback,
    }),
    [viewCtx],
  );

  // Operator + value autocomplete (#207/#208). A partial operator token surfaces
  // the matching operators (`tag:`, `path:`…); a `<op>:<partial>` token surfaces
  // matching tag/folder VALUES. Both complete on Tab / click. Empty for a
  // plain-text query — no clutter on the common case.
  const suggestions = useMemo<
    Array<{ key: string; display: string; hint: string | undefined; next: string }>
  >(() => {
    const ops = searchOperatorSuggestions(query);
    if (ops.length > 0) {
      return ops.map((o) => ({
        key: `op:${o.op}`,
        display: `${o.op}:`,
        hint: t(o.hintKey),
        next: completeOperator(query, o.op),
      }));
    }
    const vals = searchValueSuggestions(query, { tags: tagPool, folders: folderPool });
    if (vals !== null) {
      return vals.values.map((v) => ({
        key: `val:${vals.op}:${v}`,
        display: `${vals.op}:${v}`,
        hint: undefined,
        next: completeValue(query, vals.op, v),
      }));
    }
    return [];
  }, [query, tagPool, folderPool, t]);

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

  // Fetch the value-suggestion pools (tags + folders) once per open. Best-effort:
  // a locked vault / IO failure just leaves the pools empty — operator-NAME
  // suggestions still work, only the value dropdown goes quiet (#207/#208).
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    void tagTree().then(
      (nodes) => {
        if (!cancelled) setTagPool(tagRows(nodes).map((r) => r.display));
      },
      () => {},
    );
    void listFolderPaths().then(
      (fs) => {
        if (!cancelled) setFolderPool(fs.map((f) => f.path));
      },
      () => {},
    );
    return () => {
      cancelled = true;
    };
  }, [open]);

  // Dispatch one backend full-text search for `q`, applying its result ONLY if
  // it is still the latest (generation-guard, MYND-40) — Tauri invoke is not
  // cancelable, so an earlier query's late response is dropped rather than
  // overwriting fresher results.
  const runNoteSearch = useCallback(
    (q: string) => {
      const seq = (latestSearchSeq.current += 1);
      // An operator/boolean/phrase query parses to a `FilterNode` and resolves
      // through the shared engine + ranker; a plain query keeps the untouched
      // BM25 path (no regression for the common case, MYND-303/307).
      const dispatch = queryHasOperators(q)
        ? runOperatorSearch(parseQuery(q), operatorDeps)
        : searchNotes(q);
      void dispatch
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
    },
    [operatorDeps],
  );

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

  // Fetch match-context snippets for the visible body-hits (see `snippets`). The
  // BM25 index carries no body text, so each snippet is a `note_read` of a shown
  // result — capped, and dropped if the query/results change mid-flight
  // (`cancelled`). Attachment-content hits are excluded (their text isn't the
  // note body); title-only hits need no snippet (the term is in the title).
  useEffect(() => {
    const q = query.trim();
    if (!open || q === "" || noteHits.length === 0) {
      setSnippets(new Map());
      return;
    }
    const bodyHits = noteHits
      .filter(
        (h) =>
          (h.attachment_id ?? null) === null &&
          h.matched_in.body &&
          !(isTrashed?.(h.note_id) ?? false) &&
          !(isTemplate?.(h.note_id) ?? false),
      )
      .slice(0, SNIPPET_FETCH_CAP);
    if (bodyHits.length === 0) {
      setSnippets(new Map());
      return;
    }
    let cancelled = false;
    void Promise.all(
      bodyHits.map(async (h) => {
        try {
          const snip = extractMatchSnippet(await noteRead(h.note_id), q);
          return snip !== null ? ([h.note_id, snip] as const) : null;
        } catch {
          return null;
        }
      }),
    ).then((pairs) => {
      if (cancelled) return;
      const next = new Map<string, MatchSnippet>();
      for (const p of pairs) if (p !== null) next.set(p[0], p[1]);
      setSnippets(next);
    });
    return () => {
      cancelled = true;
    };
  }, [open, query, noteHits, isTrashed, isTemplate]);

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
                title: h.title === "" ? t("commandPalette.untitledNote") : h.title,
                matchedIn: h.matched_in,
                // Archived notes STAY in search (archive ≠ soft-trash) — flagged
                // for the badge, not filtered out (MYND-331).
                archived: isArchived?.(h.note_id) ?? false,
                // MYND-448a: a hit on an embedded attachment's content links to
                // the same note but is badged distinctly. Normalize a missing
                // field (older payload / test fixture) to null so the body-match
                // hint still renders for a plain note hit.
                attachmentId: h.attachment_id ?? null,
              }),
            );

    // `commandCount` is the fixed boundary between the COMMANDS and NOTES
    // sections in the flat list (commands always lead) — used for section
    // labels without re-scanning `rows`.
    return { rows: [...commandRows, ...noteRows], commandCount: commandRows.length };
  }, [query, ctx, noteHits, isTrashed, isTemplate, isArchived, t]);

  // Clamp selected index when row count changes.
  useEffect(() => {
    if (selectedIndex >= rows.length) {
      setSelectedIndex(Math.max(0, rows.length - 1));
    }
  }, [rows.length, selectedIndex]);

  // Keep the keyboard-selected row scrolled into view (block: "nearest" so it
  // only scrolls when the row is actually outside the visible band). Guarded on
  // the method itself — jsdom (test env) doesn't implement scrollIntoView.
  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>('[aria-selected="true"]');
    if (el !== null && el !== undefined && typeof el.scrollIntoView === "function") {
      el.scrollIntoView({ block: "nearest" });
    }
  }, [selectedIndex, rows.length]);

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
          // MYND-448b: after the note opens, scroll the editor to the first
          // literal occurrence of the query and select it (graceful no-op when
          // the hit was stem-only, i.e. no term occurs literally).
          const q = query.trim();
          if (q !== "") requestRevealMatch(row.id, q);
        } catch {
          /* selection failure surfaces via sidebar UX */
        }
      }
    },
    [ctx, close, query],
  );

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === "Escape") {
        e.preventDefault();
        close();
        return;
      }
      // While the autocomplete strip is open (#207/#208), Arrow/Tab/Enter drive
      // the SUGGESTIONS, not the results below — the user is picking an operator
      // or a tag/folder value. Enter on a no-op completion (the token already IS
      // the value) falls through to run the search instead.
      if (suggestions.length > 0) {
        if (e.key === "ArrowDown") {
          e.preventDefault();
          setSuggestIndex((i) => (i + 1) % suggestions.length);
          return;
        }
        if (e.key === "ArrowUp") {
          e.preventDefault();
          setSuggestIndex((i) => (i - 1 + suggestions.length) % suggestions.length);
          return;
        }
        const active = suggestions[Math.min(suggestIndex, suggestions.length - 1)];
        if (e.key === "Tab") {
          e.preventDefault();
          setQuery(active.next);
          setSuggestIndex(0);
          return;
        }
        if (e.key === "Enter" && active.next !== query) {
          e.preventDefault();
          setQuery(active.next);
          setSuggestIndex(0);
          return;
        }
        // Enter on a no-op completion falls through to run the highlighted result.
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
    [rows, selectedIndex, runRow, close, flushNoteSearch, suggestions, suggestIndex, query],
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
      <div
        ref={modalRef}
        style={MODAL_STYLE}
        role="dialog"
        aria-label={t("commandPalette.dialogLabel")}
        data-testid="palette.dialog"
      >
        <input
          ref={inputRef}
          type="text"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setSelectedIndex(0);
            setSuggestIndex(0);
          }}
          onKeyDown={onKeyDown}
          placeholder={t("commandPalette.searchPlaceholder")}
          aria-label={t("commandPalette.searchPlaceholder")}
          style={INPUT_STYLE}
          autoComplete="off"
          autoCorrect="off"
          spellCheck={false}
          data-testid="palette.input"
        />
        {suggestions.length > 0 && (
          <div style={SUGGEST_LIST_STYLE} data-testid="palette.operator-suggestions">
            {suggestions.map((s, i) => {
              const active = i === Math.min(suggestIndex, suggestions.length - 1);
              return (
                <button
                  key={s.key}
                  type="button"
                  style={{
                    ...SUGGEST_ROW_STYLE,
                    background: active ? "var(--paper-3)" : "transparent",
                  }}
                  data-testid="palette.operator-suggestion"
                  data-active={active ? "true" : "false"}
                  onMouseEnter={() => setSuggestIndex(i)}
                  // onMouseDown, not onClick: fires before the input blurs, so the
                  // caret + query survive the completion.
                  onMouseDown={(e) => {
                    e.preventDefault();
                    setQuery(s.next);
                    setSuggestIndex(0);
                    inputRef.current?.focus();
                  }}
                >
                  <span style={SUGGEST_OP_STYLE}>{s.display}</span>
                  {s.hint !== undefined && (
                    <span style={SUGGEST_HINT_STYLE}>{s.hint}</span>
                  )}
                  {active && (
                    <span style={{ ...SUGGEST_KEY_STYLE, marginLeft: "auto" }}>
                      {t("commandPalette.operatorHint")}
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        )}
        <div style={LIST_STYLE} role="listbox" ref={listRef}>
          {rows.length === 0 ? (
            <div style={EMPTY_STYLE}>{t("commandPalette.noMatches")}</div>
          ) : (
            rows.map((row, i) => {
              // Inject a section label before the first command row and before
              // the first note row (only when both sections are present).
              const label = !showSectionLabels
                ? null
                : i === 0
                  ? t("commandPalette.sectionCommands")
                  : i === commandCount
                    ? t("commandPalette.sectionNotes")
                    : null;
              const key =
                row.kind === "action"
                  ? row.action.id
                  : // MYND-448a: disambiguate a note-body row from its
                    // attachment-content row(s) — both carry the same note id.
                    `note:${row.id}:${row.attachmentId ?? ""}`;
              return (
                <Fragment key={key}>
                  {label !== null && (
                    <div style={SECTION_LABEL_STYLE}>{label}</div>
                  )}
                  {renderRow(
                    row,
                    i,
                    i === selectedIndex,
                    runRow,
                    t,
                    row.kind === "note" && row.attachmentId === null
                      ? snippets.get(row.id)
                      : undefined,
                  )}
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
  t: (key: string) => string,
  snippet?: MatchSnippet,
) {
  const isDisabled = row.kind === "action" && row.visibility === "disabled";
  const baseStyle = isDisabled
    ? ROW_DISABLED_STYLE
    : selected
      ? ROW_SELECTED_STYLE
      : ROW_STYLE;
  // A note row carrying a snippet stacks title-line over snippet-line (column);
  // every other row stays the single centred flex row.
  const style =
    snippet !== undefined
      ? { ...baseStyle, flexDirection: "column" as const, alignItems: "stretch" as const, gap: 3 }
      : baseStyle;
  // Keystroke hint for an enabled action row. The canonical binding renders as
  // keycaps (SYNC-3, #184 — legible per-key caps, not a cramped mono run); the
  // hand-typed `kbd` literal is a text fallback only, for the rare action with no
  // `defaultBinding` chord.
  const actionBinding =
    row.kind === "action" && !isDisabled ? row.action.defaultBinding : undefined;
  const kbdFallback =
    row.kind === "action" && !isDisabled && actionBinding === undefined
      ? row.action.kbd
      : undefined;
  return (
    <div
      style={style}
      role="option"
      aria-selected={selected}
      aria-disabled={isDisabled}
      data-row-index={index}
      data-testid="palette.option"
      data-kind={row.kind}
      data-action-id={row.kind === "action" ? row.action.id : undefined}
      data-note-id={row.kind === "note" ? row.id : undefined}
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
          {actionBinding !== undefined && <Keycaps chord={actionBinding} />}
          {kbdFallback !== undefined && <span style={HINT_STYLE}>{kbdFallback}</span>}
        </>
      ) : (
        <>
          <div style={{ display: "flex", alignItems: "center", gap: 8, width: "100%" }}>
            <span
              style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
            >
              {row.title}
            </span>
            {/* Archived marker (MYND-331): an archived note still appears in search
                (archive ≠ soft-trash) — a small badge tells the user why it is not
                in the working tree. */}
            {row.archived && (
              <span
                style={ARCHIVED_BADGE_STYLE}
                data-testid="palette.archived-badge"
                title={t("commandPalette.archivedBadgeTitle")}
              >
                <Icon name="archive" size={12} />
                {t("commandPalette.archivedBadge")}
              </span>
            )}
            {/* MYND-448a: an embedded-attachment content hit — the query matched
                inside a file embedded in this note, not the note's own text. A
                paperclip badge distinguishes it from a body hit; opening the row
                still opens the embedding note. Takes precedence over the body-match
                hint (an attachment doc's "body" is the extracted file text). */}
            {row.attachmentId !== null ? (
              <span
                style={ARCHIVED_BADGE_STYLE}
                data-testid="palette.attachment-badge"
                title={t("commandPalette.matchedInAttachmentTitle")}
              >
                <Icon name="paperclip" size={12} />
                {t("commandPalette.matchedInAttachment")}
              </span>
            ) : (
              /* Body-only match (MYND-40): shown only when there is no inline
                 snippet below (a stem-only hit the client-side snippet couldn't
                 locate literally) — otherwise the snippet itself IS the "why". */
              snippet === undefined &&
              row.matchedIn.body &&
              !row.matchedIn.title && (
                <span style={HINT_STYLE}>{t("commandPalette.matchedInBody")}</span>
              )
            )}
          </div>
          {/* The match-context snippet (client-side; body hits only) — the
              matched span lifts to full foreground so "what matched" is obvious. */}
          {snippet !== undefined && (
            <div style={SNIPPET_STYLE} data-testid="palette.snippet">
              {snippet.before}
              <mark style={SNIPPET_MATCH_STYLE}>{snippet.match}</mark>
              {snippet.after}
            </div>
          )}
        </>
      )}
    </div>
  );
}
