// Inline #tag chip decoration (tag-system #3 / MYND-45). The SYNC-17-coupled
// half of the interactive-tag unit: renders each inline `#tag` (the `InlineTag`
// lezer node) as a clickable chip when the cursor is elsewhere, and as RAW,
// editable text when the cursor is inside it — so typing / extending a tag is
// unhindered (`#proj` → `#project` keeps editing). Clicking a chip dispatches a
// `myne-open-tag` DOM event that the Editor relays to open the tag browser (#2)
// filtered to that one tag.
//
// Recognize-only / §6 C1: purely visual — the chip label is the LITERAL source
// text, never a rewrite of the buffer. Exclusion zones (code / wikilink interior
// / HTML / YAML frontmatter) are parser-enforced — the `InlineTag` node only
// exists outside them, so iterating the node is sufficient. The shared pill look
// (`.cm-tag-chip`, theme.ts) is the TS-5 token, identical to the browser's rows.
//
// This decoration is registered in `decorations/index.ts` ONLY because the tag
// browse surface (#2) now exists — SYNC-17: decoration never ships without browse.

import { syntaxTree } from "@codemirror/language";
import {
  type EditorState,
  type Extension,
  type Range,
  RangeSetBuilder,
} from "@codemirror/state";
import {
  Decoration,
  type DecorationSet,
  EditorView,
  WidgetType,
} from "@codemirror/view";
import { isInsideRange } from "./cursor-aware";
import { makeCursorAwareDecorationPlugin } from "./plugin-factory";

class TagChipWidget extends WidgetType {
  constructor(private readonly label: string) {
    super();
  }
  eq(other: TagChipWidget): boolean {
    return other.label === this.label;
  }
  toDOM(): HTMLElement {
    const span = document.createElement("span");
    span.className = "cm-tag-chip";
    span.setAttribute("role", "link");
    span.setAttribute("data-testid", "editor.tag-chip");
    span.textContent = this.label; // literal "#tag" — byte-stable display
    return span;
  }
  ignoreEvent(): boolean {
    return false;
  }
}

/** The tag BODY (no leading `#`) of the `InlineTag` node covering `pos`, or null
 *  if none — what `byTag`/`foldSegment` consume. The DOM→pos→tag bridge for the
 *  click handler, split out so it's unit-testable without layout. */
export function inlineTagBodyAt(state: EditorState, pos: number): string | null {
  let body: string | null = null;
  syntaxTree(state).iterate({
    from: pos,
    to: pos + 1,
    enter: (node) => {
      if (node.name !== "InlineTag") return undefined;
      body = state.doc.sliceString(node.from + 1, node.to); // strip "#"
      return false;
    },
  });
  return body;
}

/** Replace each off-cursor `InlineTag` with a chip; leave the tag the cursor is
 *  inside raw (editable). Exported for unit testing. */
export function buildTagChipDecorations(view: EditorView): DecorationSet {
  const decorations: Array<Range<Decoration>> = [];
  for (const { from, to } of view.visibleRanges) {
    syntaxTree(view.state).iterate({
      from,
      to,
      enter: (node) => {
        if (node.name !== "InlineTag") return undefined;
        if (isInsideRange(view, node.from, node.to)) return false; // editing it
        const label = view.state.doc.sliceString(node.from, node.to);
        decorations.push(
          Decoration.replace({ widget: new TagChipWidget(label) }).range(
            node.from,
            node.to,
          ),
        );
        return false;
      },
    });
  }
  const builder = new RangeSetBuilder<Decoration>();
  decorations.sort((a, b) => a.from - b.from);
  for (const d of decorations) builder.add(d.from, d.to, d.value);
  return builder.finish();
}

/** Off-cursor chipped `#tag` ranges, atomic so arrow / backspace treat each as
 *  one unit (the cursor-touched tag stays non-atomic so it can be edited).
 *  Scoped to `visibleRanges` to MATCH `buildTagChipDecorations` — off-screen
 *  tags render as raw text (no chip), so they must not be atomic either; this
 *  also bounds the per-selection-change walk to the viewport. */
function tagAtomicRanges(view: EditorView) {
  const ranges: Array<Range<Decoration>> = [];
  for (const { from, to } of view.visibleRanges) {
    syntaxTree(view.state).iterate({
      from,
      to,
      enter: (node) => {
        if (node.name !== "InlineTag") return undefined;
        if (isInsideRange(view, node.from, node.to)) return false;
        ranges.push(Decoration.replace({}).range(node.from, node.to));
        return false;
      },
    });
  }
  const builder = new RangeSetBuilder<Decoration>();
  ranges.sort((a, b) => a.from - b.from);
  for (const r of ranges) builder.add(r.from, r.to, r.value);
  return builder.finish();
}

export function tagChipDecorations(): readonly Extension[] {
  return [
    makeCursorAwareDecorationPlugin(buildTagChipDecorations),
    EditorView.atomicRanges.of(tagAtomicRanges),
    // Click-to-browse: a tag chip dispatches `myne-open-tag` with the tag body
    // (no leading `#` — what `byTag`/`foldSegment` consume). The Editor relays it
    // to open the tag browser filtered to that tag. Handled on `mousedown` +
    // `preventDefault` (the autolink pattern) so the click does NOT move the caret
    // into the tag — otherwise the caret lands on the tag boundary, which
    // `isInsideRange` counts as inside, and the cursor-aware reveal flips the chip
    // to raw text instead of navigating. To EDIT a tag the user arrows in (which
    // reveals it) or deletes + retypes (autocomplete helps).
    EditorView.domEventHandlers({
      mousedown(event, view) {
        if (event.button !== 0) return false; // left-click only
        const target = event.target as HTMLElement | null;
        const chipEl = target?.closest?.(".cm-tag-chip") as HTMLElement | null;
        if (chipEl === null) return false;
        const tag = inlineTagBodyAt(view.state, view.posAtDOM(chipEl));
        if (tag === null) return false; // InlineTag always has ≥1 body char
        view.dom.dispatchEvent(
          new CustomEvent("myne-open-tag", { detail: { tag }, bubbles: true }),
        );
        event.preventDefault();
        return true;
      },
    }),
  ];
}
