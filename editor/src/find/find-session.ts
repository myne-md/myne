// Active-editor-view registry for the in-note find bar (MYND-175, Task 2).
//
// The window-level Cmd/Ctrl+F listener (App.tsx) is the single owner of native
// find suppression and lives ABOVE the editor — it has no direct handle to the
// CodeMirror `EditorView`. Rather than drill a ref down through CMEditor /
// Editor.tsx, the listener calls `openInNoteFind()`, which resolves the view
// through the package's active-view registry.
//
// Consequence: `openInNoteFind()` no-ops on every non-editor stage (no view
// registered), which is exactly the desired gating — Cmd/Ctrl+F is swallowed
// app-wide (native find never appears) but only OPENS the bar in the editor.

import { getActiveEditorView } from "../active-view";
import {
  openSearchPanel,
  searchPanelOpen,
  setSearchQuery,
  SearchQuery,
} from "@codemirror/search";

// The view find acts on comes from `active-view.ts` (myne#328).
//
// This module used to keep its own registry, and it tracked MOUNT rather than
// FOCUS — so `activeView` was whichever CodeMirror view mounted last, never the
// one the user was editing. Two consequences, both reachable in an ordinary
// two-pane or preview-companion layout:
//
//   - the bar opened on the wrong pane, and `replaceAll` is bound to that same
//     wrong view, so a bulk replace launched from a mis-targeted bar rewrote the
//     OTHER note in one undoable transaction (or, against the read-only preview
//     companion, silently did nothing);
//   - when that view unmounted without a sibling remounting, the registry went
//     to null and the app's only in-note find was unreachable for the rest of
//     the session — and because Cmd/Ctrl+F is preventDefault'd app-wide, the
//     WebView's native find is suppressed too, so the key did literally nothing
//     with no message.
//
// `active-view.ts` already solves exactly this, in this package, by tracking
// focus as well as mount — and its extension is installed in the same bundle. A
// second registry was the bug; there is now one.

/**
 * Open the in-note find panel on the active editor view, focusing its input.
 * Returns `false` when no editor view is registered (every non-editor stage) —
 * the caller still preventDefault'd the native Cmd/Ctrl+F, it just opens nothing.
 */
export function openInNoteFind(): boolean {
  const view = getActiveEditorView();
  if (view === null) return false;

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
