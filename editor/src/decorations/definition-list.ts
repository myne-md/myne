// Definition-list decoration (`Term \n : Definition`) for the Phase 1 editor.
//
// PRD `editor-mvp-ref-and-block-rendering` (MYND-152). Keys off the custom
// `DefinitionList` node produced by `src/dialect/lezer/definition-list.ts`
// (term + `DefinitionMarker` (`:`) + `DefinitionDesc` children). The GFM grammar
// does not parse this form — the node only exists because of that parser
// extension, registered in both `parser.ts` and the editor's `markdown({…})`.
//
// Off-line: style the term (`.cm-def-term`) and indent each definition row
// (`.cm-def-desc`, via theme), and hide the leading `: ` marker. The marker hide
// is WITHIN a line, so this is a plain cursor-aware `ViewPlugin` (no line-break
// crossing → no StateField needed, unlike setext / reference-definition hiding).
// On-line: the reveal is whole-list-scoped — the cursor on ANY line of the list
// shows every raw `: ` marker for editing.
//
// Penpot reference: `flow--editor-ref-and-block` Section E — definition-lists row.

import { syntaxTree } from "@codemirror/language";
import { type Extension, type Range, RangeSetBuilder } from "@codemirror/state";
import {
  Decoration,
  type DecorationSet,
  EditorView,
} from "@codemirror/view";
import { isCursorLine } from "./cursor-aware";
import { makeCursorAwareDecorationPlugin } from "./plugin-factory";

function buildDefinitionListDecorations(view: EditorView): DecorationSet {
  const lineDecorations: Array<Range<Decoration>> = [];
  const markHides: Array<Range<Decoration>> = [];

  for (const { from, to } of view.visibleRanges) {
    syntaxTree(view.state).iterate({
      from,
      to,
      enter: (node) => {
        if (node.name !== "DefinitionList") return undefined;
        // Whole-list reveal: cursor on any line of the list shows all markers.
        const revealed = isCursorLine(view, node.from, node.to);

        let child = node.node.firstChild;
        let pendingMarker: { from: number; to: number } | null = null;
        while (child !== null) {
          if (child.name === "DefinitionTerm") {
            lineDecorations.push(
              Decoration.line({ class: "cm-def-term" }).range(
                view.state.doc.lineAt(child.from).from,
              ),
            );
          } else if (child.name === "DefinitionMarker") {
            pendingMarker = { from: child.from, to: child.to };
          } else if (child.name === "DefinitionDesc") {
            lineDecorations.push(
              Decoration.line({ class: "cm-def-desc" }).range(
                view.state.doc.lineAt(child.from).from,
              ),
            );
            if (pendingMarker !== null && !revealed) {
              // Hide the `:` plus the whitespace up to the description start
              // (`child.from`). For a bare `:` (empty definition), that range is
              // just the colon.
              markHides.push(
                Decoration.replace({}).range(pendingMarker.from, child.from),
              );
            }
            pendingMarker = null;
          }
          child = child.nextSibling;
        }
        return false;
      },
    });
  }

  const decorations = [...lineDecorations, ...markHides];
  decorations.sort((a, b) => {
    if (a.from !== b.from) return a.from - b.from;
    return (a.value.spec.side ?? 0) - (b.value.spec.side ?? 0);
  });
  const builder = new RangeSetBuilder<Decoration>();
  for (const d of decorations) builder.add(d.from, d.to, d.value);
  return builder.finish();
}

export function definitionListDecorations(): Extension {
  return makeCursorAwareDecorationPlugin(buildDefinitionListDecorations);
}
