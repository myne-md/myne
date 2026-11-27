// Form-C attachment-embed rendering for the Phase 1 editor (epic MYND-164,
// sub-feature editor-image-embeds, stories 1 / 2 / 3 / 6).
//
// Form C is `![[att:<id>|filename]]` — a wikilink EMBED whose target carries the
// `att:` scheme prefix. The dialect parser (`src/dialect/lezer/wikilink.ts`)
// already emits a `Wikilink` node with `WikilinkTarget` / `WikilinkAlias`
// children; this module recognizes the embeds whose target parses as an
// attachment ref (`parseAttachmentTarget`), resolves the id against the loaded
// catalog (`catalog.ts`), and replaces the whole span with an ATOMIC chip →
// inline image / PDF / tombstone.
//
// Interaction model (grill 2026-06-07 Q1): STRICT ATOMIC, no source-lift on
// cursor entry. Backspace / forward-delete removes the whole embed; arrows skip
// over it; the raw `att:<hash>` token is never exposed in the note. This reuses
// the SAME `EditorView.atomicRanges` mechanism the wikilink chip uses — but the
// chip widget here renders the resolved attachment instead of a text chip.
//
// IMPORTANT: this decorator handles ONLY attachment embeds (target starts with
// `att:`). Ordinary wikilink embeds (`![[Note]]`) stay owned by
// `wikilink/chip-widget.ts`, which already skips nothing — so to avoid a
// double-decoration on the same range, the wikilink chip builder is taught (via
// `isAttachmentEmbedNode`) to defer attachment embeds to this module.

import { syntaxTree } from "@codemirror/language";
import {
  type EditorState,
  type Extension,
  type Range,
  RangeSetBuilder,
  StateField,
  type Transaction,
} from "@codemirror/state";
import {
  Decoration,
  type DecorationSet,
  EditorView,
  ViewPlugin,
  type ViewUpdate,
  WidgetType,
} from "@codemirror/view";
import { LineHeightWidget } from "../widget-line-coords";
import type { SyntaxNode } from "@lezer/common";
import { parseAttachmentTarget } from "@myne/editor/host/notes/attachmentRef";
import { parseEmbedAlias } from "@myne/dialect/embedLayout";
import { parseWikilinkParts } from "../wikilink/chip-widget";
import {
  catalogChanged,
  catalogField,
  type CatalogState,
  resolveCatalog,
} from "../attachments/catalog";
import {
  AttachmentTombstoneWidget,
  makeResolvedWidget,
} from "../attachments/widgets";

/** The attachment id of an embed `Wikilink` node, or `null` if the node is not
 *  an attachment embed (not an embed, or target lacks a valid `att:` id). */
function attachmentEmbedId(state: EditorState, node: SyntaxNode): string | null {
  const parts = parseWikilinkParts(state, node.from, node.to);
  if (!parts.isEmbed || parts.target === null) return null;
  return parseAttachmentTarget(parts.target);
}

/** True iff this `Wikilink` node is a form-C attachment embed. Exported so the
 *  wikilink chip builder can defer these ranges to THIS module (no double
 *  decoration). */
export function isAttachmentEmbedNode(
  state: EditorState,
  node: SyntaxNode,
): boolean {
  return attachmentEmbedId(state, node) !== null;
}

/** True iff the range `[from, to)` overlaps any attachment-embed `Wikilink`
 *  node. An attachment embed is rendered as an atomic widget — `atomicRanges`
 *  stops the *caret* entering it, but a mouse-drag selection can still span it,
 *  and the inline-format commands operate on the raw `![[att:…]]` source. This
 *  predicate lets `toggleWrap` (and the selection toolbar) treat an embed as
 *  non-formattable: you cannot bold/italic/strike an image or PDF. Any overlap
 *  (full or partial) counts; a selection that merely abuts an embed edge does
 *  not. */
export function rangeOverlapsAttachmentEmbed(
  state: EditorState,
  from: number,
  to: number,
): boolean {
  let overlaps = false;
  syntaxTree(state).iterate({
    from,
    to,
    enter: (node) => {
      if (node.name !== "Wikilink") return undefined;
      // Real overlap (not a bare edge touch) with an attachment embed.
      if (node.from < to && node.to > from && isAttachmentEmbedNode(state, node.node)) {
        overlaps = true;
        return false;
      }
      return undefined;
    },
  });
  return overlaps;
}

/**
 * Whether an embed spanning `[from, to)` is the only thing on its line, so it is
 * drawn as a block taking the whole line (myne-md/myne#604).
 *
 * Two things follow from drawing it that way, and the second is why this is a
 * fix rather than a preference.
 *
 * **It reads right.** An embed is a figure, not a word. Sharing a line box with
 * prose makes the line as tall as the image, and inside a task item that leaves
 * the checkbox stranded at the top-left of a 240px picture, because the hanging
 * indent applies to a line box that is now enormous.
 *
 * **It is measurably steadier.** Typing one character in a line rebuilds that
 * line's content, widget DOM included, whatever `eq()` says. Probed in Chromium
 * against the real widget: the mid-line embed's frame comes back with a new
 * identity on every keystroke, while an embed on its own line keeps its DOM
 * untouched. A block embed is therefore not re-created by typing at all.
 *
 * **Whitespace only, no list marker.** `  ![[att:…]]` under a task item is the
 * shape a pasted screenshot takes, and it qualifies. `- ![[att:…]]` does not:
 * the block decoration would have to cover the whole line, which would swallow
 * the marker and un-list the item. That one stays inline, where the aspect-ratio
 * reservation in `AttachmentImageWidget` keeps it from flashing.
 */
export function embedIsAlone(state: EditorState, from: number, to: number): boolean {
  const line = state.doc.lineAt(from);
  if (to > line.to) return false;
  // Scanned rather than compared as strings. `line.text.trim() ===
  // sliceString(from, to)` reads better and copies twice per candidate embed per
  // builder per rebuild: the whole line, and the 50-to-80 characters of
  // `![[att:<64 hex>|name.png|w=400]]`. This asks the same question of offsets
  // that are already in hand.
  const start = from - line.from;
  const end = to - line.from;
  for (let i = 0; i < line.text.length; i += 1) {
    if (i >= start && i < end) continue;
    const ch = line.text[i]!;
    if (ch !== " " && ch !== "\t") return false;
  }
  return true;
}

/**
 * One attachment embed, resolved to the widget that draws it.
 *
 * Shared by the inline builder and the block field, which are otherwise a
 * copy of each other: same `Wikilink` filter, same parse chain, same
 * resolved-versus-tombstone decision. Keeping two copies meant the reasoning
 * below lived on one of them, and a change to how an unresolved embed renders
 * would land on one branch with nothing to say the other existed.
 *
 * `null` for a node that is not a form-C attachment embed, which the wikilink
 * chip owns instead.
 */
function resolveEmbedNode(
  state: EditorState,
  catalog: CatalogState,
  node: { from: number; to: number },
  block: boolean,
): WidgetType | null {
  // ONE walk per embed per rebuild. `attachmentEmbedId` + `embedAlias` each ran
  // `parseWikilinkParts` over the same node, so the tree was iterated and the
  // alias sliced twice on a path that re-runs on every document and viewport
  // change.
  const parts = parseWikilinkParts(state, node.from, node.to);
  const id =
    parts.isEmbed && parts.target !== null ? parseAttachmentTarget(parts.target) : null;
  if (id === null) return null; // not an attachment embed, left to the wikilink chip
  const { filename, layout, dropped } = parseEmbedAlias(parts.alias ?? "");

  const resolution = resolveCatalog(catalog, id);
  if (resolution.kind === "resolved") {
    return makeResolvedWidget(resolution.row, layout, dropped, block);
  }
  // Either a DELETED attachment (`kind === "deleted"`: a syntactically valid id
  // absent from a loaded catalog, so it once existed) OR the catalog still
  // loading. Both render the deleted tombstone's neutral frame: it's the correct
  // end-state for a deletion, and using it while loading avoids a flicker (the
  // alternative, a 404'ing `<img>`, would flash broken-image until the catalog
  // arrives and a real image/tombstone widget replaces it). A malformed `att:`
  // target (a "broken" reference) never reaches here: `parseAttachmentTarget`
  // rejects it, so the raw `![[…]]` stays plain (wikilink chip renders).
  return new AttachmentTombstoneWidget("deleted", filename);
}

/**
 * The measured box around a whole-line embed (myne-md/myne#990).
 *
 * # Why a wrapper at all
 *
 * A block widget's DOM IS the box CodeMirror measures, and the measurement is a
 * `getBoundingClientRect()`, which does not include MARGINS. So the 3px/10px
 * block rhythm these cards carry rendered as 13px per embed that the height map
 * never learned about. The error is cumulative and in one direction, and it was
 * measured twice against Chromium: a synthetic theme with five block widgets
 * drifted 13px each and `posAtCoords` landed up to three rows below the pointer;
 * this real extension, in a 22-line note with two embeds, painted 37px more than
 * CodeMirror believed and put twenty painted rows on doc lines
 * 1..8, 10, 11, 13, 13, 15, 16, 16, 18, 21, 22, 22, 22: two rows sharing a doc
 * line and three sharing another, which is also how a selection ends up
 * highlighting a row nobody dragged over. `theme.ts`'s `.cm-math-block` records
 * the same defect being fixed for math, mermaid, tables and embedded HTML; this
 * family was missed.
 *
 * Padding is inside the measured box, so the same rhythm expressed as padding is
 * counted. It cannot go on the cards themselves: three of them have a hairline
 * border and a surface, so padding would grow the visible card instead of the
 * space around it. Hence one wrapper that owns the vertical rhythm, and the card
 * loses its margin while it lives inside it (`.cm-attachment-block` rules in
 * `theme.ts`).
 *
 * # What it delegates, and what it deliberately does not
 *
 * `eq()` compares the inner widget by class first: every widget here implements
 * `eq` against its own fields, so asking one to compare itself with a different
 * class is not a question it can answer. `destroy` and `ignoreEvent` are the
 * inner widget's, handed the inner DOM.
 *
 * `estimatedHeight` is NOT adjusted for the wrapper's padding. That would put a
 * second copy of the 13px in TypeScript where the stylesheet already owns it, and
 * the estimate exists only until the first measure corrects it.
 */
class BlockEmbedFrame extends LineHeightWidget {
  /** Whether the caret's line is this embed's, as the field last built it. */
  private active: boolean;

  constructor(private readonly inner: WidgetType, active: boolean) {
    super();
    this.active = active;
  }

  /** `active` IS compared: two decorations that compare equal are the same one to
   *  CodeMirror, which then never re-reads the tile and never calls
   *  {@link updateDOM}. The comparison costs a DOM reuse, not a rebuild. */
  eq(other: BlockEmbedFrame): boolean {
    return (
      this.active === other.active &&
      other.inner.constructor === this.inner.constructor &&
      this.inner.eq(other.inner)
    );
  }

  updateDOM(dom: HTMLElement): boolean {
    // The OLD dom handed to the NEW widget: keeping it is only right while the
    // widget inside is still the same one (a resolved tombstone must be redrawn).
    if (dom.dataset.embedWidget !== this.inner.constructor.name) return false;
    dom.classList.toggle("cm-embed-active", this.active);
    return true;
  }

  get estimatedHeight(): number {
    return this.inner.estimatedHeight;
  }

  toDOM(view: EditorView): HTMLElement {
    const wrap = document.createElement("div");
    // A block replace covers its whole LINE, so CodeMirror draws this wrapper
    // where the line's element would be and a line decoration has nothing to land
    // on: the class lives here, from the flag the set was built with.
    wrap.className = this.active
      ? "cm-attachment-block cm-embed-active"
      : "cm-attachment-block";
    wrap.dataset.embedWidget = this.inner.constructor.name;
    wrap.appendChild(this.inner.toDOM(view));
    return wrap;
  }

  destroy(dom: HTMLElement): void {
    // The inner widget's teardown is written against ITS dom (the card), not this
    // wrapper: an overflow menu and the resize handles both hang their window
    // listeners off it. Falling back to the wrapper rather than skipping keeps a
    // widget that returned something unexpected from leaking its listeners for as
    // long as the view lives.
    const inner = dom.firstElementChild;
    this.inner.destroy(inner instanceof HTMLElement ? inner : dom);
  }

  ignoreEvent(event: Event): boolean {
    return this.inner.ignoreEvent(event);
  }
}

function buildAttachmentEmbedDecorations(
  state: EditorState,
  catalog: CatalogState,
  ranges: readonly { from: number; to: number }[],
): DecorationSet {
  const decorations: Array<Range<Decoration>> = [];
  for (const { from, to } of ranges) {
    syntaxTree(state).iterate({
      from,
      to,
      enter: (node) => {
        if (node.name !== "Wikilink") return undefined;
        // Tested BEFORE the widget is built, not after. Block embeds are not
        // this plugin's to draw: CodeMirror refuses a block decoration from a
        // ViewPlugin outright ("Block decorations may not be specified via
        // plugins"), because their height has to be known outside the viewport.
        // They come from `blockEmbedField` below. The first version parsed the
        // node and constructed a widget before discovering that, so every block
        // embed cost an allocation nothing ever painted, on every doc and
        // viewport change.
        if (embedIsAlone(state, node.from, node.to)) return false;
        const widget = resolveEmbedNode(state, catalog, node, false);
        if (widget === null) return false;
        decorations.push(
          Decoration.replace({ widget, atomic: true }).range(node.from, node.to),
        );
        return false;
      },
    });
  }
  // Sorted because `ranges` is several viewport ranges walked in turn, so nodes
  // do not arrive in document order across the outer loop. The block field's
  // single whole-document walk needs no sort and does not do one.
  const builder = new RangeSetBuilder<Decoration>();
  decorations.sort((a, b) => a.from - b.from);
  for (const d of decorations) builder.add(d.from, d.to, d.value);
  return builder.finish();
}

// Cached atomic-range set keyed by syntax tree — same pattern as the wikilink
// chip's `cachedWikilinkAtomicRanges`, so cursor moves hit the cache instead of
// re-walking the document. Covers ONLY attachment embeds (ordinary wikilinks are
// already covered by the wikilink extension's own atomicRanges).
const atomicCache = new WeakMap<
  ReturnType<typeof syntaxTree>,
  ReturnType<RangeSetBuilder<Decoration>["finish"]>
>();

function cachedAttachmentAtomicRanges(view: EditorView) {
  const tree = syntaxTree(view.state);
  const cached = atomicCache.get(tree);
  if (cached !== undefined) return cached;
  const ranges: Array<Range<Decoration>> = [];
  tree.iterate({
    from: 0,
    to: view.state.doc.length,
    enter: (node) => {
      if (node.name === "Wikilink") {
        if (isAttachmentEmbedNode(view.state, node.node)) {
          // The atomic range has to cover what the DECORATION replaces, not
          // what the node spans. A block embed replaces the whole line, indent
          // included, so on `  ![[att:…]]` the two leading spaces sat inside a
          // replaced, unrendered span that no atomic range protected: the caret
          // could be put at an offset with no rendered coordinates, which is
          // the same class `frontmatter.ts` is fixing one file over. The block
          // half accepts an indented line deliberately (`embedIsAlone` ignores
          // whitespace), so this is exactly the case that reaches it.
          const line = view.state.doc.lineAt(node.from);
          const block = embedIsAlone(view.state, node.from, node.to);
          ranges.push(
            Decoration.replace({}).range(
              block ? line.from : node.from,
              block ? line.to : node.to,
            ),
          );
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
  atomicCache.set(tree, finished);
  return finished;
}

/**
 * The block half, over the WHOLE document rather than the viewport.
 *
 * A `StateField` and not a `ViewPlugin`, and that is CodeMirror's rule rather
 * than a preference: a block decoration supplied by a plugin throws "Block
 * decorations may not be specified via plugins" at construction. The reason is
 * height. The scroller sizes itself from decorations outside the viewport too,
 * so a block whose existence depended on being scrolled into view would make the
 * document's height a function of where you had already scrolled.
 *
 * The cost is a whole-document walk where the inline half walks the viewport.
 * Bounded by the same syntax tree everything else here reads, incremental
 * between keystrokes, and only run when the document, the tree or the catalog
 * actually moved.
 */
/**
 * Whether this transaction provably cannot change the block-embed set, so the
 * whole-document walk can be skipped.
 *
 * The walk's trigger set is already minimal: the document, the syntax tree and
 * the catalog are its only three inputs and there is no fourth. But `docChanged`
 * fires on every keystroke, and the WORK per trigger is a full descent into
 * every node in the document with a `parseWikilinkParts` on each `Wikilink`. A
 * note with no embeds in it at all pays that on every character typed.
 *
 * Memoising it the way `atomicCache` below memoises is not available:
 * `syntaxTree(state)` returns a NEW tree object after any document change, so a
 * tree-keyed `WeakMap` misses on exactly the path that hurts.
 *
 * So this is a proof rather than a cache, and it is deliberately narrow. Three
 * conditions, and each one closes a way the set could have moved:
 *
 *   - nothing is drawn as a block right now, so there is no existing decoration
 *     for an edit to invalidate;
 *   - the transaction only INSERTS (`empty` on the old side), so no existing
 *     embed can have been deleted or truncated;
 *   - the inserted text contains no `[`, `]` or newline, so it can neither
 *     complete an `![[…]]` that was half-written nor split a line and leave an
 *     embed alone on one of the halves.
 *
 * Ordinary prose typing satisfies all three, which is the case worth having.
 *
 * # The `value.size !== 0` arm, and what it actually costs
 *
 * That first clause means the skip is unavailable the moment a note contains
 * one block embed, so the optimisation is present in the case that needs it
 * least. Review flagged that as an availability risk, which is the right thing
 * to ask and the wrong thing to assume, so it was measured rather than argued.
 *
 * Per keystroke at the end of a 2000-line note, in the composed editor under
 * jsdom, averaged over 30 dispatches: 20.17 ms with no embed, 20.33 ms with one
 * block embed, 20.84 ms with twenty. So the un-skippable whole-document walk
 * adds 0.16 ms against a 20 ms baseline it does not dominate, and twenty embeds
 * add 0.67 ms. Under 1% either way, which is why the clause stays as it is.
 *
 * Keying the skip on something that survives a non-empty set (rebuild only when
 * a change touches a line the set covers, map the rest) is the shape that would
 * remove the walk entirely. It is not worth its own correctness surface for
 * 0.16 ms, and this note is here so the next reader does not have to re-derive
 * that trade from scratch.
 */
function unaffectedByPlainTyping(value: DecorationSet, tr: Transaction): boolean {
  if (value.size !== 0 || !tr.docChanged) return false;
  let safe = true;
  tr.changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => {
    if (!safe) return;
    if (fromA !== toA) {
      safe = false; // a deletion or a replacement, not plain typing
      return;
    }
    const text = inserted.toString();
    // `!` and `\r` join the class, and the reason is a way the set can move that
    // the enumeration above missed. Typing `!` in front of an existing
    // `[[att:<id>|x.png]]` that already sits alone on its line satisfies every
    // other condition: the plain wikilink was never in the block set, so
    // `value.size` is 0; the change is insert-only; and `!` is none of `[`, `]`
    // or `\n`. The field returned `value` unchanged while the inline builder
    // declined it too, because `embedIsAlone` had just become true, so the
    // newly valid embed rendered as raw source until an unrelated non-plain
    // edit forced a rebuild. It self-heals and never touches the document, and
    // it persists across arbitrary further typing, which is the shape that
    // reads as broken.
    if (/[[\]\n\r!]/.test(text)) safe = false;
  });
  return safe;
}

/** The decorations, plus what a caret move needs to repaint them without walking
 *  the document again. */
interface BlockEmbeds {
  decos: DecorationSet;
  /** One entry per block embed: the line it covers, and the widget it draws. */
  embeds: readonly { from: number; to: number; inner: WidgetType }[];
  /** The `from` of every embed line the selection covered when this was built. */
  active: readonly number[];
}

const blockEmbedField = StateField.define<BlockEmbeds>({
  create(state) {
    return buildBlockEmbeds(state, state.field(catalogField, false) ?? null);
  },
  update(value, tr) {
    // Not `value.map(tr.changes)` on the else branch: a mapped block decoration
    // can come out no longer covering whole lines, which is the one shape
    // CodeMirror rejects. Rebuilt when anything it reads has moved, kept
    // verbatim when nothing has.
    if (
      !tr.docChanged &&
      !catalogChanged(tr) &&
      syntaxTree(tr.startState) === syntaxTree(tr.state)
    ) {
      // Only the caret can have moved, and it changes what this paints.
      // Repainting reuses the stored widgets: no doc walk per arrow key.
      return tr.selection ? repaintActiveEmbeds(value, tr.state) : value;
    }
    if (unaffectedByPlainTyping(value.decos, tr)) return value;
    return buildBlockEmbeds(tr.state, tr.state.field(catalogField, false) ?? null);
  },
  provide: (f) => EditorView.decorations.from(f, (v) => v.decos),
});

/** The same embeds, with `active` recomputed from the caret. */
function repaintActiveEmbeds(value: BlockEmbeds, state: EditorState): BlockEmbeds {
  const active = value.embeds
    .filter((embed) => selectionOnLine(state, embed.from))
    .map((embed) => embed.from);
  if (
    active.length === value.active.length &&
    active.every((from, index) => from === value.active[index])
  ) {
    return value;
  }
  return { decos: decorateBlockEmbeds(value.embeds, active), embeds: value.embeds, active };
}

function decorateBlockEmbeds(
  embeds: readonly { from: number; to: number; inner: WidgetType }[],
  active: readonly number[],
): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  for (const embed of embeds) {
    builder.add(
      embed.from,
      embed.to,
      Decoration.replace({
        widget: new BlockEmbedFrame(embed.inner, active.includes(embed.from)),
        block: true,
      }),
    );
  }
  return builder.finish();
}

function buildBlockEmbeds(state: EditorState, catalog: CatalogState): BlockEmbeds {
  // ONE walk from 0 to the document's end, so nodes arrive in document order
  // already and nothing needs a sort. The inline builder sorts because it walks
  // several viewport ranges in turn.
  const embeds: { from: number; to: number; inner: WidgetType }[] = [];
  syntaxTree(state).iterate({
    from: 0,
    to: state.doc.length,
    enter: (node) => {
      if (node.name !== "Wikilink") return undefined;
      if (!embedIsAlone(state, node.from, node.to)) return false;
      const inner = resolveEmbedNode(state, catalog, node, true);
      if (inner === null) return false;
      const line = state.doc.lineAt(node.from);
      embeds.push({ from: line.from, to: line.to, inner });
      return false;
    },
  });
  const active = embeds
    .filter((embed) => selectionOnLine(state, embed.from))
    .map((embed) => embed.from);
  return { decos: decorateBlockEmbeds(embeds, active), embeds, active };
}

/** The lines of the INLINE attachment embeds the caret is on (2026-11-27: the
 *  embed whose line the caret reaches wears the app's edge). A line decoration
 *  from its own plugin, not a rebuild of the embeds: rebuilding constructs new
 *  widgets, which is the flash `#604` is about. The block form has no line
 *  element, so `BlockEmbedFrame` marks itself instead. */
/** Whether `pos`'s line is part of a selection range: an embed is atomic, so the
 *  caret lands beside it on the same line rather than inside it. */
function selectionOnLine(state: EditorState, pos: number): boolean {
  const line = state.doc.lineAt(pos);
  return state.selection.ranges.some((range) =>
    range.empty
      ? range.head >= line.from && range.head <= line.to
      : range.from <= line.to && range.to >= line.from,
  );
}

function buildActiveEmbedLines(
  state: EditorState,
  ranges: readonly { from: number; to: number }[],
): DecorationSet {
  const lines = new Set<number>();
  const overlaps = (lineFrom: number, lineTo: number): boolean =>
    state.selection.ranges.some((range) =>
      range.empty
        ? range.head >= lineFrom && range.head <= lineTo
        : range.from <= lineTo && range.to >= lineFrom,
    );
  for (const { from, to } of ranges) {
    syntaxTree(state).iterate({
      from,
      to,
      enter: (node) => {
        if (node.name !== "Wikilink") return undefined;
        if (attachmentEmbedId(state, node.node) === null) return false;
        // A block replace has no line element to land on (see `BlockEmbedFrame`).
        if (embedIsAlone(state, node.from, node.to)) return false;
        const first = state.doc.lineAt(node.from);
        const last = state.doc.lineAt(Math.max(node.from, node.to - 1));
        for (let number = first.number; number <= last.number; number++) {
          const line = state.doc.line(number);
          if (overlaps(line.from, line.to)) lines.add(line.from);
        }
        return false;
      },
    });
  }
  const builder = new RangeSetBuilder<Decoration>();
  for (const from of [...lines].sort((a, b) => a - b)) {
    builder.add(from, from, Decoration.line({ class: "cm-embed-active" }));
  }
  return builder.finish();
}

export function attachmentEmbedDecorations(): readonly Extension[] {
  return [
    blockEmbedField,
    ViewPlugin.fromClass(
      class {
        decorations: DecorationSet;
        constructor(view: EditorView) {
          this.decorations = buildAttachmentEmbedDecorations(
            view.state,
            view.state.field(catalogField),
            view.visibleRanges,
          );
        }
        update(update: ViewUpdate) {
          // Rebuild on doc / viewport change, async-parse, OR when the catalog
          // load resolves (the field value flips from null → map). The local
          // name here used to shadow the imported `catalogChanged`, so one file
          // held two answers to the same question and only one of them was
          // reachable from each site.
          const catalogMoved =
            update.startState.field(catalogField) !==
            update.state.field(catalogField);
          if (
            update.docChanged ||
            update.viewportChanged ||
            catalogMoved ||
            syntaxTree(update.startState) !== syntaxTree(update.state)
          ) {
            this.decorations = buildAttachmentEmbedDecorations(
              update.state,
              update.state.field(catalogField),
              update.view.visibleRanges,
            );
          }
        }
      },
      { decorations: (v) => v.decorations },
    ),
    ViewPlugin.fromClass(
      class {
        decorations: DecorationSet;
        constructor(view: EditorView) {
          this.decorations = buildActiveEmbedLines(view.state, view.visibleRanges);
        }
        update(update: ViewUpdate) {
          if (update.selectionSet || update.docChanged || update.viewportChanged) {
            this.decorations = buildActiveEmbedLines(update.state, update.view.visibleRanges);
          }
        }
      },
      { decorations: (v) => v.decorations },
    ),
    EditorView.atomicRanges.of(cachedAttachmentAtomicRanges),
  ];
}
