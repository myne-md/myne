// Shared CM6 ViewPlugin factory for decoration extensions.
//
// All decoration files in this directory follow the same scaffold: a pure
// `build(view) -> DecorationSet` builder + a ViewPlugin that calls it on
// the relevant update signals. Extract the scaffold so each decoration
// file only owns its own builder.

import { type Extension } from "@codemirror/state";
import {
  type DecorationSet,
  EditorView,
  ViewPlugin,
  type ViewUpdate,
} from "@codemirror/view";

/** Default update trigger: doc / viewport / selection / focus changes —
 *  used by every cursor-aware decoration (emphasis, link, inline-code,
 *  heading, blockquote, hr, frontmatter). */
const cursorAwareUpdate = (update: ViewUpdate): boolean =>
  update.docChanged ||
  update.viewportChanged ||
  update.selectionSet ||
  update.focusChanged;

/** Update trigger for decorations that don't depend on cursor position —
 *  e.g. task-list (checkbox is always rendered). */
const docOnlyUpdate = (update: ViewUpdate): boolean =>
  update.docChanged || update.viewportChanged;

export function makeCursorAwareDecorationPlugin(
  build: (view: EditorView) => DecorationSet,
): Extension {
  return makeDecorationPlugin(build, cursorAwareUpdate);
}

export function makeDocOnlyDecorationPlugin(
  build: (view: EditorView) => DecorationSet,
): Extension {
  return makeDecorationPlugin(build, docOnlyUpdate);
}

function makeDecorationPlugin(
  build: (view: EditorView) => DecorationSet,
  shouldUpdate: (update: ViewUpdate) => boolean,
): Extension {
  return ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;
      constructor(view: EditorView) {
        this.decorations = build(view);
      }
      update(update: ViewUpdate) {
        if (shouldUpdate(update)) {
          this.decorations = build(update.view);
        }
      }
    },
    { decorations: (v) => v.decorations },
  );
}
