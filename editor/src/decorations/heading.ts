// Heading decoration (H1–H6) for the Phase 1 editor.
//
// PRD `editor-mvp-baseline` stories 2–5. The @lezer/markdown grammar names
// heading nodes `ATXHeading1` … `ATXHeading6` and the leading `#`s as
// `HeaderMark`. We apply:
//
//   - `Decoration.line({ class: "cm-h1" })` on the whole heading line so
//     the typography ramp (font-size + weight) is binding via theme.
//   - `Decoration.replace` on the leading `#` + space when the cursor is
//     NOT on the heading line (cursor-aware reveal).
//
// Penpot reference: `flow--editor-baseline` Section A — six heading rows,
// off-line variant hides leading `#`s, on-line variant keeps them visible.

import { syntaxTree } from "@codemirror/language";
import { type Extension, type Range, RangeSetBuilder } from "@codemirror/state";
import {
  Decoration,
  type DecorationSet,
  EditorView,
} from "@codemirror/view";
import { isCursorLine } from "./cursor-aware";
import { makeCursorAwareDecorationPlugin } from "./plugin-factory";

const HEADING_NODE_BY_LEVEL: Record<number, string> = {
  1: "ATXHeading1",
  2: "ATXHeading2",
  3: "ATXHeading3",
  4: "ATXHeading4",
  5: "ATXHeading5",
  6: "ATXHeading6",
};

const HEADING_CLASS: Record<number, string> = {
  1: "cm-h1",
  2: "cm-h2",
  3: "cm-h3",
  4: "cm-h4",
  5: "cm-h5",
  6: "cm-h6",
};

function buildHeadingDecorations(view: EditorView): DecorationSet {
  const lineDecorations: Array<Range<Decoration>> = [];
  const markDecorations: Array<Range<Decoration>> = [];

  for (const { from, to } of view.visibleRanges) {
    syntaxTree(view.state).iterate({
      from,
      to,
      enter: (node) => {
        for (let level = 1; level <= 6; level++) {
          if (node.name !== HEADING_NODE_BY_LEVEL[level]) continue;
          const line = view.state.doc.lineAt(node.from);
          lineDecorations.push(
            Decoration.line({ class: HEADING_CLASS[level] }).range(line.from),
          );
          if (!isCursorLine(view, node.from, node.to)) {
            // Find the trailing HeaderMark range plus the following space.
            const child = node.node.firstChild;
            if (child !== null && child.name === "HeaderMark") {
              const markEnd = Math.min(child.to + 1, node.to);
              markDecorations.push(
                Decoration.replace({}).range(child.from, markEnd),
              );
            }
          }
          return false;
        }
        return undefined;
      },
    });
  }

  // CM6 requires Decoration ranges sorted by `from` and grouped by side.
  // Line decorations and replace decorations don't interleave in our case
  // because line decoration's `from === line.from` while replace starts at
  // `child.from` (which equals `node.from`, also `line.from` for ATX). The
  // RangeSetBuilder requires strictly ascending `from`; we use two builders
  // and merge instead.
  const builder = new RangeSetBuilder<Decoration>();
  const merged = [...lineDecorations, ...markDecorations].sort((a, b) => {
    if (a.from !== b.from) return a.from - b.from;
    return a.value.spec.side ?? 0 - (b.value.spec.side ?? 0);
  });
  for (const d of merged) builder.add(d.from, d.to, d.value);
  return builder.finish();
}

export function headingDecorations(): Extension {
  return makeCursorAwareDecorationPlugin(buildHeadingDecorations);
}
