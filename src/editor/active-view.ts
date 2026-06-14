// Active-editor-view registry — the focused pane's CodeMirror `EditorView`,
// reachable from command-palette actions that live ABOVE the editor (which have
// no direct view handle). Mirrors the find-bar's `find-session` registry
// (MYND-175): the editor registers itself via a ViewPlugin; a palette action
// (e.g. R2 "Convert imported wikilinks", MYND-84) reads the active view + its
// WL-5 note-set facet without threading a ref through React.
//
// Multi-pane: the most-recently-FOCUSED view wins (so the command acts on the
// pane the user is in), falling back to the last-mounted on cold open.

import { EditorView, ViewPlugin } from "@codemirror/view";
import type { Extension } from "@codemirror/state";

let activeView: EditorView | null = null;

/** The focused editor view, or null on a non-editor stage / before mount. */
export function getActiveEditorView(): EditorView | null {
  return activeView;
}

export function activeViewExtension(): Extension {
  return [
    ViewPlugin.fromClass(
      class {
        constructor(private readonly view: EditorView) {
          activeView = view;
        }
        destroy() {
          if (activeView === this.view) activeView = null;
        }
      },
    ),
    EditorView.domEventHandlers({
      focus: (_e, view) => {
        activeView = view;
        return false;
      },
    }),
  ];
}
