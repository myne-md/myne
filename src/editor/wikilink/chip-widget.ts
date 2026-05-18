// Wikilink chip widget for the Phase 1 editor.
//
// PRD `editor-mvp-baseline` stories 11–21. The dialect's lezer parser
// (`src/dialect/lezer/wikilink.ts`) names the Wikilink range with children
// `WikilinkMark` (`[[`, `|`, `#`, `^`, `]]`), `WikilinkTarget`,
// `WikilinkAlias`, `WikilinkHeading`, `WikilinkBlockId`. Forms recognized:
//
//   [[Target]]                            → chip text = "Target"
//   [[Target|Display]]                    → chip text = "Display"
//   [[Target#Heading]]                    → chip text = "Target › Heading"
//   [[Target^block-id]]                   → chip text = "Target" (^ ignored)
//   ![[Target]] / ![[image.png]]          → chip text = "Embed: Target"
//
// The chip is rendered via `Decoration.replace` with `atomic: true`. The
// range is registered with `EditorView.atomicRanges` so cursor / selection /
// Backspace treat the whole `[[...]]` (or `![[...]]`) span as a single atom.
//
// Penpot reference: `flow--editor-baseline` Section C — 8 chip variants
// (default / hover / focus-adjacent / alias / heading-anchored / embed-note /
// embed-image / adjacent atomicity).

import { syntaxTree } from "@codemirror/language";
import {
  type EditorState,
  type Extension,
  type Range,
  RangeSet,
  RangeSetBuilder,
} from "@codemirror/state";
import {
  Decoration,
  type DecorationSet,
  EditorView,
  ViewPlugin,
  type ViewUpdate,
  WidgetType,
} from "@codemirror/view";

export type WikilinkParts = {
  isEmbed: boolean;
  target: string | null;
  alias: string | null;
  heading: string | null;
};

export function parseWikilinkParts(
  state: EditorState,
  wikilinkFrom: number,
  wikilinkTo: number,
): WikilinkParts {
  const result: WikilinkParts = {
    isEmbed: false,
    target: null,
    alias: null,
    heading: null,
  };
  const firstChar = state.doc.sliceString(wikilinkFrom, wikilinkFrom + 1);
  if (firstChar === "!") {
    result.isEmbed = true;
  }
  syntaxTree(state).iterate({
    from: wikilinkFrom,
    to: wikilinkTo,
    enter: (node) => {
      if (node.name === "WikilinkTarget") {
        result.target = state.doc.sliceString(node.from, node.to);
      } else if (node.name === "WikilinkAlias") {
        result.alias = state.doc.sliceString(node.from, node.to);
      } else if (node.name === "WikilinkHeading") {
        result.heading = state.doc.sliceString(node.from, node.to);
      }
    },
  });
  return result;
}

export function chipDisplayText(parts: WikilinkParts): string {
  if (parts.alias !== null && parts.alias !== "") {
    return parts.isEmbed ? `Embed: ${parts.alias}` : parts.alias;
  }
  if (parts.isEmbed) {
    return `Embed: ${parts.target ?? ""}`;
  }
  if (parts.heading !== null && parts.heading !== "") {
    return `${parts.target ?? ""} › ${parts.heading}`;
  }
  return parts.target ?? "";
}

export class WikilinkChipWidget extends WidgetType {
  constructor(
    private readonly display: string,
    private readonly isEmbed: boolean,
  ) {
    super();
  }
  eq(other: WikilinkChipWidget): boolean {
    return other.display === this.display && other.isEmbed === this.isEmbed;
  }
  toDOM(): HTMLElement {
    const span = document.createElement("span");
    span.className = this.isEmbed
      ? "cm-wikilink-chip cm-wikilink-chip-embed"
      : "cm-wikilink-chip";
    span.setAttribute("role", "link");
    span.textContent = this.display;
    return span;
  }
  ignoreEvent(): boolean {
    return false;
  }
}

function buildWikilinkChipDecorations(state: EditorState, ranges: ReadonlyArray<{ from: number; to: number }>): DecorationSet {
  const decorations: Array<Range<Decoration>> = [];
  for (const { from, to } of ranges) {
    syntaxTree(state).iterate({
      from,
      to,
      enter: (node) => {
        if (node.name !== "Wikilink") return undefined;
        const parts = parseWikilinkParts(state, node.from, node.to);
        const display = chipDisplayText(parts);
        decorations.push(
          Decoration.replace({
            widget: new WikilinkChipWidget(display, parts.isEmbed),
          }).range(node.from, node.to),
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

// Cached atomic-range RangeSet keyed by the syntax tree reference. The
// tree is reference-stable across non-doc transactions, so cursor moves
// hit the cache instead of re-walking the full document on every
// selection change.
const atomicRangesCache = new WeakMap<
  ReturnType<typeof syntaxTree>,
  ReturnType<RangeSetBuilder<Decoration>["finish"]>
>();

function cachedWikilinkAtomicRanges(view: EditorView) {
  const tree = syntaxTree(view.state);
  const cached = atomicRangesCache.get(tree);
  if (cached !== undefined) return cached;
  const ranges: Array<Range<Decoration>> = [];
  tree.iterate({
    from: 0,
    to: view.state.doc.length,
    enter: (node) => {
      if (node.name === "Wikilink") {
        ranges.push(Decoration.replace({}).range(node.from, node.to));
        return false;
      }
      return undefined;
    },
  });
  const builder = new RangeSetBuilder<Decoration>();
  ranges.sort((a, b) => a.from - b.from);
  for (const r of ranges) builder.add(r.from, r.to, r.value);
  const finished = builder.finish();
  atomicRangesCache.set(tree, finished);
  return finished;
}

export function wikilinkChipExtensions(): readonly Extension[] {
  return [
    ViewPlugin.fromClass(
      class {
        decorations: DecorationSet;
        constructor(view: EditorView) {
          this.decorations = buildWikilinkChipDecorations(
            view.state,
            view.visibleRanges,
          );
        }
        update(update: ViewUpdate) {
          if (update.docChanged || update.viewportChanged) {
            this.decorations = buildWikilinkChipDecorations(
              update.state,
              update.view.visibleRanges,
            );
          }
        }
      },
      { decorations: (v) => v.decorations },
    ),
    // Atomic-range registration: any range covered by the chip decoration
    // counts as one indivisible unit for cursor / selection / backspace.
    EditorView.atomicRanges.of(cachedWikilinkAtomicRanges),
  ];
}

// Test-friendly export: given a state + range, return the atomic-range set
// directly (used by atomic-range.test.ts to assert ranges without mounting
// a view).
export function wikilinkAtomicRanges(state: EditorState): RangeSet<Decoration> {
  const ranges: Array<Range<Decoration>> = [];
  syntaxTree(state).iterate({
    from: 0,
    to: state.doc.length,
    enter: (node) => {
      if (node.name === "Wikilink") {
        ranges.push(Decoration.replace({}).range(node.from, node.to));
        return false;
      }
      return undefined;
    },
  });
  const builder = new RangeSetBuilder<Decoration>();
  ranges.sort((a, b) => a.from - b.from);
  for (const r of ranges) builder.add(r.from, r.to, r.value);
  return builder.finish();
}
