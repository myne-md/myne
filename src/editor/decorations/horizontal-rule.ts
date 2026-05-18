// Horizontal rule decoration (`---` / `***` / `___` on their own line)
// for the Phase 1 editor.
//
// PRD `editor-mvp-baseline` story 27. The @lezer/markdown grammar names
// this node `HorizontalRule`. We replace the `---` line with an `<hr>`
// widget when the cursor is NOT on the line; otherwise show source.

import { syntaxTree } from "@codemirror/language";
import { type Extension, type Range, RangeSetBuilder } from "@codemirror/state";
import {
  Decoration,
  type DecorationSet,
  EditorView,
  WidgetType,
} from "@codemirror/view";
import { cachedLocateFrontmatter } from "../frontmatter-cache";
import { isCursorLine } from "./cursor-aware";
import { makeCursorAwareDecorationPlugin } from "./plugin-factory";

class HorizontalRuleWidget extends WidgetType {
  toDOM(): HTMLElement {
    const span = document.createElement("span");
    span.className = "cm-hr";
    span.setAttribute("aria-hidden", "true");
    return span;
  }
  eq(): boolean {
    return true;
  }
  ignoreEvent(): boolean {
    return true;
  }
}

function buildHorizontalRuleDecorations(view: EditorView): DecorationSet {
  const decorations: Array<Range<Decoration>> = [];

  // Suppress hr decoration on `---` lines that belong to a line-1-anchored
  // YAML frontmatter block — those are handled by `frontmatter.ts`. Without
  // this guard, @lezer/markdown sees the leading `---` as a HorizontalRule
  // (it has no frontmatter awareness), producing a competing `<hr>` widget
  // that visually breaks the frontmatter styled block.
  const fmRange = cachedLocateFrontmatter(view.state.doc);

  for (const { from, to } of view.visibleRanges) {
    syntaxTree(view.state).iterate({
      from,
      to,
      enter: (node) => {
        if (node.name !== "HorizontalRule") return undefined;
        if (
          fmRange !== null &&
          node.from < fmRange.blockEnd &&
          node.to <= fmRange.blockEnd
        ) {
          return undefined;
        }
        if (!isCursorLine(view, node.from, node.to)) {
          decorations.push(
            Decoration.replace({
              widget: new HorizontalRuleWidget(),
              block: false,
            }).range(node.from, node.to),
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

export function horizontalRuleDecorations(): Extension {
  return makeCursorAwareDecorationPlugin(buildHorizontalRuleDecorations);
}
