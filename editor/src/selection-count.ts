// Selection-count observability hook (multi-cursor / MYND-306, SYNC-8 E2E
// contract). Exposes the number of active selection ranges as a
// `data-selection-count` attribute on the editor's outer DOM
// (`.cm-editor`), so the E2E harness can assert multi-cursor state
// (1 = single cursor, N = N cursors) without any new visible chrome.
//
// This is observability ONLY — it never mutates the document or the
// selection, paints nothing, and adds no UI. It mirrors the data-* idiom
// used elsewhere (booleans/counts as `data-*` strings). A `ViewPlugin`
// keeps the attribute live: it writes on mount and on every selection
// change, reading `state.selection.ranges.length` (≥ 1 always).

import { type Extension } from "@codemirror/state";
import { EditorView, ViewPlugin, type ViewUpdate } from "@codemirror/view";

const SELECTION_COUNT_ATTR = "data-selection-count";

/** Write the current range count onto the editor's outer DOM node. */
function writeCount(view: EditorView): void {
  view.dom.setAttribute(
    SELECTION_COUNT_ATTR,
    String(view.state.selection.ranges.length),
  );
}

export function selectionCountObserver(): readonly Extension[] {
  return [
    ViewPlugin.define((view) => {
      writeCount(view);
      return {
        update(update: ViewUpdate) {
          // selectionSet covers add/remove cursor + collapse; docChanged covers
          // edits that can split/merge ranges. Either can change the count.
          if (update.selectionSet || update.docChanged) writeCount(update.view);
        },
      };
    }),
  ];
}
