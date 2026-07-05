// Inline typography decorations — highlight / subscript / superscript (MYND-156,
// inline-typography-extensions). Mirrors `emphasis.ts`: mark the node's text with
// a theme class and hide the delimiter `*Mark` children off-cursor, revealing
// them on-cursor (`isInsideRange`). Render-only — bytes preserved (§6 C1).
//
// The lezer node/mark names:
//   - `Highlight` / `HighlightMark`     (`==text==`, hand-rolled config)
//   - `Subscript` / `SubscriptMark`     (`~x~`, @lezer/markdown)
//   - `Superscript` / `SuperscriptMark` (`^x^`, @lezer/markdown)
//
// `.cm-highlight` / `.cm-sub` / `.cm-sup` are the SYNC-6 shared classes also
// reused by embedded-html-rendering's `<mark>`/`<sub>`/`<sup>` (MYND-209). Emoji
// `:shortcode:` rendering is a separate decoration (task 3).

import { syntaxTree } from "@codemirror/language";
import { type Extension, type Range, RangeSetBuilder } from "@codemirror/state";
import { Decoration, type DecorationSet, EditorView } from "@codemirror/view";
import { isInsideRange } from "./cursor-aware";
import { makeCursorAwareDecorationPlugin } from "./plugin-factory";

const NODE_CONFIG: Record<string, { textClass: string; markName: string }> = {
  Highlight: { textClass: "cm-highlight", markName: "HighlightMark" },
  Subscript: { textClass: "cm-sub", markName: "SubscriptMark" },
  Superscript: { textClass: "cm-sup", markName: "SuperscriptMark" },
};

function buildInlineTypographyDecorations(view: EditorView): DecorationSet {
  const decorations: Array<Range<Decoration>> = [];

  for (const { from, to } of view.visibleRanges) {
    syntaxTree(view.state).iterate({
      from,
      to,
      enter: (node) => {
        const config = NODE_CONFIG[node.name];
        if (config === undefined) return undefined;

        decorations.push(
          Decoration.mark({ class: config.textClass }).range(node.from, node.to),
        );

        if (!isInsideRange(view, node.from, node.to)) {
          let child = node.node.firstChild;
          while (child !== null) {
            if (child.name === config.markName) {
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

export function inlineTypographyDecorations(): Extension {
  return makeCursorAwareDecorationPlugin(buildInlineTypographyDecorations);
}
