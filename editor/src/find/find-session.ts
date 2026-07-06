// Active-editor-view registry for the in-note find bar (MYND-175, Task 2).
//
// The window-level Cmd/Ctrl+F listener (App.tsx) is the single owner of native
// find suppression and lives ABOVE the editor — it has no direct handle to the
// CodeMirror `EditorView`. Rather than drill a ref down through CMEditor /
// Editor.tsx, the editor registers its own view here via a ViewPlugin
// (`find-extension.ts`), and the listener calls `openInNoteFind()`.
//
// Consequence: `openInNoteFind()` no-ops on every non-editor stage (no view
// registered), which is exactly the desired gating — Cmd/Ctrl+F is swallowed
// app-wide (native find never appears) but only OPENS the bar in the editor.

import type { EditorView } from "@codemirror/view";
import {
  openSearchPanel,
  searchPanelOpen,
  setSearchQuery,
  SearchQuery,
} from "@codemirror/search";

let activeView: EditorView | null = null;

/** Called by the find ViewPlugin when an editor mounts. */
export function registerFindView(view: EditorView): void {
  activeView = view;
}

/** Called on editor teardown; guarded so a stale unmount can't clear a newer view. */
export function unregisterFindView(view: EditorView): void {
  if (activeView === view) activeView = null;
}

/**
 * Open the in-note find panel on the active editor view, focusing its input.
 * Returns `false` when no editor view is registered (every non-editor stage) —
 * the caller still preventDefault'd the native Cmd/Ctrl+F, it just opens nothing.
 */
export function openInNoteFind(): boolean {
  if (activeView === null) return false;
  const view = activeView;

  // Already open (Cmd/Ctrl+F re-press): refocus + select the input, browser-style
  // — do NOT toggle it closed or re-prefill (that would overwrite the live query
  // with the current-match text). The find panel lives inside `view.dom`.
  if (searchPanelOpen(view.state)) {
    const input = view.dom.querySelector<HTMLInputElement>(".cm-find-bar-input");
    if (input !== null) {
      input.focus();
      input.select();
    }
    return true;
  }

  // Fresh open: prefill from the editor selection (Task 7). A non-empty,
  // single-line selection becomes the query and is searched immediately; a
  // multiline or empty selection leaves the query as-is (an empty bar on a fresh
  // note). The dispatch happens here, in a plain event-handler context — safe,
  // unlike dispatching from inside the panel's create/mount during a CM update.
  const sel = view.state.selection.main;
  if (!sel.empty) {
    const text = view.state.sliceDoc(sel.from, sel.to);
    if (!text.includes("\n")) {
      view.dispatch({
        effects: setSearchQuery.of(
          new SearchQuery({
            search: text,
            caseSensitive: getFindCaseSensitive(),
            literal: true,
          }),
        ),
      });
    }
  }
  return openSearchPanel(view);
}

// Case-sensitivity is a session-level *preference*, not per-note state (MYND-175
// Task 6). It's a mode bit carrying no plaintext, so — unlike the query, which is
// per-note and cleared on note switch — it survives note switches within an
// unlocked session. In-memory only: a module singleton, never written to disk /
// vault.prefs, reset to the default (off) by the WebView reload on lock/restart.
// Hoisting a boolean does not violate the "don't hoist plaintext" rule.
let findCaseSensitive = false;

export function getFindCaseSensitive(): boolean {
  return findCaseSensitive;
}

export function setFindCaseSensitive(value: boolean): void {
  findCaseSensitive = value;
}
