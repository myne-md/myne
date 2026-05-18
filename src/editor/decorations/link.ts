// Inline link decoration `[text](url)` for the Phase 1 editor.
//
// PRD `editor-mvp-baseline` story 10. The @lezer/markdown grammar names
// inline link nodes `Link` with children including the `[text]` (no
// dedicated node — read between `LinkMark` brackets) and a `URL` node for
// the `(url)` portion.
//
// Off-line:
//   - Apply `.cm-link` class to the visible link text (between `[` and `]`)
//   - Hide the `[` `]` LinkMarks
//   - Hide the entire `(url)` portion via `Decoration.replace`
// On-line: all markup visible.

import { syntaxTree } from "@codemirror/language";
import { type Extension, type Range, RangeSetBuilder } from "@codemirror/state";
import {
  Decoration,
  type DecorationSet,
  EditorView,
} from "@codemirror/view";
import { isInsideRange } from "./cursor-aware";
import { makeCursorAwareDecorationPlugin } from "./plugin-factory";

function buildLinkDecorations(view: EditorView): DecorationSet {
  const decorations: Array<Range<Decoration>> = [];

  for (const { from, to } of view.visibleRanges) {
    syntaxTree(view.state).iterate({
      from,
      to,
      enter: (node) => {
        if (node.name !== "Link") return undefined;

        // Walk children to locate LinkMark brackets + URL.
        let firstBracketEnd: number | null = null;
        let lastBracketStart: number | null = null;
        let urlFrom: number | null = null;
        let urlTo: number | null = null;
        const linkMarkRanges: Array<[number, number]> = [];

        let child = node.node.firstChild;
        while (child !== null) {
          if (child.name === "LinkMark") {
            linkMarkRanges.push([child.from, child.to]);
            if (firstBracketEnd === null) firstBracketEnd = child.to;
            // The last "]" is the one that precedes `(url)`. Captured by
            // the loop continuing — we keep the last `]` before URL.
            if (urlFrom === null) lastBracketStart = child.from;
          } else if (child.name === "URL") {
            urlFrom = child.from;
            urlTo = child.to;
          }
          child = child.nextSibling;
        }

        // Apply .cm-link to the visible text between first `[` and last `]`.
        if (firstBracketEnd !== null && lastBracketStart !== null) {
          decorations.push(
            Decoration.mark({ class: "cm-link" }).range(
              firstBracketEnd,
              lastBracketStart,
            ),
          );
        }

        if (!isInsideRange(view, node.from, node.to)) {
          // Hide LinkMark brackets.
          for (const [f, t] of linkMarkRanges) {
            decorations.push(Decoration.replace({}).range(f, t));
          }
          // Hide `(url)` — the URL node covers the content; we need the
          // surrounding `(` and `)` too. URL node from is the first char
          // after `(`; URL.to is the last char before `)`. So we hide
          // [URL.from - 1, URL.to + 1].
          if (urlFrom !== null && urlTo !== null) {
            const parenOpen = urlFrom - 1;
            const parenClose = urlTo + 1;
            if (
              parenOpen >= node.from &&
              parenClose <= node.to &&
              view.state.doc.sliceString(parenOpen, parenOpen + 1) === "(" &&
              view.state.doc.sliceString(parenClose - 1, parenClose) === ")"
            ) {
              decorations.push(
                Decoration.replace({}).range(parenOpen, parenClose),
              );
            } else {
              // Fallback: hide only the URL content.
              decorations.push(Decoration.replace({}).range(urlFrom, urlTo));
            }
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

export function linkDecorations(): Extension {
  return makeCursorAwareDecorationPlugin(buildLinkDecorations);
}
