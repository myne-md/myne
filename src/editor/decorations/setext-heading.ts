// Setext heading decoration (`Title\n===` → H1, `Title\n---` → H2) for the
// Phase 1 editor.
//
// PRD `editor-mvp-ref-and-block-rendering` (MYND-146). The @lezer/markdown
// grammar already produces `SetextHeading1` / `SetextHeading2` nodes (no parser
// work); each node spans BOTH the text line(s) and the trailing underline line,
// and carries a `HeaderMark` child covering the `===` / `---` underline.
//
// Off-line:
//   - Apply the existing `.cm-h1` / `.cm-h2` line class to the text line(s) so
//     the typography ramp (font-size + weight) is binding via theme.
//   - Collapse the underline line OUT entirely (not just emptied) by replacing
//     the preceding newline + the underline text. Because that replace crosses
//     a line break, this MUST be a `StateField`, not a `ViewPlugin` (CM6
//     forbids line-break-replacing decorations from plugins) — same contract as
//     `frontmatter.ts` / `table.ts`. Focus is read from the shared
//     `editorFocusField`.
// On-line: the cursor-aware reveal spans the whole node, so clicking EITHER the
// text line or the underline line shows raw source on both.
//
// HR disambiguation: this keys only off `SetextHeading1` / `SetextHeading2`, so
// a standalone `---` (parsed as `HorizontalRule`) is never styled as a heading.
//
// Penpot reference: `flow--editor-ref-and-block` Section E — setext row, off-line
// hides the `===`/`---` underline, on-line keeps both lines visible.

import { syntaxTree } from "@codemirror/language";
import {
  type EditorState,
  type Extension,
  type Range,
  RangeSetBuilder,
} from "@codemirror/state";
import { Decoration, type DecorationSet } from "@codemirror/view";
import { collapseLineRange, linesRevealed } from "./cursor-aware";
import { makeCursorAwareStateField } from "./plugin-factory";

const SETEXT_CLASS: Record<string, string> = {
  SetextHeading1: "cm-h1",
  SetextHeading2: "cm-h2",
};

function buildSetextHeadingDecorations(state: EditorState): DecorationSet {
  const lineDecorations: Array<Range<Decoration>> = [];
  const replaceDecorations: Array<Range<Decoration>> = [];

  syntaxTree(state).iterate({
    enter: (node) => {
      const cls = SETEXT_CLASS[node.name];
      if (cls === undefined) return undefined;

      // Locate the underline via the HeaderMark child (the `===` / `---`).
      let underline = node.node.firstChild;
      while (underline !== null && underline.name !== "HeaderMark") {
        underline = underline.nextSibling;
      }
      // Defensive: a setext node always carries a HeaderMark underline. If the
      // tree is mid-reparse and it's absent, skip rather than mis-style.
      if (underline === null) return false;

      const textStartLine = state.doc.lineAt(node.from).number;
      const underlineLine = state.doc.lineAt(underline.from);

      // Typography on every text line above the underline (single-line is the
      // common case; CommonMark permits multi-line setext text).
      for (let n = textStartLine; n < underlineLine.number; n++) {
        const line = state.doc.line(n);
        lineDecorations.push(Decoration.line({ class: cls }).range(line.from));
      }

      if (!linesRevealed(state, textStartLine, underlineLine.number)) {
        // Collapse the underline line out (eat the preceding newline so no empty
        // gap remains) — same line-collapse maneuver as reference-definition
        // hiding, hence the shared helper.
        const { from, to } = collapseLineRange(
          state,
          underlineLine.number,
          underlineLine.number,
        );
        replaceDecorations.push(Decoration.replace({}).range(from, to));
      }
      return false;
    },
  });

  const builder = new RangeSetBuilder<Decoration>();
  const merged = [...lineDecorations, ...replaceDecorations].sort((a, b) => {
    if (a.from !== b.from) return a.from - b.from;
    return (a.value.spec.side ?? 0) - (b.value.spec.side ?? 0);
  });
  for (const d of merged) builder.add(d.from, d.to, d.value);
  return builder.finish();
}

export function setextHeadingDecorations(): Extension {
  return makeCursorAwareStateField(buildSetextHeadingDecorations);
}
