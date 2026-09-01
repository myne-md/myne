// In-note find: CodeMirror extension wiring (MYND-175, Task 2 — tracer bullet).
//
// Keeps the `@codemirror/search` ENGINE (match-finding, highlight decorations,
// findNext/findPrevious + wrap) and replaces only the stock panel: `search({
// createPanel })` mounts our Myne-styled, vanilla-DOM bar (`./find-bar-view.ts`)
// into a DOCKED top panel, so the editor reflows and the bar never occludes the
// current match (a structural guarantee, not collision-avoidance code).
//
// Single-owner discipline: Cmd/Ctrl+F is NOT bound here — the window-level
// listener in `App.tsx` is the only owner (so the native find can be suppressed
// app-wide, focus-independently). The only key bound here is editor-body Escape
// → close (a no-op when the panel is closed, so it never swallows Escape for
// other consumers); the input's own Escape is wired in `createFindPanel`.
//
// Task 2 scope: open + type→highlight-all + Esc-close. Task 3 adds the live
// "k/N" count as a READ-ONLY projection over the engine's own match set (never a
// filter/redefine): on a query/doc change a single debounced full-doc
// `SearchQuery.getCursor` scan caches the ordered match list + total; the current
// ordinal is a binary search of the selection in that cache on every selection
// change (no rescan). Task 4 wires Enter→next / Shift+Enter→prev (wrap is the
// engine default) on the input. Still layered on later: folded-region reveal
// (Task 5), session-persistent case toggle (Task 6), and zero/empty-state
// polish (Task 8).

import {
  keymap,
  EditorView,
  type Panel,
  type ViewUpdate,
} from "@codemirror/view";
import { type Extension } from "@codemirror/state";
import {
  search,
  closeSearchPanel,
  findNext,
  findPrevious,
  getSearchQuery,
  setSearchQuery,
  replaceNext,
  replaceAll,
  SearchQuery,
} from "@codemirror/search";
import { createFindBarView } from "./find-bar-view";
import { dateTimeDisplay, parseDisplayDate } from "@myne/editor/host/lib/datetimeFormat";
import {
  getFindCaseSensitive,
  setFindCaseSensitive,
} from "./find-session";
import { ensureFloatingStyles } from "../floating-styles";

const SCAN_DEBOUNCE_MS = 120; // matches the command-palette note-search cadence

// MYND-626: centre the match instead of leaving it wherever it happened to land.
//
// `findNext` / `findPrevious` move the selection and scroll it into view with
// CodeMirror's default `y: "nearest"`, which does the minimum work to make the
// match visible — so a match just below the fold stops one line inside the
// bottom edge, half-hidden behind the status bar, and a long run of hits walks
// the viewport a line at a time instead of stepping through them. Re-issuing an
// explicit `y: "center"` scroll after the command puts every match in the same
// place, so the eye can stay still while Enter cycles.
//
// This is the same treatment global search already gives a result click
// (MYND-448) and footnote navigation already gives its target — this was the
// one match-navigation surface still on the default.
function scrollMatchToCentre(view: EditorView): void {
  view.dispatch({
    effects: EditorView.scrollIntoView(view.state.selection.main.head, {
      y: "center",
    }),
  });
}

/** `findNext` + centre. Use everywhere the user steps to the next match. */
function findNextCentred(view: EditorView): void {
  findNext(view);
  scrollMatchToCentre(view);
}

/** `findPrevious` + centre. */
function findPreviousCentred(view: EditorView): void {
  findPrevious(view);
  scrollMatchToCentre(view);
}

function createFindPanel(view: EditorView): Panel {
  // Self-contained: inject the editor-chrome CSS (incl. `.cm-find-bar*`) in case
  // neither the slash menu nor the toolbar has triggered it yet. Idempotent.
  ensureFloatingStyles();

  // Case sensitivity is a session-level preference (find-session.ts): it survives
  // note switches and panel reopens within an unlocked session, defaulting off.
  // It is the single source of truth — read via `getFindCaseSensitive()` at each
  // use site, never mirrored locally — so the toggle, query, and bar can't drift.

  // Cached ordered match list (a read-only projection of the engine's matches).
  // Refreshed only by `scan()` on query/doc change; the ordinal is derived from
  // it on selection change without rescanning.
  let matches: { from: number; to: number }[] = [];
  let scanTimer: ReturnType<typeof setTimeout> | null = null;

  // Replace affordance state (MYND-302) — in-memory only, scoped to this panel
  // instance (cleared on close). `expanded` drives the replace-row disclosure;
  // `replaceText` is the replacement string carried on the query so the engine's
  // replaceNext / replaceAll commands read it (they pull `query.replace`).
  let expanded = false;
  let replaceText = "";

  // Date fallback (myne-md/myne#609): the STORED form currently being searched,
  // or `null`, which is the state of nearly every search.
  //
  // Since myne#609 a due chip prints the reader's chosen format while the
  // document holds the normative `YYYY-MM-DD`, so a user who types what is on
  // screen finds nothing. The engine reads the document, not the DOM.
  //
  // TWO LITERAL PASSES, never one clever query. The typed text is searched
  // first, exactly as before; only a zero-match result that reads back as a date
  // triggers a second, also literal, search for the stored form. An alternation
  // would need `literal: false`, and this bar has no regular-expression mode by
  // deliberate design: turning one on would also route REPLACE through
  // regular-expression substitution, whose `$1` / `$&` expansion is a hazard
  // this repository already records.
  //
  // Literal-first ordering is not just caution about the engine. It preserves a
  // match on a date written as ordinary prose: somebody who wrote `01/08/2026`
  // in a sentence still finds it, and only when nothing matches does the second
  // reading get a turn.
  let dateFallback: string | null = null;

  const searchQueryFor = (query: string): SearchQuery =>
    // literal: true → plain substring, never regex (regex is out of scope v1).
    // `replace` is carried on the query so @codemirror/search's replaceNext /
    // replaceAll find the replacement; match-case is inherited (same field).
    new SearchQuery({
      search: query,
      caseSensitive: getFindCaseSensitive(),
      literal: true,
      replace: replaceText,
    });

  /**
   * Whether a replace may run at all.
   *
   * THE RULE LIVES HERE, at the decision point, not on the buttons. The first
   * version set `disabled` on the two buttons in the bar view and nowhere else,
   * and the bar's replace INPUT is never disabled: its Enter handler, documented
   * two dozen lines below as "the primary one-handed flow", called `replaceNext`
   * unconditionally. So the control looked closed and the path most people use
   * was open, which is worse than no gate, because the disabled buttons say the
   * feature is protecting you.
   *
   * What that cost, traced end to end: with the fallback live the matched bytes
   * are the stored `YYYY-MM-DD`, so `[due:: 2026-08-01]` became
   * `[due:: 02/08/2026]`, `parseTaskInstant` refuses that, the field is
   * functionally dead, the task leaves every dated view and its reminder, and
   * the rewrite syncs to every device. The bar view's `disabled` is now a
   * PRESENTATION of this predicate rather than the rule itself.
   */
  const canReplace = (): boolean => dateFallback === null;

  const applyQuery = (query: string): void => {
    // A new typed query always starts from the literal reading. Leaving a stale
    // fallback set would let one search's second pass explain another's results.
    dateFallback = null;
    view.dispatch({ effects: setSearchQuery.of(searchQueryFor(query)) });
  };

  // Read the engine's matches across the whole doc — we never filter or exclude,
  // so the cached set IS the engine's set (folded tables / fenced code / YAML
  // frontmatter all count, since the cursor scans the canonical doc text).
  const collect = (): { from: number; to: number }[] => {
    const query = getSearchQuery(view.state);
    const found: { from: number; to: number }[] = [];
    if (query.valid) {
      const cursor = query.getCursor(view.state);
      let next = cursor.next();
      while (next.done !== true) {
        found.push({ from: next.value.from, to: next.value.to });
        next = cursor.next();
      }
    }
    return found;
  };

  const scan = (): void => {
    matches = collect();

    // The second pass, and the only place it can be decided: the first pass's
    // result is not known until here. `dateFallback === null` is the whole loop
    // guard, since it is set before the dispatch and cleared only by a NEW typed
    // query. An earlier version also carried a `fallbackPending` flag; it was
    // set and cleared inside the same synchronous block and no caller could
    // observe it as true, so it was a comment describing a mechanism that was
    // not there.
    if (matches.length === 0 && dateFallback === null) {
      const typed = bar.input.value;
      const stored = parseDisplayDate(typed, dateTimeDisplay());
      if (stored !== null && stored !== typed) {
        dateFallback = stored;
        view.dispatch({ effects: setSearchQuery.of(searchQueryFor(stored)) });
        // The dispatch reaches this panel's own `update`, which sees the query
        // change and arms `scheduleScan()`. That timer would repeat the walk
        // below 120 ms later over the same state and same query, which is a
        // whole frame's work on a large note (measured: 31 ms over 400 KiB) for
        // an identical result. Disarm it: this pass is the answer.
        if (scanTimer !== null) {
          clearTimeout(scanTimer);
          scanTimer = null;
        }
        matches = collect();
      }
    }

    render();
  };

  const scheduleScan = (): void => {
    if (scanTimer !== null) clearTimeout(scanTimer);
    scanTimer = setTimeout(() => {
      scanTimer = null;
      scan();
    }, SCAN_DEBOUNCE_MS);
  };

  // 1-based ordinal of the match at/after the current selection (the one the
  // selection sits on after a nav, else the next one Enter would reach; wraps
  // past the last match to the first). The cached list is already in document
  // order, so this is a binary search (lower bound) for the first match at/after
  // the cursor — matching the module-header note.
  const currentOrdinal = (): number => {
    if (matches.length === 0) return 0;
    const from = view.state.selection.main.from;
    // lower_bound: first index i with matches[i].from >= from.
    let lo = 0;
    let hi = matches.length; // exclusive
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if ((matches[mid]?.from ?? 0) >= from) hi = mid;
      else lo = mid + 1;
    }
    // No match at/after the cursor → wrap to the first (ordinal 1), matching the
    // prior `findIndex === -1 ? 0` behavior.
    return (lo === matches.length ? 0 : lo) + 1;
  };

  const render = (): void => {
    const query = bar.input.value;
    const caseSensitive = getFindCaseSensitive();
    if (query.length === 0) {
      bar.update({ query, caseSensitive, status: "idle", match: null, expanded, replace: replaceText, dateFallback });
      return;
    }
    const total = matches.length;
    if (total === 0) {
      bar.update({ query, caseSensitive, status: "no-match", match: null, expanded, replace: replaceText, dateFallback });
      return;
    }
    bar.update({
      query,
      caseSensitive,
      status: "matches",
      match: { current: currentOrdinal(), total },
      expanded,
      replace: replaceText,
      dateFallback,
    });
  };

  const bar = createFindBarView(
    {
      query: getSearchQuery(view.state).search,
      caseSensitive: getFindCaseSensitive(),
      status: "idle",
      match: null,
      expanded,
      replace: replaceText,
      dateFallback: null,
    },
    {
      onQueryChange: (query) => applyQuery(query),
      onToggleCase: () => {
        setFindCaseSensitive(!getFindCaseSensitive()); // single source of truth (find-session.ts)
        render(); // immediate pressed-state feedback (count refreshes on the rescan)
        applyQuery(bar.input.value);
      },
      onNext: () => {
        findNextCentred(view);
      },
      onPrev: () => {
        findPreviousCentred(view);
      },
      onClose: () => {
        closeSearchPanel(view);
      },
      onToggleReplace: () => {
        expanded = !expanded;
        render(); // attach/detach the replace row + flip the disclosure
        if (expanded) bar.replaceInput.focus();
        else bar.focus(); // collapsing returns focus to the find input
      },
      onReplaceChange: (value) => {
        replaceText = value;
        // Re-carry the replacement on the query so replaceNext/replaceAll see it.
        // No rescan needed (the search string is unchanged), but the query object
        // must be re-dispatched to update its `replace` field.
        applyQuery(bar.input.value);
      },
      onReplaceOne: () => {
        if (!canReplace()) return;
        // Replaces the current match (if the selection sits on one) and advances
        // to the next; otherwise just advances. The selection move rides the
        // existing cursor-aware reveal (un-folds folded regions, SYNC-6).
        replaceNext(view);
      },
      onReplaceAll: () => {
        if (!canReplace()) return;
        // One undoable transaction over the canonical buffer (folded regions
        // included), so a single Cmd/Ctrl+Z reverts the whole bulk replace.
        replaceAll(view);
      },
    },
  );

  // Keyboard on the find input (a CM keymap only sees keys on the content DOM,
  // so the input needs its own wires):
  //   Esc          → close (mirrors the editor-body Escape keymap)
  //   Enter        → next match, Shift+Enter → previous; both wrap at the doc
  //                  ends (engine default). findNext/findPrevious move the editor
  //                  selection and scroll it into view while focus stays in the
  //                  input — browser-find parity. The selection move also triggers
  //                  the cursor-aware reveal of folded tables/frontmatter (Task 5).
  bar.input.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      e.preventDefault();
      closeSearchPanel(view);
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      if (e.shiftKey) findPreviousCentred(view);
      else findNextCentred(view);
    }
  });

  // Keyboard on the replace input (MYND-302):
  //   Esc          → close the whole bar (mirrors the find input + editor body)
  //   Enter        → replace the current match and advance (replaceNext); the
  //                  primary one-handed flow without leaving the field.
  bar.replaceInput.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      e.preventDefault();
      closeSearchPanel(view);
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      // The gate is on the ACTION, so this path is closed by the same predicate
      // the buttons render as `disabled`. It used to call `replaceNext` outright,
      // which meant the one keyboard path the comment above calls primary was the
      // one the gate did not cover.
      if (!canReplace()) return;
      replaceNext(view);
    }
  });

  // Initial state. A fresh open is usually empty (idle). When a query already
  // exists, from the selection prefill `openInNoteFind` sets before opening or
  // from a reopen with a leftover query, the count and highlights should be
  // ready the instant the bar appears (Task 7).
  //
  // **Not `scan()`, and the difference is a crash rather than a nicety.** This
  // function body runs INSIDE a CodeMirror update: the panel spec is called from
  // `PanelGroup.update`, and `EditorView.update` throws "Calls to
  // EditorView.update are not allowed while an update is in progress" when it is
  // re-entered. Since myne-md/myne#609, `scan()` can dispatch, because the
  // date-fallback second pass installs a new query. Reachable in one gesture:
  // close the bar inside the 120 ms scan debounce with a display-format date
  // still typed, so `destroy()` clears the timer and the engine keeps the raw
  // text, then reopen. The leftover query is valid, the first pass matches
  // nothing, the fallback fires, and the dispatch lands mid-update.
  //
  // `scheduleScan()` is a 0-to-120 ms timer, which is off the update stack, and
  // it costs nothing the immediate call was buying: the bar renders its idle
  // state first and the count arrives a frame later, which is what a debounced
  // keystroke already does.
  if (getSearchQuery(view.state).valid) scheduleScan();

  return {
    dom: bar.dom,
    top: true,
    mount: () => bar.focus(),
    update: (u: ViewUpdate) => {
      const prevQuery = getSearchQuery(u.startState);
      const nextQuery = getSearchQuery(u.state);
      // The match set depends ONLY on the search pattern + flags — never on the
      // replace text. Gate the (whole-doc) scan on a search-relevant change so
      // typing in the replace field doesn't re-scan the document for an
      // identical match set.
      const searchChanged =
        prevQuery.search !== nextQuery.search ||
        prevQuery.caseSensitive !== nextQuery.caseSensitive ||
        prevQuery.literal !== nextQuery.literal ||
        prevQuery.regexp !== nextQuery.regexp ||
        prevQuery.wholeWord !== nextQuery.wholeWord;
      if (searchChanged && !nextQuery.valid) {
        // Query emptied → reset the count now; don't wait on (or run) a scan.
        if (scanTimer !== null) {
          clearTimeout(scanTimer);
          scanTimer = null;
        }
        matches = [];
        render();
        return;
      }
      if (searchChanged || u.docChanged) {
        scheduleScan(); // count refreshes when the scan lands (avoid stale render)
        return;
      }
      if (u.selectionSet) render(); // cheap ordinal recompute from the cache
    },
    destroy: () => {
      if (scanTimer !== null) clearTimeout(scanTimer);
      bar.destroy();
    },
  };
}

/** The in-note find bundle, appended to `myneExtensions()`. */
export function findExtension(): Extension[] {
  return [
    search({ top: true, createPanel: createFindPanel }),
    keymap.of([{ key: "Escape", run: closeSearchPanel }]),
  ];
}
