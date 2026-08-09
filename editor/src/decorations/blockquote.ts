// Blockquote decoration (`> ...`) for the Phase 1 editor.
//
// PRD `editor-mvp-baseline` story 26 + `editor-mvp-ref-and-block-rendering`
// polish pass (MYND-155). The @lezer/markdown grammar names the block
// `Blockquote` containing `QuoteMark` children for each `>` line marker; nested
// quotes (`> > deeper`) parse as a `Blockquote` inside a `Blockquote`, so a
// nested line is covered by TWO `Blockquote` nodes and carries TWO `QuoteMark`
// children.
//
// Apply `.cm-blockquote` line decoration to each line inside the blockquote
// (renders left bar + indent + muted italic via theme). For nested lines, scale
// the left padding by nesting depth so deeper quotes read as deeper-indented.
// Off-line: hide every `QuoteMark` + trailing space on the line (all levels);
// on-line: keep the `>` markers visible.
//
// Callout caveat (MYND-155): a `> [!NOTE]` line stays an ORDINARY blockquote —
// `[!NOTE]` is left as plain text. Callout/admonition widgets are deferred
// (markdown-dialect.md §7), so this decorator deliberately does no callout
// promotion; the `[!NOTE]` token simply renders as quote body text.

import { syntaxTree } from "@codemirror/language";
import { type Extension, type Range, RangeSetBuilder } from "@codemirror/state";
import {
  Decoration,
  type DecorationSet,
  EditorView,
} from "@codemirror/view";
import { isInsideRange } from "./cursor-aware";
import { ornamentSegment } from "./ornament-segment";
import { makeCursorAwareDecorationPlugin } from "./plugin-factory";

// Nesting bars. Penpot `flow--editor-ref-and-block` blockquote specimen
// (`e--bq--off-nested`): each nesting level draws its OWN 3px `--line-2` bar
// followed by a 14px gap — a 17px step — and the body text starts after the
// last gap. A depth-`d` line therefore paints `d` vertical bars at x = 0, 17,
// 34, … and pads its text to `d * 17`. Bars are painted as stacked
// `linear-gradient` background layers on the `.cm-line` (a line decoration is
// one DOM element, so multiple borders aren't available — gradients are).
const BAR_WIDTH = 3; // px, matches Penpot bar0/bar1 + theme `--line-2`
const BAR_GAP = 14; // px gap after each bar, matches Penpot gap0/gap1
/** Horizontal step between consecutive nesting bars (bar + gap = 17px). Shared
 *  with `fenced-code.ts` so a code card nested in a quote draws bars that align
 *  with the quote's own bars above/below it. */
export const QUOTE_BAR_STEP = BAR_WIDTH + BAR_GAP;

/** CSS painting `depth` vertical `--line-2` bars at x = 0, 17, 34, … as stacked
 *  background-image layers (a `.cm-line` is one DOM element — no multi-border —
 *  and background-image composes over any background-color the element already
 *  has, e.g. a code card's fill). Returns background props only; callers add
 *  their own `padding-left` to clear the bars. */
export function quoteBarBackgroundCss(depth: number): string {
  const layers: string[] = [];
  const sizes: string[] = [];
  const positions: string[] = [];
  for (let k = 0; k < depth; k++) {
    layers.push("linear-gradient(var(--line-2, #c8c7c1), var(--line-2, #c8c7c1))");
    sizes.push(`${BAR_WIDTH}px 100%`);
    positions.push(`${k * QUOTE_BAR_STEP}px 0`);
  }
  return [
    `background-image:${layers.join(",")}`,
    `background-size:${sizes.join(",")}`,
    `background-position:${positions.join(",")}`,
    "background-repeat:no-repeat",
  ].join(";");
}

/** Per-line inline style for a blockquote body line: bars + matching indent. */
function blockquoteBarStyle(depth: number): string {
  return `${quoteBarBackgroundCss(depth)};padding-left:${depth * QUOTE_BAR_STEP}px`;
}

function buildBlockquoteDecorations(view: EditorView): DecorationSet {
  // line number → nesting depth (number of Blockquote ancestors covering it).
  const depthByLine = new Map<number, number>();
  // Lines inside a fenced code block. They still get the quote BAR (so it aligns
  // with the code-in-quote card's own margin bars above/below), but NOT the
  // italic body class (the card / raw code shouldn't be italic), and their `>`
  // markers are NOT hidden here: away-state the card block-replaces the whole
  // block (an inline marker-replace would overlap the block-replace), and
  // on-cursor the markers reveal anyway.
  const codeLines = new Set<number>();
  // Lines covered by a table block (MYND-208). Same treatment as code lines: a
  // table nested in a quote away-state block-replaces the whole table
  // (`table.ts`), so these lines get the quote BAR (to align with the table's
  // margin) but NOT the italic body class, and their `>` markers are NOT hidden
  // here — an inline marker-replace would overlap the table's block-replace and
  // CM6 would throw. On-cursor the table reveals and the markers show anyway.
  const tableLines = new Set<number>();
  const markHides: Array<{ from: number; to: number }> = [];

  for (const { from, to } of view.visibleRanges) {
    syntaxTree(view.state).iterate({
      from,
      to,
      enter: (node) => {
        if (node.name === "Blockquote") {
          const startLine = view.state.doc.lineAt(node.from).number;
          const endLine = view.state.doc.lineAt(node.to).number;
          for (let n = startLine; n <= endLine; n++) {
            depthByLine.set(n, (depthByLine.get(n) ?? 0) + 1);
          }
        } else if (node.name === "FencedCode") {
          const startLine = view.state.doc.lineAt(node.from).number;
          const endLine = view.state.doc.lineAt(node.to).number;
          for (let n = startLine; n <= endLine; n++) codeLines.add(n);
        } else if (node.name === "Table") {
          const startLine = view.state.doc.lineAt(node.from).number;
          const endLine = view.state.doc.lineAt(node.to).number;
          for (let n = startLine; n <= endLine; n++) tableLines.add(n);
        } else if (node.name === "QuoteMark") {
          // MYND-631: caret-scoped, not line-scoped. Editing inside a quote
          // used to expose every `>` on the line and shift the text; now the
          // marker lifts only when the caret is actually in it.
          const after = node.to;
          const nextChar = view.state.doc.sliceString(after, after + 1);
          const hideTo = nextChar === " " ? after + 1 : after;
          if (!isInsideRange(view, node.from, hideTo)) {
            markHides.push({ from: node.from, to: hideTo });
          }
        }
        return undefined;
      },
    });
  }

  const decorations: Array<Range<Decoration>> = [];
  // Line decorations first so they sort ahead of the QuoteMark replaces that
  // share a line's start position (stable sort keeps line decos at the front).
  for (const [lineNo, depth] of depthByLine) {
    const line = view.state.doc.line(lineNo);
    // Code-block lines get bars (to align with the card's margin bars) but no
    // italic body class; all other quote lines get the full `.cm-blockquote`.
    decorations.push(
      Decoration.line(
        codeLines.has(lineNo) || tableLines.has(lineNo)
          ? { attributes: { style: blockquoteBarStyle(depth) } }
          : {
              class: "cm-blockquote",
              // Quotes are boxes too (myne#394) — same role, same theme control.
              //
              // The block's extent is read off `depthByLine` rather than from a
              // node: this loop is per-line by construction, and a quote's
              // neighbours are exactly the lines the same walk recorded. A line
              // whose predecessor is not quoted starts the box; one whose
              // successor is not quoted ends it. Without that, a theme selecting
              // a frame drew one around every line of the quote.
              attributes: {
                style: blockquoteBarStyle(depth),
                ...ornamentSegment(
                  lineNo,
                  depthByLine.has(lineNo - 1) ? lineNo - 1 : lineNo,
                  depthByLine.has(lineNo + 1) ? lineNo + 1 : lineNo,
                ),
              },
            },
      ).range(line.from),
    );
  }
  for (const { from: f, to: t } of markHides) {
    // Skip marker-hides on code-block AND table lines: the away-state card /
    // table block-replaces the block (an inline replace would overlap the
    // block-replace); on-cursor the markers reveal anyway.
    const markLine = view.state.doc.lineAt(f).number;
    if (codeLines.has(markLine) || tableLines.has(markLine)) continue;
    decorations.push(Decoration.replace({}).range(f, t));
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
