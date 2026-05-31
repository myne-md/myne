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
  ViewPlugin,
  type EditorView,
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
  SearchQuery,
} from "@codemirror/search";
import { createFindBarView } from "./find-bar-view";
import {
  registerFindView,
  unregisterFindView,
  getFindCaseSensitive,
  setFindCaseSensitive,
} from "./find-session";
import { ensureFloatingStyles } from "../floating-styles";

const SCAN_DEBOUNCE_MS = 120; // matches the command-palette note-search cadence

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

  const applyQuery = (query: string): void => {
    view.dispatch({
      effects: setSearchQuery.of(
        // literal: true → plain substring, never regex (regex is out of scope v1).
        new SearchQuery({ search: query, caseSensitive: getFindCaseSensitive(), literal: true }),
      ),
    });
  };

  // Read the engine's matches across the whole doc — we never filter or exclude,
  // so the cached set IS the engine's set (folded tables / fenced code / YAML
  // frontmatter all count, since the cursor scans the canonical doc text).
  const scan = (): void => {
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
    matches = found;
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
  // order, so the first match at/after the cursor is a plain scan.
  const currentOrdinal = (): number => {
    if (matches.length === 0) return 0;
    const from = view.state.selection.main.from;
    const i = matches.findIndex((m) => m.from >= from);
    return (i === -1 ? 0 : i) + 1;
  };

  const render = (): void => {
    const query = bar.input.value;
    const caseSensitive = getFindCaseSensitive();
    if (query.length === 0) {
      bar.update({ query, caseSensitive, status: "idle", match: null });
      return;
    }
    const total = matches.length;
    if (total === 0) {
      bar.update({ query, caseSensitive, status: "no-match", match: null });
      return;
    }
    bar.update({
      query,
      caseSensitive,
      status: "matches",
      match: { current: currentOrdinal(), total },
    });
  };

  const bar = createFindBarView(
    {
      query: getSearchQuery(view.state).search,
      caseSensitive: getFindCaseSensitive(),
      status: "idle",
      match: null,
    },
    {
      onQueryChange: (query) => applyQuery(query),
      onToggleCase: () => {
        setFindCaseSensitive(!getFindCaseSensitive()); // single source of truth (find-session.ts)
        render(); // immediate pressed-state feedback (count refreshes on the rescan)
        applyQuery(bar.input.value);
      },
      onNext: () => {
        findNext(view);
      },
      onPrev: () => {
        findPrevious(view);
      },
      onClose: () => {
        closeSearchPanel(view);
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
      if (e.shiftKey) findPrevious(view);
      else findNext(view);
    }
  });

  // Initial state. A fresh open is usually empty (idle). When a query already
  // exists — selection-prefill (set by `openInNoteFind` before opening) or a
  // reopen with a leftover query — scan IMMEDIATELY (not debounced) so the count
  // + highlights are ready the instant the bar appears (Task 7).
  if (getSearchQuery(view.state).valid) scan();

  return {
    dom: bar.dom,
    top: true,
    mount: () => bar.focus(),
    update: (u: ViewUpdate) => {
      const nextQuery = getSearchQuery(u.state);
      const queryChanged = !getSearchQuery(u.startState).eq(nextQuery);
      if (queryChanged && !nextQuery.valid) {
        // Query emptied → reset the count now; don't wait on (or run) a scan.
        if (scanTimer !== null) {
          clearTimeout(scanTimer);
          scanTimer = null;
        }
        matches = [];
        render();
        return;
      }
      if (queryChanged || u.docChanged) {
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

// Registers the editor's view so the window-level Cmd/Ctrl+F can open find on it
// (see `find-session.ts`); torn down on editor unmount.
const findViewRegistration = ViewPlugin.define((view) => {
  registerFindView(view);
  return {
    destroy: () => unregisterFindView(view),
  };
});

/** The in-note find bundle, appended to `myneExtensions()`. */
export function findExtension(): Extension[] {
  return [
    search({ top: true, createPanel: createFindPanel }),
    findViewRegistration,
    keymap.of([{ key: "Escape", run: closeSearchPanel }]),
  ];
}
