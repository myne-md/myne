// Hard line break rendering (MYND-208, render-conformance-harness task 6).
//
// `@codemirror/lang-markdown` emits a `HardBreak` node spanning the trailing
// marker that forces a break — either two (or more) trailing spaces or a
// trailing `\` — at the end of a line. v0.1 had no consumer, so the markers sat
// visibly at line ends. This decoration hides them off-cursor (the line break
// itself, from the source newline, is the only signal — no `↵` glyph, per
// PRODUCT.md principle 4) and reveals the raw markers on-cursor for editing.
// Render-only — the buffer is never mutated (§6 C1).

import { syntaxTree } from "@codemirror/language";
import { type Extension, type Range, RangeSetBuilder } from "@codemirror/state";
import { Decoration, type DecorationSet, EditorView } from "@codemirror/view";
import { isListItemLine } from "../list-indent";
import { isCursorLine } from "./cursor-aware";
import { makeCursorAwareDecorationPlugin } from "./plugin-factory";

function buildHardBreakDecorations(view: EditorView): DecorationSet {
  const decorations: Array<Range<Decoration>> = [];

  for (const { from, to } of view.visibleRanges) {
    syntaxTree(view.state).iterate({
      from,
      to,
      enter: (node) => {
        if (node.name !== "HardBreak") return undefined;
        // The HardBreak node includes the trailing line break; a ViewPlugin
        // replace may not cross it. Clamp to end-of-line so only the trailing
        // markers (2 spaces / `\`) are hidden, never the newline.
        const line = view.state.doc.lineAt(node.from);
        const end = Math.min(node.to, line.to);
        if (end <= node.from) return undefined;
        // Reveal the raw trailing markers while editing the line they end.
        if (isCursorLine(view, node.from, end)) return undefined;
        // …and never hide them on a LIST ITEM (myne-md/myne#657).
        //
        // Hiding the markers is right for prose: the rendered break IS the
        // signal, and two invisible spaces at the end of a paragraph are noise.
        // Inside a list item it reads as the editor eating what you typed , 
        // the item is a short labelled row whose text the reader is holding in
        // one line, so a space that is in the file and not on screen makes live
        // view and the source disagree about how long the label is, with nothing
        // to explain the difference. A hard break inside a list label is also
        // close to never what somebody meant.
        //
        // **`isListItemLine`, not `isTaskLine`, and that is a correction rather
        // than a widening.** The parser only emits a `HardBreak` on a list line
        // when the item HAS a continuation line, and at that point a plain
        // `- label  ` produces the identical node and the identical complaint.
        // Keying on the checkbox meant four characters decided whether the
        // markers were hidden, which is not a rule anybody could have predicted
        // from the outside.
        if (isListItemLine(line.text)) return undefined;
        decorations.push(Decoration.replace({}).range(node.from, end));
        return undefined;
      },
    });
  }

  const builder = new RangeSetBuilder<Decoration>();
  decorations.sort((a, b) => a.from - b.from);
  for (const d of decorations) builder.add(d.from, d.to, d.value);
  return builder.finish();
}

export function hardBreakDecorations(): Extension {
  return makeCursorAwareDecorationPlugin(buildHardBreakDecorations);
}
