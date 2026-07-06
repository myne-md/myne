// Non-fetching image-chip rendering for the Phase 1 editor (epic MYND-164,
// MYND-147 + MYND-149).
//
// Markdown-native image forms that point at a URL are rendered as a NON-FETCHING
// placeholder chip — Myne never reaches out to fetch a remote image (it would
// beacon the note open). Two forms, both via the lezer `Image` node:
//
//   - MYND-147 inline `![alt](url)`        → chip (icon + alt label, URL tooltip)
//   - MYND-149 reference `![alt][ref]`     → same chip, URL resolved against the
//     shared link-reference-definition collector (`link-reference-collector.ts`)
//
// The chip:
//   - shows an image icon + the alt text (or "image" when alt is empty),
//   - exposes the URL only as a non-navigating `title` hover tooltip,
//   - suppresses click-through entirely (never navigates out, never fetches) —
//     the privacy invariant from grill 2026-06-07 Q2,
//   - is NEVER an `<img>` for the URL (no network request is ever issued).
//
// §264 rider (MYND-149): a `[ref]: url` definition referenced ONLY by an image
// should hide off-cursor just like a link's. The `Image`-referenced definitions
// are surfaced via `imageReferencedDefinitions`, which `reference-link.ts` folds
// into the shared definition-hiding StateField.
//
// IMPORTANT: form-C attachment embeds are `![[…]]` wikilink nodes, NOT `Image`
// nodes (the dialect's Wikilink parser registers `before: "Link"`/Image), so
// this module never touches them — it owns only URL-bearing `Image` nodes.

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
} from "@codemirror/view";
import type { SyntaxNode } from "@lezer/common";
import {
  type LinkReferenceEntry,
  type LinkReferenceMap,
  linkReferencesField,
  resolveReference,
} from "./link-reference-collector";
import { makeCursorAwareDecorationPlugin } from "./plugin-factory";
import { UrlImageChipWidget } from "../attachments/widgets";

/** Parsed shape of a markdown `Image` node. */
interface ImageShape {
  /** Alt text (between `![` and `]`). */
  readonly alt: string;
  /** Resolved destination URL (inline `(url)` or a resolved `[ref]`). */
  readonly url: string;
  /** For a reference image, the definition entry it resolves to (for §264). */
  readonly definition: LinkReferenceEntry | null;
}

/**
 * Read an `Image` node into `{ alt, url, definition }`. Returns `null` for a
 * reference image whose `[ref]` is dangling (no definition) — a dangling image
 * reference is left as plain text, mirroring the dangling-link behavior, so the
 * user sees the raw broken markdown rather than a misleading chip.
 */
function readImage(
  state: EditorState,
  node: SyntaxNode,
  map: LinkReferenceMap,
): ImageShape | null {
  const marks: Array<[number, number]> = [];
  let urlNode: { from: number; to: number } | null = null;
  let labelNode: { from: number; to: number } | null = null;
  for (let child = node.firstChild; child; child = child.nextSibling) {
    if (child.name === "LinkMark") marks.push([child.from, child.to]);
    else if (child.name === "URL") urlNode = { from: child.from, to: child.to };
    else if (child.name === "LinkLabel") labelNode = { from: child.from, to: child.to };
  }
  if (marks.length < 2) return null;
  // Alt text sits between the first `![` mark and the second `]` mark.
  const alt = state.doc.sliceString(marks[0]![1], marks[1]![0]);

  if (urlNode !== null) {
    // Inline `![alt](url)` (MYND-147).
    return { alt, url: state.doc.sliceString(urlNode.from, urlNode.to).trim(), definition: null };
  }

  if (labelNode !== null) {
    // Full reference `![alt][ref]` (MYND-149) — resolve `[ref]` against the map.
    const rawLabel = state.doc.sliceString(labelNode.from, labelNode.to);
    const entry = resolveReference(map, rawLabel);
    if (entry === undefined) return null; // dangling — leave plain
    return { alt, url: entry.target, definition: entry };
  }

  // Collapsed `![alt][]` / shortcut `![ref]` only become Image nodes when
  // resolved; resolve by the alt text.
  const entry = resolveReference(map, alt);
  if (entry === undefined) return null;
  return { alt, url: entry.target, definition: entry };
}

// --- 1. Non-fetching chip (ViewPlugin) ------------------------------------

function buildImageChipDecorations(view: EditorView): DecorationSet {
  // Read the shared definition map (installed by reference-link.ts).
  const map = view.state.field(linkReferencesField);
  const decorations: Array<Range<Decoration>> = [];
  for (const { from, to } of view.visibleRanges) {
    syntaxTree(view.state).iterate({
      from,
      to,
      enter: (node) => {
        if (node.name !== "Image") return undefined;
        const shape = readImage(view.state, node.node, map);
        if (shape === null) return false; // dangling reference — plain text
        decorations.push(
          Decoration.replace({
            widget: new UrlImageChipWidget(shape.alt, shape.url),
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

// --- 2. §264 rider: definitions referenced by a reference image -----------

/**
 * Definitions referenced by a reference IMAGE (`![alt][ref]`). Consumed by
 * `reference-link.ts::referencedDefinitions` so a `[ref]: url` referenced only
 * by an image hides off-cursor (the §264 rider). De-dup is the caller's job.
 */
export function imageReferencedDefinitions(
  state: EditorState,
  map: LinkReferenceMap,
): LinkReferenceEntry[] {
  const out: LinkReferenceEntry[] = [];
  syntaxTree(state).iterate({
    enter: (node) => {
      if (node.name !== "Image") return undefined;
      const shape = readImage(state, node.node, map);
      if (shape !== null && shape.definition !== null) out.push(shape.definition);
      return false;
    },
  });
  return out;
}

export function imageUrlDecorations(): Extension {
  return makeCursorAwareDecorationPlugin(buildImageChipDecorations);
}
