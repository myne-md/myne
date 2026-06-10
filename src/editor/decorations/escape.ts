// Backslash-escape rendering (MYND-208, render-conformance-harness task 5).
//
// `@codemirror/lang-markdown` emits an `Escape` node spanning the two chars
// `\x` (backslash + the escaped char). v0.1 had no consumer, so `\*asterisk\*`
// rendered with the backslashes visible — a render≠emit miss (§6 C1 in the
// user-facing direction). This decoration hides the leading `\` off-cursor so
// the escaped glyph reads cleanly, and reveals the raw `\x` on-cursor for
// editing. Render-only — the buffer is never mutated.

import { syntaxTree } from "@codemirror/language";
import { type Extension, type Range, RangeSetBuilder } from "@codemirror/state";
import { Decoration, type DecorationSet, EditorView } from "@codemirror/view";
import { isInsideRange } from "./cursor-aware";
import { makeCursorAwareDecorationPlugin } from "./plugin-factory";

function buildEscapeDecorations(view: EditorView): DecorationSet {
  const decorations: Array<Range<Decoration>> = [];

  for (const { from, to } of view.visibleRanges) {
    syntaxTree(view.state).iterate({
      from,
      to,
      enter: (node) => {
        if (node.name !== "Escape") return undefined;
        // Reveal the raw `\x` when the cursor is inside the escape.
        if (isInsideRange(view, node.from, node.to)) return undefined;
        // An Escape node is `\` + one char; hide only the leading backslash so
        // the escaped char remains (`\*` → `*`, `\\` → `\`).
        if (node.to - node.from >= 2) {
          decorations.push(
            Decoration.replace({}).range(node.from, node.from + 1),
          );
        }
        return undefined;
      },
    });
  }

  const builder = new RangeSetBuilder<Decoration>();
  decorations.sort((a, b) => a.from - b.from);
  for (const d of decorations) builder.add(d.from, d.to, d.value);
  return builder.finish();
}

export function escapeDecorations(): Extension {
  return makeCursorAwareDecorationPlugin(buildEscapeDecorations);
}
