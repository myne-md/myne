// Inline code decoration (`` `code` ``) for the Phase 1 editor.
//
// PRD `editor-mvp-baseline` story 9. The @lezer/markdown grammar names the
// inline code node `InlineCode` with `CodeMark` children for the backticks.
//
// Apply `.cm-inline-code` (monospace + subtle background) to the InlineCode
// content. Off-line: hide CodeMark backticks. On-line: keep visible.

import { syntaxTree } from "@codemirror/language";
import { type Extension, type Range, RangeSetBuilder } from "@codemirror/state";
import {
  Decoration,
  type DecorationSet,
  EditorView,
} from "@codemirror/view";
import { isInsideRange } from "./cursor-aware";
import { makeCursorAwareDecorationPlugin } from "./plugin-factory";

function buildInlineCodeDecorations(view: EditorView): DecorationSet {
  const decorations: Array<Range<Decoration>> = [];

  for (const { from, to } of view.visibleRanges) {
    syntaxTree(view.state).iterate({
      from,
      to,
      enter: (node) => {
        if (node.name !== "InlineCode") return undefined;
        decorations.push(
          Decoration.mark({ class: "cm-inline-code" }).range(node.from, node.to),
        );
        if (!isInsideRange(view, node.from, node.to)) {
          let child = node.node.firstChild;
          while (child !== null) {
            if (child.name === "CodeMark") {
              decorations.push(
                Decoration.replace({}).range(child.from, child.to),
              );
            }
            child = child.nextSibling;
          }
        }
        return undefined;
      },
    });
  }

  const builder = new RangeSetBuilder<Decoration>();
  decorations.sort((a, b) => {
    if (a.from !== b.from) return a.from - b.from;
    if (a.to !== b.to) return a.to - b.to;
    return (a.value.spec.side ?? 0) - (b.value.spec.side ?? 0);
  });
  for (const d of decorations) builder.add(d.from, d.to, d.value);
  return builder.finish();
}

export function inlineCodeDecorations(): Extension {
  return makeCursorAwareDecorationPlugin(buildInlineCodeDecorations);
}
