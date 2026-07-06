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
} from "@codemirror/state";
import {
  Decoration,
  type DecorationSet,
  EditorView,
  ViewPlugin,
  type ViewUpdate,
} from "@codemirror/view";
import type { SyntaxNode } from "@lezer/common";
import { parseAttachmentTarget } from "@myne/editor/host/notes/attachmentRef";
import { parseWikilinkParts } from "../wikilink/chip-widget";
import {
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

/** The display filename (alias) of an embed, for the tombstone/caption label. */
function embedFilename(state: EditorState, node: SyntaxNode): string {
  const parts = parseWikilinkParts(state, node.from, node.to);
  return parts.alias ?? "";
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
        const id = attachmentEmbedId(state, node.node);
        if (id === null) return false; // not an attachment embed — leave to wikilink chip
        const filename = embedFilename(state, node.node);

        const resolution = resolveCatalog(catalog, id);
        let widget;
        if (resolution.kind === "resolved") {
          widget = makeResolvedWidget(resolution.row);
        } else {
          // Either a DELETED attachment (`kind === "deleted"`: a syntactically
          // valid id absent from a loaded catalog — it once existed) OR the
          // catalog still loading. Both render the deleted tombstone's neutral
          // frame: it's the correct end-state for a deletion, and using it while
          // loading avoids a flicker (the alternative — a 404'ing `<img>` —
          // would flash broken-image until the catalog arrives and a real
          // image/tombstone widget replaces it). A malformed `att:` target (a
          // "broken" reference) never reaches here — `parseAttachmentTarget`
          // rejects it, so the raw `![[…]]` stays plain (wikilink chip renders).
          widget = new AttachmentTombstoneWidget("deleted", filename);
        }

        decorations.push(
          Decoration.replace({ widget, atomic: true }).range(node.from, node.to),
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
  atomicCache.set(tree, finished);
  return finished;
}

export function attachmentEmbedDecorations(): readonly Extension[] {
  return [
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
          // load resolves (the field value flips from null → map).
          const catalogChanged =
            update.startState.field(catalogField) !==
            update.state.field(catalogField);
          if (
            update.docChanged ||
            update.viewportChanged ||
            catalogChanged ||
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
    EditorView.atomicRanges.of(cachedAttachmentAtomicRanges),
  ];
}
