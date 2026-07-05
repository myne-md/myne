// Emphasis decoration (bold + italic + strikethrough) for the Phase 1 editor.
//
// PRD `editor-mvp-baseline` stories 6–8. The @lezer/markdown grammar names:
//   - `StrongEmphasis` → bold (`**...**` or `__...__`)
//   - `Emphasis` → italic (`*...*` or `_..._`)
//   - `Strikethrough` (GFM extension) → strike (`~~...~~`)
// Each wraps the rendered text plus a pair of `EmphasisMark` / `StrongMark` /
// `StrikethroughMark` children for the delimiters.
//
// Off-line: hide delimiter marks via `Decoration.replace`. The styled text
// inherits typography from the theme's `.cm-bold` / `.cm-italic` / `.cm-strike`
// classes via `Decoration.mark`.

import { syntaxTree } from "@codemirror/language";
import { type Extension, type Range, RangeSetBuilder } from "@codemirror/state";
import {
  Decoration,
  type DecorationSet,
  EditorView,
} from "@codemirror/view";
import { isInsideRange } from "./cursor-aware";
import { makeCursorAwareDecorationPlugin } from "./plugin-factory";

const NODE_CLASSES: Record<string, { textClass: string; markName: string }> = {
  StrongEmphasis: { textClass: "cm-bold", markName: "EmphasisMark" },
  Emphasis: { textClass: "cm-italic", markName: "EmphasisMark" },
  Strikethrough: { textClass: "cm-strike", markName: "StrikethroughMark" },
};

function buildEmphasisDecorations(view: EditorView): DecorationSet {
  const decorations: Array<Range<Decoration>> = [];

  for (const { from, to } of view.visibleRanges) {
    syntaxTree(view.state).iterate({
      from,
      to,
      enter: (node) => {
        const config = NODE_CLASSES[node.name];
        if (config === undefined) return undefined;

        decorations.push(
          Decoration.mark({ class: config.textClass }).range(node.from, node.to),
        );

        if (!isInsideRange(view, node.from, node.to)) {
          // Hide delimiter marks (EmphasisMark / StrongMark / StrikethroughMark).
          // The actual mark node name depends on the parent — @lezer/markdown
          // uses EmphasisMark for both Emphasis and StrongEmphasis (the
          // distinction is the parent + count of `*`s). Strikethrough uses
          // StrikethroughMark.
          let child = node.node.firstChild;
          while (child !== null) {
            if (
              child.name === "EmphasisMark" ||
              child.name === "StrikethroughMark"
            ) {
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

export function emphasisDecorations(): Extension {
  return makeCursorAwareDecorationPlugin(buildEmphasisDecorations);
}
