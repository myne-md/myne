// Blockquote decoration (`> ...`) for the Phase 1 editor.
//
// PRD `editor-mvp-baseline` story 26. The @lezer/markdown grammar names the
// block `Blockquote` containing `QuoteMark` children for each `>` line marker.
//
// Apply `.cm-blockquote` line decoration to each line inside the blockquote
// (renders left border + sol padding via theme). Off-line: hide `QuoteMark`
// + trailing space; on-line: keep `>` visible.

import { syntaxTree } from "@codemirror/language";
import { type Extension, type Range, RangeSetBuilder } from "@codemirror/state";
import {
  Decoration,
  type DecorationSet,
  EditorView,
} from "@codemirror/view";
import { isCursorLine } from "./cursor-aware";
import { makeCursorAwareDecorationPlugin } from "./plugin-factory";

function buildBlockquoteDecorations(view: EditorView): DecorationSet {
  const decorations: Array<Range<Decoration>> = [];

  for (const { from, to } of view.visibleRanges) {
    syntaxTree(view.state).iterate({
      from,
      to,
      enter: (node) => {
        if (node.name === "Blockquote") {
          const startLine = view.state.doc.lineAt(node.from).number;
          const endLine = view.state.doc.lineAt(node.to).number;
          for (let n = startLine; n <= endLine; n++) {
            const line = view.state.doc.line(n);
            decorations.push(
              Decoration.line({ class: "cm-blockquote" }).range(line.from),
            );
          }
        } else if (node.name === "QuoteMark") {
          if (!isCursorLine(view, node.from, node.to)) {
            // Hide `>` + trailing space if present.
            const after = node.to;
            const nextChar = view.state.doc.sliceString(after, after + 1);
            const hideTo = nextChar === " " ? after + 1 : after;
            decorations.push(Decoration.replace({}).range(node.from, hideTo));
          }
        }
        return undefined;
      },
    });
  }

  const builder = new RangeSetBuilder<Decoration>();
  decorations.sort((a, b) => {
    if (a.from !== b.from) return a.from - b.from;
    return (a.value.spec.side ?? 0) - (b.value.spec.side ?? 0);
  });
  for (const d of decorations) builder.add(d.from, d.to, d.value);
  return builder.finish();
}

export function blockquoteDecorations(): Extension {
  return makeCursorAwareDecorationPlugin(buildBlockquoteDecorations);
}
