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
import { parseAttachmentTarget } from "../../notes/attachmentRef";
import { readNoteSet } from "./note-set";
import {
  chipTitleKey,
  isBrokenKey,
  presentTitleKeys,
  resolveChipParts,
} from "./resolve-chip";
import { pickerActiveFromField } from "./picker";

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

/**
 * True iff a parsed wikilink is a form-C ATTACHMENT embed (`![[att:<id>|…]]`).
 * Those are rendered by `decorations/attachment-embed.ts` as an inline image /
 * PDF / tombstone, NOT by the text-chip widget here — so every walk in this
 * module skips them to avoid a double decoration on the same range. A malformed
 * `att:` target (not a valid id) is NOT an attachment embed; it falls through to
 * the ordinary embed chip (plain `Embed: att:…` text), which is the intended
 * broken-reference degradation.
 */
function isAttachmentEmbed(parts: WikilinkParts): boolean {
  return (
    parts.isEmbed &&
    parts.target !== null &&
    parseAttachmentTarget(parts.target) !== null
  );
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
    private readonly broken: boolean,
  ) {
    super();
  }
  eq(other: WikilinkChipWidget): boolean {
    return (
      other.display === this.display &&
      other.isEmbed === this.isEmbed &&
      other.broken === this.broken
    );
  }
  toDOM(): HTMLElement {
    const span = document.createElement("span");
    const classes = ["cm-wikilink-chip"];
    if (this.isEmbed) classes.push("cm-wikilink-chip-embed");
    // §5.3 broken-link styling: a non-embed wikilink with no matching note.
    if (this.broken) classes.push("cm-wikilink-chip-broken");
    span.className = classes.join(" ");
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
  // WL-5: the live note-set the chip resolves against for §5.3 broken styling.
  // Fold the note titles into a key set ONCE (not per chip) so each chip's
  // broken check is an O(1) lookup, not an O(notes) resolver scan.
  const presentKeys = presentTitleKeys(readNoteSet(state));
  // The `[[…]]` the `[[` picker is actively authoring — left as raw text.
  const activeFrom = state.field(pickerActiveFromField, false) ?? null;
  for (const { from, to } of ranges) {
    syntaxTree(state).iterate({
      from,
      to,
      enter: (node) => {
        if (node.name !== "Wikilink") return undefined;
        // The link the picker is authoring stays raw/editable (no chip).
        if (node.from === activeFrom) return false;
        const parts = parseWikilinkParts(state, node.from, node.to);
        // Form-C attachment embeds are rendered by attachment-embed.ts.
        if (isAttachmentEmbed(parts)) return false;
        // Empty `[[]]` is plain text on disk (§10) — never a chip.
        if ((parts.target ?? "") === "") return false;
        const display = chipDisplayText(parts);
        const broken = isBrokenKey(chipTitleKey(parts), presentKeys);
        decorations.push(
          Decoration.replace({
            widget: new WikilinkChipWidget(display, parts.isEmbed, broken),
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

// Cached atomic-range RangeSet keyed by the syntax tree reference (+ the picker's
// active node, which un-atomics the link being authored). The tree is
// reference-stable across non-doc transactions, so cursor moves hit the cache
// instead of re-walking the full document on every selection change.
const atomicRangesCache = new WeakMap<
  ReturnType<typeof syntaxTree>,
  { activeFrom: number | null; ranges: ReturnType<RangeSetBuilder<Decoration>["finish"]> }
>();

function cachedWikilinkAtomicRanges(view: EditorView) {
  const tree = syntaxTree(view.state);
  const activeFrom = view.state.field(pickerActiveFromField, false) ?? null;
  const cached = atomicRangesCache.get(tree);
  if (cached !== undefined && cached.activeFrom === activeFrom) return cached.ranges;
  const ranges: Array<Range<Decoration>> = [];
  tree.iterate({
    from: 0,
    to: view.state.doc.length,
    enter: (node) => {
      if (node.name === "Wikilink") {
        // Attachment embeds register their own atomic range in attachment-embed.ts;
        // an empty `[[]]` is plain text (§10) and the `[[` picker's active node is
        // raw/editable — none are atomic (the cursor edits them freely).
        if (node.from === activeFrom) return false;
        const parts = parseWikilinkParts(view.state, node.from, node.to);
        if (!isAttachmentEmbed(parts) && (parts.target ?? "") !== "") {
          ranges.push(Decoration.replace({}).range(node.from, node.to));
        }
        return false;
      }
      return undefined;
    },
  });
  const builder = new RangeSetBuilder<Decoration>();
  ranges.sort((a, b) => a.from - b.from);
  for (const r of ranges) builder.add(r.from, r.to, r.value);
  const finished = builder.finish();
  atomicRangesCache.set(tree, { activeFrom, ranges: finished });
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
          // Re-decorate on doc/viewport change, on a WL-5 note-set change (a note
          // created/renamed/deleted elsewhere flips a chip's broken/resolved
          // state live on the SYNC-5 nonce, WL-6), and when the picker's active
          // node changes (so the authored link un-chips on open / re-chips on
          // close).
          const noteSetChanged =
            readNoteSet(update.startState) !== readNoteSet(update.state);
          const activeChanged =
            update.startState.field(pickerActiveFromField, false) !==
            update.state.field(pickerActiveFromField, false);
          if (
            update.docChanged ||
            update.viewportChanged ||
            noteSetChanged ||
            activeChanged
          ) {
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
    // Click-to-navigate: clicking a RESOLVED chip resolves its target and emits
    // a `myne-open-wikilink` DOM event (CMEditor relays it to its `onOpenWikilink`
    // prop → the workspace opens the note). Broken chips do nothing (their target
    // doesn't exist). `click` (not `mousedown`) so drag-selection over the chip
    // still works (§5.2).
    EditorView.domEventHandlers({
      click(event, view) {
        const target = event.target as HTMLElement | null;
        const chipEl = target?.closest?.(".cm-wikilink-chip") as HTMLElement | null;
        if (chipEl === null || chipEl.classList.contains("cm-wikilink-chip-broken")) {
          return false;
        }
        const pos = view.posAtDOM(chipEl);
        let noteUuid: string | null = null;
        syntaxTree(view.state).iterate({
          from: pos,
          to: pos + 1,
          enter: (node) => {
            if (node.name !== "Wikilink") return undefined;
            const res = resolveChipParts(
              parseWikilinkParts(view.state, node.from, node.to),
              readNoteSet(view.state),
            );
            if (res !== null && res.status === "resolved") noteUuid = res.noteUuid;
            return false;
          },
        });
        if (noteUuid === null) return false;
        view.dom.dispatchEvent(
          new CustomEvent("myne-open-wikilink", {
            detail: { noteUuid },
            bubbles: true,
          }),
        );
        return true;
      },
    }),
  ];
}

// Test-friendly export: given a state + range, return the atomic-range set
// directly (used by atomic-range.test.ts to assert ranges without mounting
// a view).
export function wikilinkAtomicRanges(state: EditorState): RangeSet<Decoration> {
  const ranges: Array<Range<Decoration>> = [];
  const activeFrom = state.field(pickerActiveFromField, false) ?? null;
  syntaxTree(state).iterate({
    from: 0,
    to: state.doc.length,
    enter: (node) => {
      if (node.name === "Wikilink") {
        if (node.from === activeFrom) return false;
        const parts = parseWikilinkParts(state, node.from, node.to);
        if (!isAttachmentEmbed(parts) && (parts.target ?? "") !== "") {
          ranges.push(Decoration.replace({}).range(node.from, node.to));
        }
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
