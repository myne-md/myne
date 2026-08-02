// Per-line text direction — the editor's RTL / bidi support (myne#172,
// epic rtl-support / SYNC-8).
//
// The hard case (the Obsidian "mixed RTL + LTR" forum thread the feature was
// filed from) is a note that mixes Arabic/Hebrew paragraphs with Latin ones.
// The fix is to let EACH LINE resolve its own base direction from its content,
// rather than forcing one direction on the whole editor:
//
//   1. `EditorView.perLineTextDirection.of(true)` — tell CodeMirror to measure
//      direction per line (so `bidiSpans`/caret motion/selection are computed
//      against the real per-line direction, not the content-wide one). CM6 ships
//      the full Unicode-Bidi machinery; we only turn it on and feed it a
//      direction per line.
//   2. A line decoration stamping `dir="auto"` on every line, so the browser
//      resolves that line's base direction from its first strong character —
//      and `getComputedStyle(line).direction` then returns the resolved value
//      CM6 reads. An empty / all-neutral line inherits the surrounding
//      direction (the UI-locale chrome dir), which is the intended fallback:
//      editor CONTENT direction is content-driven and otherwise decoupled from
//      the app chrome (a bilingual user's English lines stay LTR even in an
//      Arabic UI).
//
// Mounted MODE-INDEPENDENTLY (not inside the view-mode decoration compartment,
// which is emptied in source mode) — raw-markdown Arabic must still be RTL in
// source and reading modes alike. Render-only: never mutates the buffer.

import {
  Decoration,
  type DecorationSet,
  EditorView,
  ViewPlugin,
  type ViewUpdate,
} from "@codemirror/view";
import { RangeSetBuilder, type Extension } from "@codemirror/state";

// A single shared line decoration — `dir="auto"` on the `.cm-line`. Line
// decorations that also carry other attributes (heading class, list hanging
// indent) MERGE with this one, so it composes with the existing decoration stack.
const AUTO_DIR_LINE = Decoration.line({ attributes: { dir: "auto" } });

function buildAutoDir(view: EditorView): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  for (const { from, to } of view.visibleRanges) {
    for (let pos = from; pos <= to; ) {
      const line = view.state.doc.lineAt(pos);
      builder.add(line.from, line.from, AUTO_DIR_LINE);
      pos = line.to + 1;
    }
  }
  return builder.finish();
}

const perLineAutoDirPlugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = buildAutoDir(view);
    }
    update(update: ViewUpdate) {
      if (update.docChanged || update.viewportChanged) {
        this.decorations = buildAutoDir(update.view);
      }
    }
  },
  { decorations: (v) => v.decorations },
);

/** Enable per-line bidi: `perLineTextDirection` + a `dir="auto"` line
 *  decoration on every line. Compose in the base extension array
 *  MODE-INDEPENDENTLY (all of live / source / reading). */
export function textDirectionExtension(): Extension {
  return [EditorView.perLineTextDirection.of(true), perLineAutoDirPlugin];
}
